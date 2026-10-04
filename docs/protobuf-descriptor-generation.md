# Company Protobuf Descriptor Set

The app loads a compiled protobuf `FileDescriptorSet`; it does not compile
`.proto` files at runtime. The company sources must be compiled with imports
included so the envelope, payload messages, and `generator.message_type_ordinal`
metadata are available to the Rust decoder.

## Build machine procedure

The `mobile-server-api` build copies the source tree and generator descriptors
to `target\protos`. From the `mobile-server-api` project directory, run this
in **PowerShell** using the `protoc.exe` available on that build machine:

```powershell
$protoc = "C:\path\to\protoc.exe"
$protoRoot = (Resolve-Path "target\protos").Path
$output = (Resolve-Path "target").Path + "\mobile-server-api.pb"

& $protoc `
  "--proto_path=$protoRoot" `
  "--descriptor_set_out=$output" `
  '--include_imports' `
  '--include_source_info' `
  '@target\protos.rsp'

if ($LASTEXITCODE -ne 0) {
  throw "protoc failed with exit code $LASTEXITCODE"
}
```

Load the resulting `target\mobile-server-api.pb` in the app's **Schemas**
workspace. The status should report company type/version mappings. For example,
ordinal `43` has versioned `GetDataResponseV2Proto` and
`GetDataResponseV3Proto` descriptors.

The app's company decoder follows the client behavior in `wfe-network-types`:
it decodes `iPhonePacketProto`, reads each inner `messageType` and
`messagePayloadVersion`, then decodes the raw `payload` with the matching
versioned descriptor. Unknown or non-company protobufs retain the wire preview
fallback.

Do not copy generated JavaScript or Java model code into this repository. Those
repositories are behavioral references; the runtime decoder uses the descriptor
set and `prost-reflect`.
