# Proxy Mode Feasibility Spike

This is the first technical spike for this app. The product value depends heavily on whether local proxy, MITM, TLS, WebSocket, REST, and eventual offline dev-server behavior can be implemented reliably.

## Decision

Start with a narrow proxy spike before building the ingestion UI or protocol analysis engine. Use `hudsucker` as the first embedded Rust candidate, but explicitly compare it against `mitmproxy` and `slinger-mitm` before committing.

Reasoning:

- The live proxy is a major differentiator.
- If MITM/proxy behavior is too flaky, the product scope changes significantly.
- The normalized event model should be informed by real captured traffic, not only offline log assumptions.
- Hudsucker already targets the main hard parts: HTTP/S MITM, request/response handlers, WebSocket message handlers, CA-based interception, and optional HTTP/2 support.

## Current Candidate Stack

Primary embedded Rust candidate:

- `hudsucker`: MITM HTTP/S proxy crate with request, response, and WebSocket interception.

Reference implementation / external sidecar candidate:

- `mitmproxy`: mature TLS-capable intercepting proxy with HTTP/1, HTTP/2, WebSocket support, addons, flow analysis, modification, replay, and certificate handling.

Secondary embedded Rust candidate:

- `slinger-mitm`: Rust MITM proxy crate with automatic CA generation, Rustls HTTPS interception, interception/modification interfaces, SOCKS5 support, and raw TCP-oriented concepts.

Likely supporting crates for embedded Rust implementation:

- `tokio`: async runtime.
- `rustls`: preferred TLS implementation where possible.
- `rcgen`: local CA and leaf certificate generation.
- `hyper`: HTTP handling under Hudsucker.
- `tokio-tungstenite` / `hyper-tungstenite`: WebSocket handling through Hudsucker.
- `tracing`: structured event logging from the proxy.

Avoid committing to OpenSSL unless required. On Windows and desktop distributions, OpenSSL can add packaging friction. Rustls plus rcgen is the preferred first path.

## Proxy Engine Options

### Hudsucker

Pros:

- Rust-native and plausible to embed directly in the Tauri backend.
- MIT/Apache-2.0 licensing is product-friendly.
- Supports HTTP/S interception and WebSocket handlers.
- Has optional HTTP/2 support.
- Uses Rustls/rcgen path by default, which fits desktop packaging better than OpenSSL.
- Exposes request/response and WebSocket handler traits that map naturally to events in this app.

Risks:

- Smaller ecosystem than mitmproxy.
- Need to prove HTTP/2/gRPC behavior under real tests.
- Need to prove lifecycle management inside Tauri.
- Need to build our own UX around certificate export/install, flow storage, replay, and diagnostics.

### mitmproxy

Pros:

- Mature gold-standard proxy with broad protocol coverage.
- Strong existing behavior for TLS interception, certificates, flow capture, modification, replay, addons, and UI tooling.
- Supports HTTP/1, HTTP/2, and WebSockets.
- Addon system could emit events compatible with this app quickly.
- Useful as a reference oracle even if this app does not ship it.

Risks:

- Primarily Python, so it is not a clean embedded Rust/Tauri library.
- Porting mitmproxy to Rust is not a realistic starting strategy; it would be a multi-year rewrite of a mature proxy.
- WASM is not a good fit for this role because local proxying needs sockets, TLS, filesystem certificate storage, and OS/network integration.
- Shipping Python as a sidecar is possible, but increases installer size, update complexity, antivirus/signing risk, cross-platform packaging work, and runtime process supervision.
- This app would need a stable integration boundary: subprocess control, local API/socket, stdout event stream, or a custom mitmproxy addon.

Pragmatic use:

- Use mitmproxy as a benchmark/reference implementation.
- Consider an optional dev-only adapter that launches `mitmdump` with an addon for this app.
- Do not make mitmproxy the default embedded engine unless Rust-native options fail.

### slinger-mitm

Pros:

- Rust-native and designed specifically as a MITM proxy.
- Uses Rustls and automatic CA generation.
- Mentions transparent HTTPS interception, certificate caching, modification interfaces, SOCKS5 support, and raw TCP interception concepts.
- Could be useful if raw TCP/non-HTTP interception becomes important.

Risks:

- GPL-3.0-only license is a major constraint for any non-GPL distribution.
- Much smaller project/ecosystem than mitmproxy.
- Needs hands-on verification for WebSocket, HTTP/2, gRPC, stability, API shape, and Tauri lifecycle.
- The surrounding `slinger` project is security-research oriented; that may be useful technically, but dependency review needs to be stricter.

Pragmatic use:

- Evaluate only in an isolated spike.
- Do not add as a production dependency unless the license is acceptable and it clearly outperforms Hudsucker on required behavior.

## Sidecar Python Position

Tauri can supervise a sidecar process, including a Python-based tool, but that should be treated as an integration architecture, not an embedded library approach.

Possible sidecar approaches:

- Bundle mitmproxy/mitmdump as a packaged executable.
- Bundle Python plus mitmproxy dependencies.
- Require users to install mitmproxy separately and configure this app to launch/connect to it.
- Run a mitmproxy addon for this app that streams normalized events to the Tauri app over localhost.
- For Kubernetes/dev-environment scenarios, run mitmproxy as a container sidecar or reverse proxy and ingest exported flows/events into this app.

Notes:

- A Kubernetes mitmproxy sidecar proves the process-isolation pattern, but not desktop packaging.
- A Tauri sidecar would be a local executable managed by the desktop app, not a container injected into a deployment.
- A desktop mitmproxy sidecar still needs lifecycle management, port allocation, logs, crash handling, upgrades, signing, and event transport back to this app.
- If the sidecar depends on Python, we must decide whether to bundle Python, bundle a standalone mitmproxy executable, or require a user-installed mitmproxy.

Recommended stance:

- Use sidecar mitmproxy only as a fallback or power-user integration.
- Keep the main product path Rust-native if feasible.
- Avoid Python-in-WASM for proxying; it does not solve local socket/TLS/OS trust-store requirements.

## Licensing Position

This app may need to support future commercial distribution. Avoid GPL-3.0-only production dependencies unless the project intentionally adopts GPL-compatible distribution terms.

Implications:

- `hudsucker` is currently the safer first Rust candidate because its MIT/Apache-2.0 licensing is commercially friendly.
- `mitmproxy` is MIT licensed, so the license is not the main concern; packaging Python/runtime complexity is.
- `slinger-mitm` is GPL-3.0-only, so it should not become a default production dependency without an explicit licensing decision.

## What Must Be Proven

### Phase 1: Plain HTTP Pass-Through

- [ ] Start a local proxy on `127.0.0.1:<port>`.
- [ ] Forward plain HTTP requests to an upstream server.
- [ ] Capture method, URL, headers, status, timing, request body length, and response body length.
- [ ] Preserve behavior when bodies are large.
- [ ] Emit captured traffic as normalized proxy events.

Acceptance test:

- A local test client can call a local HTTP test server through the proxy and receive the same response.

### Phase 2: HTTPS MITM

- [ ] Generate or load a local protobuf-decoder root CA.
- [ ] Generate per-host certificates from the root CA.
- [ ] Intercept HTTPS requests from a test client that trusts the protobuf-decoder CA.
- [ ] Capture decrypted request and response metadata.
- [ ] Capture body bytes only when allowed by capture policy.
- [ ] Fail clearly when the client does not trust the CA.

Acceptance test:

- A local HTTPS test server can be reached through the proxy by a test client configured to trust the protobuf-decoder CA.

### Phase 3: WebSocket Upgrade And Messages

- [ ] Proxy HTTP WebSocket upgrade negotiation.
- [ ] Proxy secure WebSocket traffic when the client trusts the protobuf-decoder CA.
- [ ] Capture connection open/close events.
- [ ] Capture text and binary frames with direction and timestamps.
- [ ] Preserve frame forwarding without mutation.

Acceptance test:

- A local WebSocket echo server works through the proxy and this app records both directions.

### Phase 4: HTTP/2 And gRPC Reality Check

- [ ] Enable and test Hudsucker HTTP/2 support.
- [ ] Confirm whether gRPC unary calls can be intercepted cleanly.
- [ ] Confirm whether gRPC streaming calls can be represented as message events.
- [ ] Record limitations around ALPN, h2 CONNECT behavior, compression, trailers, and status metadata.

Acceptance test:

- A local gRPC unary call works through the proxy and this app can identify service, method, status, and message payload boundaries, or we document exactly why not.

### Phase 5: Offline Proxy Dev Server

- [ ] Match inbound requests to cached responses.
- [ ] Serve responses without contacting an upstream server.
- [ ] Support exact match first, field-based matching later.
- [ ] Emit the same normalized events as pass-through mode.
- [ ] Show mismatch diagnostics when no fixture matches.

Acceptance test:

- A local client can run against this app with no upstream server, and this app serves a cached response from a fixture.

## Modes

This app should support these proxy modes:

- Pass-through capture: forward all traffic unchanged and record metadata/payloads.
- MITM decode: decrypt TLS for clients that explicitly trust the protobuf-decoder CA.
- Offline stub: serve cached responses without an upstream server.
- Hybrid fallback: serve cached response when configured, otherwise pass through to upstream.
- Replay/simulation: later mode for recorded timing, error injection, and scripted behavior.

## Client Routing Model

For pass-through capture and MITM decode, prefer standard explicit proxy semantics:

- This app listens on `127.0.0.1:<port>`.
- The client is configured with `HTTP_PROXY=http://127.0.0.1:<port>` and `HTTPS_PROXY=http://127.0.0.1:<port>`, or equivalent per-client proxy settings.
- The client's application request URLs remain the original destinations, such as `https://api.example.com/orders`.
- For plain HTTP, the client sends an absolute-form request line through the proxy, so the proxy sees the original scheme, host, path, headers, and body.
- For HTTPS, the client first sends `CONNECT api.example.com:443` to the proxy, then starts TLS through that tunnel. If the client trusts the protobuf-decoder CA, this app performs MITM, sees the decrypted inner request, and forwards it to the original host.

Do not make the default pass-through mode require clients to rewrite API URLs to a localhost endpoint specific to this app. That reverse-proxy shape is useful for offline dev mode or special clients that cannot use proxy settings, but it needs an explicit destination envelope such as:

- a request path convention: `http://127.0.0.1:<port>/proxy/https/api.example.com/orders`
- a destination header: `X-Protobuf-Decoder-Upstream: https://api.example.com/orders`
- a fixture/mapping rule that maps a local route to an upstream target

The explicit proxy path is the cleaner first product path because it preserves normal client code and lets the proxy infer the original destination from HTTP proxy protocol behavior.

## Certificate And Trust Model

The protobuf-decoder CA must be explicit and local.

The desktop app uses the identifier `dev.protobuf-decoder.app` and stores its CA as `protobuf-decoder-ca.pem` and `protobuf-decoder-ca-key.pem` in that app's data directory. When upgrading from a build with a different app identifier, the app starts with a new data directory and CA; saved WebSocket mappings also remain in the previous directory. Export and trust the new CA before intercepting HTTPS, update clients' CA file paths, and remove the previous CA from any trust stores where it was installed. Exports are named `protobuf-decoder-local-test-ca.cer` and `protobuf-decoder-local-test-ca.pem`.

Requirements:

- Generate a protobuf-decoder root CA on demand.
- Store the CA private key in a local app data directory, not in the repo.
- Provide export/install guidance per OS.
- Never silently install a root CA into the OS trust store.
- Support per-project CA reset.
- Make trust status visible in the UI.
- Warn that TLS interception exposes decrypted local traffic inside this app.

Open questions:

- Should this app manage OS trust-store installation, or only export a CA and give instructions?
- Should trust be per-project, per-user, or global to the app?
- How should CA private keys be encrypted at rest?
- How should client apps that do certificate pinning be handled? Likely answer: document as unsupported unless the client has a dev-mode trust override.

## Capture Policy

Default behavior should be conservative:

- Capture metadata by default.
- Capture payloads only when enabled.
- Redact common secret headers by default.
- Allow host/path/content-type allowlists.
- Record when payload capture was disabled or redacted.

Never send captured payloads to cloud services unless the user explicitly opts in.

## Event Shape For Proxy Spike

Initial proxy event fields:

- `id`
- `timestamp`
- `direction`
- `transport`
- `protocol`
- `scheme`
- `method`
- `authority`
- `path`
- `status`
- `headers`
- `body_ref`
- `body_len`
- `connection_id`
- `stream_id`
- `request_id`
- `latency_ms`
- `error`

This is intentionally HTTP/WebSocket-biased for the spike. It should later map into the general event model.

## Risks

- Client certificate pinning can prevent MITM.
- HTTP/2 and gRPC may expose library limitations.
- WebSocket binary payload decoding still needs protocol-specific adapters.
- Large payload capture can create memory and storage pressure.
- Installing or trusting a local CA is high-friction for some users.
- Some corporate environments may block local MITM tools.
- Desktop packaging may be harder with OpenSSL than Rustls.
- Tauri lifecycle management needs careful handling for long-running async proxy tasks.

## Recommendation

Build the spike outside the main UI first, either as a small Rust binary crate or an isolated module with integration tests. Once plain HTTP, HTTPS MITM, and WebSocket pass-through are proven, expose start/stop/status commands through Tauri.

Do not start with protobuf decoding. First prove that this app can reliably see traffic in real time.

## First Implementation Slice

1. Add a Rust proxy crate or module.
2. Start a local Hudsucker proxy on an ephemeral port.
3. Add a simple in-process HTTP test server.
4. Send a request through the proxy from a test client.
5. Assert the upstream response is preserved.
6. Assert this app records a request event and response event.

Then repeat the same structure for HTTPS and WebSocket.
