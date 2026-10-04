# Protobuf decode/proxy server/dev server Codex TODO

This file is working context for future Codex sessions. Keep it practical, current, and biased toward implementation decisions.

## Project Context

This app is a local-first investigation tool for protocol-driven systems. The initial driver is replacing an existing protobuf packet-analysis workflow with something better than table-based inspection.

The goal is to help engineers understand protobuf traffic and other protocol data by reconstructing flows, pairing related messages, surfacing anomalies, and making large data sets easier to explore visually. Protobuf is the first concrete protocol target, not the intended limit of the product.

Important product directions:

- Offline log analysis: ingest protobuf logs, JSON exports, and other captured protocol data.
- Protocol expansion: support additional protocol adapters where there is demand, possibly including FIX, gRPC, JSON-over-HTTP, WebSocket payloads, and domain-specific binary protocols.
- Rich visual exploration: timelines, heatmaps, flow/swimlane views, request/response pairing, latency views, and inspectors.
- Real-time proxy mode: run this as a proxy or pass-through MITM between client and server, decode protobuf traffic live, and visualize/debug it as it happens.
- Offline/proxy dev mode: run without the real server by replaying or synthesizing responses from cached request/response data.
- Human-editable fixtures: support JSON-based cached responses so client developers can work while dev servers are unavailable.
- Optional AI-assisted anomaly analysis: investigate cloud LLM integrations such as AWS Bedrock for summarization, clustering, hypothesis generation, or explanation, without making cloud access mandatory for core anomaly detection.

Adjacent product reality check:

- Fiddler, Charles, Proxyman, and mitmproxy cover HTTP/S proxying, TLS MITM, request/response inspection, replay, and request mutation well.
- Postman, Insomnia, Kreya-style clients, grpcurl, and grpcui cover active gRPC/protobuf API calls where the user is driving the request directly and service definitions/reflection are available.
- Wireshark can dissect protobuf/gRPC with configured `.proto` search paths and is useful as a reference for schema/import UX, but it is packet-analysis-first rather than workflow/edit/replay-first.

## Protocol Strategy

The core should stay protocol-agnostic. Protocol-specific behavior belongs in adapters/plugins that can decode payloads, provide correlation hints, identify error semantics, and expose protocol-specific inspector views.

Initial protocol priorities:

1. Protobuf: first target because it is the original use case.
2. JSON fixtures and JSON-over-HTTP: useful for offline/proxy dev mode and human-editable fixtures.
3. gRPC: likely adjacent to protobuf, but requires explicit handling of HTTP/2 framing, streaming, metadata, status codes, and service/method naming.
4. FIX: likely market-relevant for financial systems; needs message dictionary support, session semantics, sequence handling, and domain-specific anomaly rules.
5. Other binary or text protocols: add only when there is clear demand or a customer/user workflow.

Avoid letting protobuf assumptions leak into the event model. The normalized model should express generic transport, session, direction, timing, payload, decode, correlation, and anomaly concepts.

## Cloud AI / AWS Bedrock Notes

This app should remain useful without cloud AI. If AWS Bedrock is added, treat it as an optional provider for higher-level analysis rather than the primary anomaly engine.

Possible Bedrock uses:

- summarize unusual flows or clusters of anomalies
- explain detector output in human-readable terms
- suggest likely root-cause hypotheses from selected evidence
- compare a trace against a known-good baseline narrative
- help classify unknown message patterns after local preprocessing

Credential and deployment concerns for a Tauri app:

- Do not embed AWS keys in the desktop app.
- Prefer standard AWS credential resolution where possible: environment variables, shared AWS config files, AWS SSO, or a local credential process.
- Consider an optional customer-owned backend/proxy for Bedrock calls if direct desktop credentials are not acceptable.
- Make data-sharing explicit: users must understand when payloads, decoded messages, or summaries leave the machine.
- Add redaction controls before sending any trace data to a cloud model.
- Keep local deterministic detectors as the source of record; Bedrock output should be advisory and evidence-linked.

## Current High-Level Architecture

Pipeline from the README:

```text
capture -> decrypt -> decode -> normalize -> correlate -> detect -> visualize
```

Keep these stages decoupled. Decoding should not be coupled to the UI. Detection should operate on normalized events and flows where possible.

Core entities:

- Event: normalized observed message or action.
- Session: related events sharing transport/session identity.
- Flow: correlated chain of events representing a conversation or workflow.
- Anomaly: suspicious timing, state, structure, or behavior with evidence.
- Baseline: known-good reference for comparison.

## Near-Term Priorities

1. Continue live traffic UI improvements now that the proxy feasibility slice is largely proven.
2. Build useful traffic views from captured data: table polish, timeline, heatmap, WebSocket frame inspection, and raw/decoded payload panes.
3. Decode binary socket data next: start with descriptorless protobuf hints, then add schema-aware WebSocket message mapping.
4. Define the normalized event model using real proxy-captured HTTP/WebSocket traffic.
5. Add raw plus decoded message inspection for HTTP bodies and WebSocket frames.
6. Add decoded-message search over captured payload previews.
7. Build request/response pairing and flow reconstruction.
8. Design offline/proxy dev-mode fixture matching.
9. Define protobuf ingestion requirements and sample fixture format.
10. Add simple anomaly detection with explainable evidence.

## Implementation TODO

### Product And Specs

- [ ] Create `docs/product-spec.md` with the core user workflows:
  - offline protobuf log investigation
  - real-time proxy debugging
  - offline/proxy dev mode with cached responses
  - anomaly triage and explanation
- [ ] Create `docs/engineering-spec.md` with module boundaries, data contracts, and storage assumptions.
- [x] Create `docs/architecture/proxy-mode.md` covering pass-through MITM, TLS/decryption boundaries, capture format, and safety constraints.
- [x] Create `docs/architecture/offline-dev-mode.md` covering request matching, cached responses, editable JSON fixtures, replay behavior, and mismatch handling.
- [ ] Create `docs/anomaly-detection.md` covering first-pass detection types and how `../net-anomaly` may integrate.

### Proxy Feasibility Spike

- [x] Proxy feasibility is considered proven enough to move product work forward: plain HTTP pass-through, HTTPS MITM with a generated  CA, WebSocket upgrade/message forwarding, persistent CA storage, Tauri startup/status commands, and live UI capture are implemented. Remaining proxy items are hardening/reference tests rather than the active milestone.
- [x] Use `hudsucker` as the first embedded Rust candidate for a proxy spike.
- [x] Compile and run the initial `core/proxy` plain HTTP pass-through test. Rust is installed at `C:\Users\gphillips\.cargo\bin`, but that directory is not on the current PowerShell `PATH`. Running Cargo by absolute path with `CARGO_HTTP_CHECK_REVOKE=false` gets past the crates.io certificate revocation error. `rcgen 0.14.x` currently fails under `rustc 1.96.0` with E0119 conflicting trait implementations, so `core/proxy` temporarily patches `rcgen` to a vendored copy with narrowed `From` impls.
- [ ] User handoff: once on an unblocked network, run `pnpm tauri dev` from `apps/web`, confirm the Tauri app starts the proxy automatically on `127.0.0.1:27777`, export the generated CA cert from the UI, then run a browser or `curl.exe` through `HTTP_PROXY=http://127.0.0.1:27777` and `HTTPS_PROXY=http://127.0.0.1:27777` to manually test pass-through/MITM behavior.
- [ ] Current local blocker: `static.crates.io` is blocked by Cisco security filtering on the current network, so Cargo receives an HTML block page for `flate2` and fails checksum verification. Retry on home/unblocked network or allowlist `static.crates.io`, `crates.io`, and `index.crates.io`.
- [x] Intercept captured traffic from the running proxy and display it in the UI as the next implementation slice.
- [ ] Compare `hudsucker`, `slinger-mitm`, and `mitmproxy` against the same acceptance tests.
- [ ] Treat `mitmproxy` as the reference implementation and possible sidecar fallback.
- [ ] Treat `slinger-mitm` as an isolated experiment until its GPL-3.0-only license is accepted or ruled out.
- [ ] Do not attempt a Rust port of mitmproxy as an initial strategy.
- [ ] Do not use Python-in-WASM for proxy mode; local sockets, TLS, certificate storage, and OS integration make it the wrong runtime boundary.
- [x] Prove plain HTTP pass-through against a local test server.
- [x] Prove HTTPS MITM with a generated CA and a test client configured to trust it. Current test uses a local HTTPS upstream with an explicit upstream test root so the proof stays offline and deterministic.
- [x] Prove WebSocket upgrade and message forwarding/capture. Current `core/proxy` records WebSocket message direction, kind, and payload-length hint, but still needs durable connection/session identity in the normalized event model.
- [ ] Test HTTP/2 support before making gRPC claims.
- [ ] Test unary gRPC through the proxy.
- [ ] Test streaming gRPC through the proxy.
- [x] Define initial Tauri start/stop/status command shape after proxy behavior is proven. `apps/web/src-tauri` now starts the proxy on app setup using fixed address `127.0.0.1:27777` and exposes `proxy_status`, `proxy_events`, `export_ca_cert`, and `stop_proxy`; the web UI has an `Export CA Cert` button that writes the persistent protobuf-decoder CA as both `protobuf-decoder-local-test-ca.cer` and `protobuf-decoder-local-test-ca.pem` in the user's Downloads directory. Use the `.pem` file directly with `curl.exe --cacert`, so OpenSSL is not required for conversion. Trust-store install/reset UX remains open.
- [ ] Windows curl/Schannel note: local generated MITM certs can fail with `CERT_TRUST_REVOCATION_STATUS_UNKNOWN` even when `--cacert` points at the exported protobuf-decoder PEM, because the dev CA/leaf certs do not publish revocation endpoints. For manual curl smoke tests use `--ssl-no-revoke` with `--cacert`; later product docs should explain this clearly and separate it from real trust-store installation guidance.
- [x] CA lifetime note: earlier proxy builds generated a fresh CA every restart, which caused stale exported certs and errors such as `certificate signature failure`. Persistent CA storage now removes that restart churn; stale exports should only happen after a future CA reset/regeneration.
- [x] Persistent CA storage implemented: Tauri now loads or creates `protobuf-decoder-ca.pem` and `protobuf-decoder-ca-key.pem` in the app data directory, starts the proxy with that saved CA, and reports CA storage status in the UI. Export still writes public `.cer` and `.pem` copies to Downloads; the private key stays in app data.
- [x] Browser setup UX implemented in the live proxy UI: shows the proxy address, CA trust guidance, copyable PowerShell launch commands for isolated Edge/Chrome profiles, and browser smoke-test links for HTTP, HTTPS, and WebSocket checks.
- [x] Initial HTTP exchange model implemented: Tauri pairs captured HTTP request/response events by `request_id`, computes duration and body-length metadata, emits first-pass anomaly flags for missing response, HTTP 4xx/5xx, slow response, and large response, and the UI displays recent exchanges in a table.
- [x] Initial payload/protobuf hinting implemented: HTTP exchanges now include request/response content-type, likely protocol (`grpc`, `protobuf`, `json`, `text`, or `unknown`), decode status text, and a low-severity `protobuf_undecoded` anomaly for likely protobuf/gRPC traffic until decoder configuration exists. Protobuf wire payloads do not self-identify proto2/proto3; descriptor/schema loading is still required for real decoding.
- [x] Payload hint cleanup: keep protobuf/gRPC protocol hints from headers, but when HTTP status is 4xx/5xx report that decoding was skipped because the response was an error and suppress the low-severity `protobuf_undecoded` anomaly so the HTTP error remains the primary signal.
- [x] First real-time protobuf decode slice implemented: the proxy captures bounded HTTP request/response bodies when the exact or upper body length is at or below 256 KB, keeps raw samples internal to Rust, and Tauri exposes a descriptorless protobuf/gRPC wire preview on each HTTP exchange. The UI exchange detail panel now shows field numbers, wire types, and value previews for captured protobuf-looking payloads. This is not schema-aware yet; field names, proto2/proto3 semantics, enums, oneofs, packed fields, maps, and exact message types still require descriptor loading.
- [x] Protobuf schema import started: Tauri now has a `prost-reflect` descriptor registry and can load a compiled `FileDescriptorSet` from a user-supplied path in the UI. The Protobuf sidebar panel reports loaded file/message/service counts and sample message names. Next step is mapping captured HTTP/WebSocket payloads to a concrete message descriptor and rendering named fields with `DynamicMessage`.
- [x] Protobuf detection refinement: HTTP payload hints can now promote unknown binary bodies to protobuf candidates when the captured bytes parse as protobuf wire data, and the table's Decode column shows the actual wire-preview status rather than the older generic "decoder not configured" hint.
- [x] Descriptorless protobuf wire preview now makes better guesses: varints show unsigned plus ZigZag-style signed interpretations, fixed32/fixed64 show integer plus float/double interpretations where finite, and length-delimited values try printable UTF-8 first, then nested protobuf wire parsing, then hex fallback. This is still heuristic and not a substitute for schema-aware `DynamicMessage` decoding.
- [x] JSON preview slice implemented: captured JSON request/response bodies are parsed with `serde_json`, pretty-printed, and shown as separate request/response preview blocks in the exchange detail panel. If parse fails, this app shows a text fallback when the captured bytes are UTF-8.
- [x] JSON preview cleanup: empty captured JSON bodies are now reported as empty instead of surfacing serde's EOF parse error, and the exchange detail Decode field now shows the actual decoder result instead of the older protocol hint.
- [x] Network table usability slice: `Response` column was clarified to `Response Size`, a `Server Time` column was added from common response headers (`Date`, `Server-Time`, `X-Server-Time`), and table headers are sortable. Default time order remains oldest-to-newest with bottom auto-follow.
- [x] Exchange table scroll stability fix: when the user scrolls away from the bottom, polling re-renders preserve the existing scroll offset instead of jumping. Programmatic bottom-follow scrolls are ignored by the scroll-state handler.
- [x] Live traffic UI ordering/control note: captured exchanges now follow Chrome DevTools-style network conventions: oldest rows at the top, newest rows appended at the bottom, and the table auto-scrolls only while the user is already at/near the bottom. Scrolling away pauses auto-follow until the user scrolls back down. The workbench toolbar includes `Clear Capture`, which clears the in-memory proxy event store without stopping the proxy.
- [x] UI cleanup slice started: the frontend now uses the full available app width and has real workspace tabs for `Traffic`, `Schemas`, and `Runtime`. Traffic keeps the main inspection table and filters; Schemas owns descriptor-set loading; Runtime owns proxy/CA/browser setup/stats. The Traffic table has DevTools-inspired column naming/order (`Name`, `Status`, `Type`, `Initiator`, `Size`, `Time`, `Method`, `Host`, `Decode`, `Findings`), and the detail panel is renamed `Traffic Detail` with split Request/Response panes.
- [x] WebSocket frame inspection UI started: WebSocket message rows are selectable and now show a frame detail panel with direction, target, connection id, payload size, decode status, JSON preview, and descriptorless protobuf wire preview fields.
- [x] Manual schema-aware WebSocket protobuf decode started: after loading a descriptor set, the selected WebSocket frame can be decoded as a user-chosen message type using `prost-reflect::DynamicMessage`; the frame detail panel shows named fields and nested values when decode succeeds. This is a manual bridge before durable URL/channel/message mapping rules.
- [ ] Node/npm WebSocket smoke-test note: running `npx wscat` while `HTTP_PROXY`/`HTTPS_PROXY` point at this app can fail before the test starts with `unable to verify the first certificate`, because npm itself is being MITM'd while downloading `wscat`. For manual testing either set `NODE_EXTRA_CA_CERTS`/`npm config set cafile` to the exported protobuf-decoder PEM before `npx`, or install/use `wscat` with proxy env vars unset and then re-enable the proxy for the actual WebSocket test.
- [x] Manual secure WebSocket smoke test worked with Postman echo: `wscat -c wss://ws.postman-echo.com/raw --proxy http://127.0.0.1:27777` after setting `NODE_EXTRA_CA_CERTS` to the exported protobuf-decoder PEM. This app displayed ping/pong and text WebSocket request/response frames after refresh.
- [x] Add WebSocket lifecycle capture and UI state: `ProxyEvent` now includes `connection_id`, `websocket_event_kind`, and `websocket_error`; the proxy records logical WebSocket open/close/error events separately from message frames; the Tauri summary reports active/opened/error counts; the live proxy UI polls every 1.5s and shows a green/red WebSocket connection indicator.
- [ ] Keep proxy tests independent from the UI so failures are easy to reproduce.
- [ ] Document unsupported cases, especially certificate pinning and clients that cannot trust a custom CA.

### Data Model

- [ ] Define a versioned `Event` schema with:
  - stable id
  - timestamp
  - direction
  - protocol
  - transport/session metadata
  - raw payload reference
  - decoded payload
  - normalization fields
  - decode errors
- [ ] Define `Session` and `Flow` schemas.
- [ ] Define a `CorrelationHint` model for request/response pairing.
- [ ] Define an `AnomalyFinding` schema with evidence, severity, explanation, and source detector id.
- [ ] Decide where schemas live first: TypeScript, Rust, JSON Schema, or generated from a shared IDL.

### Ingestion And Decoding

- [ ] Define supported v0.1 input formats.
- [ ] Add protobuf log fixture examples.
- [ ] Add editable JSON fixture examples.
- [ ] Design protobuf descriptor/schema loading. Current library direction: prefer a descriptor-set-first runtime decoder/encoder that can decode captured bytes without compiling app-specific Rust types. `docs.rs/protobuf` is the long-running `stepancheg/rust-protobuf` crate, not the new Google-owned Rust runtime; its README says it is approaching end of life in favour of a separate official implementation. The official `protocolbuffers/protobuf` Rust implementation is worth watching, but for our app' near-term dynamic decode/edit/re-encode workflow, `prost` + `prost-reflect` or `protobuf` v3 dynamic messages remain the practical candidates until the official Rust crate is published/stable with runtime descriptor support.
- [ ] Implement a minimal protobuf decoder adapter boundary.
- [ ] Add descriptor-set-to-message mapping so protobuf previews become schema-aware decoded messages. Descriptor-set loading exists; mapping still needs route/header/WebSocket channel rules, gRPC method mapping, and/or user-selected message types. Descriptorless wire preview remains a fallback/proof of live decode plumbing.
- [x] Descriptor bundle scoping started: loaded proto descriptor sets are now in-memory named bundles with host match rules (`any`, `exact`, `suffix`, `contains`) plus optional path-prefix tags. The Schemas workspace can load multiple bundles, displays their scope, and selected WebSocket frame decode suggestions prefer bundles matching that frame's host/path before falling back to all loaded message types. Persistence, edit/delete, ambiguity indicators, and explicit merge behavior remain open.
- [x] Removed sanitized fixture export from the app after validating it was not useful for real CMC decode work. For safe non-CMC development, create a tiny synthetic descriptor set plus synthetic HTTP/WebSocket protobuf payloads, implement durable mapping rules against those, then bring the generic code back to the locked-down machine for validation with the real `mobile-server-api.pb`.
- [x] Application packet decoding now follows the behavioral reference in `wfe-network-types`: loaded descriptor sets are inspected for the `generator.message_type_ordinal` file option, incoming `iPhonePacketProto` envelopes are unwrapped, and each `messageList` payload is decoded by `(messageType, messagePayloadVersion)`. This is automatic for HTTP and WebSocket previews, with the descriptorless wire preview retained for direct payloads and unknown mappings. The Rust unit tests cover ordinal/version metadata extraction; compile and executable validation must happen on the build/test machine because this workstation cannot complete Cargo dependency downloads.
- [ ] Add schema bundle persistence plus edit/delete controls.
- [ ] Add row/frame schema status indicators: matched schema, no schema, ambiguous schema.
- [ ] Handoff note for schema-aware protobuf decoding: current locked-down-machine test loaded descriptor bundle `mobile-server-api` from `C:\Work2\GP\mobile-server-api\mobile-server-api\target\mobile-server-api.pb` with 726 messages and `Any host` scope, but Traffic payload previews still show `Descriptorless protobuf wire preview; schemas are required for field names and exact types.` This is expected until a concrete message-type mapping matches the captured frame. WebSocket mapping rules now support host/path/direction/frame-kind/direct-message and envelope-field strategies, persist to app data, auto-apply in WebSocket frame preview builders, and keep descriptorless wire preview as the fallback when no rule matches or the match is ambiguous. HTTP protobuf payloads still need equivalent durable mapping rules.
- [x] Added selected WebSocket decoded-message export: after loading a descriptor set and choosing a concrete protobuf message type for a selected frame, the UI can write a non-sanitized JSON export containing target metadata plus real decoded field names and values. This is for local locked-down-machine inspection only unless policy allows moving the file.
- [x] Started durable WebSocket protobuf mapping rules: users can add rules keyed by host match, path prefix, direction, frame kind, and fully qualified message type. WebSocket previews now auto-decode with `DynamicMessage` when exactly one rule matches, report ambiguity when multiple rules match, and keep descriptorless wire preview as the fallback.
- [ ] Add `.proto` folder import by invoking/bundling `protoc` or by documenting descriptor-set generation first. Current implementation expects a precompiled `FileDescriptorSet`.
- [x] Capture bounded WebSocket frame samples and run the same preview path over them. The proxy now captures capped text/binary/ping/pong WebSocket payload samples internally without changing forwarding; Tauri emits `websocket_message_previews` with direction, target, kind, size, protocol hint, and JSON/protobuf preview status; the Traffic workspace has a `WebSocket Messages` panel showing recent frames and protobuf candidates. Existing WebSocket pass-through tests now assert captured request/response text payload samples.
- [x] Next WebSocket decoding step started: selected WebSocket binary frames can now be manually decoded with a loaded descriptor-set message type, so descriptorless candidates can become named field previews. Durable mapping rules keyed by WebSocket URL/channel/envelope fields are still needed.
- [x] Persist WebSocket protobuf mapping rules and add edit/delete controls. Rules are stored in Tauri app data as `websocket-proto-mappings.json`, loaded on startup, and saved after add/update/delete.
- [ ] Improve WebSocket active connection reporting if needed. A single WebSocket is already bidirectional; seeing two active sockets means two logical WebSocket connections or a lifecycle/coalescing issue in the current handler, not "one socket per direction."
- [ ] Preserve raw payloads separately from decoded/normalized data.
- [ ] Record decode failures as first-class events instead of dropping data.

### Search

- [ ] Add decoded-message text search using Tantivy as a derived index, not the source of truth. Index decoded/searchable text from HTTP request/response payloads, JSON previews, protobuf wire previews, and later schema-aware protobuf `DynamicMessage` output. Store stable refs back to our traffic items (`exchange_id`, direction, host/path, protocol/type, status/time) so search results can select the exact row/message in the UI.
- [ ] Add Tauri search commands such as `search_messages(query)` and clear/rebuild behavior tied to `Clear Capture`.
- [ ] Add a search results UI with highlighted snippets; clicking a result should select the matching traffic item and eventually highlight the match inside the detail payload preview.
- [ ] Batch Tantivy commits/reader refreshes for near-real-time indexing rather than committing every message individually.

### Correlation And Flows

- [ ] Implement request/response pairing rules for protobuf traffic.
- [ ] Support explicit correlation ids when present.
- [ ] Support fallback pairing by timing, endpoint, message type, and sequence.
- [ ] Represent unpaired requests and orphan responses clearly.
- [ ] Add latency calculation between paired events.
- [ ] Add flow reconstruction across related pairs.

### Visualization

- [x] Prototype an overview timeline for HTTP exchanges. The Traffic timeline tab now renders exchange start position, duration, protocol, HTTP status, and finding markers from captured data. Treat lower-level proxy/WebSocket lifecycle events as their own event timeline, closer to Wireshark-style chronological evidence, rather than mixing them into the main HTTP exchange table.
- [x] Add compact server markers to captured traffic rows. HTTP exchange rows, WebSocket frame rows, detail panes, and timeline labels now use deterministic colored server badges/dots based on the captured authority so multi-backend captures are easier to scan without adding another long text column.
- [ ] Extend the timeline to include selectable WebSocket frames/lifecycle events without losing the cleaner HTTP exchange overview.
- [ ] Prototype a swimlane/flow view.
- [ ] Prototype a heatmap for latency, error density, or message volume. Current UI has a placeholder heatmap tab and a simple status/error-colored cell grid; next step is meaningful bucketing by host/message type/latency/error density.
- [ ] Add raw/decoded inspector panel.
- [ ] Add filters for session, message type, anomaly type, latency, and direction.
- [ ] Evaluate rendering approach:
  - DOM/SVG for early prototype
  - Konva/PixiJS for dense visualizations
  - WebGPU-backed aggregation later if needed

### Anomaly Detection

- [ ] Implement simple local detectors first:
  - decode failure
  - missing response
  - late response
  - unexpected response type
  - error-state message
  - out-of-order sequence
  - latency spike against baseline
- [ ] Ensure every finding explains what was observed and why it is suspicious.
- [ ] Define detector plugin interface.
- [ ] Investigate how `../net-anomaly` should expose algorithms.
- [ ] Decide which workloads are suitable for WebGPU/WASM acceleration.

### Storage And Indexing

- [ ] Decide initial storage for v0.1:
  - SQLite
  - DuckDB
  - append-only files plus indexes
- [ ] Define raw payload storage strategy.
- [ ] Define indexes needed for timeline navigation, session lookup, and flow lookup.
- [ ] Support loading small fixtures fully in memory before optimizing.
- [ ] Benchmark with representative protobuf log sizes before committing to complex storage.

### Offline/Proxy Dev Mode

- [ ] Define editable fixture format for cached request/response pairs.
- [ ] Define request matching rules:
  - exact match
  - field-based match
  - predicate/scripted match
  - fallback default response
- [ ] Define response behavior:
  - immediate response
  - recorded latency replay
  - synthetic latency
  - error injection
- [ ] Add mismatch diagnostics when no cached response matches.
- [ ] Support fixture editing without recompiling the client.
- [ ] Preserve a trail of served cached responses for debugging.

### Live Proxy Mode

- [ ] Decide proxy architecture and runtime location.
- [ ] Decide whether the first proxy implementation lives in a separate Rust crate, the Tauri backend, or both.
- [ ] Define capture points and transport metadata.
- [ ] Define TLS/decryption requirements and limitations.
- [ ] Support pass-through mode before mutation/replay features.
- [ ] Stream decoded events into the same model used by offline ingestion.
- [ ] Make safety boundaries explicit: local use, credentials, secrets, and redaction.
- [ ] Manual target test: open `platform.cmcmarkets.com` in an isolated Edge/Chrome profile configured with `127.0.0.1:27777` as HTTP/HTTPS proxy, confirm this app passes traffic through and captures HTTP/WebSocket exchanges. Expect possible blockers from certificate pinning, HSTS/trust-store mismatch, service worker/cache behavior, HTTP/2/gRPC support gaps, authentication/session requirements, or WebSocket/protobuf payloads that need body capture before decoding.

## Open Questions

- What are the current protobuf log formats used by the existing tool?
- Are protobuf descriptors available at runtime, generated into the client, or embedded in logs?
- What fields reliably identify request/response pairs?
- Does live proxy mode need TLS MITM, plain TCP/HTTP passthrough, WebSocket support, or all of these?
- Should offline dev mode be deterministic by default, or should it simulate timing and errors?
- Should the first desktop target be Tauri immediately, or should the UI prototype start as a plain web app?
- Which storage engine best matches local-first analysis of large protocol traces?
- What is the minimum useful anomaly detector set for v0.1?

## Current Milestone

Improve the live traffic UI, then decode binary socket data:

1. Replace placeholder visualizations with useful live views over captured traffic.
2. Make selection and inspection consistent across table, timeline, heatmap, and WebSocket frame panels.
3. Add better raw/decoded payload panes for HTTP request/response bodies and WebSocket frames.
4. Add schema-aware mapping rules for binary WebSocket protobuf payloads.
5. Keep proxy hardening and HTTP/2/gRPC checks as follow-up validation, not the main blocker.

The proxy feasibility vertical slice is now historical context. The active product risk is whether captured traffic can be explored quickly enough to make protobuf/WebSocket investigation better than table-only inspection.
