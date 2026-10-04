import './style.css'
import { invoke } from '@tauri-apps/api/core'

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
  payload_hint: PayloadHint
  payload_decode: PayloadDecode
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
  company_mapping_count: number
  company_mapping_examples: string[]
  sample_messages: string[]
  message_names: string[]
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
type SortKey = 'started_at' | 'name' | 'method' | 'host' | 'status' | 'type' | 'initiator' | 'size' | 'time' | 'decode' | 'findings'
type SortDirection = 'asc' | 'desc'
type ResourceFilter = 'all' | 'fetch' | 'document' | 'js' | 'css' | 'image' | 'font' | 'media' | 'ws' | 'protobuf' | 'json' | 'other'
type HttpResourceKind = Exclude<ResourceFilter, 'all' | 'ws'>

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
            <input id="traffic-search" type="search" placeholder="Host, path, method, status">
          </label>
          <div class="field">
            <span>Resource</span>
            <div class="resource-filter" role="group" aria-label="Resource filter">
              <button class="resource-filter-button active" type="button" data-resource-filter="all">All</button>
              <button class="resource-filter-button" type="button" data-resource-filter="fetch">Fetch/XHR</button>
              <button class="resource-filter-button" type="button" data-resource-filter="document">Doc</button>
              <button class="resource-filter-button" type="button" data-resource-filter="js">JS</button>
              <button class="resource-filter-button" type="button" data-resource-filter="css">CSS</button>
              <button class="resource-filter-button" type="button" data-resource-filter="image">Img</button>
              <button class="resource-filter-button" type="button" data-resource-filter="font">Font</button>
              <button class="resource-filter-button" type="button" data-resource-filter="media">Media</button>
              <button class="resource-filter-button" type="button" data-resource-filter="ws">WS</button>
              <button class="resource-filter-button" type="button" data-resource-filter="protobuf">Proto</button>
              <button class="resource-filter-button" type="button" data-resource-filter="json">JSON</button>
              <button class="resource-filter-button" type="button" data-resource-filter="other">Other</button>
            </div>
          </div>
          <label class="field">
            <span>Payload</span>
            <select id="protocol-filter">
              <option value="all">All types</option>
              <option value="protobuf">Protobuf</option>
              <option value="grpc">gRPC</option>
              <option value="json">JSON</option>
              <option value="text">Text</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label class="check-row">
            <input id="anomaly-filter" type="checkbox">
            <span>Findings only</span>
          </label>
          <button id="analyse-selection" class="primary-button" type="button">Analyse Visible</button>
        </section>
      </aside>

      <section class="traffic-workbench">
        <div class="workbench-toolbar">
          <div>
            <h2>Traffic</h2>
            <p id="traffic-summary">Waiting for traffic. Oldest exchanges appear first.</p>
          </div>
          <div class="workbench-actions">
            <div class="view-switch" aria-label="Display mode">
              <button class="view-button active" type="button" data-view="table">Table</button>
              <button class="view-button" type="button" data-view="timeline">Timeline</button>
              <button class="view-button" type="button" data-view="heatmap">Heatmap</button>
            </div>
            <button id="clear-capture" class="quiet-button" type="button">Clear Capture</button>
          </div>
        </div>

        <div id="table-view" class="data-view active">
          <div id="exchange-table-wrap" class="exchange-table-wrap">
            <table class="exchange-table">
              <thead>
                <tr>
                  <th><button class="sort-header" type="button" data-sort-key="name">Name</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="status">Status</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="type">Type</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="initiator">Initiator</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="size">Size</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="time">Time</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="method">Method</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="host">Host</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="decode">Decode</button></th>
                  <th><button class="sort-header" type="button" data-sort-key="findings">Findings</button></th>
                </tr>
              </thead>
              <tbody id="http-exchanges">
                <tr><td colspan="10">No HTTP exchanges captured.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

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

        <section class="detail-panel" aria-label="Selected exchange">
          <div class="panel-heading">
            <h2>Traffic Detail</h2>
            <span id="selected-exchange-kind" class="small-value">No selection</span>
          </div>
          <div id="exchange-detail" class="detail-content">
            Select a traffic row to inspect request, response, payload preview, and findings.
          </div>
        </section>

        <section class="events-panel">
          <div class="panel-heading">
            <h2>Event Timeline</h2>
            <span class="small-value">Newest first</span>
          </div>
          <ol id="events" class="events"></ol>
        </section>

        <section class="events-panel">
          <div class="panel-heading">
            <h2>WebSocket Messages</h2>
            <span id="websocket-preview-summary" class="small-value">No frames</span>
          </div>
          <div class="compact-table-wrap">
            <table class="compact-table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Kind</th>
                  <th>Target</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Decode</th>
                </tr>
              </thead>
              <tbody id="websocket-message-previews">
                <tr><td colspan="6">No WebSocket messages captured.</td></tr>
              </tbody>
            </table>
          </div>
          <section class="frame-detail" aria-label="Selected WebSocket frame">
            <div class="panel-heading">
              <h3>Frame Detail</h3>
              <span id="selected-websocket-kind" class="small-value">No selection</span>
            </div>
            <div id="websocket-frame-detail" class="detail-content">
              Select a WebSocket message to inspect target, direction, payload preview, and decode status.
            </div>
          </section>
        </section>
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
            <button id="toggle-proxy" type="button">Stop</button>
          </div>
          <dl class="counts">
            <div><dt>Mode</dt><dd>Passthrough</dd></div>
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
const proxyAddress = document.querySelector<HTMLElement>('#proxy-address')!
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
const websocketPreviewSummary = document.querySelector<HTMLElement>('#websocket-preview-summary')!
const websocketMessagePreviews = document.querySelector<HTMLTableSectionElement>('#websocket-message-previews')!
const selectedWebSocketKind = document.querySelector<HTMLElement>('#selected-websocket-kind')!
const websocketFrameDetail = document.querySelector<HTMLElement>('#websocket-frame-detail')!
const exchangeTableWrap = document.querySelector<HTMLElement>('#exchange-table-wrap')!
const httpExchanges = document.querySelector<HTMLTableSectionElement>('#http-exchanges')!
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
const anomalyFilter = document.querySelector<HTMLInputElement>('#anomaly-filter')!
const clearFiltersButton = document.querySelector<HTMLButtonElement>('#clear-filters')!
const clearCaptureButton = document.querySelector<HTMLButtonElement>('#clear-capture')!
const analyseSelectionButton = document.querySelector<HTMLButtonElement>('#analyse-selection')!
const trafficSummary = document.querySelector<HTMLElement>('#traffic-summary')!
const resourceFilterButtons = document.querySelectorAll<HTMLButtonElement>('[data-resource-filter]')
const workspaceButtons = document.querySelectorAll<HTMLButtonElement>('[data-workspace-target]')
const workspaceViews = document.querySelectorAll<HTMLElement>('.workspace-view')
const viewButtons = document.querySelectorAll<HTMLButtonElement>('.view-button')
const sortHeaderButtons = document.querySelectorAll<HTMLButtonElement>('.sort-header')
const selectedExchangeKind = document.querySelector<HTMLElement>('#selected-exchange-kind')!
const exchangeDetail = document.querySelector<HTMLElement>('#exchange-detail')!
const heatmapGrid = document.querySelector<HTMLElement>('#heatmap-grid')!
const schemaChip = document.querySelector<HTMLElement>('#schema-chip')!

let proxyRunning = false
let refreshInFlight = false
let latestExchanges: HttpExchange[] = []
let latestWebSocketPreviews: WebSocketMessagePreview[] = []
let latestSchemaStatus: ProtoSchemaStatus | null = null
let latestSchemaBundles: ProtoSchemaStatus[] = []
let latestWebSocketMappings: WebSocketProtoMapping[] = []
let selectedExchangeId: string | null = null
let selectedWebSocketPreviewId: string | null = null
let selectedWebSocketDecode: PayloadDecode | null = null
let selectedWebSocketDecodeMessage = ''
let editingWebSocketMappingId: string | null = null
let activeWorkspace: Workspace = 'traffic'
let activeView: TrafficView = 'table'
let autoScrollExchanges = true
let programmaticExchangeScroll = false
let sortKey: SortKey = 'started_at'
let sortDirection: SortDirection = 'asc'
let activeResourceFilter: ResourceFilter = 'all'

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

  if (!status.running) {
    renderEvents({
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
    })
    return
  }

  const summary = await invoke<ProxyEventSummary>('proxy_events')
  renderEvents(summary)
}

function renderEvents(summary: ProxyEventSummary) {
  latestExchanges = summary.http_exchanges
  const shouldAutoScroll = autoScrollExchanges || isScrolledToBottom(exchangeTableWrap)
  eventTotal.textContent = String(summary.total)
  httpRequests.textContent = String(summary.http_requests)
  httpResponses.textContent = String(summary.http_responses)
  websocketMessages.textContent = String(summary.websocket_messages)
  websocketActive.textContent = String(summary.websocket_active_connections)
  websocketOpened.textContent = String(summary.websocket_opened_connections)
  websocketErrors.textContent = String(summary.websocket_errors)
  websocketState.dataset.state = summary.websocket_active_connections > 0 ? 'active' : 'idle'
  websocketState.lastElementChild!.textContent = summary.websocket_active_connections > 0
    ? `${summary.websocket_active_connections} WebSocket${summary.websocket_active_connections === 1 ? '' : 's'}`
    : 'No WebSockets'
  renderHttpExchanges()
  renderWebSocketMessagePreviews(summary.websocket_message_previews)
  renderSelectedExchange()
  renderTimeline()
  renderHeatmap()
  scrollExchangeTableIfNeeded(shouldAutoScroll)

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
}

function renderWebSocketMessagePreviews(previews: WebSocketMessagePreview[]) {
  latestWebSocketPreviews = previews
  const visiblePreviews = filteredWebSocketPreviews(previews)
  const recentPreviews = visiblePreviews.slice(-80).reverse()
  const protobufCount = visiblePreviews.filter((preview) => preview.payload_hint.likely_protocol === 'protobuf').length
  const filterNote = activeResourceFilter === 'all' ? '' : `, ${resourceFilterLabel(activeResourceFilter)} filter active`
  websocketPreviewSummary.textContent = `${visiblePreviews.length} visible of ${previews.length} frame${previews.length === 1 ? '' : 's'}, ${protobufCount} protobuf candidate${protobufCount === 1 ? '' : 's'}${filterNote}. Newest frames appear first.`

  if (recentPreviews.length === 0) {
    selectedWebSocketPreviewId = null
    selectedWebSocketDecode = null
    websocketMessagePreviews.innerHTML = '<tr><td colspan="6">No matching WebSocket messages.</td></tr>'
    renderSelectedWebSocketPreview()
    return
  }

  if (!selectedWebSocketPreviewId || !visiblePreviews.some((preview) => preview.id === selectedWebSocketPreviewId)) {
    selectedWebSocketPreviewId = recentPreviews[0]?.id ?? null
  }

  websocketMessagePreviews.innerHTML = recentPreviews
    .map((preview) => `
      <tr
        class="${preview.id === selectedWebSocketPreviewId ? 'selected' : ''}"
        data-websocket-preview-id="${escapeHtml(preview.id)}"
        title="${escapeHtml(preview.connection_id)}"
      >
        <td>${escapeHtml(directionLabel(preview.direction))}</td>
        <td>${escapeHtml(preview.message_kind ?? '-')}</td>
        <td>${serverBadge(preview.authority)}</td>
        <td>${payloadLabel(preview.payload_hint)}</td>
        <td>${byteLabel(preview.body_len)}</td>
        <td>${decodeLabel(preview.payload_decode)}</td>
      </tr>
    `)
    .join('')
  renderSelectedWebSocketPreview()
}

function renderSelectedWebSocketPreview() {
  const preview = latestWebSocketPreviews.find((item) => item.id === selectedWebSocketPreviewId)

  if (!preview) {
    selectedWebSocketKind.textContent = 'No selection'
    selectedWebSocketDecode = null
    websocketFrameDetail.textContent = 'Select a WebSocket message to inspect target, direction, payload preview, and decode status.'
    return
  }

  selectedWebSocketKind.textContent = preview.payload_hint.likely_protocol
  const activeDecode = selectedWebSocketDecode ?? preview.payload_decode
  renderProtoMessageOptions(messageNamesForPreview(preview))
  websocketFrameDetail.innerHTML = `
    <div class="schema-decode-controls">
      <label class="field">
        <span>Decode selected frame as</span>
        <input
          id="websocket-message-type"
          type="text"
          list="proto-message-name-options"
          placeholder="package.MessageName"
          value="${escapeHtml(selectedWebSocketDecodeMessage)}"
          ${latestSchemaStatus ? '' : 'disabled'}
        >
      </label>
      <button id="decode-websocket-frame" class="primary-button" type="button" ${latestSchemaStatus ? '' : 'disabled'}>Decode Frame</button>
      <button id="save-websocket-mapping-from-frame" type="button" ${latestSchemaStatus ? '' : 'disabled'}>Save Mapping</button>
      <label class="field">
        <span>Decoded export path</span>
        <input
          id="decoded-websocket-export-path"
          type="text"
          placeholder="C:\\Temp\\protobuf-decoder-decoded-websocket-message.json"
          ${latestSchemaStatus ? '' : 'disabled'}
        >
      </label>
      <button id="export-decoded-websocket-frame" type="button" ${latestSchemaStatus ? '' : 'disabled'}>Export Decoded JSON</button>
      <p id="websocket-schema-decode-status" class="status-message">${latestSchemaStatus ? 'Choose a loaded message type for this frame.' : 'Load a descriptor set in Schemas before schema-aware frame decoding.'}</p>
    </div>
    <dl class="detail-grid">
      <div><dt>Direction</dt><dd>${escapeHtml(directionLabel(preview.direction))}</dd></div>
      <div><dt>Kind</dt><dd>${escapeHtml(preview.message_kind ?? '-')}</dd></div>
      <div><dt>Target</dt><dd>${serverBadge(preview.authority, websocketTarget(preview))}</dd></div>
      <div><dt>Size</dt><dd>${byteLabel(preview.body_len)}</dd></div>
      <div><dt>Type</dt><dd>${escapeHtml(preview.payload_hint.likely_protocol)}</dd></div>
      <div><dt>Decode</dt><dd>${escapeHtml(activeDecode.status)}</dd></div>
      <div><dt>Connection</dt><dd>${escapeHtml(preview.connection_id)}</dd></div>
      <div><dt>Captured</dt><dd>${formatTime(preview.timestamp_unix_ms)}</dd></div>
    </dl>
    ${jsonPreviewPanel(activeDecode)}
    <div class="decode-preview">
      <div class="panel-heading">
        <h3>Payload Preview</h3>
        <span class="small-value">${escapeHtml(activeDecode.schema_message ?? activeDecode.direction ?? 'No payload')}</span>
      </div>
      <p>${escapeHtml(activeDecode.status)}</p>
      ${protobufFieldTable(activeDecode.fields)}
    </div>
  `
  bindWebSocketDecodeControls(preview)
}

function renderHttpExchanges() {
  const visibleExchanges = filteredExchanges()
  const sortedExchanges = sortExchanges(visibleExchanges)
  const visibleWindow = exchangeWindow(sortedExchanges)
  const scrollTopBeforeRender = exchangeTableWrap.scrollTop
  const shouldPreserveScroll = !autoScrollExchanges

  updateSortHeaders()
  const resourceNote = activeResourceFilter === 'all' ? 'all resources' : resourceFilterLabel(activeResourceFilter)
  trafficSummary.textContent = `${visibleExchanges.length} visible of ${latestExchanges.length} HTTP exchanges, ${resourceNote}. ${sortDescription()}; auto-scroll pauses when you scroll up.`
  analyseSelectionButton.disabled = visibleExchanges.length === 0

  if (visibleWindow.length === 0) {
    selectedExchangeId = null
    httpExchanges.innerHTML = '<tr><td colspan="10">No matching HTTP exchanges.</td></tr>'
    return
  }

  if (!selectedExchangeId || !sortedExchanges.some((exchange) => exchange.id === selectedExchangeId)) {
    selectedExchangeId = visibleWindow.at(-1)?.id ?? null
  }

  httpExchanges.innerHTML = visibleWindow
    .map((exchange) => `
      <tr class="${exchange.id === selectedExchangeId ? 'selected' : ''}" data-exchange-id="${escapeHtml(exchange.id)}">
        <td>${escapeHtml(exchangeName(exchange))}</td>
        <td>${statusLabel(exchange.status)}</td>
        <td>${payloadLabel(exchange.payload_hint)}</td>
        <td>${escapeHtml(exchangeInitiator(exchange))}</td>
        <td>${byteLabel(exchange.response_body_len)}</td>
        <td>${durationLabel(exchange.duration_ms)}</td>
        <td>${escapeHtml(exchange.method ?? '-')}</td>
        <td>${serverBadge(exchange.authority)}</td>
        <td>${decodeLabel(exchange.payload_decode)}</td>
        <td>${anomalyLabels(exchange.anomalies)}</td>
      </tr>
    `)
    .join('')

  if (shouldPreserveScroll) {
    exchangeTableWrap.scrollTop = scrollTopBeforeRender
  }
}

function renderSelectedExchange() {
  const exchange = latestExchanges.find((item) => item.id === selectedExchangeId)

  if (!exchange) {
    selectedExchangeKind.textContent = 'No selection'
    exchangeDetail.textContent = 'Select a traffic row to inspect request, response, payload preview, and findings.'
    return
  }

  selectedExchangeKind.textContent = exchange.payload_hint.likely_protocol
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
          <div><dt>Decode</dt><dd>${escapeHtml(exchange.payload_decode.status)}</dd></div>
          <div><dt>Findings</dt><dd>${anomalyLabels(exchange.anomalies)}</dd></div>
        </dl>
      </section>
    </div>
    ${jsonPreviewPanel(exchange.payload_decode)}
    <div class="decode-preview">
      <div class="panel-heading">
        <h3>Payload Preview</h3>
        <span class="small-value">${escapeHtml(exchange.payload_decode.schema_message ?? exchange.payload_decode.direction ?? 'No payload')}</span>
      </div>
      <p>${escapeHtml(exchange.payload_decode.status)}</p>
      ${protobufFieldTable(exchange.payload_decode.fields)}
    </div>
  `
}

function jsonPreviewPanel(payloadDecode: PayloadDecode) {
  if (payloadDecode.json_previews.length === 0) {
    return ''
  }

  return `
    <div class="decode-preview">
      <div class="panel-heading">
        <h3>JSON Preview</h3>
        <span class="small-value">${payloadDecode.json_previews.length} payload(s)</span>
      </div>
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
  `
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

function filteredExchanges() {
  const search = searchInput.value.trim().toLowerCase()
  const protocol = protocolFilter.value
  const anomaliesOnly = anomalyFilter.checked

  return latestExchanges.filter((exchange) => {
    if (!resourceFilterMatchesExchange(exchange)) {
      return false
    }

    if (protocol !== 'all' && exchange.payload_hint.likely_protocol !== protocol) {
      return false
    }

    if (anomaliesOnly && exchange.anomalies.length === 0) {
      return false
    }

    if (!search) {
      return true
    }

    const haystack = [
      exchange.method,
      exchange.scheme,
      exchange.authority,
      exchange.path,
      exchange.status === null ? null : String(exchange.status),
      exchange.payload_hint.likely_protocol,
      exchange.payload_hint.decode_status,
      exchange.payload_hint.request_content_type,
      exchange.payload_hint.response_content_type,
      ...exchange.anomalies.map((anomaly) => anomaly.kind),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    return haystack.includes(search)
  })
}

function filteredWebSocketPreviews(previews: WebSocketMessagePreview[]) {
  if (activeResourceFilter === 'all' || activeResourceFilter === 'ws') {
    return previews
  }

  if (activeResourceFilter === 'protobuf' || activeResourceFilter === 'json') {
    return previews.filter((preview) => preview.payload_hint.likely_protocol === activeResourceFilter)
  }

  return []
}

function resourceFilterMatchesExchange(exchange: HttpExchange) {
  if (activeResourceFilter === 'all') {
    return true
  }

  if (activeResourceFilter === 'ws') {
    return false
  }

  if (activeResourceFilter === 'protobuf') {
    return exchange.payload_hint.likely_protocol === 'protobuf' || exchange.payload_hint.likely_protocol === 'grpc'
  }

  if (activeResourceFilter === 'json') {
    return exchange.payload_hint.likely_protocol === 'json'
  }

  const resourceKind = resourceKindForExchange(exchange)
  if (activeResourceFilter === 'fetch') {
    return ['fetch', 'json', 'protobuf'].includes(resourceKind)
  }

  return resourceKind === activeResourceFilter
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

function updateResourceFilterButtons() {
  resourceFilterButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.resourceFilter === activeResourceFilter)
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

function exchangeWindow(exchanges: HttpExchange[]) {
  return exchanges
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
      return exchange.payload_decode.status
    case 'findings':
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

function payloadLabel(payloadHint: PayloadHint) {
  const contentType = payloadHint.response_content_type ?? payloadHint.request_content_type ?? '-'
  return `
    <span class="payload-kind ${escapeHtml(payloadHint.likely_protocol)}">${escapeHtml(payloadHint.likely_protocol)}</span>
    <span class="content-type">${escapeHtml(contentType)}</span>
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
  const mappingSummary = status.company_mapping_count > 0
    ? ` ${status.company_mapping_count} company type/version mappings found.`
    : ' No company ordinal mappings found.'
  protoSchemaStatus.textContent = `Loaded ${status.file_count} files, ${status.message_count} messages, ${status.service_count} services from ${status.source_path}.${mappingSummary}`
  protoMessageSamples.innerHTML = status.sample_messages
    .map((messageName) => `<li>${escapeHtml(messageName)}</li>`)
    .join('')
  if (status.company_mapping_examples.length > 0) {
    protoMessageSamples.insertAdjacentHTML(
      'afterbegin',
      `<li class="schema-mapping-note">${escapeHtml(status.company_mapping_examples[0])}</li>`,
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

function decodeLabel(payloadDecode: PayloadDecode) {
  const message = payloadDecode.schema_message
    ? `<strong class="decode-message">${escapeHtml(shortMessageName(payloadDecode.schema_message))}</strong><br>`
    : ''
  return `${message}<span>${escapeHtml(payloadDecode.status)}</span>`
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

function isScrolledToBottom(element: HTMLElement) {
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
  return distanceFromBottom <= 8
}

function scrollExchangeTableIfNeeded(shouldAutoScroll: boolean) {
  if (!shouldAutoScroll) {
    autoScrollExchanges = false
    return
  }

  programmaticExchangeScroll = true
  exchangeTableWrap.scrollTop = exchangeTableWrap.scrollHeight
  window.setTimeout(() => {
    programmaticExchangeScroll = false
  }, 0)
  autoScrollExchanges = true
}

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
  if (proxyRunning) {
    await invoke('stop_proxy')
  } else {
    await invoke('start_proxy_service')
  }

  await refresh()
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
      replaceUnscoped: false,
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

httpExchanges.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-exchange-id]')
  if (!row) {
    return
  }

  selectedExchangeId = row.dataset.exchangeId ?? null
  renderHttpExchanges()
  renderSelectedExchange()
})

websocketMessagePreviews.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-websocket-preview-id]')
  if (!row) {
    return
  }

  selectedWebSocketPreviewId = row.dataset.websocketPreviewId ?? null
  selectedWebSocketDecode = null
  renderWebSocketMessagePreviews(latestWebSocketPreviews)
})

searchInput.addEventListener('input', () => {
  autoScrollExchanges = true
  renderHttpExchanges()
  renderSelectedExchange()
  renderTimeline()
  renderHeatmap()
  scrollExchangeTableIfNeeded(true)
})

protocolFilter.addEventListener('change', () => {
  autoScrollExchanges = true
  renderHttpExchanges()
  renderSelectedExchange()
  renderTimeline()
  renderHeatmap()
  scrollExchangeTableIfNeeded(true)
})

resourceFilterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const filter = button.dataset.resourceFilter as ResourceFilter | undefined
    if (!filter) {
      return
    }

    activeResourceFilter = filter
    autoScrollExchanges = true
    updateResourceFilterButtons()
    renderHttpExchanges()
    renderWebSocketMessagePreviews(latestWebSocketPreviews)
    renderSelectedExchange()
    renderTimeline()
    renderHeatmap()
    scrollExchangeTableIfNeeded(true)
  })
})

anomalyFilter.addEventListener('change', () => {
  autoScrollExchanges = true
  renderHttpExchanges()
  renderSelectedExchange()
  renderTimeline()
  renderHeatmap()
  scrollExchangeTableIfNeeded(true)
})

clearFiltersButton.addEventListener('click', () => {
  searchInput.value = ''
  protocolFilter.value = 'all'
  anomalyFilter.checked = false
  activeResourceFilter = 'all'
  updateResourceFilterButtons()
  autoScrollExchanges = true
  renderHttpExchanges()
  renderWebSocketMessagePreviews(latestWebSocketPreviews)
  renderSelectedExchange()
  renderTimeline()
  renderHeatmap()
  scrollExchangeTableIfNeeded(true)
})

exchangeTimeline.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-exchange-id]')
  if (!row) {
    return
  }

  selectedExchangeId = row.dataset.exchangeId ?? null
  renderHttpExchanges()
  renderTimeline()
  renderSelectedExchange()
})

clearCaptureButton.addEventListener('click', async () => {
  clearCaptureButton.disabled = true

  try {
    await invoke('clear_proxy_events')
    selectedExchangeId = null
    autoScrollExchanges = true
    await refresh()
  } finally {
    clearCaptureButton.disabled = false
  }
})

analyseSelectionButton.addEventListener('click', () => {
  const visible = filteredExchanges()
  const anomalyCount = visible.filter((exchange) => exchange.anomalies.length > 0).length
  const resourceNote = activeResourceFilter === 'all' ? 'all resources' : resourceFilterLabel(activeResourceFilter)
  trafficSummary.textContent = `${visible.length} visible HTTP rows, ${anomalyCount} with findings, ${resourceNote}. ${sortDescription()}.`
})

exchangeTableWrap.addEventListener('scroll', () => {
  if (programmaticExchangeScroll) {
    return
  }

  autoScrollExchanges = isScrolledToBottom(exchangeTableWrap)
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

    autoScrollExchanges = sortKey === 'started_at' && sortDirection === 'asc'
    renderHttpExchanges()
    renderSelectedExchange()
    renderTimeline()
    scrollExchangeTableIfNeeded(autoScrollExchanges)
  })
})

void refresh()
window.setInterval(() => {
  void refresh()
}, 1500)
