use std::{future::Future, sync::Arc};

use tokio::sync::Mutex;

use crate::ProxyEvent;

pub trait CaptureSink: Clone + Send + Sync + 'static {
    fn record(&self, event: ProxyEvent) -> impl Future<Output = ()> + Send;
}

#[derive(Clone, Default)]
pub struct InMemoryCapture {
    events: Arc<Mutex<Vec<ProxyEvent>>>,
}

impl InMemoryCapture {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn events(&self) -> Vec<ProxyEvent> {
        self.events.lock().await.clone()
    }

    pub async fn clear(&self) {
        self.events.lock().await.clear();
    }
}

impl CaptureSink for InMemoryCapture {
    async fn record(&self, event: ProxyEvent) {
        self.events.lock().await.push(event);
    }
}
