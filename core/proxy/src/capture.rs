use std::{collections::VecDeque, future::Future, sync::Arc};

use tokio::sync::Mutex;

use crate::ProxyEvent;

const MAX_CAPTURE_EVENTS: usize = 2_000;

pub trait CaptureSink: Clone + Send + Sync + 'static {
    fn record(&self, event: ProxyEvent) -> impl Future<Output = ()> + Send;
}

#[derive(Clone, Default)]
pub struct InMemoryCapture {
    events: Arc<Mutex<VecDeque<ProxyEvent>>>,
}

impl InMemoryCapture {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn events(&self) -> Vec<ProxyEvent> {
        self.events.lock().await.iter().cloned().collect()
    }

    pub async fn clear(&self) {
        self.events.lock().await.clear();
    }
}

impl CaptureSink for InMemoryCapture {
    async fn record(&self, event: ProxyEvent) {
        let mut events = self.events.lock().await;
        if events.len() >= MAX_CAPTURE_EVENTS {
            events.pop_front();
        }
        events.push_back(event);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{Direction, Protocol};

    fn event(id: usize) -> ProxyEvent {
        ProxyEvent {
            id: id.to_string(),
            request_id: id.to_string(),
            connection_id: None,
            timestamp_unix_ms: id as u128,
            protocol: Protocol::Http,
            direction: Direction::Request,
            method: Some("GET".to_owned()),
            scheme: Some("http".to_owned()),
            authority: Some("localhost".to_owned()),
            path: Some("/".to_owned()),
            status: None,
            headers: BTreeMap::new(),
            body_len_hint: None,
            body_capture: None,
            websocket_event_kind: None,
            websocket_message_kind: None,
            websocket_error: None,
        }
    }

    #[tokio::test]
    async fn keeps_only_the_latest_events() {
        let capture = InMemoryCapture::new();

        for id in 0..=MAX_CAPTURE_EVENTS {
            capture.record(event(id)).await;
        }

        let events = capture.events().await;
        assert_eq!(events.len(), MAX_CAPTURE_EVENTS);
        assert_eq!(events.first().map(|event| event.id.as_str()), Some("1"));
        assert_eq!(events.last().map(|event| event.id.as_str()), Some("2000"));
    }
}
