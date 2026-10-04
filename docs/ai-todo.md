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
purpose relative to Traffic is unclear. WebSocket Messages looks like another
copy of Traffic with the Proto filter selected, and Frame Detail introduces a
second payload preview. Frame decoding currently depends on loading a descriptor
set.

The desired default workflow is: see messages, filter them, recognize their
types in the table, then select one to inspect decoded field names and contents.

## 1. Reproduce and trace the decoding failure

- [ ] Capture a representative protobuf WebSocket message and its raw bytes.
  Record the endpoint, direction, selected schema/mapping, and app build version.
  Confirm that the running exe includes the current decoding changes.
- [ ] Follow that message through capture, framing/envelope extraction, schema
  selection, message-type mapping, decoding, and UI rendering. Identify exactly
  where it falls back to the wire preview.
- [ ] Verify the existing descriptor and mapping paths before adding another
  decoding mechanism. Check company envelope ordinals/versions and WebSocket
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

- [ ] Inventory available `.proto` files, descriptor bundles, generated protobuf
  code, and envelope/type metadata in this repo and already identified local
  sources. Record what is actually available and what is missing.
- [ ] Where `.proto` sources exist, generate a descriptor set with dependencies
  included and document a repeatable generation/loading procedure. Verify that
  it contains the envelope and payload message types used by the sample.
- [ ] If only generated code or embedded descriptors exist, assess whether they
  can supply a reliable schema. Use explicit mappings when the schema exists
  but the message identity cannot be determined automatically.
- [ ] If schema information is unavailable, keep a useful wire inspection and
  state the missing information. Raw protobuf bytes alone cannot reliably
  recover original field names, exact types, or message identities. Do not
  present guessed names or wire interpretations as confirmed decoding.
- [ ] Show a concrete reason when decoding fails, such as missing schema,
  unmatched envelope ordinal/version, ambiguous mapping, or malformed payload,
  and give the user an actionable next step.

## 3. Make message identity and contents useful

- [ ] Show the decoded message type in the Traffic table so users can recognize
  messages without opening every row. Use an explicit unknown/undecoded state
  when identity cannot be established.
- [ ] On selection, show named fields and values with nested/repeated structures
  intact. Make raw bytes and wire inspection secondary views of that message.
- [ ] Include useful context: direction, host/path, connection, timestamp, and
  envelope type/version where available. Do not imply request/response pairing
  for WebSocket messages unless there is evidence supporting that relationship.
- [ ] Handle envelopes containing multiple messages: make each inner message's
  type and contents discoverable instead of labeling the entire frame as one
  payload type.
- [ ] Share decoding results between the table and inspector so they agree.

## 4. Simplify the first page

- [ ] Make the default Traffic page one message table, filter controls, and one
  selected-message inspector. Remove duplicate payload previews from this flow.
- [ ] Replace the single-choice Resource filter with independent selections.
  Selecting Img + JSON + Proto must show the union of those categories, then
  apply the other filters. Define clear All/reset and no-selection behavior.
- [ ] Preserve protobuf WebSocket messages in the main Traffic view. Put
  transport-specific WebSocket information, frame diagnostics, and connection
  details in a separate tab if that reduces clutter.
- [ ] Check whether Event Timeline respects filters and what additional question
  it answers. Move it into an optional view; do not keep a duplicate unfiltered
  table on the default page.
- [ ] Keep schema setup and advanced diagnostics accessible without expanding
  them into the main message browsing workflow.

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
