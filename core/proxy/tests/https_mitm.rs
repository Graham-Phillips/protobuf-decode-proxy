use std::net::SocketAddr;

use hudsucker::{
    certificate_authority::{CertificateAuthority, RcgenAuthority},
    rcgen::{
        BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair,
        KeyUsagePurpose,
    },
};
use protobuf_decoder_proxy::{
    start_proxy_with_capture_and_upstream_root, Direction, InMemoryCapture, Protocol,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn proxies_https_mitm_and_records_request_response_events() {
    let upstream_ca = make_test_ca("Protobuf Decoder Upstream Test CA");
    let upstream_addr = start_test_https_server(upstream_ca.authority).await;
    let proxy =
        start_proxy_with_capture_and_upstream_root(InMemoryCapture::new(), upstream_ca.der.clone())
            .await
            .expect("proxy should start with upstream test root");
    let proxy_url = format!("http://{}", proxy.addr());
    let proxy_ca = reqwest::Certificate::from_der(proxy.ca_der())
        .expect("proxy CA should be a valid DER certificate");
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::https(&proxy_url).expect("proxy URL should be valid"))
        .add_root_certificate(proxy_ca)
        .build()
        .expect("client should build");

    let response = client
        .get(format!("https://localhost:{}/secure", upstream_addr.port()))
        .header("x-protobuf-decoder-test", "https-mitm")
        .send()
        .await
        .expect("request through HTTPS MITM proxy should succeed");

    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response.text().await.expect("response body should read"),
        "secure-ok"
    );

    let events = proxy.capture().events().await;
    proxy.stop().await.expect("proxy should stop cleanly");

    let connect = events
        .iter()
        .find(|event| {
            event.protocol == Protocol::Http
                && event.direction == Direction::Request
                && event.method.as_deref() == Some("CONNECT")
        })
        .expect("CONNECT tunnel event should be recorded");
    let request = events
        .iter()
        .find(|event| {
            event.protocol == Protocol::Http
                && event.direction == Direction::Request
                && event.method.as_deref() == Some("GET")
                && event.path.as_deref() == Some("/secure")
        })
        .expect("decrypted HTTPS request event should be recorded");
    let response = events
        .iter()
        .find(|event| {
            event.protocol == Protocol::Http
                && event.direction == Direction::Response
                && event.status == Some(200)
        })
        .expect("response event should be recorded");

    let upstream_authority = format!("localhost:{}", upstream_addr.port());
    assert_eq!(
        connect.authority.as_deref(),
        Some(upstream_authority.as_str())
    );
    assert_eq!(request.method.as_deref(), Some("GET"));
    assert_eq!(request.scheme.as_deref(), Some("https"));
    assert_eq!(request.path.as_deref(), Some("/secure"));
    assert_eq!(
        request
            .headers
            .get("x-protobuf-decoder-test")
            .map(String::as_str),
        Some("https-mitm")
    );
    assert_eq!(response.status, Some(200));
    assert_eq!(request.request_id, response.request_id);
}

async fn start_test_https_server(ca: RcgenAuthority) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test HTTPS server should bind");
    let addr = listener
        .local_addr()
        .expect("test HTTPS server local addr should be available");
    let acceptor: tokio_rustls::TlsAcceptor = ca
        .gen_server_config(&"localhost".parse().expect("localhost should parse"))
        .await
        .into();

    tokio::spawn(async move {
        let (stream, _) = listener
            .accept()
            .await
            .expect("test HTTPS server should accept one connection");
        let mut stream = acceptor
            .accept(stream)
            .await
            .expect("test HTTPS server should accept TLS");
        let mut request = vec![0; 4096];
        let _ = stream
            .read(&mut request)
            .await
            .expect("test HTTPS server should read request");

        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-length: 9\r\ncontent-type: text/plain\r\n\r\nsecure-ok",
            )
            .await
            .expect("test HTTPS server should write response");
    });

    addr
}

struct TestCa {
    authority: RcgenAuthority,
    der: Vec<u8>,
}

fn make_test_ca(common_name: &str) -> TestCa {
    let key_pair = KeyPair::generate().expect("test CA key should generate");
    let key_pair_pem = key_pair.serialize_pem();
    let mut params = CertificateParams::default();
    let mut distinguished_name = DistinguishedName::new();

    distinguished_name.push(DnType::CommonName, common_name);
    params.distinguished_name = distinguished_name;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
    ];

    let cert = params
        .clone()
        .self_signed(&key_pair)
        .expect("test CA certificate should self-sign");
    let issuer = Issuer::from_ca_cert_pem(
        &cert.pem(),
        KeyPair::from_pem(&key_pair_pem).expect("test CA key PEM should parse"),
    )
    .expect("test CA issuer should build");

    TestCa {
        authority: RcgenAuthority::new(
            issuer,
            1_000,
            rustls::crypto::aws_lc_rs::default_provider(),
        ),
        der: cert.der().to_vec(),
    }
}
