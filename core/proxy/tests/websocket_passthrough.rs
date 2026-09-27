use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use protobuf_decoder_proxy::{
    start_proxy, Direction, Protocol, WebSocketEventKind, WebSocketMessageKind,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{sleep, Duration},
};
use tokio_tungstenite::{accept_async, client_async, tungstenite::Message};

#[tokio::test]
async fn proxies_websocket_messages_and_records_both_directions() {
    let upstream_addr = start_test_websocket_server().await;
    let proxy = start_proxy().await.expect("proxy should start");
    let stream = connect_tunnel(proxy.addr(), upstream_addr).await;

    let (mut ws, _) = client_async(format!("ws://{upstream_addr}/echo"), stream)
        .await
        .expect("websocket client should connect through proxy");

    ws.send(Message::text("hello"))
        .await
        .expect("websocket request should send");

    let response = ws
        .next()
        .await
        .expect("websocket response should arrive")
        .expect("websocket response should be valid");

    assert_eq!(
        response.to_text().expect("response should be text"),
        "world"
    );

    ws.close(None)
        .await
        .expect("websocket client should close cleanly");

    let events = wait_for_websocket_close(&proxy).await;
    proxy.stop().await.expect("proxy should stop cleanly");

    let websocket_events = events
        .iter()
        .filter(|event| event.protocol == Protocol::WebSocket)
        .collect::<Vec<_>>();
    let websocket_message_events = websocket_events
        .iter()
        .filter(|event| {
            matches!(
                event.websocket_event_kind.as_ref(),
                Some(WebSocketEventKind::Message)
            )
        })
        .copied()
        .collect::<Vec<_>>();
    let websocket_open_events = websocket_events
        .iter()
        .filter(|event| {
            matches!(
                event.websocket_event_kind.as_ref(),
                Some(WebSocketEventKind::Open)
            )
        })
        .copied()
        .collect::<Vec<_>>();
    let websocket_close_events = websocket_events
        .iter()
        .filter(|event| {
            matches!(
                event.websocket_event_kind.as_ref(),
                Some(WebSocketEventKind::Close)
            )
        })
        .copied()
        .collect::<Vec<_>>();
    let websocket_text_events = websocket_message_events
        .iter()
        .filter(|event| event.websocket_message_kind == Some(WebSocketMessageKind::Text))
        .copied()
        .collect::<Vec<_>>();

    assert_eq!(websocket_open_events.len(), 1);
    assert_eq!(websocket_text_events.len(), 2);
    assert_eq!(websocket_close_events.len(), 1);

    let connection_id = websocket_open_events[0]
        .connection_id
        .as_ref()
        .expect("open event should include a connection id");

    assert!(
        websocket_events
            .iter()
            .all(|event| event.connection_id.as_ref() == Some(connection_id)),
        "all websocket events should share a connection id"
    );
    assert!(websocket_text_events.iter().any(|event| {
        event.direction == Direction::Request
            && event.websocket_message_kind == Some(WebSocketMessageKind::Text)
            && event.body_len_hint == Some(5)
            && event
                .body_capture
                .as_ref()
                .is_some_and(|capture| capture.bytes == b"hello")
    }));
    assert!(websocket_text_events.iter().any(|event| {
        event.direction == Direction::Response
            && event.websocket_message_kind == Some(WebSocketMessageKind::Text)
            && event.body_len_hint == Some(5)
            && event
                .body_capture
                .as_ref()
                .is_some_and(|capture| capture.bytes == b"world")
    }));
}

async fn connect_tunnel(proxy_addr: SocketAddr, upstream_addr: SocketAddr) -> TcpStream {
    let mut stream = TcpStream::connect(proxy_addr)
        .await
        .expect("proxy TCP connection should open");
    let target = upstream_addr.to_string();
    let request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n");

    stream
        .write_all(request.as_bytes())
        .await
        .expect("CONNECT request should write");

    let mut response = Vec::new();
    let mut buffer = [0; 256];

    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .expect("CONNECT response should read");
        assert!(read > 0, "proxy closed before CONNECT response completed");

        response.extend_from_slice(&buffer[..read]);

        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let response = String::from_utf8_lossy(&response);
    assert!(
        response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"),
        "CONNECT should succeed, got {response:?}"
    );

    stream
}

async fn wait_for_websocket_close(
    proxy: &protobuf_decoder_proxy::ProxyHandle,
) -> Vec<protobuf_decoder_proxy::ProxyEvent> {
    for _ in 0..20 {
        let events = proxy.capture().events().await;

        if events.iter().any(|event| {
            event.protocol == Protocol::WebSocket
                && matches!(
                    event.websocket_event_kind.as_ref(),
                    Some(WebSocketEventKind::Close)
                )
        }) {
            return events;
        }

        sleep(Duration::from_millis(50)).await;
    }

    proxy.capture().events().await
}

async fn start_test_websocket_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test websocket server should bind");
    let addr = listener
        .local_addr()
        .expect("test websocket server local addr should be available");

    tokio::spawn(async move {
        let (stream, _) = listener
            .accept()
            .await
            .expect("test websocket server should accept one connection");
        let mut ws = accept_async(stream)
            .await
            .expect("test websocket server should accept handshake");

        let message = ws
            .next()
            .await
            .expect("test websocket server should receive one message")
            .expect("test websocket message should be valid");

        assert_eq!(message.to_text().expect("message should be text"), "hello");

        ws.send(Message::text("world"))
            .await
            .expect("test websocket server should send response");
    });

    addr
}
