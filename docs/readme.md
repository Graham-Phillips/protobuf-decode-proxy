Protobuf Decoder

This app is a local-first investigation tool for protocol-driven systems.

For current implementation context and restart-friendly task planning, see `docs/codex-todo.md`.

It ingests logs, reconstructs event flows, detects anomalies, and helps engineers understand what actually happened inside distributed systems.

Unlike traditional protocol tooling focused on decoding or packet inspection, this app focuses on:

understanding
correlation
anomaly detection
navigation
workflow acceleration

The goal is not simply to view messages.

The goal is to reconstruct the story hidden inside noisy event streams.

Vision

Most protocol and observability tooling is optimized for:

decoding correctness
metrics
packet inspection
raw event tables

But engineers debugging real systems actually need:

causal reconstruction
session understanding
anomaly surfacing
temporal navigation
fast investigation workflows

This app aims to provide:

timeline-first investigation
flow reconstruction
anomaly-focused navigation
local-first protocol analysis
protocol-agnostic architecture
explainable detections

Protobuf is the first concrete protocol target, but the architecture should support additional protocol plugins such as FIX, gRPC, JSON-over-HTTP, WebSocket payloads, and domain-specific binary protocols where there is market demand.

AI-assisted investigation may include optional integrations with services such as AWS Bedrock, but core anomaly detection should remain local-first and usable without cloud credentials.
Core Concepts
Event

A normalized representation of an observed message or action.

Session

A group of related events sharing a transport/session identity.

Flow

A correlated chain of related events representing a conversation or workflow.

Anomaly

A suspicious condition detected from timing, state, structure, or behavior.

Baseline

A known-good reference used for comparison.

Architecture

This app separates:

capture
->
decrypt
->
decode
->
normalize
->
correlate
->
detect
->
visualize

This separation is intentional.

Decoding and visualization should never be tightly coupled.

Design Principles
Local-first

Sensitive logs remain on the user’s machine.

Explainability

Every anomaly must include evidence and explanation.

Protocol-agnostic core

The timeline/correlation engine should not depend on FIX, protobuf, etc.

Plugin-based decoding

Protocol-specific logic belongs in adapters/plugins.

Navigation over raw tables

The UI should help users move through systems behavior efficiently.

Planned Features
v0.1
local file ingestion
session reconstruction
event correlation
anomaly detection
overview timeline
flow/swimlane view
raw + decoded inspector
latency analysis
compare mode
Later
live capture/proxy mode
richer protocol plugins
AI-assisted investigation
replay/simulation
collaborative workflows
Initial Tech Stack
UI
React + TypeScript
Tailwind
TanStack libraries
Desktop shell
Tauri
Core engine
Rust
Parsing
Rust parsers + optional WASM
Storage/indexing

TBD:

SQLite
DuckDB
custom append/index structure
Repository Structure (planned)
protobuf-decoder/
├── apps/
│   ├── desktop/
│   └── web/
│
├── core/
│   ├── event-model/
│   ├── ingestion/
│   ├── correlation/
│   ├── anomaly-engine/
│   ├── indexing/
│   ├── replay/
│   └── plugin-sdk/
│
├── plugins/
│   ├── fix/
│   ├── protobuf/
│   └── json/
│
├── docs/
│   ├── product-spec.md
│   ├── engineering-spec.md
│   ├── anomaly-detection.md
│   └── architecture/
│
└── work-only/
└── private-plugins/



See also
https://aws.amazon.com/blogs/big-data/near-real-time-streaming-analytics-on-protobuf-with-amazon-redshift/
Near real-time streaming analytics on protobuf with Amazon Redshift

https://victoriametrics.com/blog/go-protobuf-basic/



Plug-in system,:
https://adtk.readthedocs.io/en/stable/

--- python but can run in the browser

There are multiple ways to run Python applications in WASM: Pyodide: A WASM-based Python distribution for running Python code in the browser. CPython Compilation: Compile CPython (the standard Python implementation) into WASM using tools like Emscripten


Rendering:-
https://konvajs.org/
https://pixijs.com/




