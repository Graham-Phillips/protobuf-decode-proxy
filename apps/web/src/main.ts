import './style.css'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'

type ProxyStatus = {
  running: boolean
  addr: string | null
  ca_der_len: number | null
  ca_storage_status: string | null
  ca_cert_path: string | null
  startup_error: string | null
}

type ProxyEvent = {
  id: string
  request_id: string
  connection_id: string | null
  timestamp_unix_ms: number
  protocol: 'Http' | 'WebSocket'
  direction: 'Request' | 'Response' | 'Internal'
  method: string | null
  scheme: string | null
  authority: string | null
  path: string | null
  status: number | null
  body_len_hint: number | null
  websocket_event_kind: 'Open' | 'Message' | 'Close' | 'Error' | null
  websocket_message_kind: string | null
  websocket_error: string | null
}

type ProxyEventSummary = {
  total: number
  http_requests: number
  http_responses: number
  websocket_messages: number
  websocket_active_connections: number
  websocket_opened_connections: number
  websocket_errors: number
  http_exchanges: HttpExchange[]
  websocket_message_previews: WebSocketMessagePreview[]
  events: ProxyEvent[]
}

type HttpExchange = {
  id: string
  started_at_unix_ms: number
  completed_at_unix_ms: number | null
  duration_ms: number | null
  method: string | null
  scheme: string | null
  authority: string | null
  path: string | null
  status: number | null
  server_time: string | null
  request_body_len: number | null
  response_body_len: number | null
  request_headers: Record<string, string>
  response_headers: Record<string, string>
  payload_hint: PayloadHint
  request_payload_decode: PayloadDecode
  response_payload_decode: PayloadDecode | null
  anomalies: AnomalyFinding[]
}

type WebSocketMessagePreview = {
  id: string
  connection_id: string
  timestamp_unix_ms: number
  direction: 'Request' | 'Response' | 'Internal'
  scheme: string | null
  authority: string | null
  path: string | null
  message_kind: string | null
  body_len: number | null
  payload_hint: PayloadHint
  payload_decode: PayloadDecode
  source: string | null
}

type PayloadHint = {
  request_content_type: string | null
  response_content_type: string | null
  likely_protocol: string
  decode_status: string
}

type PayloadDecode = {
  direction: string | null
  status: string
  schema_message: string | null
  json_previews: JsonPayloadPreview[]
  fields: ProtobufFieldPreview[]
}

type JsonPayloadPreview = {
  direction: string
  status: string
  preview: string | null
}

type ProtobufFieldPreview = {
  field_number: number
  field_name: string | null
  wire_type: number
  wire_type_name: string
  value_preview: string
  nested_fields: ProtobufFieldPreview[]
}

type AnomalyFinding = {
  kind: string
  severity: 'low' | 'medium' | 'high' | 'warning' | string
  summary: string
}

type CaCertExport = {
  der_path: string
  pem_path: string
}

type CaTrustInstall = {
  cert_path: string
  store: string
  output: string
}

type ProtoSchemaStatus = {
  id: string
  name: string
  source_path: string
  host_match_type: 'any' | 'exact' | 'suffix' | 'contains' | string
  host_match_value: string | null
  path_prefix: string | null
  file_count: number
  message_count: number
  service_count: number
  application_mapping_count: number
  application_mapping_examples: string[]
  sample_messages: string[]
  message_names: string[]
}

type PacketLogImportReport = {
  cache_directory: string
  sources: PacketLogSourceReport[]
  errors: string[]
  records_loaded: number
  records_skipped: number
  record_limit: number | null
}

type PacketLogImportResult = {
  report: PacketLogImportReport
  summary: ProxyEventSummary
}

type PacketLogSourceReport = {
  source: string
  format: string
  materialized_dat: string | null
  record_count: number
  total_payload_bytes: number
  records_skipped: number
  first_timestamp_unix_ms: number | null
  last_timestamp_unix_ms: number | null
  malformed: boolean
  warning: string | null
}

type WebSocketProtoMapping = {
  id: string
  name: string
  host_match_type: 'any' | 'exact' | 'suffix' | 'contains' | string
  host_match_value: string | null
  path_prefix: string | null
  direction: string | null
  message_kind: string | null
  message_name: string
  decode_strategy: string
  envelope_message_name: string | null
  envelope_items_field: string | null
  envelope_type_field: string | null
  envelope_payload_field: string | null
  envelope_type_map_json: string | null
}

type TrafficView = 'table' | 'timeline' | 'heatmap'
type Workspace = 'traffic' | 'schemas' | 'runtime'
type CaptureMode = 'live' | 'log'
type DecodeFilter = 'all' | 'decoded' | 'undecoded'
type SortKey = 'started_at' | 'name' | 'method' | 'host' | 'status' | 'type' | 'initiator' | 'size' | 'time' | 'decode' | 'anomalies'
type SortDirection = 'asc' | 'desc'
type ResourceFilter = 'all' | 'fetch' | 'document' | 'js' | 'css' | 'image' | 'font' | 'media' | 'ws' | 'protobuf' | 'json' | 'other'
type HttpResourceKind = Exclude<ResourceFilter, 'all' | 'ws'>
type HttpTrafficPart = 'request' | 'response'
type TrafficRow =
  | { kind: 'http'; part: HttpTrafficPart; exchange: HttpExchange }
  | { kind: 'websocket'; preview: WebSocketMessagePreview }

const TRAFFIC_ROW_HEIGHT = 24
const TRAFFIC_ROW_OVERSCAN = 18

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">C</span>
        <div>
          <p class="eyebrow">Protobuf Decoder</p>
          <h1>Live Traffic</h1>
        </div>
      </div>

      <nav class="primary-nav" aria-label="Workspace">
        <button class="nav-button active" type="button" data-workspace-target="traffic">Traffic</button>
        <button class="nav-button" type="button" data-workspace-target="schemas">Schemas</button>
        <button class="nav-button" type="button" data-workspace-target="runtime">Runtime</button>
      </nav>

      <div class="top-actions">
        <span id="proxy-state" class="top-chip" data-state="starting">Proxy starting</span>
        <span id="schema-chip" class="top-chip">No schema</span>
        <span id="websocket-state" class="top-chip connection-state" data-state="idle">
          <span class="status-dot" aria-hidden="true"></span>
          <span>No WebSockets</span>
        </span>
        <button id="theme-toggle" class="quiet-button" type="button" aria-pressed="false">Dark mode</button>
      </div>
    </header>

    <section id="traffic-workspace" class="workspace workspace-view active" data-workspace="traffic">
      <aside class="side-panel traffic-sidebar" aria-label="Traffic controls">
        <section class="tool-panel">
          <div class="panel-heading">
            <h2>Filter</h2>
            <button id="clear-filters" class="quiet-button" type="button">Clear</button>
          </div>
          <label class="field">
            <span>Search</span>
            <input id="traffic-search" type="search" placeholder="Names, fields, values, headers, paths">
          </label>
          <div class="field">
            <span>Resource kind</span>
            <div class="resource-filter" role="group" aria-label="Resource filter">
              <button class="resource-filter-button active" type="button" data-resource-filter="all" aria-pressed="true">All</button>
              <button class="resource-filter-button" type="button" data-resource-filter="fetch" aria-pressed="false">Fetch/XHR</button>
              <button class="resource-filter-button" type="button" data-resource-filter="document" aria-pressed="false">Doc</button>
              <button class="resource-filter-button" type="button" data-resource-filter="js" aria-pressed="false">JS</button>
              <button class="resource-filter-button" type="button" data-resource-filter="css" aria-pressed="false">CSS</button>
              <button class="resource-filter-button" type="button" data-resource-filter="image" aria-pressed="false">Img</button>
              <button class="resource-filter-button" type="button" data-resource-filter="font" aria-pressed="false">Font</button>
              <button class="resource-filter-button" type="button" data-resource-filter="media" aria-pressed="false">Media</button>
              <button class="resource-filter-button" type="button" data-resource-filter="ws" aria-pressed="false">WS</button>
              <button class="resource-filter-button" type="button" data-resource-filter="protobuf" aria-pressed="false">Proto resource</button>
              <button class="resource-filter-button" type="button" data-resource-filter="json" aria-pressed="false">JSON resource</button>
              <button class="resource-filter-button" type="button" data-resource-filter="other" aria-pressed="false">Other</button>
            </div>
          </div>
          <label class="field">
            <span>Payload type</span>
            <select id="protocol-filter">
              <option value="all">All payload types</option>
              <option value="protobuf">Protobuf</option>
              <option value="grpc">gRPC</option>
              <option value="json">JSON</option>
              <option value="text">Text</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label class="field">
            <span>Decode state</span>
            <select id="decode-filter">
              <option value="all">All decode states</option>
              <option value="decoded">Decoded only</option>
              <option value="undecoded">Undecoded or partial</option>
            </select>
          </label>
          <label class="check-row">
            <input id="anomaly-filter" type="checkbox">
            <span>Anomalies only</span>
          </label>
          <label class="check-row">
            <input id="errors-only-filter" type="checkbox">
            <span>Errors only</span>
          </label>
          <label class="check-row">
            <input id="dead-calls-filter" type="checkbox">
            <span>Dead calls only</span>
          </label>
          <label class="check-row">
            <input id="streaming-price-filter" type="checkbox" checked>
            <span>Show StreamingPriceV4</span>
          </label>
          <label class="check-row">
            <input id="keepalive-filter" type="checkbox">
            <span>Show keep-alives</span>
          </label>
          <button id="analyse-selection" class="primary-button" type="button">Analyse Visible</button>
        </section>
        <section class="tool-panel">
          <div class="panel-heading">
            <h2>Read packet logs</h2>
            <span class="small-value">ZIP / GZ / DAT</span>
          </div>
          <label class="field">
            <span>File paths</span>
            <textarea id="packet-log-paths" rows="3" placeholder="One path per line"></textarea>
          </label>
          <label class="field">
            <span>Maximum records to load</span>
            <input id="packet-log-limit" type="number" min="100" max="100000" step="100" value="10000">
          </label>
          <label class="file-picker-button">
            <span>Choose packet logs</span>
            <input id="packet-log-files" type="file" multiple accept=".dat,.gz,.zip">
          </label>
          <div id="packet-log-drop" class="packet-log-drop" role="button" tabindex="0">
            Drop DAT, GZ, or ZIP files here
          </div>
          <button id="inspect-packet-logs" class="primary-button" type="button">Open in Traffic</button>
          <p id="packet-log-status" class="status-message" role="status" aria-live="polite">No packet-log import yet.</p>
          <div id="packet-log-results" class="packet-log-results"></div>
        </section>
      </aside>

      <section class="traffic-workbench">
        <div class="workbench-toolbar">
          <div>
            <h2>Traffic</h2>
            <p id="traffic-summary">Waiting for traffic. Oldest exchanges appear first.</p>
          </div>
          <div class="workbench-actions">
            <button id="toggle-proxy" class="primary-button" type="button">Start</button>
            <div class="capture-mode-switch" role="group" aria-label="Traffic source">
              <span class="small-value">Source</span>
              <button class="mode-button active" type="button" data-capture-mode="live" aria-pressed="true">Live proxy</button>
              <button class="mode-button" type="button" data-capture-mode="log" aria-pressed="false">Read log</button>
            </div>
            <label class="check-row toolbar-toggle">
              <input id="auto-scroll-toggle" type="checkbox" checked>
              <span>Auto-scroll</span>
            </label>
            <div class="view-switch" aria-label="Display mode">
              <button class="view-button active" type="button" data-view="table">Table</button>
              <button class="view-button" type="button" data-view="timeline">Timeline</button>
              <button class="view-button" type="button" data-view="heatmap">Heatmap</button>
            </div>
            <button id="clear-capture" class="quiet-button" type="button">Clear Capture</button>
          </div>
        </div>

        <section class="traffic-summary-strip" aria-label="Capture summary">
          <div class="summary-stat"><span>Messages</span><strong id="summary-messages">0</strong></div>
          <div class="summary-stat"><span>Decoded</span><strong id="summary-decoded">0</strong></div>
          <div class="summary-stat"><span>Anomalies</span><strong id="summary-anomalies">0</strong></div>
          <div class="summary-stat"><span>WebSockets</span><strong id="summary-websockets">0</strong></div>
          <div class="summary-stat summary-stat-wide"><span>Active filters</span><strong id="summary-filters">All traffic</strong></div>
        </section>

        <div id="table-view" class="data-view active">
          <div id="exchange-table-wrap" class="exchange-table-wrap">
            <table class="exchange-table">
              <thead>
                <tr>
                  <th><button class="sort-header" type="button" data-sort-key="name">Name</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="status">Status</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="type">Type</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="initiator">Flow</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="size">Size</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="time">Time</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="method">Method</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="host">Host</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="decode">Decode</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="anomalies">Anomalies</button></th>
                </tr>
              </thead>
              <tbody id="traffic-messages">
                <tr><td colspan="10">No traffic messages captured.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <section class="decoded-message-panel" aria-label="Decoded protobuf JSON">
          <div class="panel-heading">
            <h2>Decoded protobuf JSON</h2>
            <span id="selected-decoded-kind" class="small-value">No selection</span>
          </div>
          <div id="decoded-message-content" class="decoded-message-content">
            Select a traffic row to inspect its decoded protobuf JSON.
          </div>
        </section>

        <div id="timeline-view" class="data-view timeline-view">
          <div class="timeline-header">
            <div>
              <h3>Exchange Timeline</h3>
              <p id="timeline-summary">No exchanges captured.</p>
            </div>
            <span class="timeline-scale">Oldest to newest</span>
          </div>
          <div id="exchange-timeline" class="exchange-timeline" aria-label="HTTP exchange timeline"></div>
        </div>

        <div id="heatmap-view" class="data-view placeholder-view">
          <div id="heatmap-grid" class="heatmap-grid" aria-hidden="true"></div>
          <h3>Heatmap view</h3>
          <p>Next slice: bucket traffic by host, message type, latency, and error density.</p>
        </div>

        <details id="traffic-detail" class="detail-panel traffic-detail-panel" aria-label="Selected exchange">
          <summary class="detail-summary">
            <span class="detail-summary-title">Traffic Detail</span>
            <span id="selected-exchange-kind" class="small-value">No selection</span>
          </summary>
          <div class="detail-panel-content">
            <div class="detail-heading-actions">
              <button id="copy-selected-traffic" class="quiet-button" type="button" disabled>Copy decoded JSON</button>
            </div>
            <div id="exchange-detail" class="detail-content">
              Select a traffic row to inspect request, response, payload preview, and anomalies.
            </div>
            <p id="selected-copy-status" class="status-message" role="status" aria-live="polite"></p>
          </div>
        </details>

        <details class="diagnostics-panel">
          <summary>Capture diagnostics</summary>
          <section class="events-panel">
            <div class="panel-heading">
              <h2>Event Timeline</h2>
              <span class="small-value">Newest first</span>
            </div>
            <ol id="events" class="events"></ol>
          </section>
        </details>
      </section>
    </section>

    <section id="schemas-workspace" class="workspace-view" data-workspace="schemas">
      <section class="workspace-grid">
        <section class="tool-panel">
          <div class="panel-heading">
            <h2>Protobuf Schema</h2>
            <span id="proto-schema-summary" class="small-value">No schema</span>
          </div>
          <label class="field">
            <span>Bundle name</span>
            <input id="descriptor-bundle-name" type="text" placeholder="Trading API">
          </label>
          <label class="field">
            <span>Descriptor set path</span>
            <input id="descriptor-set-path" type="text" placeholder="C:\\path\\to\\descriptors.pb">
          </label>
          <label class="field">
            <span>Host match</span>
            <select id="descriptor-host-match-type">
              <option value="any">Any host</option>
              <option value="exact">Exact host</option>
              <option value="suffix">Host suffix</option>
              <option value="contains">Host contains</option>
            </select>
          </label>
          <label class="field">
            <span>Host value</span>
            <input id="descriptor-host-match-value" type="text" placeholder="connect.cmc.com or ourserver.com">
          </label>
          <label class="field">
            <span>Path prefix match</span>
            <input id="descriptor-path-prefix" type="text" placeholder="/ws or /grpc">
          </label>
          <button id="load-descriptor-set" class="primary-button" type="button">Load Bundle</button>
          <p id="proto-schema-status" class="status-message" role="status" aria-live="polite">Load a protoc FileDescriptorSet to enable schema-aware decoding.</p>
          <ul id="proto-message-samples" class="message-samples"></ul>
        </section>
        <section class="tool-panel">
          <div class="panel-heading">
            <h2>Schema Bundles</h2>
            <span id="proto-bundle-count" class="small-value">0 loaded</span>
          </div>
          <div id="proto-schema-bundles" class="schema-bundle-list">
            No schema bundles loaded.
          </div>
          <p class="status-message">Next: persist bundle rules and map WebSocket channels or selected payloads to concrete protobuf message types.</p>
        </section>
        <section class="tool-panel">
          <div class="panel-heading">
            <h2>WebSocket Mappings</h2>
            <span id="websocket-mapping-count" class="small-value">0 rules</span>
          </div>
          <label class="field">
            <span>Rule name</span>
            <input id="websocket-mapping-name" type="text" placeholder="Prices response">
          </label>
          <label class="field">
            <span>Host match</span>
            <select id="websocket-mapping-host-match-type">
              <option value="any">Any host</option>
              <option value="exact">Exact host</option>
              <option value="suffix">Host suffix</option>
              <option value="contains">Host contains</option>
            </select>
          </label>
          <label class="field">
            <span>Host value</span>
            <input id="websocket-mapping-host-match-value" type="text" placeholder="stream.example.com">
          </label>
          <label class="field">
            <span>Path prefix</span>
            <input id="websocket-mapping-path-prefix" type="text" placeholder="/ws">
          </label>
          <label class="field">
            <span>Direction</span>
            <select id="websocket-mapping-direction">
              <option value="">Any direction</option>
              <option value="request">client -> server</option>
              <option value="response">server -> client</option>
              <option value="internal">internal</option>
            </select>
          </label>
          <label class="field">
            <span>Frame kind</span>
            <select id="websocket-mapping-kind">
              <option value="">Any kind</option>
              <option value="Binary">Binary</option>
              <option value="Text">Text</option>
              <option value="Ping">Ping</option>
              <option value="Pong">Pong</option>
              <option value="Close">Close</option>
            </select>
          </label>
          <label class="field">
            <span>Decode strategy</span>
            <select id="websocket-mapping-decode-strategy">
              <option value="direct">Direct payload message</option>
              <option value="envelope">Envelope dispatch</option>
            </select>
          </label>
          <label class="field">
            <span>Message type</span>
            <input id="websocket-mapping-message-name" type="text" list="proto-message-name-options" placeholder="package.MessageName">
          </label>
          <label class="field envelope-mapping-field">
            <span>Envelope type</span>
            <input id="websocket-mapping-envelope-message-name" type="text" list="proto-message-name-options" placeholder="package.Envelope">
          </label>
          <label class="field envelope-mapping-field">
            <span>Envelope items field</span>
            <input id="websocket-mapping-envelope-items-field" type="text" placeholder="items; leave blank if envelope is the item">
          </label>
          <label class="field envelope-mapping-field">
            <span>Discriminator field</span>
            <input id="websocket-mapping-envelope-type-field" type="text" placeholder="kind">
          </label>
          <label class="field envelope-mapping-field">
            <span>Payload bytes field</span>
            <input id="websocket-mapping-envelope-payload-field" type="text" placeholder="payload">
          </label>
          <label class="field envelope-mapping-field">
            <span>Type map JSON</span>
            <textarea id="websocket-mapping-envelope-type-map" rows="5" placeholder='{"1":"package.MessageA","2":"package.MessageB"}'></textarea>
          </label>
          <button id="add-websocket-mapping" type="button">Add Mapping</button>
          <p id="websocket-mapping-status" class="status-message" role="status" aria-live="polite">Matched frames are decoded automatically when exactly one rule applies.</p>
          <div id="websocket-mappings" class="schema-bundle-list">No WebSocket mappings.</div>
        </section>
      </section>
    </section>

    <section id="runtime-workspace" class="workspace-view" data-workspace="runtime">
      <section class="workspace-grid">
        <section class="tool-panel">
          <div class="panel-heading">
            <h2>Proxy Runtime</h2>
            <span id="runtime-proxy-state" class="small-value">Starting</span>
          </div>
          <dl class="counts">
            <div><dt>Mode</dt><dd id="proxy-mode">Passthrough</dd></div>
            <div><dt>Address</dt><dd id="proxy-address">-</dd></div>
            <div><dt>Captured events</dt><dd id="event-total">0</dd></div>
            <div><dt>CA</dt><dd id="ca-storage">-</dd></div>
          </dl>
        </section>
        <section class="tool-panel">
          <div class="panel-heading">
            <h2>Certificate</h2>
            <span id="proxy-ca" class="small-value">-</span>
          </div>
          <p id="client-config">Waiting for proxy startup.</p>
          <div class="button-row">
            <button id="export-ca" type="button" disabled>Export CA</button>
            <button id="trust-ca" type="button" disabled>Trust CA</button>
          </div>
          <p id="ca-export-status" class="status-message" role="status" aria-live="polite"></p>
        </section>
        <section class="tool-panel">
          <h2>Browser Setup</h2>
          <details open>
            <summary>PowerShell commands (Windows)</summary>
            <p class="command-language">Run these commands in PowerShell. Each command uses an isolated browser profile.</p>
            <div class="command-list" aria-label="Browser launch commands">
              <div class="command-row">
                <span>Edge profile · PowerShell</span>
                <code id="edge-command">-</code>
                <button class="copy-command" type="button" data-copy-target="edge-command">Copy</button>
              </div>
              <div class="command-row">
                <span>Chrome profile · PowerShell</span>
                <code id="chrome-command">-</code>
                <button class="copy-command" type="button" data-copy-target="chrome-command">Copy</button>
              </div>
            </div>
          </details>
          <p id="browser-setup-status" class="status-message">Waiting for proxy startup.</p>
          <p id="copy-status" class="status-message" role="status" aria-live="polite"></p>
        </section>
        <section class="tool-panel">
          <h2>Stats</h2>
          <dl class="counts">
            <div><dt>HTTP requests</dt><dd id="http-requests">0</dd></div>
            <div><dt>HTTP responses</dt><dd id="http-responses">0</dd></div>
            <div><dt>WebSocket frames</dt><dd id="websocket-messages">0</dd></div>
            <div><dt>WebSocket active</dt><dd id="websocket-active">0</dd></div>
            <div><dt>WebSocket opened</dt><dd id="websocket-opened">0</dd></div>
            <div><dt>WebSocket errors</dt><dd id="websocket-errors">0</dd></div>
          </dl>
        </section>
      </section>
    </section>
  </main>
`

const proxyState = document.querySelector<HTMLElement>('#proxy-state')!
const themeToggle = document.querySelector<HTMLButtonElement>('#theme-toggle')!
const proxyAddress = document.querySelector<HTMLElement>('#proxy-address')!
const runtimeProxyState = document.querySelector<HTMLElement>('#runtime-proxy-state')!
const proxyMode = document.querySelector<HTMLElement>('#proxy-mode')!
const proxyCa = document.querySelector<HTMLElement>('#proxy-ca')!
const caStorage = document.querySelector<HTMLElement>('#ca-storage')!
const eventTotal = document.querySelector<HTMLElement>('#event-total')!
const clientConfig = document.querySelector<HTMLElement>('#client-config')!
const httpRequests = document.querySelector<HTMLElement>('#http-requests')!
const httpResponses = document.querySelector<HTMLElement>('#http-responses')!
const websocketMessages = document.querySelector<HTMLElement>('#websocket-messages')!
const websocketActive = document.querySelector<HTMLElement>('#websocket-active')!
const websocketOpened = document.querySelector<HTMLElement>('#websocket-opened')!
const websocketErrors = document.querySelector<HTMLElement>('#websocket-errors')!
const websocketState = document.querySelector<HTMLElement>('#websocket-state')!
const exchangeTableWrap = document.querySelector<HTMLElement>('#exchange-table-wrap')!
const trafficMessages = document.querySelector<HTMLTableSectionElement>('#traffic-messages')!
const exchangeTimeline = document.querySelector<HTMLElement>('#exchange-timeline')!
const timelineSummary = document.querySelector<HTMLElement>('#timeline-summary')!
const eventsList = document.querySelector<HTMLOListElement>('#events')!
const exportCaButton = document.querySelector<HTMLButtonElement>('#export-ca')!
const trustCaButton = document.querySelector<HTMLButtonElement>('#trust-ca')!
const toggleProxyButton = document.querySelector<HTMLButtonElement>('#toggle-proxy')!
const caExportStatus = document.querySelector<HTMLElement>('#ca-export-status')!
const browserSetupStatus = document.querySelector<HTMLElement>('#browser-setup-status')!
const edgeCommand = document.querySelector<HTMLElement>('#edge-command')!
const chromeCommand = document.querySelector<HTMLElement>('#chrome-command')!
const copyStatus = document.querySelector<HTMLElement>('#copy-status')!
const copyCommandButtons = document.querySelectorAll<HTMLButtonElement>('.copy-command')
const descriptorBundleName = document.querySelector<HTMLInputElement>('#descriptor-bundle-name')!
const descriptorSetPath = document.querySelector<HTMLInputElement>('#descriptor-set-path')!
const descriptorHostMatchType = document.querySelector<HTMLSelectElement>('#descriptor-host-match-type')!
const descriptorHostMatchValue = document.querySelector<HTMLInputElement>('#descriptor-host-match-value')!
const descriptorPathPrefix = document.querySelector<HTMLInputElement>('#descriptor-path-prefix')!
const loadDescriptorSetButton = document.querySelector<HTMLButtonElement>('#load-descriptor-set')!
const protoSchemaSummary = document.querySelector<HTMLElement>('#proto-schema-summary')!
const protoSchemaStatus = document.querySelector<HTMLElement>('#proto-schema-status')!
const protoMessageSamples = document.querySelector<HTMLElement>('#proto-message-samples')!
const protoBundleCount = document.querySelector<HTMLElement>('#proto-bundle-count')!
const protoSchemaBundles = document.querySelector<HTMLElement>('#proto-schema-bundles')!
const websocketMappingCount = document.querySelector<HTMLElement>('#websocket-mapping-count')!
const websocketMappingName = document.querySelector<HTMLInputElement>('#websocket-mapping-name')!
const websocketMappingHostMatchType = document.querySelector<HTMLSelectElement>('#websocket-mapping-host-match-type')!
const websocketMappingHostMatchValue = document.querySelector<HTMLInputElement>('#websocket-mapping-host-match-value')!
const websocketMappingPathPrefix = document.querySelector<HTMLInputElement>('#websocket-mapping-path-prefix')!
const websocketMappingDirection = document.querySelector<HTMLSelectElement>('#websocket-mapping-direction')!
const websocketMappingKind = document.querySelector<HTMLSelectElement>('#websocket-mapping-kind')!
const websocketMappingDecodeStrategy = document.querySelector<HTMLSelectElement>('#websocket-mapping-decode-strategy')!
const websocketMappingMessageName = document.querySelector<HTMLInputElement>('#websocket-mapping-message-name')!
const websocketMappingEnvelopeMessageName = document.querySelector<HTMLInputElement>('#websocket-mapping-envelope-message-name')!
const websocketMappingEnvelopeItemsField = document.querySelector<HTMLInputElement>('#websocket-mapping-envelope-items-field')!
const websocketMappingEnvelopeTypeField = document.querySelector<HTMLInputElement>('#websocket-mapping-envelope-type-field')!
const websocketMappingEnvelopePayloadField = document.querySelector<HTMLInputElement>('#websocket-mapping-envelope-payload-field')!
const websocketMappingEnvelopeTypeMap = document.querySelector<HTMLTextAreaElement>('#websocket-mapping-envelope-type-map')!
const addWebSocketMappingButton = document.querySelector<HTMLButtonElement>('#add-websocket-mapping')!
const websocketMappingStatus = document.querySelector<HTMLElement>('#websocket-mapping-status')!
const websocketMappings = document.querySelector<HTMLElement>('#websocket-mappings')!
const searchInput = document.querySelector<HTMLInputElement>('#traffic-search')!
const protocolFilter = document.querySelector<HTMLSelectElement>('#protocol-filter')!
const decodeFilter = document.querySelector<HTMLSelectElement>('#decode-filter')!
const anomalyFilter = document.querySelector<HTMLInputElement>('#anomaly-filter')!
const errorsOnlyFilter = document.querySelector<HTMLInputElement>('#errors-only-filter')!
const deadCallsFilter = document.querySelector<HTMLInputElement>('#dead-calls-filter')!
const streamingPriceFilter = document.querySelector<HTMLInputElement>('#streaming-price-filter')!
const keepAliveFilter = document.querySelector<HTMLInputElement>('#keepalive-filter')!
const clearFiltersButton = document.querySelector<HTMLButtonElement>('#clear-filters')!
const clearCaptureButton = document.querySelector<HTMLButtonElement>('#clear-capture')!
const analyseSelectionButton = document.querySelector<HTMLButtonElement>('#analyse-selection')!
const packetLogPaths = document.querySelector<HTMLTextAreaElement>('#packet-log-paths')!
const packetLogLimit = document.querySelector<HTMLInputElement>('#packet-log-limit')!
const packetLogFiles = document.querySelector<HTMLInputElement>('#packet-log-files')!
const packetLogDrop = document.querySelector<HTMLElement>('#packet-log-drop')!
const inspectPacketLogsButton = document.querySelector<HTMLButtonElement>('#inspect-packet-logs')!
const packetLogStatus = document.querySelector<HTMLElement>('#packet-log-status')!
const packetLogResults = document.querySelector<HTMLElement>('#packet-log-results')!
const captureModeButtons = document.querySelectorAll<HTMLButtonElement>('[data-capture-mode]')
const trafficSummary = document.querySelector<HTMLElement>('#traffic-summary')!
const summaryMessages = document.querySelector<HTMLElement>('#summary-messages')!
const summaryDecoded = document.querySelector<HTMLElement>('#summary-decoded')!
const summaryAnomalies = document.querySelector<HTMLElement>('#summary-anomalies')!
const summaryWebSockets = document.querySelector<HTMLElement>('#summary-websockets')!
const summaryFilters = document.querySelector<HTMLElement>('#summary-filters')!
const autoScrollToggle = document.querySelector<HTMLInputElement>('#auto-scroll-toggle')!
const resourceFilterButtons = document.querySelectorAll<HTMLButtonElement>('[data-resource-filter]')
const workspaceButtons = document.querySelectorAll<HTMLButtonElement>('[data-workspace-target]')
const workspaceViews = document.querySelectorAll<HTMLElement>('.workspace-view')
const viewButtons = document.querySelectorAll<HTMLButtonElement>('.view-button')
const sortHeaderButtons = document.querySelectorAll<HTMLButtonElement>('.sort-header')
const selectedExchangeKind = document.querySelector<HTMLElement>('#selected-exchange-kind')!
const selectedDecodedKind = document.querySelector<HTMLElement>('#selected-decoded-kind')!
const decodedMessageContent = document.querySelector<HTMLElement>('#decoded-message-content')!
const copySelectedTrafficButton = document.querySelector<HTMLButtonElement>('#copy-selected-traffic')!
const selectedCopyStatus = document.querySelector<HTMLElement>('#selected-copy-status')!
const trafficDetail = document.querySelector<HTMLDetailsElement>('#traffic-detail')!
const exchangeDetail = document.querySelector<HTMLElement>('#exchange-detail')!
const heatmapGrid = document.querySelector<HTMLElement>('#heatmap-grid')!
const schemaChip = document.querySelector<HTMLElement>('#schema-chip')!

let proxyRunning = false
let refreshInFlight = false
let latestExchanges: HttpExchange[] = []
let latestWebSocketPreviews: WebSocketMessagePreview[] = []
let latestLiveSummary: ProxyEventSummary | null = null
let latestImportedSummary: ProxyEventSummary | null = null
let captureMode: CaptureMode = 'live'
let latestSchemaStatus: ProtoSchemaStatus | null = null
let latestSchemaBundles: ProtoSchemaStatus[] = []
let latestWebSocketMappings: WebSocketProtoMapping[] = []
let packetLogImportInFlight = false
let selectedExchangeId: string | null = null
let selectedWebSocketPreviewId: string | null = null
let selectedTrafficKey: string | null = null
let selectedWebSocketDecode: PayloadDecode | null = null
let selectedWebSocketDecodeMessage = ''
let selectedInspectorSignature: string | null = null
type DecodedJsonMode = 'string' | 'formatted'
let decodedJsonMode: DecodedJsonMode = 'formatted'
let editingWebSocketMappingId: string | null = null
let activeWorkspace: Workspace = 'traffic'
let activeView: TrafficView = 'table'
let autoScrollExchanges = true
let programmaticExchangeScroll = false
let sortKey: SortKey = 'started_at'
let sortDirection: SortDirection = 'asc'
let activeResourceFilters = new Set<ResourceFilter>()
let autoScrollEnabled = true
let currentTrafficPairs = new Map<string, TrafficPairInfo>()

const uiPreferencesKey = 'protobuf-decoder-ui-preferences-v1'

type UiPreferences = {
  theme?: 'light' | 'dark'
  search?: string
  protocol?: string
  decodeState?: DecodeFilter
  anomaliesOnly?: boolean
  errorsOnly?: boolean
  deadCallsOnly?: boolean
  showStreamingPriceV4?: boolean
  showKeepAlives?: boolean
  /** Retained so existing saved preferences migrate cleanly. */
  showKeepAliveAcks?: boolean
  resourceFilters?: ResourceFilter[]
  autoScroll?: boolean
}

function readUiPreferences(): UiPreferences {
  try {
    const stored = localStorage.getItem(uiPreferencesKey)
    return stored ? JSON.parse(stored) as UiPreferences : {}
  } catch {
    return {}
  }
}

function saveUiPreferences() {
  try {
    localStorage.setItem(uiPreferencesKey, JSON.stringify({
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      search: searchInput.value,
      protocol: protocolFilter.value,
      decodeState: decodeFilter.value as DecodeFilter,
      anomaliesOnly: anomalyFilter.checked,
      errorsOnly: errorsOnlyFilter.checked,
      deadCallsOnly: deadCallsFilter.checked,
      showStreamingPriceV4: streamingPriceFilter.checked,
      showKeepAlives: keepAliveFilter.checked,
      resourceFilters: [...activeResourceFilters],
      autoScroll: autoScrollEnabled,
    } satisfies UiPreferences))
  } catch {
    // Preferences are optional in restricted webviews.
  }
}

function setTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme
  themeToggle.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode'
  themeToggle.setAttribute('aria-pressed', String(theme === 'dark'))
}

const savedUiPreferences = readUiPreferences()
setTheme(savedUiPreferences.theme === 'light' ? 'light' : 'dark')
searchInput.value = savedUiPreferences.search ?? ''
protocolFilter.value = savedUiPreferences.protocol && [...protocolFilter.options].some((option) => option.value === savedUiPreferences.protocol)
  ? savedUiPreferences.protocol
  : 'all'
decodeFilter.value = savedUiPreferences.decodeState && [...decodeFilter.options].some((option) => option.value === savedUiPreferences.decodeState)
  ? savedUiPreferences.decodeState
  : 'all'
anomalyFilter.checked = savedUiPreferences.anomaliesOnly === true
errorsOnlyFilter.checked = savedUiPreferences.errorsOnly === true
deadCallsFilter.checked = savedUiPreferences.deadCallsOnly === true
streamingPriceFilter.checked = savedUiPreferences.showStreamingPriceV4 !== false
keepAliveFilter.checked = savedUiPreferences.showKeepAlives ?? savedUiPreferences.showKeepAliveAcks === true
activeResourceFilters = new Set((savedUiPreferences.resourceFilters ?? []).filter((filter) => filter !== 'all'))
autoScrollEnabled = savedUiPreferences.autoScroll !== false
autoScrollToggle.checked = autoScrollEnabled
updateResourceFilterButtons()

function emptyTrafficSummary(): ProxyEventSummary {
  return {
    total: 0,
    http_requests: 0,
    http_responses: 0,
    websocket_messages: 0,
    websocket_active_connections: 0,
    websocket_opened_connections: 0,
    websocket_errors: 0,
    http_exchanges: [],
    websocket_message_previews: [],
    events: [],
  }
}

function renderCaptureMode() {
  captureModeButtons.forEach((button) => {
    const active = button.dataset.captureMode === captureMode
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })

  packetLogStatus.textContent = captureMode === 'log'
    ? latestImportedSummary ? 'Reading imported packet-log traffic.' : 'Read log mode is active. Open a packet log to populate Traffic.'
    : 'Live proxy traffic is active.'
}

async function setCaptureMode(mode: CaptureMode) {
  captureMode = mode
  renderCaptureMode()

  if (captureMode === 'log') {
    renderEvents(latestImportedSummary ?? emptyTrafficSummary())
    return
  }

  if (latestLiveSummary) {
    renderEvents(latestLiveSummary)
  } else {
    await refresh()
  }
}

async function refresh() {
  if (refreshInFlight) {
    return
  }

  refreshInFlight = true

  try {
    await refreshProxy()
  } finally {
    refreshInFlight = false
  }
}

async function refreshProxy() {
  const status = await invoke<ProxyStatus>('proxy_status')
  const schemaStatus = await invoke<ProtoSchemaStatus | null>('proto_schema_status')
  const schemaBundles = await invoke<ProtoSchemaStatus[]>('proto_schema_bundles')
  const mappings = await invoke<WebSocketProtoMapping[]>('websocket_proto_mappings')
  proxyRunning = status.running
  renderProtoSchemaStatus(schemaStatus)
  renderProtoSchemaBundles(schemaBundles)
  renderWebSocketMappings(mappings)

  proxyState.textContent = status.running ? 'Proxy running' : 'Proxy stopped'
  proxyState.dataset.state = status.running ? 'running' : 'stopped'
  toggleProxyButton.textContent = status.running ? 'Stop' : 'Start'
  runtimeProxyState.textContent = status.running ? 'Running' : 'Stopped'
  proxyMode.textContent = status.running ? 'Passthrough' : 'Stopped'
  proxyAddress.textContent = status.addr ?? '-'
  proxyCa.textContent = status.ca_der_len === null ? '-' : `${status.ca_der_len} bytes`
  caStorage.textContent = status.ca_storage_status ?? '-'
  caStorage.title = status.ca_cert_path ?? ''
  exportCaButton.disabled = status.ca_der_len === null
  trustCaButton.disabled = status.ca_der_len === null

  if (status.startup_error) {
    clientConfig.textContent = status.startup_error
    browserSetupStatus.textContent = status.startup_error
  } else if (status.addr) {
    clientConfig.textContent = `Set HTTP_PROXY and HTTPS_PROXY to http://${status.addr}. Keep application URLs pointed at their real destinations.`
    browserSetupStatus.textContent = 'Use Trust CA on Windows, or export the CA and trust the .cer manually for browser testing.'
  } else {
    clientConfig.textContent = 'The proxy is not running.'
    browserSetupStatus.textContent = 'The proxy is not running.'
  }
  renderBrowserSetup(status)

  if (captureMode === 'log') {
    renderEvents(latestImportedSummary ?? emptyTrafficSummary())
    return
  }

  if (!status.running) {
    renderEvents(emptyTrafficSummary())
    return
  }

  const summary = await invoke<ProxyEventSummary>('proxy_events')
  renderEvents(summary)
}

function renderEvents(summary: ProxyEventSummary) {
  if (captureMode === 'live') {
    latestLiveSummary = summary
  }
  latestExchanges = summary.http_exchanges
  latestWebSocketPreviews = summary.websocket_message_previews
  const shouldAutoScroll = autoScrollEnabled && autoScrollExchanges
  eventTotal.textContent = String(summary.total)
  httpRequests.textContent = String(summary.http_requests)
  httpResponses.textContent = String(summary.http_responses)
  websocketMessages.textContent = String(summary.websocket_messages)
  websocketActive.textContent = String(summary.websocket_active_connections)
  websocketOpened.textContent = String(summary.websocket_opened_connections)
  websocketErrors.textContent = String(summary.websocket_errors)
  websocketState.dataset.state = summary.websocket_active_connections > 0 ? 'active' : 'idle'
  websocketState.lastElementChild!.textContent = captureMode === 'log'
    ? 'Imported log'
    : summary.websocket_active_connections > 0
      ? `${summary.websocket_active_connections} WebSocket${summary.websocket_active_connections === 1 ? '' : 's'}`
      : 'No WebSockets'
  renderTrafficMessages()
  renderSelectedTraffic()
  if (activeView === 'timeline') {
    renderTimeline()
  } else if (activeView === 'heatmap') {
    renderHeatmap()
  }
  scrollExchangeTableIfNeeded(shouldAutoScroll)

  const diagnosticsScrollTop = eventsList.scrollTop
  eventsList.innerHTML = summary.events
    .slice(-12)
    .reverse()
    .map((event) => {
      const target = event.path ?? event.authority ?? '-'
      const connection = event.connection_id ? `Connection ${shortConnectionId(event.connection_id)}` : 'Connection'
      const primary = event.protocol === 'Http'
        ? `${event.method ?? event.status ?? 'HTTP'} ${target}`
        : websocketEventLabel(event, connection)
      const category = event.protocol === 'WebSocket' && event.direction === 'Internal'
        ? 'WebSocket Lifecycle'
        : `${event.protocol} ${event.direction}`

      return `
        <li>
          <span>${category}</span>
          <strong>${escapeHtml(primary)}</strong>
        </li>
      `
    })
    .join('')
  eventsList.scrollTop = diagnosticsScrollTop
}

function renderSelectedWebSocketPreview() {
  const preview = latestWebSocketPreviews.find((item) => item.id === selectedWebSocketPreviewId)

  if (!preview) {
    selectedExchangeKind.textContent = 'No selection'
    copySelectedTrafficButton.disabled = true
    selectedWebSocketDecode = null
    exchangeDetail.textContent = 'Select a traffic row to inspect request, response, payload preview, and anomalies.'
    return
  }

  selectedExchangeKind.textContent = preview.payload_hint.likely_protocol
  copySelectedTrafficButton.disabled = false
  const activeDecode = selectedWebSocketDecode ?? preview.payload_decode
  const canDecodeFrame = latestSchemaStatus !== null && preview.source === null
  renderProtoMessageOptions(messageNamesForPreview(preview))
  exchangeDetail.innerHTML = `
    <div class="schema-decode-controls">
      <label class="field">
        <span>Decode selected frame as</span>
        <input
          id="websocket-message-type"
          type="text"
          list="proto-message-name-options"
          placeholder="package.MessageName"
          value="${escapeHtml(selectedWebSocketDecodeMessage)}"
          ${canDecodeFrame ? '' : 'disabled'}
        >
      </label>
      <button id="decode-websocket-frame" class="primary-button" type="button" ${canDecodeFrame ? '' : 'disabled'}>Decode Frame</button>
      <button id="save-websocket-mapping-from-frame" type="button" ${canDecodeFrame ? '' : 'disabled'}>Save Mapping</button>
      <label class="field">
        <span>Decoded export path</span>
        <input
          id="decoded-websocket-export-path"
          type="text"
          placeholder="C:\\Temp\\protobuf-decoder-decoded-websocket-message.json"
          ${canDecodeFrame ? '' : 'disabled'}
        >
      </label>
      <button id="export-decoded-websocket-frame" type="button" ${canDecodeFrame ? '' : 'disabled'}>Export Decoded JSON</button>
      <p id="websocket-schema-decode-status" class="status-message">${preview.source ? 'Imported packet-log payload is decoded from the loaded descriptor set.' : latestSchemaStatus ? 'Choose a loaded message type for this frame.' : 'Load a descriptor set in Schemas before schema-aware frame decoding.'}</p>
    </div>
    <dl class="detail-grid">
      <div><dt>Direction</dt><dd>${escapeHtml(directionLabel(preview.direction))}</dd></div>
      <div><dt>Kind</dt><dd>${escapeHtml(preview.message_kind ?? '-')}</dd></div>
      <div><dt>Target</dt><dd>${serverBadge(preview.authority, websocketTarget(preview))}</dd></div>
      <div><dt>Size</dt><dd>${byteLabel(preview.body_len)}</dd></div>
      <div><dt>Type</dt><dd>${escapeHtml(preview.payload_hint.likely_protocol)}</dd></div>
      <div><dt>Decode</dt><dd>${escapeHtml(activeDecode.status)}</dd></div>
      <div><dt>Connection</dt><dd>${escapeHtml(preview.connection_id)}</dd></div>
      ${preview.source ? `<div><dt>Source</dt><dd title="${escapeHtml(preview.source)}">${escapeHtml(preview.source)}</dd></div>` : ''}
      <div><dt>Captured</dt><dd>${formatTime(preview.timestamp_unix_ms)}</dd></div>
    </dl>
  `
  renderSelectedDecodedPayload(activeDecode)
  bindWebSocketDecodeControls(preview)
}

function renderTrafficMessages() {
  const allRows = trafficRows()
  currentTrafficPairs = buildTrafficPairMap(allRows)
  const visibleRows = filteredTrafficRows()
  const sortedRows = sortTrafficRows(visibleRows)
  const scrollTopBeforeRender = exchangeTableWrap.scrollTop
  const shouldPreserveScroll = !autoScrollEnabled || !autoScrollExchanges
  const decodedRows = allRows.filter((row) => {
    const decode = trafficRowDecode(row)
    return payloadDecodeState(decode) === 'decoded'
  }).length
  const anomalies = allRows.reduce((count, row) => count + trafficRowAnomalies(row).length, 0)
  const scrollStatus = autoScrollEnabled
    ? autoScrollExchanges ? 'auto-scroll follows new messages' : 'auto-scroll paused; use the toggle to resume'
    : 'auto-scroll is off'

  updateSortHeaders()
  trafficSummary.textContent = `${visibleRows.length} visible of ${allRows.length} traffic messages, ${resourceFilterSummary()}. ${sortDescription()}; ${scrollStatus}.`
  summaryMessages.textContent = String(allRows.length)
  summaryDecoded.textContent = String(decodedRows)
  summaryAnomalies.textContent = String(anomalies)
  summaryWebSockets.textContent = String(latestWebSocketPreviews.length)
  summaryFilters.textContent = activeResourceFilters.size === 0
    ? `${protocolFilter.value === 'all' ? 'All payload types' : protocolFilter.value}${decodeFilter.value === 'all' ? '' : `, ${decodeFilter.value}`}${anomalyFilter.checked ? ', anomalies' : ''}${errorsOnlyFilter.checked ? ', errors' : ''}${deadCallsFilter.checked ? ', dead calls' : ''}${streamingPriceFilter.checked ? '' : ', StreamingPriceV4 hidden'}${keepAliveFilter.checked ? '' : ', keep-alives hidden'}`
    : `${resourceFilterSummary()}${decodeFilter.value === 'all' ? '' : `, ${decodeFilter.value}`}${anomalyFilter.checked ? ', anomalies' : ''}${errorsOnlyFilter.checked ? ', errors' : ''}${deadCallsFilter.checked ? ', dead calls' : ''}${streamingPriceFilter.checked ? '' : ', StreamingPriceV4 hidden'}${keepAliveFilter.checked ? '' : ', keep-alives hidden'}`
  analyseSelectionButton.disabled = visibleRows.length === 0

  if (sortedRows.length === 0) {
    selectedTrafficKey = null
    selectedExchangeId = null
    selectedWebSocketPreviewId = null
    selectedWebSocketDecode = null
    trafficMessages.innerHTML = '<tr><td colspan="10">No matching traffic messages.</td></tr>'
    return
  }

  if (!selectedTrafficKey || !sortedRows.some((row) => trafficRowKey(row) === selectedTrafficKey)) {
    const newest = visibleRows.reduce((latest, row) => trafficRowTimestamp(row) > trafficRowTimestamp(latest) ? row : latest)
    selectedTrafficKey = trafficRowKey(newest)
  }

  const viewportRows = Math.max(12, Math.ceil(exchangeTableWrap.clientHeight / TRAFFIC_ROW_HEIGHT))
  const firstIndex = Math.max(0, Math.floor(scrollTopBeforeRender / TRAFFIC_ROW_HEIGHT) - TRAFFIC_ROW_OVERSCAN)
  const lastIndex = Math.min(sortedRows.length, firstIndex + viewportRows + (TRAFFIC_ROW_OVERSCAN * 2))
  const visibleWindow = sortedRows.slice(firstIndex, lastIndex)
  const topSpacer = firstIndex > 0
    ? `<tr class="traffic-virtual-spacer" aria-hidden="true"><td colspan="10" style="height: ${firstIndex * TRAFFIC_ROW_HEIGHT}px"></td></tr>`
    : ''
  const bottomSpacer = sortedRows.length > lastIndex
    ? `<tr class="traffic-virtual-spacer" aria-hidden="true"><td colspan="10" style="height: ${(sortedRows.length - lastIndex) * TRAFFIC_ROW_HEIGHT}px"></td></tr>`
    : ''

  trafficMessages.innerHTML = topSpacer + visibleWindow
    .map((row) => {
      const pair = trafficPairForRow(row)
      const source = row.kind === 'websocket' ? row.preview.source : null
      return `
      <tr class="${trafficRowKey(row) === selectedTrafficKey ? 'selected' : ''}${pair ? ` paired-row pair-tone-${pair.tone}` : ''}" data-traffic-key="${escapeHtml(trafficRowKey(row))}" title="${escapeHtml([trafficRowHost(row), source, pair ? `paired with message #${pair.messageId}` : null].filter(Boolean).join('; '))}">
        <td>${escapeHtml(trafficRowName(row))}${pair ? `<span class="pair-badge" title="Matched by request message number">Pair #${escapeHtml(String(pair.messageId))}</span>` : ''}</td>
        <td>${trafficRowStatus(row)}</td>
        <td>${payloadLabel(trafficRowPayloadHint(row), row.kind === 'http' ? row.part : null)}</td>
        <td>${escapeHtml(trafficRowDirection(row))}</td>
        <td>${byteLabel(trafficRowSize(row))}</td>
        <td>${escapeHtml(trafficRowDuration(row))}</td>
        <td>${escapeHtml(trafficRowMethod(row))}</td>
        <td>${serverBadge(trafficRowHost(row))}</td>
        <td>${decodeLabel(trafficRowDecode(row))}</td>
        <td>${trafficRowAnomalies(row).length > 0 ? anomalyLabels(trafficRowAnomalies(row)) : '<span class="muted">None</span>'}</td>
      </tr>
    `
    })
    .join('') + bottomSpacer

  if (shouldPreserveScroll) {
    programmaticExchangeScroll = true
    exchangeTableWrap.scrollTop = scrollTopBeforeRender
    window.setTimeout(() => {
      programmaticExchangeScroll = false
    }, 0)
  }
}

function renderSelectedTraffic() {
  const row = trafficRows().find((candidate) => trafficRowKey(candidate) === selectedTrafficKey)

  if (!row) {
    selectedExchangeId = null
    selectedWebSocketPreviewId = null
    selectedWebSocketDecode = null
    selectedExchangeKind.textContent = 'No selection'
    copySelectedTrafficButton.disabled = true
    exchangeDetail.textContent = 'Select a traffic row to inspect request, response, payload preview, and anomalies.'
    selectedDecodedKind.textContent = 'No selection'
    decodedMessageContent.textContent = 'Select a traffic row to inspect its decoded protobuf JSON.'
    selectedInspectorSignature = 'none'
    return
  }

  const payloadDecode = trafficRowDecode(row)
  const activeDecode = selectedWebSocketDecode ?? payloadDecode
  const signature = JSON.stringify({
    key: selectedTrafficKey,
    status: activeDecode.status,
    schemaMessage: activeDecode.schema_message,
    fieldCount: activeDecode.fields.length,
    jsonPreviewCount: activeDecode.json_previews.length,
    transport: row.kind === 'http'
      ? {
          status: row.exchange.status,
          duration: row.exchange.duration_ms,
          requestBody: row.exchange.request_body_len,
          responseBody: row.exchange.response_body_len,
          anomalies: row.exchange.anomalies.map((anomaly) => `${anomaly.kind}:${anomaly.summary}`),
          part: row.part,
        }
      : {
          timestamp: row.preview.timestamp_unix_ms,
          bodyLength: row.preview.body_len,
        },
  })
  if (signature === selectedInspectorSignature) {
    return
  }
  selectedInspectorSignature = signature

  if (row.kind === 'http') {
    selectedExchangeId = row.exchange.id
    selectedWebSocketPreviewId = null
    renderSelectedExchange()
  } else {
    selectedExchangeId = null
    selectedWebSocketPreviewId = row.preview.id
    renderSelectedWebSocketPreview()
  }
  renderSelectedDecodedPayload(activeDecode)
}

function renderSelectedDecodedPayload(payloadDecode: PayloadDecode) {
  const messageNames = applicationMessageEntries(payloadDecode).map((message) => friendlyMessageName(message.messageName))
  const fallbackName = payloadDecode.schema_message ? friendlyMessageName(payloadDecode.schema_message) : payloadDecode.direction ?? 'No payload'
  selectedDecodedKind.textContent = messageNames.length > 0 ? messageNames.join(', ') : fallbackName
  decodedMessageContent.innerHTML = payloadDecodePanel(payloadDecode)
}

function selectedTrafficCopyText() {
  const row = trafficRows().find((candidate) => trafficRowKey(candidate) === selectedTrafficKey)
  if (!row) {
    return null
  }

  const payloadDecode = row.kind === 'http'
    ? trafficRowDecode(row)
    : selectedWebSocketDecode ?? row.preview.payload_decode
  const applicationMessages = applicationMessageEntries(payloadDecode).map((message) => ({
    messageType: friendlyMessageName(message.messageName),
    protobufType: message.messageName,
    fields: protobufFieldsToObject(message.fields),
  }))

  return JSON.stringify({
    messageType: payloadDecode.schema_message ? friendlyMessageName(payloadDecode.schema_message) : null,
    protobufType: payloadDecode.schema_message,
    status: payloadDecode.status,
    direction: row.kind === 'http' ? trafficRowDirection(row) : directionLabel(row.preview.direction),
    part: row.kind === 'http' ? row.part : null,
    target: trafficRowHost(row),
    path: row.kind === 'http' ? row.exchange.path : row.preview.path,
    messages: applicationMessages.length > 0 ? applicationMessages : protobufFieldsToObject(payloadDecode.fields),
  }, null, 2)
}

async function copyTextToClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

function renderSelectedExchange() {
  const exchange = latestExchanges.find((item) => item.id === selectedExchangeId)

  if (!exchange) {
    selectedExchangeKind.textContent = 'No selection'
    copySelectedTrafficButton.disabled = true
    exchangeDetail.textContent = 'Select a traffic row to inspect request, response, payload preview, and anomalies.'
    return
  }

  selectedExchangeKind.textContent = exchange.payload_hint.likely_protocol
  copySelectedTrafficButton.disabled = false
  exchangeDetail.innerHTML = `
    <div class="traffic-detail-split">
      <section class="detail-pane">
        <div class="panel-heading">
          <h3>Request</h3>
          <span class="small-value">${escapeHtml(exchange.method ?? '-')}</span>
        </div>
        <dl class="detail-grid single">
          <div><dt>URL</dt><dd>${escapeHtml(exchange.scheme ?? '-')}://${escapeHtml(exchange.authority ?? '-')}${escapeHtml(exchange.path ?? '')}</dd></div>
          <div><dt>Host</dt><dd>${serverBadge(exchange.authority)}</dd></div>
          <div><dt>Body</dt><dd>${byteLabel(exchange.request_body_len)}</dd></div>
          <div><dt>Content type</dt><dd>${escapeHtml(exchange.payload_hint.request_content_type ?? '-')}</dd></div>
          <div><dt>Message</dt><dd>${escapeHtml(payloadDecodeName(exchange.request_payload_decode))}</dd></div>
          <div><dt>Decode</dt><dd>${escapeHtml(exchange.request_payload_decode.status)}</dd></div>
          <div class="detail-wide">${headerPreview('Request headers', exchange.request_headers)}</div>
        </dl>
      </section>
      <section class="detail-pane">
        <div class="panel-heading">
          <h3>Response</h3>
          <span class="small-value">${exchange.status ?? 'Pending'}</span>
        </div>
        <dl class="detail-grid single">
          <div><dt>Status</dt><dd>${exchange.status ?? 'Pending'}</dd></div>
          <div><dt>Time</dt><dd>${durationLabel(exchange.duration_ms)}</dd></div>
          <div><dt>Size</dt><dd>${byteLabel(exchange.response_body_len)}</dd></div>
          <div><dt>Server time</dt><dd>${escapeHtml(exchange.server_time ?? '-')}</dd></div>
          <div><dt>Content type</dt><dd>${escapeHtml(exchange.payload_hint.response_content_type ?? '-')}</dd></div>
          <div><dt>Message</dt><dd>${escapeHtml(exchange.response_payload_decode ? payloadDecodeName(exchange.response_payload_decode) : '-')}</dd></div>
          <div><dt>Decode</dt><dd>${escapeHtml(exchange.response_payload_decode?.status ?? 'No response body to decode')}</dd></div>
          <div><dt>Anomalies</dt><dd>${anomalyLabels(exchange.anomalies)}</dd></div>
          <div class="detail-wide">${headerPreview('Response headers', exchange.response_headers)}</div>
        </dl>
      </section>
    </div>
  `
}

function payloadDecodeName(payloadDecode: PayloadDecode) {
  const names = applicationMessageEntries(payloadDecode).map((message) => friendlyMessageName(message.messageName))
  return names.length > 0 ? names.join(', ') : payloadDecode.schema_message ? friendlyMessageName(payloadDecode.schema_message) : '-'
}

function headerPreview(label: string, headers: Record<string, string>) {
  const count = Object.keys(headers).length
  return `
    <dt>${escapeHtml(label)}</dt>
    <dd>
      <details class="raw-protobuf-preview">
        <summary>${count.toLocaleString()} header${count === 1 ? '' : 's'}</summary>
        <pre class="json-preview">${escapeHtml(JSON.stringify(headers, null, 2))}</pre>
      </details>
    </dd>
  `
}

function jsonPreviewPanel(payloadDecode: PayloadDecode) {
  if (payloadDecode.json_previews.length === 0) {
    return ''
  }

  return `
    <details class="decoded-secondary">
      <summary>
        <span>Wire JSON preview</span>
        <span class="small-value">${payloadDecode.json_previews.length} payload(s)</span>
      </summary>
      <div class="decoded-secondary-content">
        ${payloadDecode.json_previews
          .map((preview) => `
            <div class="json-preview-block">
              <div class="json-preview-heading">
                <strong>${escapeHtml(preview.direction)}</strong>
                <span>${escapeHtml(preview.status)}</span>
              </div>
              ${preview.preview ? `<pre class="json-preview">${escapeHtml(preview.preview)}</pre>` : ''}
            </div>
          `)
          .join('')}
      </div>
    </details>
  `
}

function payloadDecodePanel(payloadDecode: PayloadDecode) {
  const applicationMessages = applicationMessageEntries(payloadDecode)

  if (applicationMessages.length === 0 && (!payloadDecode.schema_message || payloadDecode.fields.length === 0)) {
    return `
      ${jsonPreviewPanel(payloadDecode)}
      <div class="decode-preview">
        <div class="panel-heading">
          <h3>Payload Preview</h3>
          <span class="small-value">${escapeHtml(payloadDecode.schema_message ?? payloadDecode.direction ?? 'No payload')}</span>
        </div>
        <p>${escapeHtml(payloadDecode.status)}</p>
        ${protobufFieldTable(payloadDecode.fields)}
      </div>
    `
  }

  const messageJson = applicationMessages.length > 0
    ? applicationMessages.map((message) => ({
        messageType: friendlyMessageName(message.messageName),
        protobufType: message.messageName,
        fields: protobufFieldsToObject(message.fields),
      }))
    : [{
        messageType: payloadDecode.schema_message ? friendlyMessageName(payloadDecode.schema_message) : null,
        protobufType: payloadDecode.schema_message,
        fields: protobufFieldsToObject(payloadDecode.fields),
      }]
  const compactJson = JSON.stringify(messageJson)
  const formattedJson = JSON.stringify(messageJson, null, 2)
  const rawFieldsLabel = applicationMessages.length > 0 ? 'Raw envelope fields' : 'Raw protobuf fields'
  const jsonOutput = decodedJsonMode === 'string' ? compactJson : formattedJson
  const jsonOutputLabel = decodedJsonMode === 'string' ? 'JSON string' : 'Formatted JSON'

  return `
    <div class="decode-preview">
      <div class="json-output-block">
        <div class="json-preview-heading">
          <strong>Decoded JSON</strong>
          <div class="view-switch" role="group" aria-label="Decoded JSON view">
            <button class="view-button ${decodedJsonMode === 'string' ? 'active' : ''}" type="button" data-json-view="string">String</button>
            <button class="view-button ${decodedJsonMode === 'formatted' ? 'active' : ''}" type="button" data-json-view="formatted">Formatted</button>
          </div>
        </div>
        <pre class="${decodedJsonMode === 'string' ? 'json-compact' : 'decoded-json'}" aria-label="${jsonOutputLabel}">${escapeHtml(jsonOutput)}</pre>
      </div>
      <p>${escapeHtml(payloadDecode.status)}</p>
      ${jsonPreviewPanel(payloadDecode)}
      <details class="raw-protobuf-preview">
        <summary>${rawFieldsLabel}</summary>
        ${protobufFieldTable(payloadDecode.fields)}
      </details>
    </div>
  `
}

function applicationMessageEntries(payloadDecode: PayloadDecode) {
  return payloadDecode.fields.flatMap((field) => {
    const match = field.field_name?.match(/^messageList\[\d+\]\.payload \((.+)\)$/)
    return match ? [{ messageName: match[1], fields: field.nested_fields }] : []
  })
}

type ApplicationMessageMetadata = {
  messageId: number | null
  requestMessageId: number | null
  messageType: number | null
  messageName: string | null
}

type TrafficPairInfo = {
  messageId: number
  tone: number
}

function numericProtobufField(fields: ProtobufFieldPreview[], name: string) {
  const field = fields.find((candidate) => candidate.field_name === name)
  if (!field || !/^-?\d+(\.\d+)?$/.test(field.value_preview)) {
    return null
  }

  const value = Number(field.value_preview)
  return Number.isFinite(value) ? value : null
}

function applicationMessageMetadata(payloadDecode: PayloadDecode): ApplicationMessageMetadata[] {
  const messageList = payloadDecode.fields.find((field) => field.field_name === 'messageList')
  if (!messageList) {
    return []
  }

  return messageList.nested_fields
    .filter((field) => /^messageList\[\d+\]$/.test(field.field_name ?? ''))
    .map((field) => {
      const index = Number(field.field_name?.match(/\[(\d+)\]$/)?.[1] ?? -1)
      const decodedPayload = payloadDecode.fields.find((candidate) => candidate.field_name?.startsWith(`messageList[${index}].payload (`))
      const decodedName = decodedPayload?.field_name?.match(/^messageList\[\d+\]\.payload \((.+)\)$/)?.[1] ?? null
      return {
        messageId: numericProtobufField(field.nested_fields, 'messageId'),
        requestMessageId: numericProtobufField(field.nested_fields, 'requestMessageId'),
        messageType: numericProtobufField(field.nested_fields, 'messageType'),
        messageName: decodedName,
      }
    })
}

function trafficPairTone(pairKey: string) {
  let hash = 0
  for (const character of pairKey) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0
  }

  return Math.abs(hash) % 5
}

function buildTrafficPairMap(rows: TrafficRow[]) {
  const requests = new Map<string, TrafficRow>()
  const pairs = new Map<string, TrafficPairInfo>()

  rows.forEach((row) => {
    if (row.kind !== 'websocket' || row.preview.direction !== 'Request') {
      return
    }

    applicationMessageMetadata(row.preview.payload_decode).forEach((message) => {
      if (message.messageId !== null) {
        requests.set(`${row.preview.connection_id}:${message.messageId}`, row)
      }
    })
  })

  rows.forEach((row) => {
    if (row.kind !== 'websocket' || row.preview.direction !== 'Response') {
      return
    }

    applicationMessageMetadata(row.preview.payload_decode).forEach((message) => {
      if (message.requestMessageId === null) {
        return
      }

      const pairKey = `${row.preview.connection_id}:${message.requestMessageId}`
      const request = requests.get(pairKey)
      if (!request || trafficRowKey(request) === trafficRowKey(row)) {
        return
      }

      const pair = {
        messageId: message.requestMessageId,
        tone: trafficPairTone(pairKey),
      }
      pairs.set(trafficRowKey(request), pair)
      pairs.set(trafficRowKey(row), pair)
    })
  })

  return pairs
}

function trafficPairForRow(row: TrafficRow) {
  return currentTrafficPairs.get(trafficRowKey(row)) ?? null
}

function friendlyMessageName(messageName: string) {
  const shortName = shortMessageName(messageName)
  if (shortName.startsWith('StreamingActiveOrders')) {
    return 'Open Orders Streaming Update'
  }

  return shortName.replace(/Proto$/, '')
}

function protobufFieldsToObject(fields: ProtobufFieldPreview[]): Record<string, unknown> {
  const object: Record<string, unknown> = {}

  for (const field of fields) {
    const name = field.field_name ?? `field_${field.field_number}`
    const repeatedChildren = field.nested_fields.filter((child) => child.field_name?.startsWith(`${name}[`))

    if (repeatedChildren.length > 0) {
      object[name] = protobufRepeatedFieldsToValue(repeatedChildren)
    } else if (field.nested_fields.length > 0) {
      object[name] = protobufFieldsToObject(field.nested_fields)
    } else {
      object[name] = protobufPreviewValue(field.value_preview)
    }
  }

  return object
}

function protobufRepeatedFieldsToValue(fields: ProtobufFieldPreview[]) {
  const indexed = fields
    .map((field) => ({
      field,
      index: Number(field.field_name?.match(/\[(\d+)\]$/)?.[1] ?? -1),
    }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)

  if (indexed.length !== fields.length) {
    return fields.map((field) => protobufPreviewValue(field.value_preview))
  }

  return indexed.map(({ field }) => field.nested_fields.length > 0
    ? protobufFieldsToObject(field.nested_fields)
    : protobufPreviewValue(field.value_preview))
}

function protobufPreviewValue(value: string): unknown {
  if (value === 'true' || value === 'false') {
    return value === 'true'
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value)
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  return value
}

function protobufFieldTable(fields: ProtobufFieldPreview[]) {
  if (fields.length === 0) {
    return ''
  }

  return `
    <table class="decode-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Wire</th>
          <th>Preview</th>
        </tr>
      </thead>
      <tbody>
        ${protobufFieldRows(fields, 0)}
      </tbody>
    </table>
  `
}

function protobufFieldRows(fields: ProtobufFieldPreview[], depth: number): string {
  return fields
    .map((field) => `
      <tr class="${depth > 0 ? 'nested-field' : ''}">
        <td style="--field-depth: ${depth}">${escapeHtml(field.field_name ? `${field.field_name} #${field.field_number}` : String(field.field_number))}</td>
        <td>${escapeHtml(field.wire_type_name)} (${field.wire_type})</td>
        <td>${escapeHtml(field.value_preview)}</td>
      </tr>
      ${protobufFieldRows(field.nested_fields, depth + 1)}
    `)
    .join('')
}

function bindWebSocketDecodeControls(preview: WebSocketMessagePreview) {
  const messageTypeInput = document.querySelector<HTMLInputElement>('#websocket-message-type')
  const decodeButton = document.querySelector<HTMLButtonElement>('#decode-websocket-frame')
  const saveMappingButton = document.querySelector<HTMLButtonElement>('#save-websocket-mapping-from-frame')
  const exportPathInput = document.querySelector<HTMLInputElement>('#decoded-websocket-export-path')
  const exportButton = document.querySelector<HTMLButtonElement>('#export-decoded-websocket-frame')
  const decodeStatus = document.querySelector<HTMLElement>('#websocket-schema-decode-status')

  if (!messageTypeInput || !decodeButton || !saveMappingButton || !exportPathInput || !exportButton || !decodeStatus) {
    return
  }

  messageTypeInput.addEventListener('input', () => {
    selectedWebSocketDecodeMessage = messageTypeInput.value
  })

  decodeButton.addEventListener('click', async () => {
    const messageName = messageTypeInput.value.trim()

    if (!messageName) {
      decodeStatus.textContent = 'Enter a protobuf message type first.'
      return
    }

    decodeButton.disabled = true
    decodeButton.textContent = 'Decoding...'
    decodeStatus.textContent = ''

    try {
      selectedWebSocketDecodeMessage = messageName
      selectedWebSocketDecode = await invoke<PayloadDecode>('decode_websocket_message_as_proto', {
        previewId: preview.id,
        messageName,
      })
      renderSelectedWebSocketPreview()
    } catch (error) {
      decodeStatus.textContent = `Frame decode failed: ${String(error)}`
    } finally {
      decodeButton.disabled = false
      decodeButton.textContent = 'Decode Frame'
    }
  })

  saveMappingButton.addEventListener('click', async () => {
    const messageName = messageTypeInput.value.trim()

    if (!messageName) {
      decodeStatus.textContent = 'Enter a protobuf message type first.'
      return
    }

    saveMappingButton.disabled = true
    saveMappingButton.textContent = 'Saving...'
    decodeStatus.textContent = ''

    try {
      await addWebSocketMapping({
        name: `${shortServerName(preview.authority)} ${directionLabel(preview.direction)}`,
        hostMatchType: preview.authority ? 'exact' : 'any',
        hostMatchValue: preview.authority ? hostWithoutPort(preview.authority) : null,
        pathPrefix: preview.path ?? null,
        direction: directionNameForMapping(preview.direction),
        messageKind: preview.message_kind ?? null,
        messageName,
      })
      selectedWebSocketDecodeMessage = messageName
      decodeStatus.textContent = 'Saved mapping. Future matching frames will auto-decode.'
      await refresh()
    } catch (error) {
      decodeStatus.textContent = `Mapping save failed: ${String(error)}`
    } finally {
      saveMappingButton.disabled = false
      saveMappingButton.textContent = 'Save Mapping'
    }
  })

  exportButton.addEventListener('click', async () => {
    const messageName = messageTypeInput.value.trim()
    const path = exportPathInput.value.trim()

    if (!messageName) {
      decodeStatus.textContent = 'Enter a protobuf message type first.'
      return
    }

    if (!path) {
      decodeStatus.textContent = 'Enter a decoded export path first.'
      return
    }

    exportButton.disabled = true
    exportButton.textContent = 'Exporting...'
    decodeStatus.textContent = ''

    try {
      selectedWebSocketDecodeMessage = messageName
      const exportedPath = await invoke<string>('export_decoded_websocket_message', {
        previewId: preview.id,
        messageName,
        path,
      })
      decodeStatus.textContent = `Exported decoded message to ${exportedPath}`
    } catch (error) {
      decodeStatus.textContent = `Decoded export failed: ${String(error)}`
    } finally {
      exportButton.disabled = false
      exportButton.textContent = 'Export Decoded JSON'
    }
  })
}

function trafficRows(): TrafficRow[] {
  return [
    ...latestExchanges.flatMap((exchange) => [
      { kind: 'http' as const, part: 'request' as const, exchange },
      ...(exchange.response_payload_decode
        ? [{ kind: 'http' as const, part: 'response' as const, exchange }]
        : []),
    ]),
    ...latestWebSocketPreviews.map((preview) => ({ kind: 'websocket' as const, preview })),
  ]
}

function trafficRowKey(row: TrafficRow) {
  return row.kind === 'http'
    ? `${row.kind}:${row.exchange.id}:${row.part}`
    : `${row.kind}:${row.preview.id}`
}

function trafficRowTimestamp(row: TrafficRow) {
  if (row.kind !== 'http') {
    return row.preview.timestamp_unix_ms
  }

  return row.part === 'response'
    ? row.exchange.completed_at_unix_ms ?? row.exchange.started_at_unix_ms
    : row.exchange.started_at_unix_ms
}

function trafficRowName(row: TrafficRow) {
  if (row.kind === 'http') {
    return exchangeName(row.exchange)
  }

  return row.preview.message_kind ?? 'WebSocket frame'
}

function trafficRowDirection(row: TrafficRow) {
  if (row.kind === 'http') {
    return row.part === 'request' ? 'Request' : 'Response'
  }

  if (row.preview.direction === 'Request') {
    return 'Client -> server'
  }

  if (row.preview.direction === 'Response') {
    return 'Server push'
  }

  return 'Internal'
}

function trafficRowSize(row: TrafficRow) {
  if (row.kind !== 'http') {
    return row.preview.body_len
  }

  return row.part === 'request' ? row.exchange.request_body_len : row.exchange.response_body_len
}

function trafficRowDuration(row: TrafficRow) {
  return row.kind === 'http' && row.part === 'response' ? durationLabel(row.exchange.duration_ms) : '-'
}

function trafficRowMethod(row: TrafficRow) {
  if (row.kind === 'http') {
    return row.part === 'request' ? row.exchange.method ?? '-' : '-'
  }

  return row.preview.message_kind ?? 'Frame'
}

function trafficRowHost(row: TrafficRow) {
  return row.kind === 'http' ? row.exchange.authority ?? '-' : row.preview.authority ?? '-'
}

function trafficRowStatus(row: TrafficRow) {
  if (row.kind !== 'http') {
    return '<span class="muted">Frame</span>'
  }

  return row.part === 'request'
    ? '<span class="status-badge pending">Request</span>'
    : statusLabel(row.exchange.status)
}

function trafficRowPayloadHint(row: TrafficRow) {
  return row.kind === 'http' ? row.exchange.payload_hint : row.preview.payload_hint
}

function trafficRowDecode(row: TrafficRow) {
  if (row.kind !== 'http') {
    return row.preview.payload_decode
  }

  return row.part === 'request'
    ? row.exchange.request_payload_decode
    : row.exchange.response_payload_decode!
}

function trafficRowMessageNames(row: TrafficRow) {
  const payloadDecode = trafficRowDecode(row)
  const nestedNames = applicationMessageEntries(payloadDecode).map((message) => message.messageName)
  return nestedNames.length > 0
    ? nestedNames
    : payloadDecode.schema_message ? [payloadDecode.schema_message] : []
}

function protobufFieldSearchText(fields: ProtobufFieldPreview[]): string {
  return fields
    .flatMap((field) => [
      field.field_name,
      field.value_preview,
      protobufFieldSearchText(field.nested_fields),
    ])
    .filter(Boolean)
    .join(' ')
}

function payloadSearchText(payloadDecode: PayloadDecode) {
  return [
    payloadDecode.direction,
    payloadDecode.status,
    payloadDecode.schema_message,
    protobufFieldSearchText(payloadDecode.fields),
    ...payloadDecode.json_previews.flatMap((preview) => [preview.direction, preview.status, preview.preview]),
  ]
    .filter(Boolean)
    .join(' ')
}

function headersSearchText(headers: Record<string, string>) {
  return Object.entries(headers)
    .flatMap(([name, value]) => [name, value])
    .join(' ')
}

function trafficRowSearchText(row: TrafficRow) {
  const payloadDecode = trafficRowDecode(row)
  const exchangeText = row.kind === 'http'
    ? [
        row.exchange.id,
        headersSearchText(row.exchange.request_headers),
        headersSearchText(row.exchange.response_headers),
      ]
    : [row.preview.id, row.preview.connection_id, row.preview.source]

  return [
    trafficRowName(row),
    trafficRowDirection(row),
    trafficRowMethod(row),
    trafficRowHost(row),
    row.kind === 'http' ? row.exchange.scheme : row.preview.scheme,
    row.kind === 'http' ? row.exchange.path : row.preview.path,
    row.kind === 'http' && row.part === 'response' && row.exchange.status !== null ? String(row.exchange.status) : null,
    trafficRowPayloadHint(row).likely_protocol,
    trafficRowPayloadHint(row).decode_status,
    trafficRowPayloadHint(row).request_content_type,
    trafficRowPayloadHint(row).response_content_type,
    ...trafficRowAnomalies(row).map((anomaly) => `${anomaly.kind} ${anomaly.summary}`),
    payloadSearchText(payloadDecode),
    ...exchangeText,
  ]
    .filter(Boolean)
    .join(' ')
}

function isStreamingPriceV4Row(row: TrafficRow) {
  return trafficRowMessageNames(row).some((name) => name.toLowerCase().includes('streamingpricev4'))
}

function isKeepAliveRow(row: TrafficRow) {
  const names = trafficRowMessageNames(row).map((name) => name.toLowerCase())
  if (names.some((name) => name.includes('keepalive'))) {
    return true
  }

  if (row.kind !== 'http') {
    return false
  }

  const path = row.exchange.path?.toLowerCase() ?? ''
  return path.includes('keepalive')
}

function trafficRowAnomalies(row: TrafficRow) {
  return row.kind === 'http' && row.part === 'response' ? row.exchange.anomalies : []
}

type DecodeState = 'decoded' | 'partial' | 'undecoded' | 'error'

function payloadDecodeState(payloadDecode: PayloadDecode): DecodeState {
  const status = payloadDecode.status.toLowerCase()
  if (/(failed|error|malformed|invalid)/.test(status)) {
    return 'error'
  }

  if (status.includes('not decoded') || status.includes('no descriptor') || status.includes('wire preview')) {
    return 'partial'
  }

  if (applicationMessageEntries(payloadDecode).length > 0 || payloadDecode.schema_message !== null || payloadDecode.json_previews.length > 0) {
    return 'decoded'
  }

  return 'undecoded'
}

function trafficRowHasError(row: TrafficRow) {
  const decodeState = payloadDecodeState(trafficRowDecode(row))
  if (decodeState === 'error') {
    return true
  }

  if (row.kind === 'http' && row.part === 'response' && row.exchange.status !== null && row.exchange.status >= 400) {
    return true
  }

  return trafficRowAnomalies(row).some((anomaly) => anomaly.kind === 'http_4xx' || anomaly.kind === 'http_5xx')
}

function trafficRowIsDeadCall(row: TrafficRow) {
  return row.kind === 'http' && row.part === 'request' && row.exchange.response_payload_decode === null
}

function filteredTrafficRows() {
  const search = searchInput.value.trim().toLowerCase()
  const protocol = protocolFilter.value
  const selectedDecodeFilter = decodeFilter.value as DecodeFilter
  const anomaliesOnly = anomalyFilter.checked

  return trafficRows().filter((row) => {
    if (!streamingPriceFilter.checked && isStreamingPriceV4Row(row)) {
      return false
    }

    if (!keepAliveFilter.checked && isKeepAliveRow(row)) {
      return false
    }

    if (!resourceFilterMatchesTrafficRow(row)) {
      return false
    }

    const payloadHint = trafficRowPayloadHint(row)
    const anomalies = trafficRowAnomalies(row)
    if (protocol !== 'all' && payloadHint.likely_protocol !== protocol) {
      return false
    }

    const decodeState = payloadDecodeState(trafficRowDecode(row))
    if (selectedDecodeFilter === 'decoded' && decodeState !== 'decoded') {
      return false
    }
    if (selectedDecodeFilter === 'undecoded' && decodeState === 'decoded') {
      return false
    }

    if (anomaliesOnly && anomalies.length === 0) {
      return false
    }

    if (errorsOnlyFilter.checked && !trafficRowHasError(row)) {
      return false
    }

    if (deadCallsFilter.checked && !trafficRowIsDeadCall(row)) {
      return false
    }

    if (!search) {
      return true
    }

    const haystack = trafficRowSearchText(row).toLowerCase()

    return haystack.includes(search)
  })
}

function filteredExchanges() {
  const visibleExchangeIds = new Set(
    filteredTrafficRows()
      .filter((row) => row.kind === 'http')
      .map((row) => row.exchange.id),
  )

  return latestExchanges.filter((exchange) => visibleExchangeIds.has(exchange.id))
}

function resourceFilterMatchesExchange(exchange: HttpExchange) {
  if (activeResourceFilters.size === 0) {
    return true
  }

  const resourceKind = resourceKindForExchange(exchange)
  return [...activeResourceFilters].some((filter) => resourceFilterMatchesHttpKind(filter, resourceKind))
}

function resourceFilterMatchesTrafficRow(row: TrafficRow) {
  if (activeResourceFilters.size === 0) {
    return true
  }

  if (row.kind === 'http') {
    return resourceFilterMatchesExchange(row.exchange)
  }

  return [...activeResourceFilters].some((filter) => {
    if (filter === 'ws') {
      return true
    }
    if (filter === 'protobuf') {
      return ['protobuf', 'grpc'].includes(row.preview.payload_hint.likely_protocol)
    }
    if (filter === 'json') {
      return row.preview.payload_hint.likely_protocol === 'json'
    }
    return false
  })
}

function resourceFilterMatchesHttpKind(filter: ResourceFilter, resourceKind: HttpResourceKind) {
  if (filter === 'ws') {
    return false
  }
  if (filter === 'protobuf') {
    return resourceKind === 'protobuf'
  }
  if (filter === 'json') {
    return resourceKind === 'json'
  }
  if (filter === 'fetch') {
    return ['fetch', 'json', 'protobuf'].includes(resourceKind)
  }
  return resourceKind === filter
}

function resourceKindForExchange(exchange: HttpExchange): HttpResourceKind {
  const protocol = exchange.payload_hint.likely_protocol
  if (protocol === 'protobuf' || protocol === 'grpc') {
    return 'protobuf'
  }
  if (protocol === 'json') {
    return 'json'
  }

  const contentType = (exchange.payload_hint.response_content_type ?? exchange.payload_hint.request_content_type ?? '').toLowerCase()
  const path = (exchange.path ?? '').split('?')[0].toLowerCase()
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.')) : ''

  if (contentType.includes('text/html') || extension === '.html' || extension === '.htm') {
    return 'document'
  }
  if (contentType.includes('javascript') || ['.js', '.mjs', '.cjs'].includes(extension)) {
    return 'js'
  }
  if (contentType.includes('text/css') || extension === '.css') {
    return 'css'
  }
  if (contentType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif'].includes(extension)) {
    return 'image'
  }
  if (contentType.startsWith('font/') || ['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(extension)) {
    return 'font'
  }
  if (contentType.startsWith('audio/') || contentType.startsWith('video/') || ['.mp4', '.webm', '.mp3', '.wav', '.m4a', '.mov'].includes(extension)) {
    return 'media'
  }
  if (exchange.method && !['GET', 'HEAD', 'OPTIONS'].includes(exchange.method.toUpperCase())) {
    return 'fetch'
  }

  return 'other'
}

function resourceFilterLabel(filter: ResourceFilter) {
  switch (filter) {
    case 'all':
      return 'all resources'
    case 'fetch':
      return 'Fetch/XHR'
    case 'document':
      return 'documents'
    case 'js':
      return 'JavaScript'
    case 'css':
      return 'CSS'
    case 'image':
      return 'images'
    case 'font':
      return 'fonts'
    case 'media':
      return 'media'
    case 'ws':
      return 'WebSocket'
    case 'protobuf':
      return 'protobuf'
    case 'json':
      return 'JSON'
    case 'other':
      return 'other'
  }
}

function resourceFilterSummary() {
  if (activeResourceFilters.size === 0) {
    return 'all resources'
  }

  return [...activeResourceFilters].map(resourceFilterLabel).join(', ')
}

function updateResourceFilterButtons() {
  resourceFilterButtons.forEach((button) => {
    const filter = button.dataset.resourceFilter as ResourceFilter | undefined
    const active = filter === 'all' ? activeResourceFilters.size === 0 : filter !== undefined && activeResourceFilters.has(filter)
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
}

function exchangeName(exchange: HttpExchange) {
  const path = exchange.path ?? '/'
  const cleanPath = path.split('?')[0]
  const segments = cleanPath.split('/').filter(Boolean)
  return segments.at(-1) ?? cleanPath ?? '/'
}

function exchangeInitiator(exchange: HttpExchange) {
  return exchange.server_time ? `server ${exchange.server_time}` : '-'
}

function sortExchanges(exchanges: HttpExchange[]) {
  return [...exchanges].sort((left, right) => {
    const result = compareSortValue(sortValue(left, sortKey), sortValue(right, sortKey))
    return sortDirection === 'asc' ? result : -result
  })
}

function sortValue(exchange: HttpExchange, key: SortKey): string | number {
  switch (key) {
    case 'started_at':
      return exchange.started_at_unix_ms
    case 'name':
      return exchangeName(exchange)
    case 'method':
      return exchange.method ?? ''
    case 'host':
      return exchange.authority ?? ''
    case 'status':
      return exchange.status ?? -1
    case 'type':
      return exchange.payload_hint.likely_protocol
    case 'initiator':
      return exchangeInitiator(exchange)
    case 'size':
      return exchange.response_body_len ?? -1
    case 'time':
      return exchange.duration_ms ?? -1
    case 'decode':
      return exchange.response_payload_decode?.status ?? exchange.request_payload_decode.status
    case 'anomalies':
      return exchange.anomalies.length
  }
}

function compareSortValue(left: string | number, right: string | number) {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }

  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
}

function sortDescription() {
  if (sortKey === 'started_at' && sortDirection === 'asc') {
    return 'Oldest first'
  }

  const label = sortHeaderLabel(sortKey)
  return `${label} ${sortDirection === 'asc' ? 'ascending' : 'descending'}`
}

function sortHeaderLabel(key: SortKey) {
  return key
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function updateSortHeaders() {
  sortHeaderButtons.forEach((button) => {
    const key = button.dataset.sortKey as SortKey | undefined
    const isActive = key === sortKey
    button.classList.toggle('active', isActive)
    button.textContent = `${sortHeaderLabel(key ?? 'started_at')}${isActive ? (sortDirection === 'asc' ? ' asc' : ' desc') : ''}`
  })
}

function payloadLabel(payloadHint: PayloadHint, side: HttpTrafficPart | null = null) {
  const contentType = side === 'request'
    ? payloadHint.request_content_type ?? '-'
    : side === 'response'
      ? payloadHint.response_content_type ?? '-'
      : payloadHint.response_content_type ?? payloadHint.request_content_type ?? '-'
  const normalizedContentType = contentType.toLowerCase().split(';', 1)[0].trim()
  const visibleContentType = normalizedContentType === 'application/octet-stream' ? null : contentType
  return `
    <span class="payload-kind ${escapeHtml(payloadHint.likely_protocol)}">${escapeHtml(payloadHint.likely_protocol)}</span>
    ${visibleContentType ? `<span class="content-type">${escapeHtml(visibleContentType)}</span>` : ''}
  `
}

function statusLabel(status: number | null) {
  if (status === null) {
    return '<span class="status-badge pending">Pending</span>'
  }

  const severity = status >= 500 ? 'high' : status >= 400 ? 'medium' : 'ok'
  return `<span class="status-badge ${severity}">${status}</span>`
}

function durationLabel(durationMs: number | null) {
  return durationMs === null ? '-' : `${durationMs} ms`
}

function byteLabel(bytes: number | null) {
  if (bytes === null) {
    return '-'
  }

  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`
  }

  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`
  }

  return `${bytes} B`
}

function formatTime(timestampUnixMs: number) {
  return new Date(timestampUnixMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

function anomalyLabels(anomalies: AnomalyFinding[]) {
  if (anomalies.length === 0) {
    return '<span class="muted">None</span>'
  }

  return anomalies
    .map((anomaly) => `<span class="anomaly ${escapeHtml(anomaly.severity)}" title="${escapeHtml(anomaly.summary)}">${escapeHtml(anomaly.kind)}</span>`)
    .join('')
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function websocketEventLabel(event: ProxyEvent, connection: string) {
  if (event.websocket_event_kind === 'Open') {
    return `${connection} opened ${event.authority ?? ''}`.trim()
  }

  if (event.websocket_event_kind === 'Close') {
    return `${connection} closed`
  }

  if (event.websocket_event_kind === 'Error') {
    return `${connection} error: ${event.websocket_error ?? 'unknown error'}`
  }

  return `${event.websocket_message_kind ?? 'Message'} ${event.body_len_hint ?? 0} bytes`
}

function directionLabel(direction: WebSocketMessagePreview['direction']) {
  if (direction === 'Request') {
    return 'client -> server'
  }

  if (direction === 'Response') {
    return 'server -> client'
  }

  return 'internal'
}

function directionNameForMapping(direction: WebSocketMessagePreview['direction']) {
  if (direction === 'Request') {
    return 'request'
  }

  if (direction === 'Response') {
    return 'response'
  }

  return 'internal'
}

function websocketTarget(preview: WebSocketMessagePreview) {
  return `${preview.scheme ?? 'ws'}://${preview.authority ?? '-'}${preview.path ?? ''}`
}

function serverBadge(authority: string | null, label?: string) {
  const server = authority ?? '-'
  const display = label ?? shortServerName(authority)
  return `
    <span class="server-badge server-${serverColorIndex(authority)}" title="${escapeHtml(server)}">
      <span class="server-dot" aria-hidden="true"></span>
      <span>${escapeHtml(display)}</span>
    </span>
  `
}

function serverDot(authority: string | null) {
  return `<span class="server-dot inline server-${serverColorIndex(authority)}" title="${escapeHtml(authority ?? '-')}"></span>`
}

function shortServerName(authority: string | null) {
  if (!authority) {
    return '-'
  }

  const host = authority.split(':')[0] ?? authority
  const cleanHost = host.startsWith('www.') ? host.slice(4) : host
  const parts = cleanHost.split('.').filter(Boolean)

  if (parts.length <= 2) {
    return cleanHost
  }

  return parts.slice(-2).join('.')
}

function serverColorIndex(authority: string | null) {
  const value = authority ?? '-'
  let hash = 0

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }

  return hash % 8
}

function shortConnectionId(connectionId: string) {
  const separator = connectionId.indexOf('->')
  return separator === -1 ? connectionId : connectionId.slice(0, separator)
}

function renderBrowserSetup(status: ProxyStatus) {
  edgeCommand.textContent = browserLaunchCommand('edge', status.addr)
  chromeCommand.textContent = browserLaunchCommand('chrome', status.addr)
}

function renderProtoSchemaStatus(status: ProtoSchemaStatus | null) {
  latestSchemaStatus = status
  if (!status) {
    protoSchemaSummary.textContent = 'No schema'
    schemaChip.textContent = 'No schema'
    protoSchemaStatus.textContent = 'Load a protoc FileDescriptorSet to enable schema-aware decoding.'
    protoMessageSamples.innerHTML = ''
    renderProtoMessageOptions([])
    return
  }

  protoSchemaSummary.textContent = `${status.message_count} messages`
  schemaChip.textContent = `${status.message_count} schema messages`
  const mappingSummary = status.application_mapping_count > 0
    ? ` ${status.application_mapping_count} application type/version mappings found.`
    : ' No application ordinal mappings found.'
  protoSchemaStatus.textContent = `Loaded ${status.file_count} files, ${status.message_count} messages, ${status.service_count} services from ${status.source_path}.${mappingSummary}`
  protoMessageSamples.innerHTML = status.sample_messages
    .map((messageName) => `<li>${escapeHtml(messageName)}</li>`)
    .join('')
  if (status.application_mapping_examples.length > 0) {
    protoMessageSamples.insertAdjacentHTML(
      'afterbegin',
      `<li class="schema-mapping-note">${escapeHtml(status.application_mapping_examples[0])}</li>`,
    )
  }
  renderProtoMessageOptions(status.message_names)
}

function renderProtoSchemaBundles(bundles: ProtoSchemaStatus[]) {
  latestSchemaBundles = bundles
  const messageCount = bundles.reduce((total, bundle) => total + bundle.message_count, 0)
  protoBundleCount.textContent = `${bundles.length} loaded`

  if (bundles.length === 0) {
    protoSchemaBundles.textContent = 'No schema bundles loaded.'
    return
  }

  protoSchemaSummary.textContent = `${bundles.length} bundle${bundles.length === 1 ? '' : 's'}`
  schemaChip.textContent = `${messageCount} schema messages`
  protoSchemaBundles.innerHTML = bundles
    .map((bundle) => `
      <article class="schema-bundle">
        <div>
          <strong>${escapeHtml(bundle.name)}</strong>
          <span>${escapeHtml(bundle.message_count.toString())} messages from ${escapeHtml(bundle.source_path)}</span>
        </div>
        <div class="schema-scope">
          ${schemaHostScopeLabel(bundle)}
          ${bundle.path_prefix ? `<code>${escapeHtml(bundle.path_prefix)}</code>` : ''}
        </div>
      </article>
    `)
    .join('')
}

function renderWebSocketMappings(mappings: WebSocketProtoMapping[]) {
  latestWebSocketMappings = mappings
  websocketMappingCount.textContent = `${mappings.length} rule${mappings.length === 1 ? '' : 's'}`

  if (mappings.length === 0) {
    websocketMappings.textContent = 'No WebSocket mappings.'
    return
  }

  websocketMappings.innerHTML = mappings
    .map((mapping) => `
      <article class="schema-bundle" data-websocket-mapping-id="${escapeHtml(mapping.id)}">
        <div>
          <strong>${escapeHtml(mapping.name)}</strong>
          <span>${escapeHtml(mappingDescription(mapping))}</span>
        </div>
        <div class="schema-scope">
          ${mappingHostScopeLabel(mapping)}
          ${mapping.path_prefix ? `<code>${escapeHtml(mapping.path_prefix)}</code>` : ''}
          ${mapping.direction ? `<code>${escapeHtml(directionScopeLabel(mapping.direction))}</code>` : ''}
          ${mapping.message_kind ? `<code>${escapeHtml(mapping.message_kind)}</code>` : ''}
        </div>
        <div class="schema-actions">
          <button class="quiet-button" type="button" data-edit-websocket-mapping="${escapeHtml(mapping.id)}">Edit</button>
          <button class="quiet-button danger-button" type="button" data-delete-websocket-mapping="${escapeHtml(mapping.id)}">Delete</button>
        </div>
      </article>
    `)
    .join('')
}

function updateWebSocketMappingStrategyFields() {
  const isEnvelope = websocketMappingDecodeStrategy.value === 'envelope'
  document.querySelectorAll<HTMLElement>('.envelope-mapping-field').forEach((field) => {
    field.hidden = !isEnvelope
  })
  websocketMappingMessageName.disabled = isEnvelope
}

function mappingDescription(mapping: WebSocketProtoMapping) {
  if (mapping.decode_strategy === 'envelope') {
    const envelope = mapping.envelope_message_name ?? 'Envelope'
    return `${envelope} -> nested payload map`
  }

  return mapping.message_name
}

function schemaHostScopeLabel(bundle: ProtoSchemaStatus) {
  if (bundle.host_match_type === 'any') {
    return '<span class="muted">Any host</span>'
  }

  const hostLabel = bundle.host_match_value ? serverBadge(bundle.host_match_value) : '<span class="muted">No host value</span>'
  return `<span class="scope-kind">${escapeHtml(bundle.host_match_type)}</span>${hostLabel}`
}

function mappingHostScopeLabel(mapping: WebSocketProtoMapping) {
  if (mapping.host_match_type === 'any') {
    return '<span class="muted">Any host</span>'
  }

  const hostLabel = mapping.host_match_value ? serverBadge(mapping.host_match_value) : '<span class="muted">No host value</span>'
  return `<span class="scope-kind">${escapeHtml(mapping.host_match_type)}</span>${hostLabel}`
}

function directionScopeLabel(direction: string) {
  if (direction === 'request') {
    return 'client -> server'
  }

  if (direction === 'response') {
    return 'server -> client'
  }

  return direction
}

function renderProtoMessageOptions(messageNames: string[]) {
  let datalist = document.querySelector<HTMLDataListElement>('#proto-message-name-options')

  if (!datalist) {
    datalist = document.createElement('datalist')
    datalist.id = 'proto-message-name-options'
    document.body.appendChild(datalist)
  }

  datalist.innerHTML = messageNames
    .map((messageName) => `<option value="${escapeHtml(messageName)}"></option>`)
    .join('')
}

function messageNamesForPreview(preview: WebSocketMessagePreview) {
  const matchingBundles = latestSchemaBundles.filter((bundle) => schemaBundleMatchesPreview(bundle, preview))
  const sourceBundles = matchingBundles.length > 0 ? matchingBundles : latestSchemaBundles
  const messageNames = sourceBundles.flatMap((bundle) => bundle.message_names)
  return [...new Set(messageNames)].sort()
}

function schemaBundleMatchesPreview(bundle: ProtoSchemaStatus, preview: WebSocketMessagePreview) {
  if (bundle.host_match_type !== 'any') {
    const previewHost = hostWithoutPort(preview.authority)
    const bundleHost = hostWithoutPort(bundle.host_match_value)

    if (!previewHost || !bundleHost) {
      return false
    }

    const hostMatches = bundle.host_match_type === 'exact'
      ? previewHost === bundleHost
      : bundle.host_match_type === 'suffix'
        ? previewHost.endsWith(bundleHost)
        : bundle.host_match_type === 'contains'
          ? previewHost.includes(bundleHost)
          : true

    if (!hostMatches) {
      return false
    }
  }

  if (bundle.path_prefix && !preview.path?.startsWith(bundle.path_prefix)) {
    return false
  }

  return true
}

function renderPacketLogImportReport(report: PacketLogImportReport) {
  const sourceCount = report.sources.length
  const recordCount = report.sources.reduce((total, source) => total + source.record_count, 0)
  const limitNote = report.records_skipped > 0
    ? ` Loaded ${report.records_loaded.toLocaleString()} into Traffic and skipped ${report.records_skipped.toLocaleString()} over the ${report.record_limit?.toLocaleString() ?? 'configured'}-record limit.`
    : ''
  packetLogStatus.textContent = `Scanned ${sourceCount} source${sourceCount === 1 ? '' : 's'} and ${recordCount.toLocaleString()} record${recordCount === 1 ? '' : 's'}.${limitNote} Cache: ${report.cache_directory}`
  packetLogResults.innerHTML = [
    ...report.sources.slice(0, 12).map((source) => `
      <div class="packet-log-result">
        <strong>${escapeHtml(source.format.toUpperCase())}</strong>
        <span>${source.record_count.toLocaleString()} records${source.records_skipped > 0 ? `, ${source.records_skipped.toLocaleString()} skipped` : ''}${source.malformed ? ' - malformed' : ''}</span>
        <small title="${escapeHtml(source.source)}">${escapeHtml(source.source)}</small>
        ${source.materialized_dat ? `<small>Cached as ${escapeHtml(source.materialized_dat)}</small>` : ''}
        ${source.warning ? `<small class="status-error">${escapeHtml(source.warning)}</small>` : ''}
      </div>
    `),
    report.sources.length > 12 ? `<small>Showing the first 12 sources.</small>` : '',
    ...report.errors.map((error) => `<small class="status-error">${escapeHtml(error)}</small>`),
  ].join('') || '<small>No packet-log entries found.</small>'
}

function sortTrafficRows(rows: TrafficRow[]) {
  return [...rows].sort((left, right) => {
    const result = compareSortValue(trafficSortValue(left, sortKey), trafficSortValue(right, sortKey))
    return sortDirection === 'asc' ? result : -result
  })
}

function trafficSortValue(row: TrafficRow, key: SortKey): string | number {
  if (row.kind === 'http') {
    switch (key) {
      case 'started_at':
        return trafficRowTimestamp(row)
      case 'name':
        return trafficRowName(row)
      case 'method':
        return trafficRowMethod(row)
      case 'host':
        return trafficRowHost(row)
      case 'status':
        return row.part === 'response' ? row.exchange.status ?? -1 : -1
      case 'type':
        return row.exchange.payload_hint.likely_protocol
      case 'initiator':
        return trafficRowDirection(row)
      case 'size':
        return trafficRowSize(row) ?? -1
      case 'time':
        return row.part === 'response' ? row.exchange.duration_ms ?? -1 : -1
      case 'decode':
        return trafficRowDecode(row).status
      case 'anomalies':
        return trafficRowAnomalies(row).length
    }
  }

  switch (key) {
    case 'started_at':
      return row.preview.timestamp_unix_ms
    case 'name':
      return trafficRowName(row)
    case 'method':
      return trafficRowMethod(row)
    case 'host':
      return trafficRowHost(row)
    case 'status':
      return -1
    case 'type':
      return row.preview.payload_hint.likely_protocol
    case 'initiator':
      return trafficRowDirection(row)
    case 'size':
      return row.preview.body_len ?? -1
    case 'time':
      return -1
    case 'decode':
      return row.preview.payload_decode.status
    case 'anomalies':
      return 0
  }
}

function decodeLabel(payloadDecode: PayloadDecode) {
  const state = payloadDecodeState(payloadDecode)
  const applicationNames = applicationMessageEntries(payloadDecode)
    .map((message) => friendlyMessageName(message.messageName))
  const messageNames = [...new Set(applicationNames.length > 0
    ? applicationNames
    : payloadDecode.schema_message
      ? [friendlyMessageName(payloadDecode.schema_message)]
      : [])]

  if (state === 'error') {
    return `<span class="decode-state error" title="${escapeHtml(payloadDecode.status)}">Decode error</span>`
  }

  if (state === 'decoded' && messageNames.length === 0) {
    return `<span class="decode-state decoded" title="${escapeHtml(payloadDecode.status)}">Decoded payload</span>`
  }

  if (state === 'undecoded' || messageNames.length === 0) {
    return `<span class="decode-state unknown" title="${escapeHtml(payloadDecode.status)}">Undecoded</span>`
  }

  const visibleNames = messageNames.slice(0, 2)
  const remainingCount = messageNames.length - visibleNames.length
  const suffix = remainingCount > 0 ? ` +${remainingCount} more` : ''
  const label = state === 'partial' ? `Partial: ${visibleNames.join(', ')}` : visibleNames.join(', ')
  return `<strong class="decode-message ${state}" title="${escapeHtml(payloadDecode.status)}">${escapeHtml(label)}${suffix}</strong>`
}

function hostWithoutPort(authority: string | null) {
  return authority
    ?.split(':')[0]
    ?.replace(/^www\./, '')
    .toLowerCase() ?? null
}

type WebSocketMappingInput = {
  name: string
  hostMatchType: string
  hostMatchValue: string | null
  pathPrefix: string | null
  direction: string | null
  messageKind: string | null
  messageName: string
  decodeStrategy?: string
  envelopeMessageName?: string | null
  envelopeItemsField?: string | null
  envelopeTypeField?: string | null
  envelopePayloadField?: string | null
  envelopeTypeMapJson?: string | null
}

async function addWebSocketMapping(input: WebSocketMappingInput) {
  const mapping = await invoke<WebSocketProtoMapping>('add_websocket_proto_mapping', {
    name: input.name,
    hostMatchType: input.hostMatchType,
    hostMatchValue: input.hostMatchValue,
    pathPrefix: input.pathPrefix,
    direction: input.direction,
    messageKind: input.messageKind,
    messageName: input.messageName,
    decodeStrategy: input.decodeStrategy ?? 'direct',
    envelopeMessageName: input.envelopeMessageName ?? null,
    envelopeItemsField: input.envelopeItemsField ?? null,
    envelopeTypeField: input.envelopeTypeField ?? null,
    envelopePayloadField: input.envelopePayloadField ?? null,
    envelopeTypeMapJson: input.envelopeTypeMapJson ?? null,
  })
  renderWebSocketMappings([...latestWebSocketMappings, mapping])
  return mapping
}

async function updateWebSocketMapping(id: string, input: WebSocketMappingInput) {
  const mapping = await invoke<WebSocketProtoMapping>('update_websocket_proto_mapping', {
    id,
    name: input.name,
    hostMatchType: input.hostMatchType,
    hostMatchValue: input.hostMatchValue,
    pathPrefix: input.pathPrefix,
    direction: input.direction,
    messageKind: input.messageKind,
    messageName: input.messageName,
    decodeStrategy: input.decodeStrategy ?? 'direct',
    envelopeMessageName: input.envelopeMessageName ?? null,
    envelopeItemsField: input.envelopeItemsField ?? null,
    envelopeTypeField: input.envelopeTypeField ?? null,
    envelopePayloadField: input.envelopePayloadField ?? null,
    envelopeTypeMapJson: input.envelopeTypeMapJson ?? null,
  })
  renderWebSocketMappings(latestWebSocketMappings.map((item) => item.id === id ? mapping : item))
  return mapping
}

function readWebSocketMappingForm(): WebSocketMappingInput {
  const decodeStrategy = websocketMappingDecodeStrategy.value
  const messageName = websocketMappingMessageName.value.trim()
  const envelopeMessageName = websocketMappingEnvelopeMessageName.value.trim()

  return {
    name: websocketMappingName.value.trim() || shortMessageName(messageName || envelopeMessageName),
    hostMatchType: websocketMappingHostMatchType.value,
    hostMatchValue: websocketMappingHostMatchValue.value.trim() || null,
    pathPrefix: websocketMappingPathPrefix.value.trim() || null,
    direction: websocketMappingDirection.value || null,
    messageKind: websocketMappingKind.value || null,
    messageName,
    decodeStrategy,
    envelopeMessageName: envelopeMessageName || null,
    envelopeItemsField: websocketMappingEnvelopeItemsField.value.trim() || null,
    envelopeTypeField: websocketMappingEnvelopeTypeField.value.trim() || null,
    envelopePayloadField: websocketMappingEnvelopePayloadField.value.trim() || null,
    envelopeTypeMapJson: websocketMappingEnvelopeTypeMap.value.trim() || null,
  }
}

function startEditingWebSocketMapping(mapping: WebSocketProtoMapping) {
  editingWebSocketMappingId = mapping.id
  websocketMappingName.value = mapping.name
  websocketMappingHostMatchType.value = mapping.host_match_type
  websocketMappingHostMatchValue.value = mapping.host_match_value ?? ''
  websocketMappingPathPrefix.value = mapping.path_prefix ?? ''
  websocketMappingDirection.value = mapping.direction ?? ''
  websocketMappingKind.value = mapping.message_kind ?? ''
  websocketMappingDecodeStrategy.value = mapping.decode_strategy || 'direct'
  websocketMappingMessageName.value = mapping.message_name
  websocketMappingEnvelopeMessageName.value = mapping.envelope_message_name ?? ''
  websocketMappingEnvelopeItemsField.value = mapping.envelope_items_field ?? ''
  websocketMappingEnvelopeTypeField.value = mapping.envelope_type_field ?? ''
  websocketMappingEnvelopePayloadField.value = mapping.envelope_payload_field ?? ''
  websocketMappingEnvelopeTypeMap.value = mapping.envelope_type_map_json ?? ''
  addWebSocketMappingButton.textContent = 'Update Mapping'
  websocketMappingStatus.textContent = `Editing ${mapping.name}.`
  updateWebSocketMappingStrategyFields()
}

function resetWebSocketMappingForm() {
  editingWebSocketMappingId = null
  websocketMappingName.value = ''
  websocketMappingMessageName.value = ''
  websocketMappingEnvelopeMessageName.value = ''
  websocketMappingEnvelopeItemsField.value = ''
  websocketMappingEnvelopeTypeField.value = ''
  websocketMappingEnvelopePayloadField.value = ''
  websocketMappingEnvelopeTypeMap.value = ''
  addWebSocketMappingButton.textContent = 'Add Mapping'
}

function shortDescriptorName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1)?.replace(/\.[^.]+$/, '') || 'Schema bundle'
}

function shortMessageName(messageName: string) {
  return messageName.split('.').filter(Boolean).at(-1) || 'WebSocket mapping'
}

function browserLaunchCommand(browser: 'edge' | 'chrome', proxyAddress: string | null) {
  if (!proxyAddress) {
    return '-'
  }

  const proxyArg = `--proxy-server="http=${proxyAddress};https=${proxyAddress}"`

  if (browser === 'edge') {
    return `$edge = "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe"; & $edge --user-data-dir="$env:TEMP\\protobuf-decoder-edge-profile" ${proxyArg}`
  }

  return `$chrome = "\${env:ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe"; & $chrome --user-data-dir="$env:TEMP\\protobuf-decoder-chrome-profile" ${proxyArg}`
}

function setActiveView(view: TrafficView) {
  activeView = view
  viewButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === activeView)
  })
  document.querySelectorAll<HTMLElement>('.data-view').forEach((viewElement) => {
    viewElement.classList.toggle('active', viewElement.id === `${activeView}-view`)
  })
  if (activeView === 'timeline') {
    renderTimeline()
  } else if (activeView === 'heatmap') {
    renderHeatmap()
  }
}

function setActiveWorkspace(workspace: Workspace) {
  activeWorkspace = workspace
  workspaceButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.workspaceTarget === activeWorkspace)
  })
  workspaceViews.forEach((view) => {
    view.classList.toggle('active', view.dataset.workspace === activeWorkspace)
  })
}

function renderHeatmap() {
  const visible = filteredExchanges().slice(-36)
  heatmapGrid.innerHTML = visible
    .map((exchange) => {
      const severity = exchange.status && exchange.status >= 500
        ? 'hot'
        : exchange.status && exchange.status >= 400
          ? 'warm'
          : exchange.anomalies.length > 0
            ? 'watch'
            : 'cool'
      const title = `${exchange.authority ?? '-'}${exchange.path ?? ''}`
      return `<span class="${severity}" title="${escapeHtml(title)}"></span>`
    })
    .join('')
}

function renderTimeline() {
  const visible = sortExchanges(filteredExchanges()).slice(-80)

  if (visible.length === 0) {
    timelineSummary.textContent = 'No matching exchanges.'
    exchangeTimeline.innerHTML = '<div class="timeline-empty">No matching HTTP exchanges.</div>'
    return
  }

  const firstStartedAt = Math.min(...visible.map((exchange) => exchange.started_at_unix_ms))
  const lastCompletedAt = Math.max(
    ...visible.map((exchange) => exchange.completed_at_unix_ms ?? exchange.started_at_unix_ms),
  )
  const spanMs = Math.max(lastCompletedAt - firstStartedAt, 1)

  timelineSummary.textContent = `${visible.length} visible exchange${visible.length === 1 ? '' : 's'} over ${durationLabel(spanMs)}.`
  exchangeTimeline.innerHTML = visible
    .map((exchange) => {
      const startedOffset = exchange.started_at_unix_ms - firstStartedAt
      const duration = exchange.duration_ms ?? 1
      const left = Math.max(0, Math.min(99, (startedOffset / spanMs) * 100))
      const width = Math.max(1.5, Math.min(100 - left, (duration / spanMs) * 100))
      const severity = timelineSeverity(exchange)
      const title = `${exchange.method ?? '-'} ${exchange.authority ?? '-'}${exchange.path ?? ''} ${durationLabel(exchange.duration_ms)}`

      return `
        <button
          class="timeline-row ${exchange.id === selectedExchangeId ? 'selected' : ''}"
          type="button"
          data-exchange-id="${escapeHtml(exchange.id)}"
          title="${escapeHtml(title)}"
        >
          <span class="timeline-label">
            <strong>${escapeHtml(exchangeName(exchange))}</strong>
            <span>${serverDot(exchange.authority)}${escapeHtml(exchange.method ?? '-')} ${escapeHtml(shortServerName(exchange.authority))}</span>
          </span>
          <span class="timeline-track">
            <span
              class="timeline-bar ${severity} ${escapeHtml(exchange.payload_hint.likely_protocol)}"
              style="left: ${left.toFixed(2)}%; width: ${width.toFixed(2)}%;"
            >
              <span>${escapeHtml(timelineBarLabel(exchange))}</span>
            </span>
          </span>
        </button>
      `
    })
    .join('')
}

function timelineSeverity(exchange: HttpExchange) {
  if (exchange.status && exchange.status >= 500) {
    return 'high'
  }

  if (exchange.status && exchange.status >= 400) {
    return 'medium'
  }

  if (exchange.anomalies.length > 0) {
    return 'watch'
  }

  return 'ok'
}

function timelineBarLabel(exchange: HttpExchange) {
  const status = exchange.status === null ? 'pending' : String(exchange.status)
  return `${status} ${durationLabel(exchange.duration_ms)}`
}

function scrollExchangeTableIfNeeded(shouldAutoScroll: boolean) {
  if (!shouldAutoScroll || !autoScrollEnabled) {
    autoScrollExchanges = false
    return
  }

  programmaticExchangeScroll = true
  exchangeTableWrap.scrollTop = exchangeTableWrap.scrollHeight
  renderTrafficMessages()
  window.setTimeout(() => {
    programmaticExchangeScroll = false
  }, 0)
  autoScrollExchanges = true
}

themeToggle.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  setTheme(nextTheme)
  saveUiPreferences()
})

autoScrollToggle.addEventListener('change', () => {
  autoScrollEnabled = autoScrollToggle.checked
  autoScrollExchanges = autoScrollEnabled
  saveUiPreferences()
  if (autoScrollEnabled) {
    scrollExchangeTableIfNeeded(true)
  } else {
    renderTrafficMessages()
  }
})

exportCaButton.addEventListener('click', async () => {
  exportCaButton.disabled = true
  exportCaButton.textContent = 'Exporting...'
  caExportStatus.textContent = ''

  try {
    const exportResult = await invoke<CaCertExport>('export_ca_cert')
    caExportStatus.textContent = `Exported CA certificates to ${exportResult.der_path} and ${exportResult.pem_path}`
  } catch (error) {
    caExportStatus.textContent = `CA certificate export failed: ${String(error)}`
  } finally {
    exportCaButton.textContent = 'Export CA'
    exportCaButton.disabled = !proxyRunning
  }
})

trustCaButton.addEventListener('click', async () => {
  trustCaButton.disabled = true
  trustCaButton.textContent = 'Trusting...'
  caExportStatus.textContent = ''

  try {
    const trustResult = await invoke<CaTrustInstall>('trust_ca_cert_for_current_user')
    caExportStatus.textContent = `Trusted CA in ${trustResult.store} from ${trustResult.cert_path}. Restart browser sessions that already showed certificate errors.`
    if (trustResult.output) {
      console.info(trustResult.output)
    }
  } catch (error) {
    caExportStatus.textContent = `CA trust failed: ${String(error)}`
  } finally {
    trustCaButton.textContent = 'Trust CA'
    trustCaButton.disabled = !proxyRunning
  }
})

toggleProxyButton.addEventListener('click', async () => {
  toggleProxyButton.disabled = true
  toggleProxyButton.textContent = proxyRunning ? 'Stopping...' : 'Starting...'

  try {
    if (proxyRunning) {
      await invoke('stop_proxy')
    } else {
      await invoke('start_proxy_service')
    }
  } catch (error) {
    const message = `Proxy ${proxyRunning ? 'stop' : 'start'} failed: ${String(error)}`
    proxyState.textContent = 'Proxy error'
    proxyState.dataset.state = 'stopped'
    clientConfig.textContent = message
    browserSetupStatus.textContent = message
  } finally {
    try {
      await refresh()
    } catch (error) {
      const message = `Proxy status refresh failed: ${String(error)}`
      clientConfig.textContent = message
      browserSetupStatus.textContent = message
    }
    toggleProxyButton.disabled = false
  }
})

captureModeButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    const mode = button.dataset.captureMode as CaptureMode | undefined
    if (!mode || mode === captureMode) {
      return
    }

    button.disabled = true
    try {
      await setCaptureMode(mode)
    } finally {
      button.disabled = false
    }
  })
})

copyCommandButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    const targetId = button.dataset.copyTarget
    const target = targetId ? document.getElementById(targetId) : null
    const text = target?.textContent ?? ''

    if (!text || text === '-') {
      copyStatus.textContent = 'No command available to copy.'
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      copyStatus.textContent = 'Command copied.'
    } catch (error) {
      copyStatus.textContent = `Copy failed: ${String(error)}`
    }
  })
})

copySelectedTrafficButton.addEventListener('click', async () => {
  const text = selectedTrafficCopyText()
  if (!text) {
    selectedCopyStatus.textContent = 'Select a traffic message first.'
    return
  }

  copySelectedTrafficButton.disabled = true
  selectedCopyStatus.textContent = ''
  try {
    await copyTextToClipboard(text)
    selectedCopyStatus.textContent = 'Selected message copied.'
  } catch (error) {
    selectedCopyStatus.textContent = `Copy failed: ${String(error)}`
  } finally {
    copySelectedTrafficButton.disabled = false
  }
})

inspectPacketLogsButton.addEventListener('click', async () => {
  const paths = packetLogPaths.value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)

  await importPacketLogs(paths)
})

async function importPacketLogs(paths: string[]) {

  if (paths.length === 0) {
    packetLogStatus.textContent = 'No supported DAT, GZ, or ZIP paths were selected.'
    return
  }

  if (packetLogImportInFlight) {
    packetLogStatus.textContent = 'A packet-log import is already in progress.'
    return
  }

  packetLogImportInFlight = true
  inspectPacketLogsButton.disabled = true
  inspectPacketLogsButton.textContent = 'Opening...'
  packetLogStatus.textContent = 'Opening sources, materializing archives, and decoding packet records...'
  packetLogResults.textContent = ''

  const parsedLimit = Number.parseInt(packetLogLimit.value, 10)
  const maxRecords = Number.isFinite(parsedLimit) ? Math.min(100_000, Math.max(100, parsedLimit)) : 10_000
  packetLogLimit.value = String(maxRecords)

  try {
    const imported = await invoke<PacketLogImportResult>('import_packet_log_sources', { paths, maxRecords })
    latestImportedSummary = imported.summary
    captureMode = 'log'
    renderCaptureMode()
    renderPacketLogImportReport(imported.report)
    renderEvents(imported.summary)
  } catch (error) {
    packetLogStatus.textContent = `Packet-log import failed: ${String(error)}`
  } finally {
    packetLogImportInFlight = false
    inspectPacketLogsButton.disabled = false
    inspectPacketLogsButton.textContent = 'Open in Traffic'
  }
}

packetLogFiles.addEventListener('change', () => {
  const paths = [...(packetLogFiles.files ?? [])]
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => Boolean(path))

  if (paths.length === 0) {
    packetLogStatus.textContent = 'The file picker did not expose local paths. Paste paths or use the drop area in the Tauri window.'
    return
  }

  packetLogPaths.value = paths.join('\n')
  void importPacketLogs(paths)
})

void getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === 'enter' || event.payload.type === 'over') {
    packetLogDrop.classList.add('drag-over')
    return
  }

  packetLogDrop.classList.remove('drag-over')
  if (event.payload.type !== 'drop' || event.payload.paths.length === 0) {
    return
  }

  const paths = event.payload.paths.filter((path) => /\.(dat|gz|zip)$/i.test(path))
  packetLogPaths.value = paths.join('\n')
  void importPacketLogs(paths)
}).catch(() => {
  packetLogStatus.textContent = 'Drag and drop is unavailable in this window; use the file picker or paste paths.'
})

decodedMessageContent.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const button = target.closest<HTMLButtonElement>('[data-json-view]')
  const view = button?.dataset.jsonView
  if (view !== 'string' && view !== 'formatted') {
    return
  }

  decodedJsonMode = view
  selectedInspectorSignature = null
  renderSelectedTraffic()
})

loadDescriptorSetButton.addEventListener('click', async () => {
  const path = descriptorSetPath.value.trim()
  const name = descriptorBundleName.value.trim() || shortDescriptorName(path)
  const hostMatchType = descriptorHostMatchType.value
  const hostMatchValue = descriptorHostMatchValue.value.trim() || null
  const pathPrefix = descriptorPathPrefix.value.trim() || null

  if (!path) {
    protoSchemaStatus.textContent = 'Enter a descriptor set path first.'
    return
  }

  loadDescriptorSetButton.disabled = true
  loadDescriptorSetButton.textContent = 'Loading...'

  try {
    const status = await invoke<ProtoSchemaStatus>('load_proto_descriptor_bundle', {
      name,
      path,
      hostMatchType,
      hostMatchValue,
      pathPrefix,
      replaceUnscoped: hostMatchType === 'any',
    })
    renderProtoSchemaStatus(status)
    await refresh()
  } catch (error) {
    protoSchemaStatus.textContent = `Schema bundle load failed: ${String(error)}`
  } finally {
    loadDescriptorSetButton.disabled = false
    loadDescriptorSetButton.textContent = 'Load Bundle'
  }
})

websocketMappingDecodeStrategy.addEventListener('change', updateWebSocketMappingStrategyFields)
updateWebSocketMappingStrategyFields()

addWebSocketMappingButton.addEventListener('click', async () => {
  const input = readWebSocketMappingForm()

  if (input.decodeStrategy === 'direct' && !input.messageName) {
    websocketMappingStatus.textContent = 'Enter a protobuf message type first.'
    return
  }

  if (input.decodeStrategy === 'envelope' && !input.envelopeMessageName) {
    websocketMappingStatus.textContent = 'Enter an envelope protobuf message type first.'
    return
  }

  addWebSocketMappingButton.disabled = true
  addWebSocketMappingButton.textContent = editingWebSocketMappingId ? 'Updating...' : 'Adding...'
  websocketMappingStatus.textContent = ''

  try {
    if (editingWebSocketMappingId) {
      await updateWebSocketMapping(editingWebSocketMappingId, input)
      websocketMappingStatus.textContent = 'Updated WebSocket mapping.'
    } else {
      await addWebSocketMapping(input)
      websocketMappingStatus.textContent = 'Added WebSocket mapping.'
    }
    resetWebSocketMappingForm()
    await refresh()
  } catch (error) {
    websocketMappingStatus.textContent = `Mapping save failed: ${String(error)}`
  } finally {
    addWebSocketMappingButton.disabled = false
    addWebSocketMappingButton.textContent = editingWebSocketMappingId ? 'Update Mapping' : 'Add Mapping'
  }
})

websocketMappings.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement
  const editButton = target.closest<HTMLButtonElement>('button[data-edit-websocket-mapping]')
  const deleteButton = target.closest<HTMLButtonElement>('button[data-delete-websocket-mapping]')

  if (editButton) {
    const mapping = latestWebSocketMappings.find((item) => item.id === editButton.dataset.editWebsocketMapping)
    if (mapping) {
      startEditingWebSocketMapping(mapping)
    }
    return
  }

  if (!deleteButton) {
    return
  }

  const id = deleteButton.dataset.deleteWebsocketMapping
  if (!id) {
    return
  }

  deleteButton.disabled = true
  websocketMappingStatus.textContent = ''
  try {
    await invoke('delete_websocket_proto_mapping', { id })
    if (editingWebSocketMappingId === id) {
      resetWebSocketMappingForm()
    }
    renderWebSocketMappings(latestWebSocketMappings.filter((mapping) => mapping.id !== id))
    websocketMappingStatus.textContent = 'Deleted WebSocket mapping.'
    await refresh()
  } catch (error) {
    websocketMappingStatus.textContent = `Mapping delete failed: ${String(error)}`
  } finally {
    deleteButton.disabled = false
  }
})

trafficMessages.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-traffic-key]')
  if (!row) {
    return
  }

  selectedTrafficKey = row.dataset.trafficKey ?? null
  selectedWebSocketDecode = null
  selectedCopyStatus.textContent = ''
  autoScrollExchanges = false
  renderTrafficMessages()
  renderSelectedTraffic()
})

searchInput.addEventListener('input', () => {
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

protocolFilter.addEventListener('change', () => {
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

decodeFilter.addEventListener('change', () => {
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

resourceFilterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const filter = button.dataset.resourceFilter as ResourceFilter | undefined
    if (!filter) {
      return
    }

    if (filter === 'all') {
      activeResourceFilters.clear()
    } else if (activeResourceFilters.has(filter)) {
      activeResourceFilters.delete(filter)
    } else {
      activeResourceFilters.add(filter)
    }
    autoScrollExchanges = false
    saveUiPreferences()
    updateResourceFilterButtons()
    renderTrafficMessages()
    renderSelectedTraffic()
    renderTimeline()
    renderHeatmap()
  })
})

anomalyFilter.addEventListener('change', () => {
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

errorsOnlyFilter.addEventListener('change', () => {
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

deadCallsFilter.addEventListener('change', () => {
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

streamingPriceFilter.addEventListener('change', () => {
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

keepAliveFilter.addEventListener('change', () => {
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

clearFiltersButton.addEventListener('click', () => {
  searchInput.value = ''
  protocolFilter.value = 'all'
  decodeFilter.value = 'all'
  anomalyFilter.checked = false
  errorsOnlyFilter.checked = false
  deadCallsFilter.checked = false
  streamingPriceFilter.checked = true
  keepAliveFilter.checked = true
  activeResourceFilters.clear()
  updateResourceFilterButtons()
  autoScrollExchanges = false
  saveUiPreferences()
  renderTrafficMessages()
  renderSelectedTraffic()
  renderTimeline()
  renderHeatmap()
})

exchangeTimeline.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-exchange-id]')
  if (!row) {
    return
  }

  const exchangeId = row.dataset.exchangeId ?? ''
  const exchange = latestExchanges.find((candidate) => candidate.id === exchangeId)
  selectedTrafficKey = `http:${exchangeId}:${exchange?.response_payload_decode ? 'response' : 'request'}`
  selectedCopyStatus.textContent = ''
  autoScrollExchanges = false
  renderTrafficMessages()
  renderTimeline()
  renderSelectedTraffic()
})

clearCaptureButton.addEventListener('click', async () => {
  clearCaptureButton.disabled = true

  try {
    if (captureMode === 'log') {
      latestImportedSummary = null
      renderCaptureMode()
      renderEvents(emptyTrafficSummary())
    } else {
      await invoke('clear_proxy_events')
    }
    selectedExchangeId = null
    selectedWebSocketPreviewId = null
    selectedTrafficKey = null
    selectedWebSocketDecode = null
    selectedInspectorSignature = null
    selectedCopyStatus.textContent = ''
    trafficDetail.open = false
    autoScrollExchanges = true
    await refresh()
  } finally {
    clearCaptureButton.disabled = false
  }
})

analyseSelectionButton.addEventListener('click', () => {
  const visible = filteredTrafficRows()
  const anomalyCount = visible.filter((row) => trafficRowAnomalies(row).length > 0).length
  trafficSummary.textContent = `${visible.length} visible traffic rows, ${anomalyCount} with anomalies, ${resourceFilterSummary()}. ${sortDescription()}.`
})

exchangeTableWrap.addEventListener('scroll', () => {
  if (programmaticExchangeScroll) {
    return
  }

  const atBottom = exchangeTableWrap.scrollTop + exchangeTableWrap.clientHeight >= exchangeTableWrap.scrollHeight - 4
  autoScrollExchanges = autoScrollEnabled && atBottom
  renderTrafficMessages()
})

viewButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const view = button.dataset.view
    if (view === 'table' || view === 'timeline' || view === 'heatmap') {
      setActiveView(view)
    }
  })
})

workspaceButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.workspaceTarget
    if (target === 'traffic' || target === 'schemas' || target === 'runtime') {
      setActiveWorkspace(target)
    }
  })
})

sortHeaderButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.sortKey as SortKey | undefined
    if (!key) {
      return
    }

    if (sortKey === key) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey = key
      sortDirection = 'asc'
    }

    autoScrollExchanges = false
    renderTrafficMessages()
    renderSelectedTraffic()
    renderTimeline()
  })
})

renderCaptureMode()
void refresh()
window.setInterval(() => {
  void refresh()
}, 1500)
