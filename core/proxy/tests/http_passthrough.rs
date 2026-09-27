use std::net::SocketAddr;

use protobuf_decoder_proxy::{start_proxy, Direction};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn proxies_plain_http_and_records_request_response_events() {
    let upstream_addr = start_test_http_server().await;
    let proxy = start_proxy().await.expect("proxy should start");
    let proxy_url = format!("http://{}", proxy.addr());
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(&proxy_url).expect("proxy URL should be valid"))
        .build()
        .expect("client should build");

    let response = client
        .get(format!(
            "http://{upstream_addr}/hello?name=protobuf-decoder"
        ))
        .header("x-protobuf-decoder-test", "plain-http")
        .send()
        .await
        .expect("request through proxy should succeed");

    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response
            .text()
            .await
            .expect("response body should be readable"),
        "protobuf-decoder-ok"
    );

    let events = proxy.capture().events().await;
    proxy.stop().await.expect("proxy should stop cleanly");

    let request = events
        .iter()
        .find(|event| event.direction == Direction::Request)
        .expect("request event should be recorded");
    let response = events
        .iter()
        .find(|event| event.direction == Direction::Response)
        .expect("response event should be recorded");

    assert_eq!(request.method.as_deref(), Some("GET"));
    assert_eq!(
        request.path.as_deref(),
        Some("/hello?name=protobuf-decoder")
    );
    assert_eq!(
        request
            .headers
            .get("x-protobuf-decoder-test")
            .map(String::as_str),
        Some("plain-http")
    );
    assert_eq!(response.status, Some(200));
    assert_eq!(request.request_id, response.request_id);
}

async fn start_test_http_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test server should bind");
    let addr = listener
        .local_addr()
        .expect("test server local addr should be available");

    tokio::spawn(async move {
        let (mut stream, _) = listener
            .accept()
            .await
            .expect("test server should accept one connection");
        let mut request = vec![0; 4096];
        let _ = stream
            .read(&mut request)
            .await
            .expect("test server should read request");

        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-length: 19\r\ncontent-type: text/plain\r\n\r\nprotobuf-decoder-ok",
            )
            .await
            .expect("test server should write response");
    });

    addr
}
