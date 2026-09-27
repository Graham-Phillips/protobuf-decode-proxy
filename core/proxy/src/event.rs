use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum Direction {
    Request,
    Response,
    Internal,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum Protocol {
    Http,
    WebSocket,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum WebSocketMessageKind {
    Text,
    Binary,
    Ping,
    Pong,
    Close,
    Frame,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum WebSocketEventKind {
    Open,
    Message,
    Close,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProxyEvent {
    pub id: String,
    pub request_id: String,
    pub connection_id: Option<String>,
    pub timestamp_unix_ms: u128,
    pub protocol: Protocol,
    pub direction: Direction,
    pub method: Option<String>,
    pub scheme: Option<String>,
    pub authority: Option<String>,
    pub path: Option<String>,
    pub status: Option<u16>,
    pub headers: BTreeMap<String, String>,
    pub body_len_hint: Option<u64>,
    #[serde(skip_serializing)]
    pub body_capture: Option<BodyCapture>,
    pub websocket_event_kind: Option<WebSocketEventKind>,
    pub websocket_message_kind: Option<WebSocketMessageKind>,
    pub websocket_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BodyCapture {
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub capture_limit: usize,
}
