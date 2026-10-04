use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use prost_reflect::{DescriptorPool, DynamicMessage, FieldDescriptor, ReflectMessage, Value};
use protobuf_decoder_proxy::{
    generate_proxy_ca, start_proxy_on_default_addr_with_ca, BodyCapture, Direction, Protocol,
    ProxyCa, ProxyEvent, ProxyHandle, WebSocketEventKind, WebSocketMessageKind,
};
use serde::Deserialize;
use serde::Serialize;
use tauri::Manager;

#[derive(Default)]
struct ProxyState {
    handle: Mutex<Option<ProxyHandle>>,
    startup_error: Mutex<Option<String>>,
    ca_status: Mutex<Option<PersistentCaStatus>>,
    proto_schemas: Mutex<Vec<ProtoSchemaBundle>>,
    websocket_mappings: Mutex<Vec<WebSocketProtoMapping>>,
    websocket_mapping_store_path: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
struct ProxyStatus {
    running: bool,
    addr: Option<String>,
    ca_der_len: Option<usize>,
    ca_storage_status: Option<String>,
    ca_cert_path: Option<String>,
    startup_error: Option<String>,
}

#[derive(Serialize)]
struct ProxyEventSummary {
    total: usize,
    http_requests: usize,
    http_responses: usize,
    websocket_messages: usize,
    websocket_active_connections: usize,
    websocket_opened_connections: usize,
    websocket_errors: usize,
    http_exchanges: Vec<HttpExchange>,
    websocket_message_previews: Vec<WebSocketMessagePreview>,
    events: Vec<ProxyEvent>,
}

#[derive(Serialize)]
struct HttpExchange {
    id: String,
    started_at_unix_ms: u128,
    completed_at_unix_ms: Option<u128>,
    duration_ms: Option<u128>,
    method: Option<String>,
    scheme: Option<String>,
    authority: Option<String>,
    path: Option<String>,
    status: Option<u16>,
    server_time: Option<String>,
    request_body_len: Option<u64>,
    response_body_len: Option<u64>,
    payload_hint: PayloadHint,
    payload_decode: PayloadDecode,
    anomalies: Vec<AnomalyFinding>,
}

#[derive(Serialize)]
struct WebSocketMessagePreview {
    id: String,
    connection_id: String,
    timestamp_unix_ms: u128,
    direction: Direction,
    scheme: Option<String>,
    authority: Option<String>,
    path: Option<String>,
    message_kind: Option<WebSocketMessageKind>,
    body_len: Option<u64>,
    payload_hint: PayloadHint,
    payload_decode: PayloadDecode,
}

#[derive(Clone, Deserialize, Serialize)]
struct WebSocketProtoMapping {
    id: String,
    name: String,
    host_match_type: String,
    host_match_value: Option<String>,
    path_prefix: Option<String>,
    direction: Option<String>,
    message_kind: Option<String>,
    message_name: String,
    decode_strategy: String,
    envelope_message_name: Option<String>,
    envelope_items_field: Option<String>,
    envelope_type_field: Option<String>,
    envelope_payload_field: Option<String>,
    envelope_type_map_json: Option<String>,
}

#[derive(Clone)]
struct WebSocketProtoMappingInput {
    name: String,
    host_match_type: String,
    host_match_value: Option<String>,
    path_prefix: Option<String>,
    direction: Option<String>,
    message_kind: Option<String>,
    message_name: String,
    decode_strategy: Option<String>,
    envelope_message_name: Option<String>,
    envelope_items_field: Option<String>,
    envelope_type_field: Option<String>,
    envelope_payload_field: Option<String>,
    envelope_type_map_json: Option<String>,
}

#[derive(Serialize)]
struct PayloadHint {
    request_content_type: Option<String>,
    response_content_type: Option<String>,
    likely_protocol: String,
    decode_status: String,
}

#[derive(Serialize)]
struct PayloadDecode {
    direction: Option<String>,
    status: String,
    schema_message: Option<String>,
    json_previews: Vec<JsonPayloadPreview>,
    fields: Vec<ProtobufFieldPreview>,
}

struct DecodedPayload<'a> {
    direction: &'a Direction,
    bytes: &'a [u8],
    truncated: bool,
    capture_limit: usize,
}

struct ProtoDecoderRegistry<'a> {
    schemas: &'a [ProtoSchemaBundle],
}

impl<'a> ProtoDecoderRegistry<'a> {
    fn new(schemas: &'a [ProtoSchemaBundle]) -> Self {
        Self { schemas }
    }

    fn find_message_for_event(
        &self,
        event: &ProxyEvent,
        message_name: &str,
    ) -> Option<prost_reflect::MessageDescriptor> {
        self.schemas
            .iter()
            .filter(|schema| schema_matches_event(schema, event))
            .find_map(|schema| schema.pool.get_message_by_name(message_name))
            .or_else(|| {
                self.schemas
                    .iter()
                    .find_map(|schema| schema.pool.get_message_by_name(message_name))
            })
    }

    fn find_application_message_for_event(
        &self,
        event: &ProxyEvent,
        message_type: i32,
        payload_version: u32,
    ) -> Result<Option<prost_reflect::MessageDescriptor>, String> {
        let scoped_schemas = self
            .schemas
            .iter()
            .filter(|schema| schema_matches_event(schema, event))
            .collect::<Vec<_>>();
        let candidate_schemas = if scoped_schemas.is_empty() {
            self.schemas.iter().collect::<Vec<_>>()
        } else {
            scoped_schemas
        };

        let mut candidates = candidate_schemas
            .iter()
            .flat_map(|schema| {
                schema
                    .application_message_mappings
                    .get(&(message_type, payload_version))
                    .into_iter()
                    .flat_map(|names| names.iter())
                    .filter_map(|name| schema.pool.get_message_by_name(name))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| left.full_name().cmp(right.full_name()));
        candidates.dedup_by(|left, right| left.full_name() == right.full_name());

        match candidates.as_slice() {
            [] => Ok(None),
            [candidate] => Ok(Some(candidate.clone())),
            candidates => Err(format!(
                "application protobuf message type {message_type} version {payload_version} is ambiguous: {}",
                candidates
                    .iter()
                    .map(|candidate| candidate.full_name())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
}

#[derive(Deserialize)]
struct EnvelopeTypeMapEntry {
    key: String,
    message: String,
}

#[derive(Serialize)]
struct JsonPayloadPreview {
    direction: String,
    status: String,
    preview: Option<String>,
}

#[derive(Serialize)]
struct ProtobufFieldPreview {
    field_number: u32,
    field_name: Option<String>,
    wire_type: u8,
    wire_type_name: String,
    value_preview: String,
    nested_fields: Vec<ProtobufFieldPreview>,
}

#[derive(Serialize)]
struct AnomalyFinding {
    kind: String,
    severity: String,
    summary: String,
}

#[derive(Serialize)]
struct CaCertExport {
    der_path: String,
    pem_path: String,
}

#[derive(Serialize)]
struct CaTrustInstall {
    cert_path: String,
    store: String,
    output: String,
}

#[derive(Clone, Serialize)]
struct ProtoSchemaStatus {
    id: String,
    name: String,
    source_path: String,
    host_match_type: String,
    host_match_value: Option<String>,
    path_prefix: Option<String>,
    file_count: usize,
    message_count: usize,
    service_count: usize,
    application_mapping_count: usize,
    application_mapping_examples: Vec<String>,
    sample_messages: Vec<String>,
    message_names: Vec<String>,
}

struct ProtoSchemaBundle {
    host_match_type: HostMatchType,
    host_match_value: Option<String>,
    path_prefix: Option<String>,
    pool: DescriptorPool,
    application_message_mappings: BTreeMap<(i32, u32), Vec<String>>,
    status: ProtoSchemaStatus,
}

#[derive(Clone, Copy)]
enum HostMatchType {
    Any,
    Exact,
    Suffix,
    Contains,
}

#[derive(Clone, Serialize)]
struct PersistentCaStatus {
    source: String,
    cert_path: String,
}

#[derive(Serialize)]
struct DecodedWebSocketMessageExport {
    format: String,
    generated_unix_ms: u128,
    warnings: Vec<String>,
    preview_id: String,
    connection_id: String,
    timestamp_unix_ms: u128,
    direction: String,
    scheme: Option<String>,
    authority: Option<String>,
    path: Option<String>,
    message_kind: Option<String>,
    body_len: Option<u64>,
    decode: PayloadDecode,
}

#[tauri::command]
fn proxy_status(state: tauri::State<'_, ProxyState>) -> ProxyStatus {
    let handle = state.handle.lock().expect("proxy state should lock");
    let startup_error = state
        .startup_error
        .lock()
        .expect("proxy startup error state should lock")
        .clone();
    let ca_status = state
        .ca_status
        .lock()
        .expect("proxy CA status state should lock")
        .clone();

    ProxyStatus {
        running: handle.is_some(),
        addr: handle.as_ref().map(|handle| handle.addr().to_string()),
        ca_der_len: handle.as_ref().map(|handle| handle.ca_der().len()),
        ca_storage_status: ca_status.as_ref().map(|status| status.source.clone()),
        ca_cert_path: ca_status.map(|status| status.cert_path),
        startup_error,
    }
}

#[tauri::command]
async fn start_proxy_service(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProxyState>,
) -> Result<ProxyStatus, String> {
    let already_running = {
        let handle = state.handle.lock().map_err(|error| error.to_string())?;
        handle.is_some()
    };

    if already_running {
        return Ok(proxy_status(state));
    }

    let (ca, ca_status) = load_or_create_persistent_ca(&app)?;
    let handle = start_proxy_on_default_addr_with_ca(ca)
        .await
        .map_err(|error| error.to_string())?;
    log::info!("Protobuf Decoder proxy started at {}", handle.addr());

    {
        let mut startup_error = state
            .startup_error
            .lock()
            .map_err(|error| error.to_string())?;
        startup_error.take();
    }

    {
        let mut current_ca_status = state.ca_status.lock().map_err(|error| error.to_string())?;
        *current_ca_status = Some(ca_status);
    }

    {
        let mut current = state.handle.lock().map_err(|error| error.to_string())?;
        *current = Some(handle);
    }

    Ok(proxy_status(state))
}

#[tauri::command]
async fn proxy_events(state: tauri::State<'_, ProxyState>) -> Result<ProxyEventSummary, String> {
    let capture = {
        let handle = state.handle.lock().map_err(|error| error.to_string())?;
        handle
            .as_ref()
            .map(|handle| handle.capture())
            .ok_or_else(|| "proxy is not running".to_owned())?
    };
    let events = capture.events().await;
    let mut active_websocket_connections = BTreeSet::new();
    let mut opened_websocket_connections = BTreeSet::new();
    let http_exchanges = {
        let schemas = state
            .proto_schemas
            .lock()
            .map_err(|error| error.to_string())?;
        build_http_exchanges(&events, &schemas)
    };
    let websocket_message_previews = {
        let schemas = state
            .proto_schemas
            .lock()
            .map_err(|error| error.to_string())?;
        let mappings = state
            .websocket_mappings
            .lock()
            .map_err(|error| error.to_string())?;
        build_websocket_message_previews(&events, &schemas, &mappings)
    };

    for event in &events {
        if event.protocol != Protocol::WebSocket {
            continue;
        }

        let Some(connection_id) = &event.connection_id else {
            continue;
        };
        let Some(event_kind) = &event.websocket_event_kind else {
            continue;
        };

        match event_kind {
            WebSocketEventKind::Open => {
                active_websocket_connections.insert(connection_id.clone());
                opened_websocket_connections.insert(connection_id.clone());
            }
            WebSocketEventKind::Close => {
                active_websocket_connections.remove(connection_id);
            }
            WebSocketEventKind::Message | WebSocketEventKind::Error => {}
        }
    }

    Ok(ProxyEventSummary {
        total: events.len(),
        http_requests: events
            .iter()
            .filter(|event| {
                event.protocol == Protocol::Http && event.direction == Direction::Request
            })
            .count(),
        http_responses: events
            .iter()
            .filter(|event| {
                event.protocol == Protocol::Http && event.direction == Direction::Response
            })
            .count(),
        websocket_messages: events
            .iter()
            .filter(|event| {
                event.protocol == Protocol::WebSocket
                    && matches!(
                        event.websocket_event_kind.as_ref(),
                        Some(WebSocketEventKind::Message)
                    )
            })
            .count(),
        websocket_active_connections: active_websocket_connections.len(),
        websocket_opened_connections: opened_websocket_connections.len(),
        websocket_errors: events
            .iter()
            .filter(|event| {
                event.protocol == Protocol::WebSocket
                    && matches!(
                        event.websocket_event_kind.as_ref(),
                        Some(WebSocketEventKind::Error)
                    )
            })
            .count(),
        http_exchanges,
        websocket_message_previews,
        events,
    })
}

#[tauri::command]
async fn export_ca_cert(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProxyState>,
) -> Result<CaCertExport, String> {
    let (ca_der, ca_pem) = {
        let handle = state.handle.lock().map_err(|error| error.to_string())?;
        handle
            .as_ref()
            .map(|handle| (handle.ca_der().to_vec(), handle.ca_pem().to_owned()))
            .ok_or_else(|| "proxy is not running".to_owned())?
    };

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    let der_path = download_dir.join("protobuf-decoder-local-test-ca.cer");
    let pem_path = download_dir.join("protobuf-decoder-local-test-ca.pem");

    fs::write(&der_path, ca_der)
        .map_err(|error| format!("failed to export DER CA certificate: {error}"))?;
    fs::write(&pem_path, ca_pem)
        .map_err(|error| format!("failed to export PEM CA certificate: {error}"))?;

    Ok(CaCertExport {
        der_path: der_path.to_string_lossy().into_owned(),
        pem_path: pem_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn trust_ca_cert_for_current_user(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProxyState>,
) -> Result<CaTrustInstall, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        let _ = state;
        Err("automatic CA trust is currently only available on Windows".to_owned())
    }

    #[cfg(target_os = "windows")]
    {
        let ca_der = {
            let handle = state.handle.lock().map_err(|error| error.to_string())?;
            handle
                .as_ref()
                .map(|handle| handle.ca_der().to_vec())
                .ok_or_else(|| "proxy is not running".to_owned())?
        };

        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&dir)
            .map_err(|error| format!("failed to create CA trust staging directory: {error}"))?;

        let cert_path = dir.join("protobuf-decoder-local-test-ca.cer");
        fs::write(&cert_path, ca_der)
            .map_err(|error| format!("failed to stage CA certificate: {error}"))?;

        let output = Command::new("certutil")
            .args(["-user", "-addstore", "Root"])
            .arg(&cert_path)
            .output()
            .map_err(|error| format!("failed to run certutil: {error}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let command_output = [stdout.trim(), stderr.trim()]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        if !output.status.success() {
            return Err(format!(
                "certutil failed with exit code {:?}: {}",
                output.status.code(),
                command_output
            ));
        }

        Ok(CaTrustInstall {
            cert_path: cert_path.to_string_lossy().into_owned(),
            store: "CurrentUser\\Root".to_owned(),
            output: command_output,
        })
    }
}

#[tauri::command]
async fn clear_proxy_events(state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    let capture = {
        let handle = state.handle.lock().map_err(|error| error.to_string())?;
        handle
            .as_ref()
            .map(|handle| handle.capture())
            .ok_or_else(|| "proxy is not running".to_owned())?
    };

    capture.clear().await;

    Ok(())
}

#[tauri::command]
fn proto_schema_status(state: tauri::State<'_, ProxyState>) -> Option<ProtoSchemaStatus> {
    state
        .proto_schemas
        .lock()
        .expect("proto schema state should lock")
        .last()
        .map(|schema| schema.status.clone())
}

#[tauri::command]
fn proto_schema_bundles(state: tauri::State<'_, ProxyState>) -> Vec<ProtoSchemaStatus> {
    state
        .proto_schemas
        .lock()
        .expect("proto schema state should lock")
        .iter()
        .map(|schema| schema.status.clone())
        .collect()
}

#[tauri::command]
fn websocket_proto_mappings(state: tauri::State<'_, ProxyState>) -> Vec<WebSocketProtoMapping> {
    state
        .websocket_mappings
        .lock()
        .expect("websocket mapping state should lock")
        .clone()
}

#[tauri::command]
fn add_websocket_proto_mapping(
    name: String,
    host_match_type: String,
    host_match_value: Option<String>,
    path_prefix: Option<String>,
    direction: Option<String>,
    message_kind: Option<String>,
    message_name: String,
    decode_strategy: Option<String>,
    envelope_message_name: Option<String>,
    envelope_items_field: Option<String>,
    envelope_type_field: Option<String>,
    envelope_payload_field: Option<String>,
    envelope_type_map_json: Option<String>,
    state: tauri::State<'_, ProxyState>,
) -> Result<WebSocketProtoMapping, String> {
    let input = WebSocketProtoMappingInput {
        name,
        host_match_type,
        host_match_value,
        path_prefix,
        direction,
        message_kind,
        message_name,
        decode_strategy,
        envelope_message_name,
        envelope_items_field,
        envelope_type_field,
        envelope_payload_field,
        envelope_type_map_json,
    };
    let mut mappings = state
        .websocket_mappings
        .lock()
        .map_err(|error| error.to_string())?;
    let id = next_websocket_mapping_id(&mappings);
    let mapping = build_websocket_proto_mapping(id, input, &state)?;
    mappings.push(mapping.clone());
    persist_websocket_mappings(&state, &mappings)?;

    Ok(mapping)
}

#[tauri::command]
fn update_websocket_proto_mapping(
    id: String,
    name: String,
    host_match_type: String,
    host_match_value: Option<String>,
    path_prefix: Option<String>,
    direction: Option<String>,
    message_kind: Option<String>,
    message_name: String,
    decode_strategy: Option<String>,
    envelope_message_name: Option<String>,
    envelope_items_field: Option<String>,
    envelope_type_field: Option<String>,
    envelope_payload_field: Option<String>,
    envelope_type_map_json: Option<String>,
    state: tauri::State<'_, ProxyState>,
) -> Result<WebSocketProtoMapping, String> {
    let input = WebSocketProtoMappingInput {
        name,
        host_match_type,
        host_match_value,
        path_prefix,
        direction,
        message_kind,
        message_name,
        decode_strategy,
        envelope_message_name,
        envelope_items_field,
        envelope_type_field,
        envelope_payload_field,
        envelope_type_map_json,
    };
    let mapping = build_websocket_proto_mapping(id.clone(), input, &state)?;
    let mut mappings = state
        .websocket_mappings
        .lock()
        .map_err(|error| error.to_string())?;
    let existing = mappings
        .iter_mut()
        .find(|mapping| mapping.id == id)
        .ok_or_else(|| format!("WebSocket mapping not found: {id}"))?;
    *existing = mapping.clone();
    persist_websocket_mappings(&state, &mappings)?;

    Ok(mapping)
}

#[tauri::command]
fn delete_websocket_proto_mapping(
    id: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    let mut mappings = state
        .websocket_mappings
        .lock()
        .map_err(|error| error.to_string())?;
    let original_len = mappings.len();
    mappings.retain(|mapping| mapping.id != id);
    if mappings.len() == original_len {
        return Err(format!("WebSocket mapping not found: {id}"));
    }
    persist_websocket_mappings(&state, &mappings)?;

    Ok(())
}

fn build_websocket_proto_mapping(
    id: String,
    input: WebSocketProtoMappingInput,
    state: &tauri::State<'_, ProxyState>,
) -> Result<WebSocketProtoMapping, String> {
    let host_match_type =
        host_match_type_name(parse_host_match_type(&input.host_match_type)?).to_owned();
    let host_match_value = normalize_optional_string(input.host_match_value);
    if host_match_type != "any" && host_match_value.is_none() {
        return Err("enter a host match value or choose Any".to_owned());
    }

    let decode_strategy = normalize_decode_strategy(input.decode_strategy)?;
    let message_name = input.message_name.trim().to_owned();
    let envelope_message_name = normalize_optional_string(input.envelope_message_name);
    let envelope_items_field = normalize_optional_string(input.envelope_items_field);
    let envelope_type_field = normalize_optional_string(input.envelope_type_field);
    let envelope_payload_field = normalize_optional_string(input.envelope_payload_field);
    let envelope_type_map_json = normalize_optional_string(input.envelope_type_map_json);

    if decode_strategy == "direct" && message_name.is_empty() {
        return Err("enter a protobuf message type".to_owned());
    }

    if decode_strategy == "envelope" {
        if envelope_message_name.is_none() {
            return Err("enter an envelope protobuf message type".to_owned());
        }
        if envelope_type_field.is_none() {
            return Err("enter the envelope discriminator field".to_owned());
        }
        if envelope_payload_field.is_none() {
            return Err("enter the envelope payload bytes field".to_owned());
        }
        parse_envelope_type_map(envelope_type_map_json.as_deref())?;
    }

    {
        let schemas = state
            .proto_schemas
            .lock()
            .map_err(|error| error.to_string())?;
        if schemas.is_empty() {
            return Err("load a protobuf descriptor set before adding mappings".to_owned());
        }

        let required_message_names = match decode_strategy.as_str() {
            "direct" => vec![message_name.as_str()],
            "envelope" => vec![envelope_message_name.as_deref().unwrap_or_default()],
            _ => Vec::new(),
        };

        for required_message_name in required_message_names {
            if schemas.iter().all(|schema| {
                schema
                    .pool
                    .get_message_by_name(required_message_name)
                    .is_none()
            }) {
                return Err(format!(
                    "message type not found in loaded descriptor bundles: {required_message_name}"
                ));
            }
        }
    }

    let name = if input.name.trim().is_empty() {
        if decode_strategy == "envelope" {
            short_message_name(envelope_message_name.as_deref().unwrap_or("Envelope")).to_owned()
        } else {
            short_message_name(&message_name).to_owned()
        }
    } else {
        input.name.trim().to_owned()
    };

    Ok(WebSocketProtoMapping {
        id,
        name,
        host_match_type,
        host_match_value,
        path_prefix: normalize_optional_string(input.path_prefix),
        direction: normalize_optional_string(input.direction),
        message_kind: normalize_optional_string(input.message_kind),
        message_name,
        decode_strategy,
        envelope_message_name,
        envelope_items_field,
        envelope_type_field,
        envelope_payload_field,
        envelope_type_map_json,
    })
}

fn next_websocket_mapping_id(mappings: &[WebSocketProtoMapping]) -> String {
    let next_number = mappings
        .iter()
        .filter_map(|mapping| mapping.id.strip_prefix("ws-map-"))
        .filter_map(|suffix| suffix.parse::<usize>().ok())
        .max()
        .unwrap_or(0)
        + 1;

    format!("ws-map-{next_number}")
}

fn persist_websocket_mappings(
    state: &tauri::State<'_, ProxyState>,
    mappings: &[WebSocketProtoMapping],
) -> Result<(), String> {
    let path = state
        .websocket_mapping_store_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "WebSocket mapping store path is not initialized".to_owned())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create WebSocket mapping directory: {error}"))?;
    }

    let json = serde_json::to_string_pretty(mappings)
        .map_err(|error| format!("failed to serialize WebSocket mappings: {error}"))?;
    fs::write(&path, json)
        .map_err(|error| format!("failed to save WebSocket mappings: {error}"))?;

    Ok(())
}

fn load_persisted_websocket_mappings(
    app: &tauri::AppHandle,
) -> Result<Vec<WebSocketProtoMapping>, String> {
    let path = websocket_mapping_store_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let json = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read WebSocket mappings: {error}"))?;
    serde_json::from_str(&json)
        .map_err(|error| format!("failed to parse WebSocket mappings: {error}"))
}

#[tauri::command]
fn load_proto_descriptor_set(
    path: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<ProtoSchemaStatus, String> {
    load_proto_descriptor_bundle(
        "Default schema".to_owned(),
        path,
        "any".to_owned(),
        None,
        None,
        true,
        state,
    )
}

#[tauri::command]
fn load_proto_descriptor_bundle(
    name: String,
    path: String,
    host_match_type: String,
    host_match_value: Option<String>,
    path_prefix: Option<String>,
    replace_unscoped: bool,
    state: tauri::State<'_, ProxyState>,
) -> Result<ProtoSchemaStatus, String> {
    let bytes = fs::read(&path)
        .map_err(|error| format!("failed to read protobuf descriptor set: {error}"))?;
    let pool = DescriptorPool::decode(bytes.as_slice())
        .map_err(|error| format!("failed to parse protobuf descriptor set: {error}"))?;
    let application_message_mappings = application_message_mappings_from_descriptor_set(&bytes)?;
    let host_match_type = parse_host_match_type(&host_match_type)?;
    let host_match_value = normalize_optional_string(host_match_value);
    if !matches!(host_match_type, HostMatchType::Any) && host_match_value.is_none() {
        return Err("enter a host match value or choose Any".to_owned());
    }
    let path_prefix = normalize_optional_string(path_prefix);
    let name = if name.trim().is_empty() {
        "Unnamed schema".to_owned()
    } else {
        name.trim().to_owned()
    };

    let mut schemas = state
        .proto_schemas
        .lock()
        .map_err(|error| error.to_string())?;
    if replace_unscoped {
        schemas.clear();
    }

    let id = format!("schema-{}", schemas.len() + 1);
    let mut status = proto_schema_status_from_pool(
        id.clone(),
        name.clone(),
        &path,
        host_match_type,
        host_match_value.clone(),
        path_prefix.clone(),
        &pool,
    );
    status.application_mapping_count = application_message_mappings.len();
    status.application_mapping_examples =
        application_message_mapping_examples(&application_message_mappings);
    schemas.push(ProtoSchemaBundle {
        host_match_type,
        host_match_value,
        path_prefix,
        pool,
        application_message_mappings,
        status: status.clone(),
    });

    Ok(status)
}

#[derive(Debug)]
enum DescriptorWireValue {
    Varint(u64),
    Bytes(Vec<u8>),
}

fn application_message_mappings_from_descriptor_set(
    bytes: &[u8],
) -> Result<BTreeMap<(i32, u32), Vec<String>>, String> {
    let mut mappings = BTreeMap::<(i32, u32), Vec<String>>::new();

    for (field_number, value) in descriptor_wire_fields(bytes)? {
        if field_number != 1 {
            continue;
        }
        let DescriptorWireValue::Bytes(file_bytes) = value else {
            continue;
        };

        let file_fields = descriptor_wire_fields(&file_bytes)?;
        let package = file_fields
            .iter()
            .find_map(|(field_number, value)| {
                (*field_number == 2).then(|| match value {
                    DescriptorWireValue::Bytes(bytes) => String::from_utf8(bytes.clone()).ok(),
                    DescriptorWireValue::Varint(_) => None,
                })
            })
            .flatten()
            .unwrap_or_default();
        let ordinal = file_fields.iter().find_map(|(field_number, value)| {
            if *field_number != 8 {
                return None;
            }
            let DescriptorWireValue::Bytes(options) = value else {
                return None;
            };
            descriptor_wire_fields(options).ok()?.into_iter().find_map(
                |(option_field_number, option_value)| {
                    if option_field_number != 50009 {
                        return None;
                    }
                    let DescriptorWireValue::Varint(raw) = option_value else {
                        return None;
                    };
                    let decoded = ((raw >> 1) as i64) ^ (-((raw & 1) as i64));
                    i32::try_from(decoded).ok()
                },
            )
        });

        let Some(ordinal) = ordinal else {
            continue;
        };

        for (field_number, value) in file_fields {
            if field_number != 4 {
                continue;
            }
            let DescriptorWireValue::Bytes(message_bytes) = value else {
                continue;
            };
            let Some(name) = descriptor_wire_fields(&message_bytes)?
                .into_iter()
                .find_map(|(message_field_number, message_value)| {
                    (message_field_number == 1).then(|| match message_value {
                        DescriptorWireValue::Bytes(bytes) => String::from_utf8(bytes).ok(),
                        DescriptorWireValue::Varint(_) => None,
                    })
                })
                .flatten()
            else {
                continue;
            };

            let full_name = if package.is_empty() {
                name.clone()
            } else {
                format!("{package}.{name}")
            };
            mappings
                .entry((ordinal, application_message_version(&name)))
                .or_default()
                .push(full_name);
        }
    }

    for names in mappings.values_mut() {
        names.sort();
        names.dedup();
    }

    Ok(mappings)
}

fn descriptor_wire_fields(mut bytes: &[u8]) -> Result<Vec<(u32, DescriptorWireValue)>, String> {
    let mut fields = Vec::new();

    while !bytes.is_empty() {
        let (key, rest) = read_varint(bytes)?;
        bytes = rest;
        let field_number = u32::try_from(key >> 3)
            .map_err(|_| "descriptor field number is too large".to_owned())?;
        if field_number == 0 {
            return Err("descriptor field number cannot be zero".to_owned());
        }

        match (key & 7) as u8 {
            0 => {
                let (value, rest) = read_varint(bytes)?;
                fields.push((field_number, DescriptorWireValue::Varint(value)));
                bytes = rest;
            }
            1 => {
                if bytes.len() < 8 {
                    return Err("truncated fixed64 descriptor field".to_owned());
                }
                bytes = &bytes[8..];
            }
            2 => {
                let (length, rest) = read_varint(bytes)?;
                let length = usize::try_from(length)
                    .map_err(|_| "descriptor field length is too large".to_owned())?;
                if rest.len() < length {
                    return Err("truncated length-delimited descriptor field".to_owned());
                }
                fields.push((
                    field_number,
                    DescriptorWireValue::Bytes(rest[..length].to_vec()),
                ));
                bytes = &rest[length..];
            }
            5 => {
                if bytes.len() < 4 {
                    return Err("truncated fixed32 descriptor field".to_owned());
                }
                bytes = &bytes[4..];
            }
            wire_type => {
                return Err(format!("unsupported descriptor wire type {wire_type}"));
            }
        }
    }

    Ok(fields)
}

fn application_message_version(name: &str) -> u32 {
    let Some(name) = name.strip_suffix("Proto") else {
        return 1;
    };
    let Some(version_start) = name.rfind('V') else {
        return 1;
    };
    let version = &name[version_start + 1..];
    if version.is_empty() || !version.chars().all(|character| character.is_ascii_digit()) {
        return 1;
    }
    version.parse().unwrap_or(1)
}

#[tauri::command]
async fn decode_websocket_message_as_proto(
    preview_id: String,
    message_name: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<PayloadDecode, String> {
    decode_websocket_message_payload(&preview_id, &message_name, &state)
        .await
        .map(|decoded| decoded.decode)
}

#[tauri::command]
async fn export_decoded_websocket_message(
    preview_id: String,
    message_name: String,
    path: String,
    state: tauri::State<'_, ProxyState>,
) -> Result<String, String> {
    let output_path = PathBuf::from(path.trim());

    if output_path.as_os_str().is_empty() {
        return Err("enter an output path for the decoded message export".to_owned());
    }

    let mut decoded = decode_websocket_message_payload(&preview_id, &message_name, &state).await?;
    decoded.warnings = vec![
        "This export can contain real hostnames, paths, proto field names, and decoded values."
            .to_owned(),
        "Review data handling policy before moving this file off-network.".to_owned(),
    ];
    let json = serde_json::to_string_pretty(&decoded)
        .map_err(|error| format!("failed to serialize decoded message export: {error}"))?;

    if let Some(parent) = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| {
            format!("failed to create decoded export output directory: {error}")
        })?;
    }

    fs::write(&output_path, json)
        .map_err(|error| format!("failed to write decoded message export: {error}"))?;

    Ok(output_path.to_string_lossy().into_owned())
}

async fn decode_websocket_message_payload(
    preview_id: &str,
    message_name: &str,
    state: &tauri::State<'_, ProxyState>,
) -> Result<DecodedWebSocketMessageExport, String> {
    let capture = {
        let handle = state.handle.lock().map_err(|error| error.to_string())?;
        handle
            .as_ref()
            .map(|handle| handle.capture())
            .ok_or_else(|| "proxy is not running".to_owned())?
    };
    let events = capture.events().await;
    let event = events
        .iter()
        .find(|event| {
            event.id == preview_id
                && event.protocol == Protocol::WebSocket
                && matches!(
                    event.websocket_event_kind.as_ref(),
                    Some(WebSocketEventKind::Message)
                )
        })
        .ok_or_else(|| "WebSocket message frame was not found in the current capture".to_owned())?;
    let body_capture = event
        .body_capture
        .as_ref()
        .ok_or_else(|| "selected WebSocket frame has no captured payload sample".to_owned())?;

    if body_capture.bytes.is_empty() {
        return Err("selected WebSocket frame payload is empty".to_owned());
    }

    let message_descriptor = {
        let schemas = state
            .proto_schemas
            .lock()
            .map_err(|error| error.to_string())?;
        if schemas.is_empty() {
            return Err("load a protobuf descriptor set before schema-aware decoding".to_owned());
        }

        ProtoDecoderRegistry::new(&schemas)
            .find_message_for_event(event, message_name)
            .ok_or_else(|| {
                format!("message type not found in loaded descriptor bundles: {message_name}")
            })?
    };

    let payload = DecodedPayload {
        direction: &event.direction,
        bytes: &body_capture.bytes,
        truncated: body_capture.truncated,
        capture_limit: body_capture.capture_limit,
    };

    decode_payload_as_message(&payload, message_descriptor, None).map(|decode| {
        DecodedWebSocketMessageExport {
            format: "protobuf-decoder-decoded-websocket-message-v1".to_owned(),
            generated_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
            warnings: Vec::new(),
            preview_id: event.id.clone(),
            connection_id: event.connection_id.clone().unwrap_or_default(),
            timestamp_unix_ms: event.timestamp_unix_ms,
            direction: direction_name(&event.direction).to_owned(),
            scheme: event.scheme.clone(),
            authority: event.authority.clone(),
            path: event.path.clone(),
            message_kind: event
                .websocket_message_kind
                .as_ref()
                .map(|kind| format!("{kind:?}")),
            body_len: event.body_len_hint,
            decode,
        }
    })
}

fn build_http_exchanges(events: &[ProxyEvent], schemas: &[ProtoSchemaBundle]) -> Vec<HttpExchange> {
    let mut exchanges = BTreeMap::<String, HttpExchangeBuilder>::new();

    for event in events {
        if event.protocol != Protocol::Http {
            continue;
        }

        let exchange = exchanges
            .entry(event.request_id.clone())
            .or_insert_with(|| HttpExchangeBuilder::new(event.request_id.clone()));

        match event.direction {
            Direction::Request => exchange.request = Some(event.clone()),
            Direction::Response => exchange.response = Some(event.clone()),
            Direction::Internal => {}
        }
    }

    let mut exchanges = exchanges
        .into_values()
        .filter_map(|exchange| exchange.build(schemas))
        .collect::<Vec<_>>();

    exchanges.sort_by_key(|exchange| exchange.started_at_unix_ms);
    exchanges
}

fn build_websocket_message_previews(
    events: &[ProxyEvent],
    schemas: &[ProtoSchemaBundle],
    mappings: &[WebSocketProtoMapping],
) -> Vec<WebSocketMessagePreview> {
    events
        .iter()
        .filter(|event| {
            event.protocol == Protocol::WebSocket
                && matches!(
                    event.websocket_event_kind.as_ref(),
                    Some(WebSocketEventKind::Message)
                )
        })
        .map(|event| {
            let mut payload_hint = detect_websocket_payload_hint(event);
            refine_payload_hint_from_body(&mut payload_hint, event.body_capture.as_ref(), None);
            let payload_decode =
                decode_websocket_payload_preview(event, &payload_hint, schemas, mappings);

            WebSocketMessagePreview {
                id: event.id.clone(),
                connection_id: event.connection_id.clone().unwrap_or_default(),
                timestamp_unix_ms: event.timestamp_unix_ms,
                direction: event.direction.clone(),
                scheme: event.scheme.clone(),
                authority: event.authority.clone(),
                path: event.path.clone(),
                message_kind: event.websocket_message_kind.clone(),
                body_len: event.body_len_hint,
                payload_hint,
                payload_decode,
            }
        })
        .collect()
}

fn decode_websocket_payload_preview(
    event: &ProxyEvent,
    payload_hint: &PayloadHint,
    schemas: &[ProtoSchemaBundle],
    mappings: &[WebSocketProtoMapping],
) -> PayloadDecode {
    if let Some(mapped_decode) = decode_websocket_payload_with_mapping(event, schemas, mappings) {
        return mapped_decode;
    }

    match event.direction {
        Direction::Request => decode_payload_preview(
            payload_hint,
            event.body_capture.as_ref(),
            None,
            event,
            schemas,
        ),
        Direction::Response | Direction::Internal => decode_payload_preview(
            payload_hint,
            None,
            event.body_capture.as_ref(),
            event,
            schemas,
        ),
    }
}

fn decode_websocket_payload_with_mapping(
    event: &ProxyEvent,
    schemas: &[ProtoSchemaBundle],
    mappings: &[WebSocketProtoMapping],
) -> Option<PayloadDecode> {
    if schemas.is_empty() || mappings.is_empty() {
        return None;
    }

    let matching_mappings = mappings
        .iter()
        .filter(|mapping| websocket_mapping_matches_event(mapping, event))
        .collect::<Vec<_>>();

    if matching_mappings.is_empty() {
        return None;
    }

    if matching_mappings.len() > 1 {
        return Some(PayloadDecode {
            direction: Some(direction_name(&event.direction).to_owned()),
            status: format!(
                "Ambiguous protobuf mapping: {} rules match this frame.",
                matching_mappings.len()
            ),
            schema_message: None,
            json_previews: Vec::new(),
            fields: Vec::new(),
        });
    }

    let mapping = matching_mappings[0];
    let body_capture = match event.body_capture.as_ref() {
        Some(capture) if !capture.bytes.is_empty() => capture,
        Some(_) => {
            return Some(PayloadDecode {
                direction: Some(direction_name(&event.direction).to_owned()),
                status: "Matched protobuf mapping, but selected frame payload is empty.".to_owned(),
                schema_message: Some(mapping.message_name.clone()),
                json_previews: Vec::new(),
                fields: Vec::new(),
            });
        }
        None => {
            return Some(PayloadDecode {
                direction: Some(direction_name(&event.direction).to_owned()),
                status: "Matched protobuf mapping, but no payload sample was captured.".to_owned(),
                schema_message: Some(mapping.message_name.clone()),
                json_previews: Vec::new(),
                fields: Vec::new(),
            });
        }
    };

    let payload = DecodedPayload {
        direction: &event.direction,
        bytes: &body_capture.bytes,
        truncated: body_capture.truncated,
        capture_limit: body_capture.capture_limit,
    };
    let registry = ProtoDecoderRegistry::new(schemas);

    let decoded = if mapping.decode_strategy == "envelope" {
        decode_payload_with_envelope_mapping(&payload, event, &registry, mapping)
    } else {
        let Some(message_descriptor) =
            registry.find_message_for_event(event, &mapping.message_name)
        else {
            return Some(PayloadDecode {
                direction: Some(direction_name(&event.direction).to_owned()),
                status: format!(
                    "Matched protobuf mapping {}, but message type is not loaded.",
                    mapping.name
                ),
                schema_message: Some(mapping.message_name.clone()),
                json_previews: Vec::new(),
                fields: Vec::new(),
            });
        };

        decode_payload_as_message(&payload, message_descriptor, Some(&mapping.name))
    };

    Some(decoded.unwrap_or_else(|error| {
        PayloadDecode {
            direction: Some(direction_name(&event.direction).to_owned()),
            status: error,
            schema_message: mapping
                .envelope_message_name
                .clone()
                .or_else(|| Some(mapping.message_name.clone())),
            json_previews: Vec::new(),
            fields: Vec::new(),
        }
    }))
}

const APPLICATION_PACKET_MESSAGE: &str = "com.cmcmarkets.iphone.transport.protos.iPhonePacketProto";

fn decode_application_packet_payload(
    bytes: &[u8],
    event: &ProxyEvent,
    schemas: &[ProtoSchemaBundle],
    truncated: bool,
    capture_limit: usize,
) -> Option<PayloadDecode> {
    let registry = ProtoDecoderRegistry::new(schemas);
    let envelope_descriptor = registry.find_message_for_event(event, APPLICATION_PACKET_MESSAGE)?;
    let envelope = match DynamicMessage::decode(envelope_descriptor.clone(), bytes) {
        Ok(envelope) => envelope,
        Err(_) => return None,
    };
    let Some(items_value) = envelope.get_field_by_name("messageList") else {
        return None;
    };
    let items = match items_value.as_ref() {
        Value::List(items) => items,
        _ => {
            return Some(PayloadDecode {
                direction: Some(direction_name(&event.direction).to_owned()),
                status: "Application protobuf packet has a non-repeated messageList field."
                    .to_owned(),
                schema_message: Some(envelope_descriptor.full_name().to_owned()),
                json_previews: Vec::new(),
                fields: dynamic_message_fields(&envelope),
            })
        }
    };

    let mut fields = dynamic_message_fields(&envelope);
    let mut decoded_count = 0usize;
    let mut unknown_count = 0usize;
    let mut details = Vec::new();
    let mut decoded_message_names = Vec::new();

    for (index, item_value) in items.iter().enumerate() {
        let Value::Message(item) = item_value else {
            unknown_count += 1;
            details.push(format!("messageList[{index}] is not a message"));
            continue;
        };

        let message_type = item
            .get_field_by_name("messageType")
            .and_then(|value| integer_value(value.as_ref()))
            .map(|value| value as i32);
        let payload_version = item
            .get_field_by_name("messagePayloadVersion")
            .and_then(|value| integer_value(value.as_ref()))
            .map(|value| value.max(1) as u32)
            .unwrap_or(1);
        let payload = item
            .get_field_by_name("payload")
            .and_then(|value| match value.as_ref() {
                Value::Bytes(bytes) => Some(bytes.to_vec()),
                _ => None,
            });

        let Some(message_type) = message_type else {
            unknown_count += 1;
            details.push(format!("messageList[{index}] has no messageType"));
            continue;
        };
        let Some(payload) = payload else {
            unknown_count += 1;
            details.push(format!("messageList[{index}] has no bytes payload"));
            continue;
        };

        let descriptor =
            match registry.find_application_message_for_event(event, message_type, payload_version)
            {
                Ok(descriptor) => descriptor,
                Err(error) => {
                    unknown_count += 1;
                    details.push(format!("messageList[{index}]: {error}"));
                    continue;
                }
            };

        let Some(descriptor) = descriptor else {
            unknown_count += 1;
            details.push(format!(
                "messageList[{index}] has no descriptor for type {message_type} version {payload_version}"
            ));
            continue;
        };

        match DynamicMessage::decode(descriptor.clone(), payload.as_slice()) {
            Ok(message) => {
                fields.push(ProtobufFieldPreview {
                    field_number: item
                        .descriptor()
                        .get_field_by_name("payload")
                        .map(|field| field.number())
                        .unwrap_or_default(),
                    field_name: Some(format!(
                        "messageList[{index}].payload ({})",
                        descriptor.full_name()
                    )),
                    wire_type: 2,
                    wire_type_name: "application-message-payload".to_owned(),
                    value_preview: format!(
                        "type {message_type}, version {payload_version}, {} bytes",
                        payload.len()
                    ),
                    nested_fields: dynamic_message_fields(&message),
                });
                decoded_message_names.push(descriptor.full_name().to_owned());
                decoded_count += 1;
            }
            Err(error) => {
                unknown_count += 1;
                details.push(format!(
                    "messageList[{index}] failed to decode type {message_type} version {payload_version} as {}: {error}",
                    descriptor.full_name()
                ));
            }
        }
    }

    let mut status = format!(
        "Decoded application packet {} with {decoded_count}/{} nested message(s).",
        envelope_descriptor.full_name(),
        items.len()
    );
    if unknown_count > 0 {
        status.push_str(&format!(
            " {unknown_count} nested message(s) were not decoded."
        ));
    }
    if !details.is_empty() {
        status.push_str(" ");
        status.push_str(&details.join("; "));
    }
    if truncated {
        status.push_str(&format!(
            " Payload sample was truncated at {capture_limit} bytes."
        ));
    }

    Some(PayloadDecode {
        direction: Some(direction_name(&event.direction).to_owned()),
        status,
        schema_message: if decoded_message_names.len() == 1 {
            decoded_message_names.into_iter().next()
        } else {
            Some(envelope_descriptor.full_name().to_owned())
        },
        json_previews: Vec::new(),
        fields,
    })
}

fn integer_value(value: &Value) -> Option<i64> {
    match value {
        Value::I32(value) => Some(i64::from(*value)),
        Value::I64(value) => Some(*value),
        Value::U32(value) => Some(i64::from(*value)),
        Value::U64(value) => i64::try_from(*value).ok(),
        Value::EnumNumber(value) => Some(i64::from(*value)),
        _ => None,
    }
}

fn decode_payload_as_message(
    payload: &DecodedPayload<'_>,
    message_descriptor: prost_reflect::MessageDescriptor,
    mapping_name: Option<&str>,
) -> Result<PayloadDecode, String> {
    let message = DynamicMessage::decode(message_descriptor.clone(), payload.bytes)
        .map_err(|error| format!("schema-aware protobuf decode failed: {error}"))?;
    let fields = dynamic_message_fields(&message);
    let status_prefix = mapping_name
        .map(|name| format!("Decoded by mapping {name}: "))
        .unwrap_or_default();
    let status = if payload.truncated {
        format!(
            "{}Decoded {} from first {} bytes; payload sample was truncated.",
            status_prefix,
            message_descriptor.full_name(),
            payload.capture_limit
        )
    } else {
        format!(
            "{}Decoded {} with loaded descriptor set.",
            status_prefix,
            message_descriptor.full_name()
        )
    };

    Ok(PayloadDecode {
        direction: Some(direction_name(payload.direction).to_owned()),
        status,
        schema_message: Some(message_descriptor.full_name().to_owned()),
        json_previews: Vec::new(),
        fields,
    })
}

fn decode_payload_with_envelope_mapping(
    payload: &DecodedPayload<'_>,
    event: &ProxyEvent,
    registry: &ProtoDecoderRegistry<'_>,
    mapping: &WebSocketProtoMapping,
) -> Result<PayloadDecode, String> {
    let envelope_message_name = mapping
        .envelope_message_name
        .as_deref()
        .ok_or_else(|| "matched envelope mapping is missing an envelope message type".to_owned())?;
    let envelope_descriptor = registry
        .find_message_for_event(event, envelope_message_name)
        .ok_or_else(|| {
            format!(
                "matched envelope mapping {}, but envelope message type is not loaded.",
                mapping.name
            )
        })?;
    let envelope = DynamicMessage::decode(envelope_descriptor.clone(), payload.bytes)
        .map_err(|error| format!("envelope protobuf decode failed: {error}"))?;
    let mut fields = dynamic_message_fields(&envelope);
    let type_map = parse_envelope_type_map(mapping.envelope_type_map_json.as_deref())?;
    let envelope_items = envelope_items(&envelope, mapping.envelope_items_field.as_deref())?;
    let mut decoded_nested_count = 0usize;
    let mut missing_mapping_count = 0usize;

    for (index, item) in envelope_items.iter().enumerate() {
        let type_key = envelope_item_type_key(item, mapping.envelope_type_field.as_deref())?;
        let Some(nested_message_name) = type_map.get(&type_key) else {
            missing_mapping_count += 1;
            continue;
        };
        let payload_bytes = envelope_item_payload(item, mapping.envelope_payload_field.as_deref())?;
        let nested_descriptor = registry
            .find_message_for_event(event, nested_message_name)
            .ok_or_else(|| {
                format!("envelope nested message type is not loaded: {nested_message_name}")
            })?;
        let nested_message =
            DynamicMessage::decode(nested_descriptor.clone(), payload_bytes.as_slice()).map_err(
                |error| {
                    format!(
                        "envelope nested payload decode failed for key {type_key} as {}: {error}",
                        nested_descriptor.full_name()
                    )
                },
            )?;
        let payload_field_number = item
            .descriptor()
            .get_field_by_name(
                mapping
                    .envelope_payload_field
                    .as_deref()
                    .unwrap_or_default(),
            )
            .map(|field| field.number())
            .unwrap_or_default();

        fields.push(ProtobufFieldPreview {
            field_number: payload_field_number,
            field_name: Some(format!(
                "decoded_payload[{index}] {}",
                nested_descriptor.full_name()
            )),
            wire_type: 2,
            wire_type_name: "envelope-dispatch".to_owned(),
            value_preview: format!(
                "key {type_key}; {} bytes decoded as {}",
                payload_bytes.len(),
                nested_descriptor.full_name()
            ),
            nested_fields: dynamic_message_fields(&nested_message),
        });
        decoded_nested_count += 1;
    }

    let mut status = format!(
        "Decoded envelope {} with {} nested payload(s) via mapping {}.",
        envelope_descriptor.full_name(),
        decoded_nested_count,
        mapping.name
    );
    if missing_mapping_count > 0 {
        status.push_str(&format!(
            " {missing_mapping_count} nested payload(s) had no discriminator mapping."
        ));
    }
    if payload.truncated {
        status.push_str(&format!(
            " Payload sample was truncated at {} bytes.",
            payload.capture_limit
        ));
    }

    Ok(PayloadDecode {
        direction: Some(direction_name(payload.direction).to_owned()),
        status,
        schema_message: Some(envelope_descriptor.full_name().to_owned()),
        json_previews: Vec::new(),
        fields,
    })
}

fn envelope_items(
    envelope: &DynamicMessage,
    items_field_name: Option<&str>,
) -> Result<Vec<DynamicMessage>, String> {
    let Some(items_field_name) = items_field_name else {
        return Ok(vec![envelope.clone()]);
    };
    if envelope
        .descriptor()
        .get_field_by_name(items_field_name)
        .is_none()
    {
        return Err(format!("envelope field not found: {items_field_name}"));
    }
    let value = envelope
        .get_field_by_name(items_field_name)
        .ok_or_else(|| format!("envelope field not found: {items_field_name}"))?;

    match value.as_ref() {
        Value::List(values) => values
            .iter()
            .map(|value| match value {
                Value::Message(message) => Ok(message.clone()),
                _ => Err(format!(
                    "envelope items field {items_field_name} must contain messages"
                )),
            })
            .collect(),
        Value::Message(message) => Ok(vec![message.clone()]),
        _ => Err(format!(
            "envelope items field {items_field_name} must be a message or repeated message"
        )),
    }
}

fn envelope_item_type_key(
    item: &DynamicMessage,
    type_field_name: Option<&str>,
) -> Result<String, String> {
    let type_field_name = type_field_name
        .ok_or_else(|| "envelope mapping is missing a discriminator field".to_owned())?;
    let value = item
        .get_field_by_name(type_field_name)
        .ok_or_else(|| format!("envelope discriminator field not found: {type_field_name}"))?;

    envelope_discriminator_key(value.as_ref()).ok_or_else(|| {
        format!("envelope discriminator field {type_field_name} must be scalar or enum")
    })
}

fn envelope_item_payload(
    item: &DynamicMessage,
    payload_field_name: Option<&str>,
) -> Result<Vec<u8>, String> {
    let payload_field_name = payload_field_name
        .ok_or_else(|| "envelope mapping is missing a payload field".to_owned())?;
    let value = item
        .get_field_by_name(payload_field_name)
        .ok_or_else(|| format!("envelope payload field not found: {payload_field_name}"))?;

    match value.as_ref() {
        Value::Bytes(bytes) => Ok(bytes.to_vec()),
        _ => Err(format!(
            "envelope payload field {payload_field_name} must be bytes"
        )),
    }
}

fn envelope_discriminator_key(value: &Value) -> Option<String> {
    match value {
        Value::Bool(value) => Some(value.to_string()),
        Value::I32(value) => Some(value.to_string()),
        Value::I64(value) => Some(value.to_string()),
        Value::U32(value) => Some(value.to_string()),
        Value::U64(value) => Some(value.to_string()),
        Value::String(value) => Some(value.clone()),
        Value::EnumNumber(value) => Some(value.to_string()),
        _ => None,
    }
}

struct HttpExchangeBuilder {
    id: String,
    request: Option<ProxyEvent>,
    response: Option<ProxyEvent>,
}

impl HttpExchangeBuilder {
    fn new(id: String) -> Self {
        Self {
            id,
            request: None,
            response: None,
        }
    }

    fn build(self, schemas: &[ProtoSchemaBundle]) -> Option<HttpExchange> {
        let request = self.request?;
        let response = self.response;
        let completed_at_unix_ms = response.as_ref().map(|event| event.timestamp_unix_ms);
        let duration_ms = completed_at_unix_ms
            .map(|completed_at| completed_at.saturating_sub(request.timestamp_unix_ms));
        let status = response.as_ref().and_then(|event| event.status);
        let server_time = response
            .as_ref()
            .and_then(|event| header_value(event, "date"))
            .or_else(|| {
                response
                    .as_ref()
                    .and_then(|event| header_value(event, "server-time"))
            })
            .or_else(|| {
                response
                    .as_ref()
                    .and_then(|event| header_value(event, "x-server-time"))
            });
        let response_body_len = response.as_ref().and_then(|event| event.body_len_hint);
        let request_content_type = header_value(&request, "content-type");
        let response_content_type = response
            .as_ref()
            .and_then(|event| header_value(event, "content-type"));
        let mut payload_hint = detect_payload_hint(
            request_content_type.clone(),
            response_content_type.clone(),
            &request.path,
            status,
        );
        refine_payload_hint_from_body(
            &mut payload_hint,
            request.body_capture.as_ref(),
            response
                .as_ref()
                .and_then(|event| event.body_capture.as_ref()),
        );
        let payload_decode = decode_payload_preview(
            &payload_hint,
            request.body_capture.as_ref(),
            response
                .as_ref()
                .and_then(|event| event.body_capture.as_ref()),
            response.as_ref().unwrap_or(&request),
            schemas,
        );
        let anomalies = detect_http_anomalies(
            status,
            duration_ms,
            response_body_len,
            &payload_hint,
            &payload_decode,
        );

        Some(HttpExchange {
            id: self.id,
            started_at_unix_ms: request.timestamp_unix_ms,
            completed_at_unix_ms,
            duration_ms,
            method: request.method,
            scheme: request.scheme,
            authority: request.authority,
            path: request.path,
            status,
            server_time,
            request_body_len: request.body_len_hint,
            response_body_len,
            payload_hint,
            payload_decode,
            anomalies,
        })
    }
}

fn header_value(event: &ProxyEvent, name: &str) -> Option<String> {
    event
        .headers
        .iter()
        .find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

fn detect_payload_hint(
    request_content_type: Option<String>,
    response_content_type: Option<String>,
    path: &Option<String>,
    status: Option<u16>,
) -> PayloadHint {
    let combined = [
        request_content_type.as_deref().unwrap_or_default(),
        response_content_type.as_deref().unwrap_or_default(),
        path.as_deref().unwrap_or_default(),
    ]
    .join(" ")
    .to_ascii_lowercase();

    let likely_protocol = if combined.contains("application/grpc") || combined.contains("grpc") {
        "grpc"
    } else if combined.contains("protobuf") || combined.contains("x-protobuf") {
        "protobuf"
    } else if combined.contains("application/json") || combined.contains("+json") {
        "json"
    } else if combined.contains("text/") {
        "text"
    } else {
        "unknown"
    }
    .to_owned();

    let decode_status = if let Some(error_status) = status.filter(|status| *status >= 400) {
        format!("Not decoded because response returned HTTP {error_status}")
    } else {
        match likely_protocol.as_str() {
            "grpc" => "gRPC/protobuf likely; decoder not configured".to_owned(),
            "protobuf" => "Protobuf likely; decoder not configured".to_owned(),
            "json" => "JSON detected; waiting for captured body".to_owned(),
            "text" => "Text payload detected; body capture not enabled".to_owned(),
            _ => "No payload decoder selected".to_owned(),
        }
    };

    PayloadHint {
        request_content_type,
        response_content_type,
        likely_protocol,
        decode_status,
    }
}

fn detect_websocket_payload_hint(event: &ProxyEvent) -> PayloadHint {
    let message_kind = event
        .websocket_message_kind
        .as_ref()
        .map(|kind| format!("{kind:?}").to_ascii_lowercase())
        .unwrap_or_default();
    let path = event
        .path
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();

    let likely_protocol = if path.contains("protobuf") || path.contains("proto") {
        "protobuf"
    } else if matches!(
        event.websocket_message_kind.as_ref(),
        Some(WebSocketMessageKind::Text)
    ) && event
        .body_capture
        .as_ref()
        .is_some_and(|capture| looks_like_json(&capture.bytes))
    {
        "json"
    } else if matches!(
        event.websocket_message_kind.as_ref(),
        Some(WebSocketMessageKind::Binary)
    ) {
        "unknown"
    } else if message_kind == "text" {
        "text"
    } else {
        "unknown"
    }
    .to_owned();

    let decode_status = match likely_protocol.as_str() {
        "protobuf" => "WebSocket protobuf likely; decoder not configured".to_owned(),
        "json" => "WebSocket JSON detected; waiting for captured body".to_owned(),
        "text" => "WebSocket text detected.".to_owned(),
        _ => "No WebSocket payload decoder selected".to_owned(),
    };

    PayloadHint {
        request_content_type: None,
        response_content_type: None,
        likely_protocol,
        decode_status,
    }
}

fn refine_payload_hint_from_body(
    payload_hint: &mut PayloadHint,
    request_capture: Option<&BodyCapture>,
    response_capture: Option<&BodyCapture>,
) {
    if payload_hint.likely_protocol != "unknown" {
        return;
    }

    let Some(capture) = response_capture.or(request_capture) else {
        return;
    };

    if capture.bytes.len() < 2 || looks_like_text(&capture.bytes) {
        return;
    }

    if protobuf_wire_preview(&capture.bytes, 8).is_ok_and(|fields| !fields.is_empty()) {
        payload_hint.likely_protocol = "protobuf".to_owned();
        payload_hint.decode_status =
            "Protobuf wire structure detected; schemas are required for field names.".to_owned();
    }
}

fn decode_payload_preview(
    payload_hint: &PayloadHint,
    request_capture: Option<&BodyCapture>,
    response_capture: Option<&BodyCapture>,
    event: &ProxyEvent,
    schemas: &[ProtoSchemaBundle],
) -> PayloadDecode {
    let (direction, capture) = response_capture
        .map(|capture| ("response".to_owned(), capture))
        .or_else(|| request_capture.map(|capture| ("request".to_owned(), capture)))
        .map_or((None, None), |(direction, capture)| {
            (Some(direction), Some(capture))
        });

    let Some(capture) = capture else {
        if payload_hint.likely_protocol == "json" {
            return decode_json_preview(request_capture, response_capture);
        }

        return PayloadDecode {
            direction,
            status: if matches!(payload_hint.likely_protocol.as_str(), "protobuf" | "grpc") {
                "Protobuf likely, but body sample was not captured because it was too large or streamed with unknown length.".to_owned()
            } else {
                payload_hint.decode_status.clone()
            },
            schema_message: None,
            json_previews: Vec::new(),
            fields: Vec::new(),
        };
    };

    if capture.bytes.is_empty() {
        return PayloadDecode {
            direction,
            status: if matches!(payload_hint.likely_protocol.as_str(), "protobuf" | "grpc") {
                "Protobuf likely, but captured body was empty.".to_owned()
            } else {
                payload_hint.decode_status.clone()
            },
            schema_message: None,
            json_previews: Vec::new(),
            fields: Vec::new(),
        };
    }

    if payload_hint.likely_protocol == "json" {
        return decode_json_preview(request_capture, response_capture);
    }

    let decode_input = if payload_hint.likely_protocol == "grpc" {
        match grpc_message_payload(&capture.bytes) {
            Ok(payload) => payload,
            Err(status) => {
                return PayloadDecode {
                    direction,
                    status,
                    schema_message: None,
                    json_previews: Vec::new(),
                    fields: Vec::new(),
                };
            }
        }
    } else {
        capture.bytes.as_slice()
    };

    if matches!(payload_hint.likely_protocol.as_str(), "protobuf" | "grpc")
        || (!looks_like_text(decode_input) && !schemas.is_empty())
    {
        if let Some(application_decode) = decode_application_packet_payload(
            decode_input,
            event,
            schemas,
            capture.truncated,
            capture.capture_limit,
        ) {
            return application_decode;
        }
    }

    if !matches!(payload_hint.likely_protocol.as_str(), "protobuf" | "grpc") {
        return PayloadDecode {
            direction,
            status: payload_hint.decode_status.clone(),
            schema_message: None,
            json_previews: Vec::new(),
            fields: Vec::new(),
        };
    }

    match protobuf_wire_preview(decode_input, 32) {
        Ok(fields) if fields.is_empty() => PayloadDecode {
            direction,
            status: "Captured protobuf body, but no fields were found.".to_owned(),
            schema_message: None,
            json_previews: Vec::new(),
            fields,
        },
        Ok(fields) => PayloadDecode {
            direction,
            status: if capture.truncated {
                format!(
                    "Descriptorless protobuf wire preview from first {} bytes; schemas are required for field names and exact types.",
                    capture.capture_limit
                )
            } else {
                "Descriptorless protobuf wire preview; schemas are required for field names and exact types.".to_owned()
            },
            schema_message: None,
            json_previews: Vec::new(),
            fields,
        },
        Err(error) => PayloadDecode {
            direction,
            status: format!("Protobuf wire preview failed: {error}"),
            schema_message: None,
            json_previews: Vec::new(),
            fields: Vec::new(),
        },
    }
}

fn decode_json_preview(
    request_capture: Option<&BodyCapture>,
    response_capture: Option<&BodyCapture>,
) -> PayloadDecode {
    let mut previews = Vec::new();

    if let Some(capture) = request_capture {
        previews.push(json_payload_preview("request", capture));
    }

    if let Some(capture) = response_capture {
        previews.push(json_payload_preview("response", capture));
    }

    let status = if previews.is_empty() {
        "JSON detected, but body samples were not captured because they were too large or streamed with unknown length.".to_owned()
    } else if previews
        .iter()
        .all(|preview| preview.status == "JSON body is empty.")
    {
        "JSON detected, but captured body samples were empty.".to_owned()
    } else if previews.iter().all(|preview| preview.preview.is_some()) {
        format!("JSON decoded for {} payload(s).", previews.len())
    } else {
        "JSON detected; one or more payloads could not be parsed.".to_owned()
    };

    PayloadDecode {
        direction: previews.last().map(|preview| preview.direction.clone()),
        status,
        schema_message: None,
        json_previews: previews,
        fields: Vec::new(),
    }
}

fn json_payload_preview(direction: &str, capture: &BodyCapture) -> JsonPayloadPreview {
    if capture.bytes.is_empty() {
        return JsonPayloadPreview {
            direction: direction.to_owned(),
            status: "JSON body is empty.".to_owned(),
            preview: None,
        };
    }

    match serde_json::from_slice::<serde_json::Value>(&capture.bytes)
        .and_then(|value| serde_json::to_string_pretty(&value))
    {
        Ok(json) => JsonPayloadPreview {
            direction: direction.to_owned(),
            status: "JSON decoded.".to_owned(),
            preview: Some(truncate_preview(json, 12_000)),
        },
        Err(error) => JsonPayloadPreview {
            direction: direction.to_owned(),
            status: format!("JSON parse failed: {error}"),
            preview: std::str::from_utf8(&capture.bytes)
                .ok()
                .map(|text| truncate_preview(text.to_owned(), 12_000)),
        },
    }
}

fn truncate_preview(mut value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }

    value = value.chars().take(max_chars).collect();
    value.push_str("\n...");
    value
}

fn grpc_message_payload(bytes: &[u8]) -> Result<&[u8], String> {
    if bytes.len() < 5 {
        return Err("gRPC body is shorter than the 5-byte message frame header.".to_owned());
    }

    if bytes[0] != 0 {
        return Err("gRPC message is compressed; decompression is not implemented yet.".to_owned());
    }

    let message_len = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
    let message_end = 5usize
        .checked_add(message_len)
        .ok_or_else(|| "gRPC message length overflowed.".to_owned())?;

    if bytes.len() < message_end {
        return Err(format!(
            "gRPC message frame declares {message_len} bytes, but only {} bytes were captured.",
            bytes.len().saturating_sub(5)
        ));
    }

    Ok(&bytes[5..message_end])
}

fn protobuf_wire_preview(
    mut bytes: &[u8],
    max_fields: usize,
) -> Result<Vec<ProtobufFieldPreview>, String> {
    let mut fields = Vec::new();

    while !bytes.is_empty() && fields.len() < max_fields {
        let (key, rest) = read_varint(bytes)?;
        bytes = rest;

        let field_number = (key >> 3) as u32;
        let wire_type = (key & 0b111) as u8;

        if field_number == 0 {
            return Err("field number 0 is invalid.".to_owned());
        }

        let (value_preview, nested_fields, rest) = match wire_type {
            0 => {
                let (value, rest) = read_varint(bytes)?;
                (varint_preview(value), Vec::new(), rest)
            }
            1 => {
                if bytes.len() < 8 {
                    return Err(format!("field {field_number} fixed64 value is truncated."));
                }

                let value =
                    u64::from_le_bytes(bytes[..8].try_into().expect("slice length checked"));
                (fixed64_preview(value), Vec::new(), &bytes[8..])
            }
            2 => {
                let (len, rest) = read_varint(bytes)?;
                let len = len as usize;

                if rest.len() < len {
                    return Err(format!(
                        "field {field_number} length-delimited value declares {len} bytes, but only {} remain.",
                        rest.len()
                    ));
                }

                let value = &rest[..len];
                let (preview, nested_fields) = length_delimited_preview(value);
                (preview, nested_fields, &rest[len..])
            }
            3 => {
                return Err(format!(
                    "field {field_number} uses unsupported start-group wire type."
                ))
            }
            4 => {
                return Err(format!(
                    "field {field_number} uses unexpected end-group wire type."
                ))
            }
            5 => {
                if bytes.len() < 4 {
                    return Err(format!("field {field_number} fixed32 value is truncated."));
                }

                let value =
                    u32::from_le_bytes(bytes[..4].try_into().expect("slice length checked"));
                (fixed32_preview(value), Vec::new(), &bytes[4..])
            }
            _ => {
                return Err(format!(
                    "field {field_number} has invalid wire type {wire_type}."
                ))
            }
        };

        fields.push(ProtobufFieldPreview {
            field_number,
            field_name: None,
            wire_type,
            wire_type_name: protobuf_wire_type_name(wire_type).to_owned(),
            value_preview,
            nested_fields,
        });

        bytes = rest;
    }

    Ok(fields)
}

fn read_varint(bytes: &[u8]) -> Result<(u64, &[u8]), String> {
    let mut value = 0u64;

    for (index, byte) in bytes.iter().copied().enumerate().take(10) {
        value |= u64::from(byte & 0x7f) << (index * 7);

        if byte & 0x80 == 0 {
            return Ok((value, &bytes[index + 1..]));
        }
    }

    Err("unterminated or oversized varint.".to_owned())
}

fn length_delimited_preview(bytes: &[u8]) -> (String, Vec<ProtobufFieldPreview>) {
    if bytes.is_empty() {
        return ("0 bytes".to_owned(), Vec::new());
    }

    match std::str::from_utf8(bytes) {
        Ok(text) if is_display_text(text) => {
            let mut preview = text.chars().take(80).collect::<String>();

            if text.chars().count() > 80 {
                preview.push_str("...");
            }

            (
                format!("{} bytes string \"{preview}\"", bytes.len()),
                Vec::new(),
            )
        }
        _ => {
            if let Ok(fields) = protobuf_wire_preview(bytes, 12) {
                if !fields.is_empty() {
                    return (
                        format!("{} bytes nested protobuf message", bytes.len()),
                        fields,
                    );
                }
            }

            let hex = bytes
                .iter()
                .take(16)
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(" ");
            let suffix = if bytes.len() > 16 { " ..." } else { "" };

            (
                format!("{} bytes hex {hex}{suffix}", bytes.len()),
                Vec::new(),
            )
        }
    }
}

fn varint_preview(value: u64) -> String {
    match value {
        0 | 1 => format!("{value} bool={}", value == 1),
        _ => format!("{value} sint={}", decode_zigzag64(value)),
    }
}

fn fixed32_preview(value: u32) -> String {
    let float = f32::from_bits(value);

    if float.is_finite() {
        format!("0x{value:08x} uint={value} float={float}")
    } else {
        format!("0x{value:08x} uint={value}")
    }
}

fn fixed64_preview(value: u64) -> String {
    let double = f64::from_bits(value);

    if double.is_finite() {
        format!("0x{value:016x} uint={value} double={double}")
    } else {
        format!("0x{value:016x} uint={value}")
    }
}

fn decode_zigzag64(value: u64) -> i64 {
    ((value >> 1) as i64) ^ (-((value & 1) as i64))
}

fn is_display_text(text: &str) -> bool {
    text.chars()
        .all(|ch| !ch.is_control() || matches!(ch, '\r' | '\n' | '\t'))
}

fn looks_like_text(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes)
        .map(is_display_text)
        .unwrap_or(false)
}

fn looks_like_json(bytes: &[u8]) -> bool {
    let trimmed = bytes
        .iter()
        .copied()
        .skip_while(|byte| byte.is_ascii_whitespace())
        .collect::<Vec<_>>();

    matches!(trimmed.first(), Some(b'{') | Some(b'['))
}

fn protobuf_wire_type_name(wire_type: u8) -> &'static str {
    match wire_type {
        0 => "varint",
        1 => "fixed64",
        2 => "length-delimited",
        3 => "start-group",
        4 => "end-group",
        5 => "fixed32",
        _ => "invalid",
    }
}

fn dynamic_message_fields(message: &DynamicMessage) -> Vec<ProtobufFieldPreview> {
    message
        .fields()
        .map(|(field, value)| dynamic_field_preview(&field, value))
        .collect()
}

fn dynamic_field_preview(field: &FieldDescriptor, value: &Value) -> ProtobufFieldPreview {
    let nested_fields = match value {
        Value::Message(message) => dynamic_message_fields(message),
        Value::List(values) => values
            .iter()
            .enumerate()
            .map(|(index, value)| dynamic_repeated_value_preview(field, index, value))
            .collect(),
        Value::Map(entries) => entries
            .iter()
            .map(|(key, value)| ProtobufFieldPreview {
                field_number: field.number(),
                field_name: Some(format!("{}[{}]", field.name(), map_key_preview(key))),
                wire_type: 2,
                wire_type_name: "schema-map-entry".to_owned(),
                value_preview: dynamic_value_preview(value),
                nested_fields: match value {
                    Value::Message(message) => dynamic_message_fields(message),
                    _ => Vec::new(),
                },
            })
            .collect(),
        _ => Vec::new(),
    };

    ProtobufFieldPreview {
        field_number: field.number(),
        field_name: Some(field.name().to_owned()),
        wire_type: 0,
        wire_type_name: format!("{:?}", field.kind()),
        value_preview: dynamic_value_preview(value),
        nested_fields,
    }
}

fn dynamic_repeated_value_preview(
    field: &FieldDescriptor,
    index: usize,
    value: &Value,
) -> ProtobufFieldPreview {
    ProtobufFieldPreview {
        field_number: field.number(),
        field_name: Some(format!("{}[{index}]", field.name())),
        wire_type: 0,
        wire_type_name: format!("{:?}", field.kind()),
        value_preview: dynamic_value_preview(value),
        nested_fields: match value {
            Value::Message(message) => dynamic_message_fields(message),
            _ => Vec::new(),
        },
    }
}

fn dynamic_value_preview(value: &Value) -> String {
    match value {
        Value::Bool(value) => value.to_string(),
        Value::I32(value) => value.to_string(),
        Value::I64(value) => value.to_string(),
        Value::U32(value) => value.to_string(),
        Value::U64(value) => value.to_string(),
        Value::F32(value) => value.to_string(),
        Value::F64(value) => value.to_string(),
        Value::String(value) => {
            let mut preview = value.chars().take(120).collect::<String>();
            if value.chars().count() > 120 {
                preview.push_str("...");
            }
            format!("\"{preview}\"")
        }
        Value::Bytes(value) => {
            let hex = value
                .iter()
                .take(24)
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(" ");
            let suffix = if value.len() > 24 { " ..." } else { "" };
            format!("{} bytes hex {hex}{suffix}", value.len())
        }
        Value::EnumNumber(value) => format!("enum #{value}"),
        Value::Message(message) => format!("{} fields", message.fields().count()),
        Value::List(values) => format!("{} item(s)", values.len()),
        Value::Map(entries) => format!("{} entrie(s)", entries.len()),
    }
}

fn map_key_preview(key: &prost_reflect::MapKey) -> String {
    match key {
        prost_reflect::MapKey::Bool(value) => value.to_string(),
        prost_reflect::MapKey::I32(value) => value.to_string(),
        prost_reflect::MapKey::I64(value) => value.to_string(),
        prost_reflect::MapKey::U32(value) => value.to_string(),
        prost_reflect::MapKey::U64(value) => value.to_string(),
        prost_reflect::MapKey::String(value) => value.clone(),
    }
}

fn direction_name(direction: &Direction) -> &'static str {
    match direction {
        Direction::Request => "request",
        Direction::Response => "response",
        Direction::Internal => "internal",
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn normalize_decode_strategy(value: Option<String>) -> Result<String, String> {
    match value
        .as_deref()
        .unwrap_or("direct")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "direct" => Ok("direct".to_owned()),
        "envelope" => Ok("envelope".to_owned()),
        other => Err(format!("unsupported protobuf decode strategy: {other}")),
    }
}

fn parse_envelope_type_map(value: Option<&str>) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(BTreeMap::new());
    };

    if let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(value) {
        return Ok(map);
    }

    let entries = serde_json::from_str::<Vec<EnvelopeTypeMapEntry>>(value).map_err(|error| {
        format!(
            "envelope type map must be JSON object or array of {{ key, message }} entries: {error}"
        )
    })?;

    Ok(entries
        .into_iter()
        .map(|entry| (entry.key, entry.message))
        .collect())
}

fn parse_host_match_type(value: &str) -> Result<HostMatchType, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "any" => Ok(HostMatchType::Any),
        "exact" => Ok(HostMatchType::Exact),
        "suffix" => Ok(HostMatchType::Suffix),
        "contains" => Ok(HostMatchType::Contains),
        other => Err(format!("unsupported host match type: {other}")),
    }
}

fn host_match_type_name(value: HostMatchType) -> &'static str {
    match value {
        HostMatchType::Any => "any",
        HostMatchType::Exact => "exact",
        HostMatchType::Suffix => "suffix",
        HostMatchType::Contains => "contains",
    }
}

fn schema_matches_event(schema: &ProtoSchemaBundle, event: &ProxyEvent) -> bool {
    if !matches!(schema.host_match_type, HostMatchType::Any) {
        let Some(authority_host) = event
            .authority
            .as_ref()
            .and_then(|authority| normalized_host(authority))
        else {
            return false;
        };
        let Some(match_value) = schema
            .host_match_value
            .as_ref()
            .and_then(|value| normalized_host(value))
        else {
            return false;
        };

        let matches_host = match schema.host_match_type {
            HostMatchType::Any => true,
            HostMatchType::Exact => authority_host == match_value,
            HostMatchType::Suffix => authority_host.ends_with(&match_value),
            HostMatchType::Contains => authority_host.contains(&match_value),
        };

        if !matches_host {
            return false;
        }
    }

    if let Some(path_prefix) = &schema.path_prefix {
        let Some(path) = &event.path else {
            return false;
        };

        if !path.starts_with(path_prefix) {
            return false;
        }
    }

    true
}

fn websocket_mapping_matches_event(mapping: &WebSocketProtoMapping, event: &ProxyEvent) -> bool {
    if mapping.host_match_type != "any" {
        let Some(authority_host) = event
            .authority
            .as_ref()
            .and_then(|authority| normalized_host(authority))
        else {
            return false;
        };
        let Some(match_value) = mapping
            .host_match_value
            .as_ref()
            .and_then(|value| normalized_host(value))
        else {
            return false;
        };

        let matches_host = match mapping.host_match_type.as_str() {
            "exact" => authority_host == match_value,
            "suffix" => authority_host.ends_with(&match_value),
            "contains" => authority_host.contains(&match_value),
            "any" => true,
            _ => false,
        };

        if !matches_host {
            return false;
        }
    }

    if let Some(path_prefix) = &mapping.path_prefix {
        let Some(path) = &event.path else {
            return false;
        };

        if !path.starts_with(path_prefix) {
            return false;
        }
    }

    if let Some(direction) = &mapping.direction {
        if !direction.eq_ignore_ascii_case(direction_name(&event.direction)) {
            return false;
        }
    }

    if let Some(message_kind) = &mapping.message_kind {
        let Some(event_kind) = &event.websocket_message_kind else {
            return false;
        };

        if !message_kind.eq_ignore_ascii_case(&format!("{event_kind:?}")) {
            return false;
        }
    }

    true
}

fn normalized_host(authority: &str) -> Option<String> {
    let host = authority
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("ws://")
        .trim_start_matches("wss://")
        .split('/')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .trim_start_matches("www.")
        .trim_start_matches('.')
        .to_ascii_lowercase();

    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

fn short_message_name(message_name: &str) -> &str {
    message_name.rsplit('.').next().unwrap_or(message_name)
}

fn proto_schema_status_from_pool(
    id: String,
    name: String,
    source_path: &str,
    host_match_type: HostMatchType,
    host_match_value: Option<String>,
    path_prefix: Option<String>,
    pool: &DescriptorPool,
) -> ProtoSchemaStatus {
    let message_names = pool
        .all_messages()
        .map(|message| message.full_name().to_owned())
        .collect::<Vec<_>>();
    let sample_messages = message_names.iter().take(8).cloned().collect::<Vec<_>>();

    ProtoSchemaStatus {
        id,
        name,
        source_path: source_path.to_owned(),
        host_match_type: host_match_type_name(host_match_type).to_owned(),
        host_match_value,
        path_prefix,
        file_count: pool.files().count(),
        message_count: message_names.len(),
        service_count: pool.services().count(),
        application_mapping_count: 0,
        application_mapping_examples: Vec::new(),
        sample_messages,
        message_names,
    }
}

fn application_message_mapping_examples(
    mappings: &BTreeMap<(i32, u32), Vec<String>>,
) -> Vec<String> {
    mappings
        .iter()
        .flat_map(|((message_type, version), names)| {
            names
                .iter()
                .map(|name| format!("type {message_type}, version {version}: {name}"))
        })
        .take(8)
        .collect()
}

fn detect_http_anomalies(
    status: Option<u16>,
    duration_ms: Option<u128>,
    response_body_len: Option<u64>,
    payload_hint: &PayloadHint,
    payload_decode: &PayloadDecode,
) -> Vec<AnomalyFinding> {
    let mut anomalies = Vec::new();

    if status.is_none() {
        anomalies.push(AnomalyFinding {
            kind: "missing_response".to_owned(),
            severity: "warning".to_owned(),
            summary: "Request has not received a response yet.".to_owned(),
        });
    }

    if let Some(status) = status {
        if status >= 500 {
            anomalies.push(AnomalyFinding {
                kind: "http_5xx".to_owned(),
                severity: "high".to_owned(),
                summary: format!("Upstream returned server error {status}."),
            });
        } else if status >= 400 {
            anomalies.push(AnomalyFinding {
                kind: "http_4xx".to_owned(),
                severity: "medium".to_owned(),
                summary: format!("Upstream returned client error {status}."),
            });
        }
    }

    if duration_ms.is_some_and(|duration| duration > 2_000) {
        anomalies.push(AnomalyFinding {
            kind: "slow_response".to_owned(),
            severity: "medium".to_owned(),
            summary: "Response took longer than 2000 ms.".to_owned(),
        });
    }

    if response_body_len.is_some_and(|body_len| body_len > 1_000_000) {
        anomalies.push(AnomalyFinding {
            kind: "large_response".to_owned(),
            severity: "low".to_owned(),
            summary: "Response body length is larger than 1 MB.".to_owned(),
        });
    }

    if !status.is_some_and(|status| status >= 400)
        && matches!(payload_hint.likely_protocol.as_str(), "protobuf" | "grpc")
        && payload_decode.fields.is_empty()
    {
        anomalies.push(AnomalyFinding {
            kind: "protobuf_undecoded".to_owned(),
            severity: "low".to_owned(),
            summary: payload_hint.decode_status.clone(),
        });
    }

    anomalies
}

#[tauri::command]
async fn stop_proxy(state: tauri::State<'_, ProxyState>) -> Result<(), String> {
    let handle = {
        let mut handle = state.handle.lock().map_err(|error| error.to_string())?;
        handle.take()
    };

    if let Some(handle) = handle {
        handle.stop().await.map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProxyState::default())
        .setup(|app| {
            let state = app.state::<ProxyState>();

            match websocket_mapping_store_path(app.handle()).and_then(|path| {
                *state
                    .websocket_mapping_store_path
                    .lock()
                    .map_err(|error| error.to_string())? = Some(path);
                load_persisted_websocket_mappings(app.handle())
            }) {
                Ok(mappings) => {
                    *state
                        .websocket_mappings
                        .lock()
                        .expect("websocket mapping state should lock") = mappings;
                }
                Err(error) => {
                    log::error!("Protobuf Decoder failed to load WebSocket mappings: {error}");
                }
            }

            match load_or_create_persistent_ca(app.handle()).and_then(|(ca, ca_status)| {
                tauri::async_runtime::block_on(start_proxy_on_default_addr_with_ca(ca))
                    .map(|handle| (handle, ca_status))
                    .map_err(|error| error.to_string())
            }) {
                Ok((handle, ca_status)) => {
                    log::info!("Protobuf Decoder proxy started at {}", handle.addr());
                    *state.handle.lock().expect("proxy state should lock") = Some(handle);
                    *state
                        .ca_status
                        .lock()
                        .expect("proxy CA status state should lock") = Some(ca_status);
                }
                Err(error) => {
                    log::error!("Protobuf Decoder proxy failed to start: {error}");
                    *state
                        .startup_error
                        .lock()
                        .expect("proxy startup error state should lock") = Some(error);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            proxy_status,
            start_proxy_service,
            proxy_events,
            clear_proxy_events,
            proto_schema_status,
            proto_schema_bundles,
            websocket_proto_mappings,
            add_websocket_proto_mapping,
            update_websocket_proto_mapping,
            delete_websocket_proto_mapping,
            load_proto_descriptor_set,
            load_proto_descriptor_bundle,
            decode_websocket_message_as_proto,
            export_decoded_websocket_message,
            export_ca_cert,
            trust_ca_cert_for_current_user,
            stop_proxy
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{application_message_mappings_from_descriptor_set, application_message_version};

    fn varint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if value == 0 {
                return bytes;
            }
        }
    }

    fn length_delimited(field_number: u32, value: &[u8]) -> Vec<u8> {
        let mut bytes = varint(u64::from(field_number) << 3 | 2);
        bytes.extend(varint(value.len() as u64));
        bytes.extend(value);
        bytes
    }

    #[test]
    fn application_message_version_reads_versioned_names() {
        assert_eq!(application_message_version("GetDataResponseV3Proto"), 3);
        assert_eq!(application_message_version("KeepAliveProto"), 1);
        assert_eq!(application_message_version("VerifyTOTPResponseProto"), 1);
    }

    #[test]
    fn application_message_mappings_read_generator_ordinals() {
        let mut options = varint(u64::from(50009u32) << 3);
        options.extend(varint(84));

        let mut file = length_delimited(2, b"com.example");
        file.extend(length_delimited(8, &options));
        file.extend(length_delimited(
            4,
            &length_delimited(1, b"ExampleResponseV2Proto"),
        ));

        let descriptor_set = length_delimited(1, &file);
        let mappings = application_message_mappings_from_descriptor_set(&descriptor_set).unwrap();

        assert_eq!(
            mappings.get(&(42, 2)),
            Some(&vec!["com.example.ExampleResponseV2Proto".to_owned()])
        );
    }
}

fn load_or_create_persistent_ca(
    app: &tauri::AppHandle,
) -> Result<(ProxyCa, PersistentCaStatus), String> {
    let paths = persistent_ca_paths(app)?;

    if paths.cert.exists() && paths.key.exists() {
        let cert_pem = fs::read_to_string(&paths.cert)
            .map_err(|error| format!("failed to read persistent CA certificate: {error}"))?;
        let key_pem = fs::read_to_string(&paths.key)
            .map_err(|error| format!("failed to read persistent CA private key: {error}"))?;

        return Ok((
            ProxyCa { cert_pem, key_pem },
            PersistentCaStatus {
                source: "Persistent CA loaded".to_owned(),
                cert_path: paths.cert.to_string_lossy().into_owned(),
            },
        ));
    }

    fs::create_dir_all(&paths.dir)
        .map_err(|error| format!("failed to create persistent CA directory: {error}"))?;

    let ca = generate_proxy_ca().map_err(|error| error.to_string())?;
    fs::write(&paths.cert, &ca.cert_pem)
        .map_err(|error| format!("failed to save persistent CA certificate: {error}"))?;
    fs::write(&paths.key, &ca.key_pem)
        .map_err(|error| format!("failed to save persistent CA private key: {error}"))?;

    Ok((
        ca,
        PersistentCaStatus {
            source: "New persistent CA generated".to_owned(),
            cert_path: paths.cert.to_string_lossy().into_owned(),
        },
    ))
}

struct PersistentCaPaths {
    dir: PathBuf,
    cert: PathBuf,
    key: PathBuf,
}

fn persistent_ca_paths(app: &tauri::AppHandle) -> Result<PersistentCaPaths, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;

    Ok(PersistentCaPaths {
        cert: dir.join("protobuf-decoder-ca.pem"),
        key: dir.join("protobuf-decoder-ca-key.pem"),
        dir,
    })
}

fn websocket_mapping_store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("websocket-proto-mappings.json"))
        .map_err(|error| error.to_string())
}
