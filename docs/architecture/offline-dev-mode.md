# Offline / Proxy Dev Mode

Offline dev mode lets this app act as a local protocol-aware stub server. A client can point at this app instead of a real upstream service, and this app serves cached or synthetic responses from editable fixtures while recording the same investigation events used by pass-through proxy mode.

This mode is separate from passive log ingestion. It is active: this app receives client requests, chooses a fixture response, returns it to the client, and records the interaction for debugging.

## Goals

- Let client developers work when a real dev server is unavailable, unstable, expensive, or difficult to seed.
- Reuse captured request/response traffic as editable local fixtures.
- Support deterministic replay first, then controlled latency and error simulation.
- Emit normalized events compatible with offline ingestion and live proxy capture.
- Make mismatches explainable instead of silently returning arbitrary fallback data.

## Non-Goals For The First Slice

- Full production-grade service virtualization.
- Arbitrary scripting as the default matching mechanism.
- Cloud-hosted fixture storage.
- Transparent TLS MITM in offline mode before plain HTTP behavior is proven.
- Protocol-specific mutation UI before the fixture and matching model is stable.

## Modes

### Stub Only

This app does not contact an upstream server. Every request must match a fixture or receive a configured mismatch response.

Use when:

- the upstream service is unavailable
- deterministic local development is required
- a team wants to exercise client workflows from a known fixture set

### Hybrid Fallback

This app tries fixtures first. If no fixture matches, it forwards the request to the configured upstream and may optionally record the live response as a new fixture candidate.

Use when:

- most traffic can be cached
- some endpoints still need the real service
- teams are building a fixture corpus incrementally

### Replay

This app serves recorded responses using recorded or synthetic timing.

Use when:

- testing client loading states
- reproducing timing-sensitive bugs
- demonstrating flows without a backend

Replay should be deterministic by default. Timing variance and error injection should be explicit options.

## Fixture Format

Use JSON for v0.1 fixtures so developers can inspect and edit responses without recompiling anything.

An initial fixture file should contain:

- `version`: fixture schema version
- `name`: human-readable fixture set name
- `defaults`: shared replay behavior
- `entries`: request/response pairs

Example:

```json
{
  "version": 1,
  "name": "payments happy path",
  "defaults": {
    "latency_ms": 0,
    "on_mismatch": "diagnostic_404"
  },
  "entries": [
    {
      "id": "get-account-123",
      "match": {
        "method": "GET",
        "path": "/accounts/123",
        "headers": {
          "accept": "application/json"
        }
      },
      "response": {
        "status": 200,
        "headers": {
          "content-type": "application/json"
        },
        "body_json": {
          "id": "123",
          "status": "active"
        }
      }
    }
  ]
}
```

For protobuf, the response body can initially be represented as base64 plus metadata until a descriptor-aware editor exists:

```json
{
  "id": "protobuf-response-example",
  "match": {
    "method": "POST",
    "path": "/example.Service/GetThing",
    "protocol": "grpc"
  },
  "response": {
    "status": 200,
    "headers": {
      "content-type": "application/grpc"
    },
    "body_base64": "AAAAAA==",
    "decode": {
      "schema": "example.Service.GetThingResponse",
      "format": "protobuf"
    }
  }
}
```

## Matching Rules

Matching should be layered from safest to most flexible.

### Phase 1: Exact HTTP Match

Match using:

- method
- scheme, when relevant
- authority, when relevant
- path and query
- selected headers
- body hash, when configured

This is simple, deterministic, and enough to prove the workflow.

### Phase 2: Field-Based Match

Allow fixtures to match decoded fields rather than the whole body.

Examples:

- JSON body field equals `customer_id`
- protobuf field equals `order_id`
- gRPC service and method equal a known call
- FIX message type and correlation fields match

Field-based matching requires a decoded representation. Decode failures should be recorded and surfaced as mismatch evidence.

### Phase 3: Predicate Match

Predicate or scripted matching is useful, but it creates security and reproducibility risks.

If added, it should be:

- disabled by default
- local-only
- deterministic where possible
- sandboxed
- clearly marked in fixture metadata

Avoid adding predicate matching until exact and field-based matching are insufficient for real workflows.

## Match Selection

If multiple fixtures match, this app should use explicit priority before file order.

Selection order:

1. Highest `priority`.
2. Most specific match.
3. First entry in fixture file.

This app should record when multiple fixtures matched because that usually means the fixture set is ambiguous.

## Response Behavior

Supported first-pass response behavior:

- immediate response
- fixed synthetic latency
- recorded latency
- status and headers from fixture
- body from JSON, text, base64, or file reference

Later behavior:

- random latency from a bounded distribution
- error injection
- sequence-aware responses
- stateful fixture sessions

Keep stateful behavior out of v0.1 unless a real workflow requires it. Stateless fixtures are easier to reason about and review.

## Mismatch Handling

Mismatch handling is part of the product, not an error afterthought.

When no fixture matches, this app should return a clear diagnostic response in stub mode. The response should include:

- request method and path
- fixture set name
- closest candidate fixtures
- mismatch reasons
- suggested fields to add or relax

The UI should also record a mismatch event with evidence.

Example mismatch reasons:

- method differed
- path differed
- required header missing
- body hash differed
- body could not be decoded
- decoded field value differed

In hybrid mode, a mismatch may forward to upstream, but this app should still record that no fixture matched.

## Capture And Promotion

Hybrid mode can help build fixtures from real traffic.

Capture flow:

1. Request misses fixture set.
2. This app forwards to upstream.
3. This app records request and response.
4. User can promote the pair into a fixture entry.
5. User chooses which request fields should be match keys.

Do not automatically persist captured payloads without user consent. Payloads can contain credentials, personal data, or production secrets.

## Event Model

Offline dev mode should emit the same normalized events as pass-through proxy mode, plus fixture-specific fields:

- `fixture_set`
- `fixture_entry_id`
- `match_result`
- `match_score`
- `mismatch_reasons`
- `served_from_fixture`
- `upstream_contacted`
- `configured_latency_ms`
- `actual_latency_ms`

This keeps the timeline and anomaly views useful across offline logs, live proxy capture, and local stub sessions.

## Safety And Redaction

Default behavior should be conservative:

- Do not store request or response bodies unless capture is enabled.
- Redact common secret headers.
- Treat promoted fixtures as user-controlled project files.
- Make it visible when a response is synthetic or fixture-backed.
- Never send fixture payloads to cloud AI services without explicit opt-in.

Common headers to redact:

- `authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `proxy-authorization`

## First Implementation Slice

1. Add a plain HTTP stub mode behind the proxy crate or a sibling crate.
2. Load one JSON fixture file from disk.
3. Match `method` plus `path`.
4. Return fixture status, headers, and JSON/text body.
5. Record request, response, and fixture match events.
6. Return diagnostic `404` when no fixture matches.
7. Add tests with one matched request and one mismatch.

Do not start with protobuf-specific fixture editing. First prove that this app can reliably serve and explain cached HTTP responses.

## Open Questions

- Should fixtures live beside captured traces, inside project config, or in a dedicated fixture workspace?
- Should this app support multiple active fixture sets at once?
- How should fixture updates be diffed and reviewed in source control?
- Which protobuf/gRPC body representation is easiest for humans before descriptor-aware editing exists?
- Should fixture promotion default to exact body hash matching or decoded field matching?
- How much latency simulation is needed for the first useful developer workflow?
