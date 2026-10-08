use std::{
    collections::BTreeMap,
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use http_body_util::BodyExt;
use hudsucker::{
    certificate_authority::RcgenAuthority,
    hyper::{body::Body as _, header::HeaderMap, Request, Response, Uri},
    hyper_util::client::legacy::connect::HttpConnector,
    rcgen::{
        BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair,
        KeyUsagePurpose,
    },
    tokio_tungstenite::tungstenite::{self, Message},
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse, WebSocketContext, WebSocketHandler,
};
use hyper_rustls::HttpsConnector;
use rustls::pki_types::{pem::PemObject, CertificateDer};
use thiserror::Error;
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex},
    task::JoinHandle,
};
use uuid::Uuid;

use crate::{
    BodyCapture, CaptureSink, Direction, InMemoryCapture, Protocol, ProxyEvent, WebSocketEventKind,
    WebSocketMessageKind,
};

pub const DEFAULT_PROXY_ADDR: &str = "127.0.0.1:27777";
const BODY_CAPTURE_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug)]
pub struct ProxyCa {
    pub cert_pem: String,
    pub key_pem: String,
}

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("failed to bind proxy listener: {0}")]
    Bind(#[source] std::io::Error),
    #[error("failed to generate local CA key pair: {0}")]
    KeyPair(#[from] hudsucker::rcgen::Error),
    #[error("failed to parse local CA certificate PEM: {0}")]
    CertificatePem(#[from] rustls::pki_types::pem::Error),
    #[error("failed to build proxy: {0}")]
    Build(#[from] hudsucker::Error),
    #[error("failed to build TLS configuration: {0}")]
    Tls(#[from] rustls::Error),
    #[error("proxy task failed: {0}")]
    TaskJoin(#[from] tokio::task::JoinError),
}

pub struct ProxyHandle {
    addr: SocketAddr,
    ca_der: Vec<u8>,
    ca_pem: String,
    capture: InMemoryCapture,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), hudsucker::Error>>,
}

impl ProxyHandle {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn ca_der(&self) -> &[u8] {
        &self.ca_der
    }

    pub fn ca_pem(&self) -> &str {
        &self.ca_pem
    }

    pub fn capture(&self) -> InMemoryCapture {
        self.capture.clone()
    }

    pub async fn stop(mut self) -> Result<(), ProxyError> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }

        self.task.await??;
        Ok(())
    }
}

pub async fn start_proxy() -> Result<ProxyHandle, ProxyError> {
    let capture = InMemoryCapture::new();
    start_proxy_with_capture(capture).await
}

pub async fn start_proxy_on_default_addr() -> Result<ProxyHandle, ProxyError> {
    let capture = InMemoryCapture::new();
    start_proxy_with_capture_on(capture, DEFAULT_PROXY_ADDR).await
}

pub async fn start_proxy_on_default_addr_with_ca(ca: ProxyCa) -> Result<ProxyHandle, ProxyError> {
    let capture = InMemoryCapture::new();
    start_proxy_with_capture_on_ca(capture, DEFAULT_PROXY_ADDR, ca).await
}

pub async fn start_proxy_on_ephemeral_addr_with_ca(ca: ProxyCa) -> Result<ProxyHandle, ProxyError> {
    let capture = InMemoryCapture::new();
    start_proxy_with_capture_on_ca(capture, "127.0.0.1:0", ca).await
}

pub async fn start_proxy_with_capture(capture: InMemoryCapture) -> Result<ProxyHandle, ProxyError> {
    start_proxy_with_capture_on(capture, "127.0.0.1:0").await
}

async fn start_proxy_with_capture_on(
    capture: InMemoryCapture,
    bind_addr: &str,
) -> Result<ProxyHandle, ProxyError> {
    let ca = generate_proxy_ca()?;
    start_proxy_with_capture_on_ca(capture, bind_addr, ca).await
}

async fn start_proxy_with_capture_on_ca(
    capture: InMemoryCapture,
    bind_addr: &str,
    ca: ProxyCa,
) -> Result<ProxyHandle, ProxyError> {
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(ProxyError::Bind)?;
    let addr = listener.local_addr().map_err(ProxyError::Bind)?;
    let ca = load_proxy_ca(ca)?;
    let handler = RecordingHandler::new(capture.clone());
    let websocket_handler = RecordingWebSocketHandler::new(capture.clone());
    let (stop, done) = oneshot::channel();

    let proxy = Proxy::builder()
        .with_listener(listener)
        .with_ca(ca.authority)
        .with_rustls_connector(rustls::crypto::aws_lc_rs::default_provider())
        .with_http_handler(handler)
        .with_websocket_handler(websocket_handler)
        .with_graceful_shutdown(async {
            let _ = done.await;
        })
        .build()?;

    let task = tokio::spawn(proxy.start());

    Ok(ProxyHandle {
        addr,
        ca_der: ca.der,
        ca_pem: ca.pem,
        capture,
        stop: Some(stop),
        task,
    })
}

pub async fn start_proxy_with_capture_and_upstream_root(
    capture: InMemoryCapture,
    upstream_root_der: Vec<u8>,
) -> Result<ProxyHandle, ProxyError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(ProxyError::Bind)?;
    let addr = listener.local_addr().map_err(ProxyError::Bind)?;
    let ca = load_proxy_ca(generate_proxy_ca()?)?;
    let handler = RecordingHandler::new(capture.clone());
    let websocket_handler = RecordingWebSocketHandler::new(capture.clone());
    let (stop, done) = oneshot::channel();

    let proxy = Proxy::builder()
        .with_listener(listener)
        .with_ca(ca.authority)
        .with_http_connector(rustls_connector_with_roots(vec![upstream_root_der])?)
        .with_http_handler(handler)
        .with_websocket_handler(websocket_handler)
        .with_graceful_shutdown(async {
            let _ = done.await;
        })
        .build()?;

    let task = tokio::spawn(proxy.start());

    Ok(ProxyHandle {
        addr,
        ca_der: ca.der,
        ca_pem: ca.pem,
        capture,
        stop: Some(stop),
        task,
    })
}

struct GeneratedCa {
    authority: RcgenAuthority,
    der: Vec<u8>,
    pem: String,
}

pub fn generate_proxy_ca() -> Result<ProxyCa, ProxyError> {
    let key_pair = KeyPair::generate()?;
    let key_pair_pem = key_pair.serialize_pem();
    let mut params = CertificateParams::default();
    let mut distinguished_name = DistinguishedName::new();

    distinguished_name.push(DnType::CommonName, "Protobuf Decoder Local Test CA");
    params.distinguished_name = distinguished_name;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
    ];

    let cert = params.clone().self_signed(&key_pair)?;
    let cert_pem = cert.pem();

    Ok(ProxyCa {
        cert_pem,
        key_pem: key_pair_pem,
    })
}

fn load_proxy_ca(ca: ProxyCa) -> Result<GeneratedCa, ProxyError> {
    let cert_der = CertificateDer::from_pem_slice(ca.cert_pem.as_bytes())?;
    let issuer = Issuer::from_ca_cert_pem(&ca.cert_pem, KeyPair::from_pem(&ca.key_pem)?)?;

    Ok(GeneratedCa {
        authority: RcgenAuthority::new(
            issuer,
            1_000,
            rustls::crypto::aws_lc_rs::default_provider(),
        ),
        der: cert_der.to_vec(),
        pem: ca.cert_pem,
    })
}

fn rustls_connector_with_roots(
    root_certs: Vec<Vec<u8>>,
) -> Result<HttpsConnector<HttpConnector>, rustls::Error> {
    let mut roots = rustls::RootCertStore::empty();

    for root in root_certs {
        roots.add(rustls::pki_types::CertificateDer::from(root))?;
    }

    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();

    Ok(hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(config)
        .https_or_http()
        .enable_http1()
        .build())
}

#[derive(Clone)]
struct RecordingHandler<S = InMemoryCapture> {
    capture: S,
    current_request_id: Option<String>,
}

impl<S> RecordingHandler<S>
where
    S: CaptureSink,
{
    fn new(capture: S) -> Self {
        Self {
            capture,
            current_request_id: None,
        }
    }
}

impl<S> HttpHandler for RecordingHandler<S>
where
    S: CaptureSink,
{
    async fn handle_request(
        &mut self,
        _ctx: &HttpContext,
        req: Request<Body>,
    ) -> RequestOrResponse {
        let request_id = Uuid::new_v4().to_string();
        self.current_request_id = Some(request_id.clone());
        let (parts, body) = req.into_parts();
        let body_len_hint = exact_body_len(&body);
        let (body, body_capture) = capture_body(body).await;

        self.capture
            .record(ProxyEvent {
                id: Uuid::new_v4().to_string(),
                request_id,
                connection_id: None,
                timestamp_unix_ms: now_unix_ms(),
                protocol: Protocol::Http,
                direction: Direction::Request,
                method: Some(parts.method.to_string()),
                scheme: parts.uri.scheme_str().map(ToOwned::to_owned),
                authority: parts.uri.authority().map(ToString::to_string),
                path: parts
                    .uri
                    .path_and_query()
                    .map(|path_and_query| path_and_query.as_str().to_owned()),
                status: None,
                headers: headers_to_map(&parts.headers),
                body_len_hint,
                body_capture,
                websocket_event_kind: None,
                websocket_message_kind: None,
                websocket_error: None,
            })
            .await;

        Request::from_parts(parts, body).into()
    }

    async fn handle_response(&mut self, _ctx: &HttpContext, res: Response<Body>) -> Response<Body> {
        let request_id = self
            .current_request_id
            .take()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let (parts, body) = res.into_parts();
        let body_len_hint = exact_body_len(&body);
        let (body, body_capture) = capture_body(body).await;

        self.capture
            .record(ProxyEvent {
                id: Uuid::new_v4().to_string(),
                request_id,
                connection_id: None,
                timestamp_unix_ms: now_unix_ms(),
                protocol: Protocol::Http,
                direction: Direction::Response,
                method: None,
                scheme: None,
                authority: None,
                path: None,
                status: Some(parts.status.as_u16()),
                headers: headers_to_map(&parts.headers),
                body_len_hint,
                body_capture,
                websocket_event_kind: None,
                websocket_message_kind: None,
                websocket_error: None,
            })
            .await;

        Response::from_parts(parts, body)
    }
}

#[derive(Clone)]
struct RecordingWebSocketHandler<S = InMemoryCapture> {
    capture: S,
    active_connections: Arc<Mutex<BTreeMap<String, usize>>>,
}

impl<S> RecordingWebSocketHandler<S>
where
    S: CaptureSink,
{
    fn new(capture: S) -> Self {
        Self {
            capture,
            active_connections: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    async fn mark_connection_open(&self, ctx: &WebSocketContext, connection_id: &str) {
        let should_record = {
            let mut active_connections = self.active_connections.lock().await;
            let stream_count = active_connections
                .entry(connection_id.to_owned())
                .or_default();
            *stream_count += 1;

            *stream_count == 1
        };

        if should_record {
            self.record_lifecycle_event(ctx, connection_id, WebSocketEventKind::Open, None)
                .await;
        }
    }

    async fn mark_connection_closed(&self, ctx: &WebSocketContext, connection_id: &str) {
        let should_record = {
            let mut active_connections = self.active_connections.lock().await;

            if let Some(stream_count) = active_connections.get_mut(connection_id) {
                *stream_count = stream_count.saturating_sub(1);

                if *stream_count == 0 {
                    active_connections.remove(connection_id);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };

        if should_record {
            self.record_lifecycle_event(ctx, connection_id, WebSocketEventKind::Close, None)
                .await;
        }
    }

    async fn record_error(&self, ctx: &WebSocketContext, connection_id: &str, error: String) {
        self.record_lifecycle_event(ctx, connection_id, WebSocketEventKind::Error, Some(error))
            .await;
    }

    async fn record_lifecycle_event(
        &self,
        ctx: &WebSocketContext,
        connection_id: &str,
        event_kind: WebSocketEventKind,
        error: Option<String>,
    ) {
        self.capture
            .record(websocket_event(
                ctx,
                connection_id,
                Direction::Internal,
                Some(event_kind),
                None,
                None,
                None,
                error,
            ))
            .await;
    }

    async fn record_message(
        &self,
        ctx: &WebSocketContext,
        connection_id: &str,
        message: Message,
    ) -> Option<Message> {
        let direction = match ctx {
            WebSocketContext::ClientToServer { .. } => Direction::Request,
            WebSocketContext::ServerToClient { .. } => Direction::Response,
        };
        let body_len_hint = Some(message.len() as u64);
        let message_kind = Some(websocket_message_kind(&message));
        let body_capture = websocket_body_capture(&message);

        self.capture
            .record(websocket_event(
                ctx,
                connection_id,
                direction,
                Some(WebSocketEventKind::Message),
                message_kind,
                body_len_hint,
                body_capture,
                None,
            ))
            .await;

        Some(message)
    }
}

impl<S> WebSocketHandler for RecordingWebSocketHandler<S>
where
    S: CaptureSink,
{
    async fn handle_websocket(
        self,
        ctx: WebSocketContext,
        mut stream: impl Stream<Item = Result<Message, tungstenite::Error>> + Unpin + Send + 'static,
        mut sink: impl Sink<Message, Error = tungstenite::Error> + Unpin + Send + 'static,
    ) {
        let connection_id = websocket_connection_id(&ctx);
        self.mark_connection_open(&ctx, &connection_id).await;

        while let Some(message) = stream.next().await {
            match message {
                Ok(message) => {
                    let Some(message) = self.record_message(&ctx, &connection_id, message).await
                    else {
                        continue;
                    };

                    match sink.send(message).await {
                        Err(tungstenite::Error::ConnectionClosed) => break,
                        Err(error) => {
                            self.record_error(&ctx, &connection_id, error.to_string())
                                .await;
                            break;
                        }
                        Ok(()) => {}
                    }
                }
                Err(error) => {
                    self.record_error(&ctx, &connection_id, error.to_string())
                        .await;

                    match sink.send(Message::Close(None)).await {
                        Err(tungstenite::Error::ConnectionClosed) => {}
                        Err(error) => {
                            self.record_error(&ctx, &connection_id, error.to_string())
                                .await;
                        }
                        Ok(()) => {}
                    };

                    break;
                }
            }
        }

        self.mark_connection_closed(&ctx, &connection_id).await;
    }
}

fn websocket_event(
    ctx: &WebSocketContext,
    connection_id: &str,
    direction: Direction,
    event_kind: Option<WebSocketEventKind>,
    message_kind: Option<WebSocketMessageKind>,
    body_len_hint: Option<u64>,
    body_capture: Option<BodyCapture>,
    error: Option<String>,
) -> ProxyEvent {
    let target = websocket_target_uri(ctx);

    ProxyEvent {
        id: Uuid::new_v4().to_string(),
        request_id: connection_id.to_owned(),
        connection_id: Some(connection_id.to_owned()),
        timestamp_unix_ms: now_unix_ms(),
        protocol: Protocol::WebSocket,
        direction,
        method: None,
        scheme: target.scheme_str().map(ToOwned::to_owned),
        authority: target.authority().map(ToString::to_string),
        path: target
            .path_and_query()
            .map(|path_and_query| path_and_query.as_str().to_owned()),
        status: None,
        headers: BTreeMap::new(),
        body_len_hint,
        body_capture,
        websocket_event_kind: event_kind,
        websocket_message_kind: message_kind,
        websocket_error: error,
    }
}

fn websocket_connection_id(ctx: &WebSocketContext) -> String {
    let client_addr = match ctx {
        WebSocketContext::ClientToServer { src, .. } => src,
        WebSocketContext::ServerToClient { dst, .. } => dst,
    };

    format!("{client_addr}->{}", websocket_target_uri(ctx))
}

fn websocket_target_uri(ctx: &WebSocketContext) -> &Uri {
    match ctx {
        WebSocketContext::ClientToServer { dst, .. } => dst,
        WebSocketContext::ServerToClient { src, .. } => src,
    }
}

fn exact_body_len(body: &Body) -> Option<u64> {
    body.size_hint().exact()
}

async fn capture_body(body: Body) -> (Body, Option<BodyCapture>) {
    if !should_capture_body(&body) {
        return (body, None);
    }

    match body.collect().await {
        Ok(collected) => {
            let bytes = collected.to_bytes();
            let captured = bytes.to_vec();

            (
                Body::from(bytes),
                Some(BodyCapture {
                    bytes: captured,
                    truncated: false,
                    capture_limit: BODY_CAPTURE_LIMIT,
                }),
            )
        }
        Err(_) => (Body::empty(), None),
    }
}

fn should_capture_body(body: &Body) -> bool {
    if body.is_end_stream() {
        return true;
    }

    body.size_hint()
        .upper()
        .is_some_and(|upper| upper <= BODY_CAPTURE_LIMIT as u64)
}

fn headers_to_map(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let value = value
                .to_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|_| "<non-utf8>".to_owned());

            (name.as_str().to_owned(), value)
        })
        .collect()
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn websocket_message_kind(message: &Message) -> WebSocketMessageKind {
    match message {
        Message::Text(_) => WebSocketMessageKind::Text,
        Message::Binary(_) => WebSocketMessageKind::Binary,
        Message::Ping(_) => WebSocketMessageKind::Ping,
        Message::Pong(_) => WebSocketMessageKind::Pong,
        Message::Close(_) => WebSocketMessageKind::Close,
        Message::Frame(_) => WebSocketMessageKind::Frame,
    }
}

fn websocket_body_capture(message: &Message) -> Option<BodyCapture> {
    let bytes = match message {
        Message::Text(text) => text.as_bytes(),
        Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => bytes.as_ref(),
        Message::Close(_) | Message::Frame(_) => return None,
    };

    let captured_len = bytes.len().min(BODY_CAPTURE_LIMIT);

    Some(BodyCapture {
        bytes: bytes[..captured_len].to_vec(),
        truncated: bytes.len() > BODY_CAPTURE_LIMIT,
        capture_limit: BODY_CAPTURE_LIMIT,
    })
}
