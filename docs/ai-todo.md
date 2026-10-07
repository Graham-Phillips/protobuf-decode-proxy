# Next tasks for AI

Use this file for the next round of work. `codex-todo.md` is background and
history; verify its claims against the current code and running app. Leave it
unchanged for this work.

## What needs fixing

The main page is too busy, but still does not show the information we need:
what protobuf message was sent and what its named fields contain. The user
reports that recent decoding changes have not fixed this in the running exe.

Traffic Detail mostly shows request/response information without useful message
context. Payload Preview still shows generic wire fields. Event Timeline's
purpose relative to Traffic is unclear. The combined Traffic table now includes
WebSocket messages, but the selected-message inspector still contains
WebSocket-specific controls and duplicate transport context. Frame decoding
currently depends on loading a descriptor set.

The desired default workflow is: see messages, filter them, recognize their
types in the table, then select one to inspect decoded field names and contents.

## Current decoding evidence

- `C:\Work2\GP\protos` and `C:\Work2\GP\mobile-server-api\mobile-server-api\src\protos`
  contain the application `.proto` sources, including `generator/descriptor.proto`,
  `iPhonePacketProto`, and versioned payload messages such as
  `GetDataResponseV2Proto` and `GetDataResponseV3Proto`.
- The existing `mockdata\protbuf.pb` is a usable `FileDescriptorSet` containing
  the application envelope and ordinal metadata. The server/client mapping confirms
  that one ordinal can select several payload versions; ordinal `43` is the
  concrete example.
- The URL Generator decodes the outer `iPhonePacketProto`, then selects the
  inner message by `(messageType, messagePayloadVersion)`. The Rust path now
  follows that behavior for HTTP and WebSocket payloads, including binary frames
  whose transport hint is initially unknown.
- The build/test machine still needs to compile the executable and capture a
  real sample. This workstation is intentionally not used for Cargo dependency
  downloads or Rust compilation.

## 1. Reproduce and trace the decoding failure

- [ ] Capture a representative protobuf WebSocket message and its raw bytes.
  Record the endpoint, direction, selected schema/mapping, and app build version.
  Confirm that the running exe includes the current decoding changes.
- [ ] Follow that message through capture, framing/envelope extraction, schema
  selection, message-type mapping, decoding, and UI rendering. Identify exactly
  where it falls back to the wire preview.
- [x] Verify the existing descriptor and mapping paths before adding another
  decoding mechanism. Check application envelope ordinals/versions and WebSocket
  rules where applicable; do not assume all traffic uses those formats.
- [ ] Turn the captured sample into a regression fixture once its expected
  message type and contents are established.

Example of the current output, which is a wire inspection rather than named
message decoding (nested rows are flattened in this copied example):

| Field | Wire | Preview |
| --- | --- | --- |
| 1 | length-delimited (2) | 7 bytes nested protobuf message |
| 1 | varint (0) | 1791115316285 sint=-895557658143 |
| 2 | length-delimited (2) | 12 bytes hex 69 01 77 6e a4 50 78 05 f1 88 13 b1 |
| 3 | length-delimited (2) | 13 bytes nested protobuf message |
| 1 | varint (0) | 182 sint=91 |
| 2 | varint (0) | 1 bool=true |
| 3 | length-delimited (2) | 2 bytes nested protobuf message |
| 1 | varint (0) | 1 bool=true |
| 4 | varint (0) | 5 sint=-3 |
| 5 | varint (0) | 2 sint=1 |

## 2. Obtain enough schema information to decode real messages

- [x] Inventory available `.proto` files, descriptor bundles, generated protobuf
  code, and envelope/type metadata in this repo and already identified local
  sources. Record what is actually available and what is missing.
- [ ] Where `.proto` sources exist, generate a descriptor set with dependencies
  included and document a repeatable generation/loading procedure. Verify that
  it contains the envelope and payload message types used by the sample.
- [ ] If only generated code or embedded descriptors exist, assess whether they
  can supply a reliable schema. Use explicit mappings when the schema exists
  but the message identity cannot be determined automatically.
- [ ] Treat a missing user-supplied `.pb` file separately from a missing schema:
  investigate the platform and URL Generator decoder/encoder implementations as
  an application-owned codec source, including embedded descriptors, generated
  message code, ordinal/version maps, and envelope rules.
- [ ] Define versioned codec packs or adapters so Rust and JavaScript can use the
  same message identity, typed field model, decode behavior, and encode behavior.
  Record the codec/build version used for every decoded or encoded message.
- [ ] Support protobuf encoding from edited decoded data when a compatible
  platform codec or descriptor is available. For unknown message types, allow
  raw replay or wire inspection but do not claim that arbitrary encoding is safe.
- [ ] If schema information is unavailable, keep a useful wire inspection and
  state whether the missing source is a user descriptor, bundled platform codec,
  message mapping, or incompatible codec version. Raw protobuf bytes alone
  cannot reliably recover original field names, exact types, or message
  identities. Do not present guessed names or wire interpretations as confirmed
  decoding.
- [ ] Show a concrete reason when decoding fails, such as missing schema,
  unmatched envelope ordinal/version, ambiguous mapping, or malformed payload,
  and give the user an actionable next step.

## 3. Make message identity and contents useful

- [x] Show the decoded message type in the Traffic table so users can recognize
  messages without opening every row. Use an explicit unknown/undecoded state
  when identity cannot be established.
- [ ] On selection, show named fields and values with nested/repeated structures
  intact. Make raw bytes and wire inspection secondary views of that message.
- [ ] Render protobuf request and response content independently: show the
  request message name and parameters, then the response message name and
  payload. For WebSocket traffic, show one message with direction rather than
  implying an HTTP-style request/response pair.
- [ ] Provide a single payload view toggle between formatted JSON and compact
  JSON string. Both views must come from the same typed decoded message, not
  from parsing display-preview strings.
- [ ] Include useful context: direction, host/path, connection, timestamp, and
  envelope type/version where available. Do not imply request/response pairing
  for WebSocket messages unless there is evidence supporting that relationship.
- [ ] Handle envelopes containing multiple messages: make each inner message's
  type and contents discoverable instead of labeling the entire frame as one
  payload type.
- [ ] Share decoding results between the table and inspector so they agree.

## 4. Simplify the first page

- [x] Make the default Traffic page one message table, filter controls, and one
  selected-message inspector. Remove duplicate payload previews from this flow.
- [x] Replace the single-choice Resource filter with independent selections.
  Selecting Img + JSON + Proto must show the union of those categories, then
  apply the other filters. Define clear All/reset and no-selection behavior.
- [x] Preserve protobuf WebSocket messages in the main Traffic view. Put
  transport-specific WebSocket information, frame diagnostics, and connection
  details in the shared selected-message inspector.
- [x] Check whether Event Timeline respects filters and what additional question
  it answers. Move it into an optional view; do not keep a duplicate unfiltered
  table on the default page. Capture diagnostics are collapsed by default.
- [x] Keep schema setup and advanced diagnostics accessible without expanding
  them into the main message browsing workflow.
- [ ] Decide whether Traffic Detail adds information beyond the main Traffic
  table and selected protobuf payload. Hide, collapse, or redesign duplicate
  content so the default view stays focused on message data.
- [ ] Audit the WebSocket inspector controls: define the purpose of Decode Frame,
  decoded export path, Save Mapping, and Export Decoded JSON. Move genuinely
  advanced transport/schema actions behind an advanced section or remove
  controls that duplicate the main workflow.
- [ ] Add a Sessions panel listing session IDs found in the current data set.
  Selecting a session must jump to the response/message that introduced or
  included that session ID, with clear behavior for multiple matches.
- [ ] Add traffic filters for unknown/undecoded messages, dead calls, and errors.
  Provide an explicit Errors-only toggle and define how pending, missing,
  cancelled, and failed calls are classified.
- [ ] Add a dual request/response view with requests on the left and responses
  on the right, aligned by correlation so the matching response sits beside its
  request. Keep WebSocket messages as a direction-aware stream when no pairing
  evidence exists.
- [ ] Add local text search over message names, paths, session IDs, transport
  metadata, and case-insensitive request/response headers.
- [ ] Search raw UTF-8/text and JSON bodies where available, protobuf wire
  previews, and schema-decoded protobuf field names, nested values, and
  envelope/application message names. Keep request/response direction attached
  to each match and do not claim that arbitrary binary bytes are searchable
  without a decoder.
- [ ] Index decoded values as derived local data while preserving the raw
  payload as the source of truth. Update the index for live traffic, imported
  logs, and saved captures without sending payloads to a cloud service.
- [ ] Show match snippets and source/direction context; selecting a result must
  select the underlying Traffic row/message and eventually highlight the match
  in the decoded/header/body inspector.
- [x] Clarify the Resource `Proto` filter versus Payload `protobuf` filter. The
  UI now labels them as `Proto resource` and `Payload type: Protobuf`; revisit
  the underlying predicates if real captures show they are still equivalent.
- [ ] Fix Capture diagnostics jumping to the latest message during refresh. Keep
  the user's diagnostics scroll position unless they explicitly request latest.
- [ ] Stop traffic-window auto-follow when a message is selected, while keeping
  the explicit auto-scroll toggle available to resume following new messages.
- [ ] Match the `wfe-central:tools:Packetlog viewer` filtering model for Connect
  and mobile-server calls, highlight Connect API traffic, and then add clearer
  message identity, decoded JSON, and anomaly context than the existing tool.
- [x] Rename user-facing `Findings` terminology to `Anomalies` consistently in
  filters, columns, summaries, and detail panels.
- [ ] Add stable, accessible session colors in the Traffic table and inspector,
  with a legend or other way to avoid relying on color alone.
- [ ] Reduce the Decode section to a compact success/unknown/error state in the
  default view. Put detailed status, mapping evidence, and raw wire fields in a
  collapsed advanced section.

Implementation note: the Traffic page now uses one combined HTTP/WebSocket
message table and one selected-message inspector. Event Timeline remains an
optional filtered view, while the capture event list is collapsed under
Capture diagnostics.

- [x] Runtime Browser Setup now labels the generated launch snippets as
  Windows PowerShell commands, including the copyable Edge and Chrome rows.

## 5. Verify the result

- [ ] Test the representative message with a known schema/mapping: its type is
  visible in Traffic and selection shows expected named fields and values.
- [ ] Test missing and ambiguous schemas/mappings: the UI explains the failure
  and still permits raw inspection without claiming successful decoding.
- [ ] Verify Img + JSON + Proto together, other filter combinations, and reset.
- [ ] Verify that selecting HTTP and WebSocket messages opens one consistent
  inspector and that clearing capture clears stale selection/details.
- [ ] Build a fresh release exe and repeat the browser/proxy capture workflow.
  Source-level tests alone do not establish that the user's exe is fixed.
- [ ] Update this checklist with completed work, remaining issues, and the exact
  build/sample used for verification. Keep notes short; do not add unrelated
  product plans.

## 6. UI refinement and usability

The current UI is still an engineering prototype. The primary measure of
progress is whether a user can quickly find a message, understand what it is,
and inspect the useful data without navigating through unrelated detail.

- [ ] Audit the main page for unhelpful or duplicated data. Remove it from the
  default view or move advanced transport, diagnostics, and schema setup into
  secondary views/pages.
- [x] Add dark mode with a clear theme control and persisted preference. Check
  tables, code blocks, empty states, dialogs, and status messages in both themes.
- [x] Add a compact summary box showing the current capture state and the most
  useful counts, such as messages, decoded messages, errors, and active filters.
- [x] Add an explicit auto-scroll toggle. Preserve the current scroll position
  when auto-scroll is disabled and make the enabled/disabled state obvious.
- [ ] Make messages easier to understand: use friendly names alongside the
  fully-qualified protobuf type, distinguish request/response/frame context,
  surface decode failures clearly, and keep raw wire data secondary.
- [x] Persist filter settings across refreshes and app restarts. Define which
  settings are global and which belong to a workspace or capture session.
- [ ] Verify the 1.5-second refresh behavior. Confirm whether the current
  implementation rewrites the whole screen; update only changed rows/panels,
  and preserve selection, scroll position, expanded sections, and input focus.
- [ ] Add focused UI tests for filtering, theme changes, refresh preservation,
  selection, and empty/error states.

## 7. Capture and log workflow

- [ ] Add a way to save captured data to a log file. Define the log format,
  metadata, schema references, raw payload retention, and whether decoded data
  is stored as a derived view.
- [ ] Separate capture snapshots from continuous recording: allow saving the
  current live session and optionally appending new live events while the proxy
  is running.
- [ ] Preserve the original source file, archive entry, record offset, and
  parser version on imported events so results remain traceable.
- [ ] Allow users to select individual traffic/messages or a range of lines and
  save only the selected data to a file.
- [ ] Add recording mode: for a selected request, save the request and its
  matching response as a reusable request/response set.
- [ ] Define how a request/response set is represented by a directory and its
  contents, including naming, metadata, ordering, and incomplete pairs.
- [ ] Make pairing behavior explicit for missing responses, duplicate requests,
  streaming messages, and WebSocket traffic.

## 8. Operating modes

### Real-time decode

- [ ] Support live proxy capture and decode as the default real-time workflow.
- [ ] Add optional log recording while real-time decoding is active.
- [ ] Add an explicit Traffic source/session switch for Live, Imported, and
  Replay data. Keep imported logs out of the live stream and preserve the live
  session when switching views.
- [ ] Make it possible to pause live monitoring/display without discarding the
  live capture, and show the active source clearly in the UI.
- [ ] Keep capture status, refresh interval, dropped data, and decode errors
  visible without crowding the message inspector.

### Log decode

- [ ] Add an open-log workflow for one or more log files.
- [ ] Support file picker and drag-and-drop input.
- [ ] Support multiple selected/dropped files as one named import session while
  retaining per-file source identity and errors.
- [ ] Sniff file signatures as well as extensions and support raw packet-log
  `.dat`, gzip-compressed `.dat.gz`, and zip archives containing supported log
  entries. Walk nested zip archives recursively, with a maximum nesting depth
  and a clear source path such as `outer.zip!/inner.zip!/packet.dat.gz`.
- [ ] When a `.gz` packet log is opened, stream-decompress it and offer to save
  the materialized `.dat` in an application-managed user-data cache using a
  collision-safe name. Keep the original `.gz` or archive unchanged and record
  whether the `.dat` was generated or already present. Expose the cache
  location in the UI and leave a configurable directory override for a later
  settings pass.
- [ ] Detect packet-log `.dat` members inside `.tar` files found in real-world
  exports, or report them as unsupported with the archive member name rather
  than treating the tar bytes as a raw packet log.
- [ ] Define whether unsupported archive entries are skipped or reported.
- [ ] Implement a streaming packet-log decoder adapter compatible with the
  existing `wfe-central:tools:Packetlog viewer` format. Do not infer the wire
  format from the filename; capture representative files or the existing
  parser contract as golden fixtures first.
- [ ] Normalize decoded log records into the same event/exchange model used by
  live proxy capture, including timestamps, direction, correlation, raw bytes,
  decode status, and source metadata.
- [ ] Define stable multi-file ordering: timestamp order with file/order/offset
  tie-breakers, plus an explicit warning when timestamps are missing or mixed.
- [ ] Stream large imports with progress, cancellation, bounded memory, and a
  malformed-record report instead of loading every file into the webview.
- [ ] Show the selected log/set, decode progress, malformed entries, and source
  file for each message.

### Replay and persistence ingestion

- [ ] Add Replay Mode for previously captured request/response data, with clear
  control over timing, ordering, and whether traffic is sent upstream.
- [ ] Load a saved native capture as an immutable Imported or Replay session;
  never silently merge it into the live capture.
- [ ] Ingest persisted capture/log files as a first-class source of Traffic data,
  preserving raw payloads, decoded data, codec identity, timestamps, and session
  identifiers.
- [ ] Allow users to drag and drop one or more protobuf/schema files into the
  tool, including supported `.zip` and timezone/archive formats. Define whether
  files are copied into a managed workspace or referenced in place.
- [ ] Support multiple schema/codec inputs with explicit precedence, conflict
  reporting, and a visible active codec set.

### Dev server / offline local mode

- [ ] Add a dedicated Local Dev Server mode that serves predefined responses
  directly to the client on a separate local endpoint/port.
- [ ] Add explicit Stub Only, Hybrid Fallback, and Replay behavior; make the
  active mode visible and prevent fixture-backed responses from being confused
  with passive live monitoring.
- [ ] Implement request-to-response mapping backed by a directory of fixtures.
- [ ] Support partial offline mode where mapped requests are served locally but
  authentication/login still uses the real server.
- [ ] Support response sequences for typical requests, including changing
  responses over time and mappings to a folder of responses.
- [ ] Define keep-alive behavior and connection/session lifecycle for offline
  responses.
- [ ] Define how JWTs and other authentication state are handled in offline and
  partial-offline modes.
- [ ] Support price subscriptions, price responses, and configurable price
  generators for development scenarios.
- [ ] Add workflows to edit an existing response map/set and generate a new
  response map/set from recorded traffic.
- [ ] Make the active set, mapping result, fallback-to-server behavior, and
  replay/sequence position visible and auditable.

## 9. Mode and format design decisions

- [ ] Choose a versioned log format that can preserve raw traffic, decoded JSON,
  schema identity, timestamps, direction, and request/response correlation.
- [ ] Define a source/session envelope around normalized events, including
  `live`, `imported`, `replay`, and `stub` provenance without duplicating event
  payloads.
- [ ] Decide whether the native saved format is a streaming length-delimited
  binary format, JSON Lines with base64 payloads, or a container holding both
  metadata and raw records. Keep decoded JSON derived and reproducible.
- [ ] Define round-trip scope: native save/load first; add compatibility export
  to the wfe-central packet-log format only after its exact writer contract is
  known.
- [ ] Decide whether log archives are opened in place or extracted into a
  managed workspace, and how large files are handled safely.
- [ ] Define the persistence boundary for UI preferences, capture sessions,
  logs, request/response sets, and offline-server configuration.
- [ ] Define the refresh/update model before optimizing the UI: full snapshot,
  incremental events, or a hybrid approach.
- [ ] Add end-to-end fixtures covering real-time capture, saved logs, replay,
  partial offline mode, response sequences, and missing/ambiguous mappings.
- [ ] Add end-to-end coverage for multi-file imports, `.dat`, `.dat.gz`, zip
  containers, drag-and-drop, cancellation, malformed records, source switching,
  and live/imported isolation.
