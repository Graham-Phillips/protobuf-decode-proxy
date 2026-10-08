param(
  [string]$ProtoRoot = 'C:\Work2\GP\protos\protos',
  [string]$SupportRoot = 'C:\Work2\GP\mobile-server-api\mobile-server-api\target\protos',
  [string]$ProtocPath = 'C:\Work2\GP\mobile-server-api\tools\protocol_buffers\protoc.exe',
  [string]$OutputPath = "$PSScriptRoot\..\mockdata\protos-client-event.pb",
  [string[]]$RootFiles,
  [switch]$AllSources
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ProtocPath -PathType Leaf)) {
  throw "protoc.exe was not found at '$ProtocPath'. Pass -ProtocPath with the compiler location."
}

if (-not (Test-Path -LiteralPath $ProtoRoot -PathType Container)) {
  throw "Proto source directory was not found: '$ProtoRoot'"
}

if (-not (Test-Path -LiteralPath (Join-Path $SupportRoot 'generator\descriptor.proto') -PathType Leaf)) {
  throw "Support definitions were not found below '$SupportRoot'. Expected generator\descriptor.proto."
}

$sourceRoot = (Resolve-Path -LiteralPath $ProtoRoot).Path
$supportRoot = (Resolve-Path -LiteralPath $SupportRoot).Path
$output = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $output

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$protoFiles = if ($AllSources) {
  @(
    'com/cmcmarkets/iphone/transport/protos/iPhonePacketProtoBuf.proto'
    Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Filter '*.proto' |
      Where-Object { Select-String -LiteralPath $_.FullName -Pattern 'message_type_ordinal' -Quiet } |
      ForEach-Object { $_.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/') }
  ) | Sort-Object -Unique
} elseif ($RootFiles.Count -gt 0) {
  $RootFiles
} else {
  @(
    'com/cmcmarkets/iphone/transport/protos/iPhonePacketProtoBuf.proto'
    'com/cmcmarkets/iphone/api/protos/ClientEventReportingRequestProtoBuf.proto'
  )
}

if ($protoFiles.Count -eq 0) {
  throw "No .proto files were found below '$sourceRoot'."
}

foreach ($protoFile in $protoFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $protoFile) -PathType Leaf)) {
    throw "Proto source was not found below '$sourceRoot': $protoFile"
  }
}

$arguments = @(
  "--proto_path=$sourceRoot"
  "--proto_path=$supportRoot"
  "--descriptor_set_out=$output"
  '--include_imports'
  '--include_source_info'
)
$arguments += $protoFiles
$responseFile = Join-Path $outputDirectory 'protos-new.rsp'
$arguments | Set-Content -LiteralPath $responseFile -Encoding ascii

Write-Host "Compiling $($protoFiles.Count) protobuf definitions..."
try {
  & $ProtocPath "@$responseFile"
  if ($LASTEXITCODE -ne 0) {
    throw "protoc failed with exit code $LASTEXITCODE"
  }
} finally {
  Remove-Item -LiteralPath $responseFile -Force -ErrorAction SilentlyContinue
}

Write-Host "Wrote descriptor set: $output"
