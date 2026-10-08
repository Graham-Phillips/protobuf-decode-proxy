use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Cursor, Read, Seek},
    path::{Path, PathBuf},
};

use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

const MAX_RECORD_LENGTH: u32 = 64 * 1024 * 1024;
const MAX_NESTED_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_NESTED_ARCHIVE_DEPTH: usize = 4;
const CACHE_DIRECTORY: &str = "packet-log-cache";

#[derive(Clone, Debug, Serialize)]
pub struct PacketLogImportReport {
    pub cache_directory: String,
    pub sources: Vec<PacketLogSourceReport>,
    pub errors: Vec<String>,
    pub records_loaded: u64,
    pub records_skipped: u64,
    pub record_limit: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct PacketLogRecord {
    pub source: String,
    pub record_index: u64,
    pub timestamp_unix_ms: u64,
    pub payload: Vec<u8>,
}

pub struct PacketLogImport {
    pub report: PacketLogImportReport,
    pub records: Vec<PacketLogRecord>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PacketLogSourceReport {
    pub source: String,
    pub format: String,
    pub materialized_dat: Option<String>,
    pub record_count: u64,
    pub records_skipped: u64,
    pub total_payload_bytes: u64,
    pub first_timestamp_unix_ms: Option<u64>,
    pub last_timestamp_unix_ms: Option<u64>,
    pub malformed: bool,
    pub warning: Option<String>,
}

#[derive(Default)]
struct PacketLogStats {
    record_count: u64,
    records_skipped: u64,
    total_payload_bytes: u64,
    first_timestamp_unix_ms: Option<u64>,
    last_timestamp_unix_ms: Option<u64>,
    malformed: bool,
    warning: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceFormat {
    Dat,
    Gzip,
    Zip,
    Unknown,
}

impl SourceFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dat => "dat",
            Self::Gzip => "gz",
            Self::Zip => "zip",
            Self::Unknown => "unknown",
        }
    }
}

pub fn inspect_sources(
    app: &AppHandle,
    paths: Vec<String>,
) -> Result<PacketLogImportReport, String> {
    Ok(process_sources(app, paths, None, None)?.report)
}

pub fn import_sources(
    app: &AppHandle,
    paths: Vec<String>,
    max_records: usize,
) -> Result<PacketLogImport, String> {
    let mut records = Vec::new();
    let mut imported = process_sources(app, paths, Some(&mut records), Some(max_records))?;
    imported.records = records;
    Ok(imported)
}

fn process_sources(
    app: &AppHandle,
    paths: Vec<String>,
    mut record_sink: Option<&mut Vec<PacketLogRecord>>,
    max_records: Option<usize>,
) -> Result<PacketLogImport, String> {
    let cache_directory = cache_directory(app)?;
    fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("failed to create packet-log cache: {error}"))?;

    let mut report = PacketLogImportReport {
        cache_directory: cache_directory.to_string_lossy().into_owned(),
        sources: Vec::new(),
        errors: Vec::new(),
        records_loaded: 0,
        records_skipped: 0,
        record_limit: max_records.map(|limit| limit as u64),
    };

    if paths.is_empty() {
        report
            .errors
            .push("no packet-log sources were selected".to_owned());
        return Ok(PacketLogImport {
            report,
            records: Vec::new(),
        });
    }

    for path in paths {
        let path = PathBuf::from(path);
        if !path.is_file() {
            report.errors.push(format!(
                "packet-log source is not a file: {}",
                path.display()
            ));
            continue;
        }

        if let Err(error) = inspect_path(
            &cache_directory,
            &path,
            &mut report,
            record_sink.as_mut().map(|sink| &mut **sink),
            max_records,
        ) {
            report.errors.push(format!("{}: {error}", path.display()));
        }
    }

    report.records_loaded = record_sink.as_ref().map_or(0, |sink| sink.len() as u64);
    report.records_skipped = report
        .sources
        .iter()
        .map(|source| source.records_skipped)
        .sum();

    Ok(PacketLogImport {
        report,
        records: Vec::new(),
    })
}

fn inspect_path(
    cache_directory: &Path,
    path: &Path,
    report: &mut PacketLogImportReport,
    record_sink: Option<&mut Vec<PacketLogRecord>>,
    max_records: Option<usize>,
) -> Result<(), String> {
    let format = detect_file_format(path)?;
    match format {
        SourceFormat::Dat => {
            let file = File::open(path).map_err(|error| error.to_string())?;
            report.sources.push(source_report(
                path.to_string_lossy().into_owned(),
                SourceFormat::Dat,
                None,
                inspect_records_with_sink(file, &path.to_string_lossy(), record_sink, max_records),
            ));
        }
        SourceFormat::Gzip => {
            let dat_path = matching_dat_path(path);
            if dat_path.is_file() {
                let file = File::open(&dat_path).map_err(|error| error.to_string())?;
                report.sources.push(source_report(
                    path.to_string_lossy().into_owned(),
                    SourceFormat::Dat,
                    None,
                    inspect_records_with_sink(
                        file,
                        &path.to_string_lossy(),
                        record_sink,
                        max_records,
                    ),
                ));
                return Ok(());
            }

            let cache_path =
                materialized_cache_path(cache_directory, &path.to_string_lossy(), path);
            materialize_gzip_file(path, &cache_path)?;
            let file = File::open(&cache_path).map_err(|error| error.to_string())?;
            report.sources.push(source_report(
                path.to_string_lossy().into_owned(),
                SourceFormat::Gzip,
                Some(cache_path.to_string_lossy().into_owned()),
                inspect_records_with_sink(file, &path.to_string_lossy(), record_sink, max_records),
            ));
        }
        SourceFormat::Zip => {
            let file = File::open(path).map_err(|error| error.to_string())?;
            inspect_zip(
                cache_directory,
                ZipArchive::new(file).map_err(|error| error.to_string())?,
                &path.to_string_lossy(),
                0,
                report,
                record_sink,
                max_records,
            )?;
        }
        SourceFormat::Unknown => {
            return Err("unsupported packet-log format".to_owned());
        }
    }

    Ok(())
}

fn inspect_zip<R: Read + Seek>(
    cache_directory: &Path,
    mut archive: ZipArchive<R>,
    source_prefix: &str,
    depth: usize,
    report: &mut PacketLogImportReport,
    mut record_sink: Option<&mut Vec<PacketLogRecord>>,
    max_records: Option<usize>,
) -> Result<(), String> {
    let entry_names = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|entry| entry.name().to_owned())
        })
        .collect::<Vec<_>>();
    let dat_bases = entry_names
        .iter()
        .filter(|name| is_dat_name(name))
        .map(|name| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to read archive entry {index}: {error}"))?;
        if entry.is_dir() {
            continue;
        }

        let entry_name = entry.name().to_owned();
        let source = format!("{source_prefix}!/{entry_name}");
        let mut prefix = [0_u8; 4];
        let prefix_len = entry.read(&mut prefix).map_err(|error| error.to_string())?;
        let format = detect_format_from_prefix(&prefix[..prefix_len], &entry_name);

        match format {
            SourceFormat::Dat => {
                let reader = Cursor::new(prefix[..prefix_len].to_vec()).chain(entry);
                report.sources.push(source_report(
                    source.clone(),
                    SourceFormat::Dat,
                    None,
                    inspect_records_with_sink(
                        reader,
                        &source,
                        record_sink.as_mut().map(|sink| &mut **sink),
                        max_records,
                    ),
                ));
            }
            SourceFormat::Gzip => {
                if matching_zip_dat(&entry_name, &dat_bases) {
                    continue;
                }

                let cache_path =
                    materialized_cache_path(cache_directory, &source, Path::new(&entry_name));
                let compressed = Cursor::new(prefix[..prefix_len].to_vec()).chain(entry);
                materialize_gzip_reader(compressed, &cache_path)?;
                let file = File::open(&cache_path).map_err(|error| error.to_string())?;
                report.sources.push(source_report(
                    source.clone(),
                    SourceFormat::Gzip,
                    Some(cache_path.to_string_lossy().into_owned()),
                    inspect_records_with_sink(
                        file,
                        &source,
                        record_sink.as_mut().map(|sink| &mut **sink),
                        max_records,
                    ),
                ));
            }
            SourceFormat::Zip => {
                if depth >= MAX_NESTED_ARCHIVE_DEPTH {
                    report.errors.push(format!(
                        "{source}: nested archive depth exceeds {MAX_NESTED_ARCHIVE_DEPTH}"
                    ));
                    continue;
                }
                let mut bytes = prefix[..prefix_len].to_vec();
                let remaining_limit = MAX_NESTED_ARCHIVE_BYTES
                    .saturating_add(1)
                    .saturating_sub(prefix_len as u64);
                entry
                    .take(remaining_limit)
                    .read_to_end(&mut bytes)
                    .map_err(|error| error.to_string())?;
                if bytes.len() as u64 > MAX_NESTED_ARCHIVE_BYTES {
                    report.errors.push(format!(
                        "{source}: nested archive exceeds {} MiB",
                        MAX_NESTED_ARCHIVE_BYTES / (1024 * 1024)
                    ));
                    continue;
                }
                inspect_zip(
                    cache_directory,
                    ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?,
                    &source,
                    depth + 1,
                    report,
                    record_sink.as_mut().map(|sink| &mut **sink),
                    max_records,
                )?;
            }
            SourceFormat::Unknown => {
                report
                    .errors
                    .push(format!("{source}: unsupported archive entry"));
            }
        }
    }

    Ok(())
}

fn detect_file_format(path: &Path) -> Result<SourceFormat, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = [0_u8; 4];
    let length = file.read(&mut prefix).map_err(|error| error.to_string())?;
    Ok(detect_format_from_prefix(
        &prefix[..length],
        &path.to_string_lossy(),
    ))
}

fn detect_format_from_prefix(prefix: &[u8], name: &str) -> SourceFormat {
    if prefix.starts_with(&[0x50, 0x4b, 0x03, 0x04])
        || prefix.starts_with(&[0x50, 0x4b, 0x05, 0x06])
        || prefix.starts_with(&[0x50, 0x4b, 0x07, 0x08])
    {
        SourceFormat::Zip
    } else if prefix.starts_with(&[0x1f, 0x8b]) {
        SourceFormat::Gzip
    } else if is_dat_name(name) {
        SourceFormat::Dat
    } else {
        SourceFormat::Unknown
    }
}

fn is_dat_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".dat")
}

fn is_gzip_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".gz")
}

fn matching_dat_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("packet.dat.gz");
    let dat_name = name.strip_suffix(".gz").unwrap_or(name);
    path.with_file_name(dat_name)
}

fn matching_zip_dat(name: &str, dat_bases: &HashSet<String>) -> bool {
    if !is_gzip_name(name) {
        return false;
    }
    dat_bases.contains(&name[..name.len() - 3].to_ascii_lowercase())
}

fn materialized_cache_path(cache_directory: &Path, source: &str, hint: &Path) -> PathBuf {
    let stem = hint
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("packet-log")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    let digest = hasher.finalize();
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    cache_directory.join(format!("{stem}-{suffix}.dat"))
}

fn materialize_gzip_file(source: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(source).map_err(|error| error.to_string())?;
    materialize_gzip_reader(file, destination)
}

fn materialize_gzip_reader<R: Read>(reader: R, destination: &Path) -> Result<(), String> {
    if destination.is_file() {
        return Ok(());
    }

    let temporary = destination.with_extension("dat.partial");
    let mut decoder = GzDecoder::new(reader);
    let mut output = File::create(&temporary).map_err(|error| error.to_string())?;
    if let Err(error) = io::copy(&mut decoder, &mut output) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("failed to decompress gzip source: {error}"));
    }
    output.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, destination).map_err(|error| error.to_string())
}

fn inspect_records<R: Read>(mut reader: R) -> PacketLogStats {
    inspect_records_with_sink(&mut reader, "", None, None)
}

fn inspect_records_with_sink<R: Read>(
    mut reader: R,
    source: &str,
    mut record_sink: Option<&mut Vec<PacketLogRecord>>,
    max_records: Option<usize>,
) -> PacketLogStats {
    let mut stats = PacketLogStats::default();
    let mut length_bytes = [0_u8; 4];
    let mut timestamp_bytes = [0_u8; 8];
    let mut discard_buffer = [0_u8; 8192];
    let mut record_index = 0_u64;

    loop {
        match reader.read_exact(&mut length_bytes) {
            Ok(()) => {}
            Err(error)
                if error.kind() == io::ErrorKind::UnexpectedEof && stats.record_count == 0 =>
            {
                stats.malformed = true;
                stats.warning =
                    Some("packet-log stream did not contain a complete record".to_owned());
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => {
                stats.malformed = true;
                stats.warning = Some(format!("failed reading record length: {error}"));
                break;
            }
        }

        let length = u32::from_be_bytes(length_bytes);
        // The stored length includes this four-byte length prefix.
        if !(12..=MAX_RECORD_LENGTH).contains(&length) {
            stats.malformed = true;
            stats.warning = Some(format!("invalid record length {length}"));
            break;
        }

        if let Err(error) = reader.read_exact(&mut timestamp_bytes) {
            stats.malformed = true;
            stats.warning = Some(format!("truncated record timestamp: {error}"));
            break;
        }
        let timestamp = u64::from_be_bytes(timestamp_bytes);
        stats.first_timestamp_unix_ms.get_or_insert(timestamp);
        stats.last_timestamp_unix_ms = Some(timestamp);
        stats.record_count += 1;
        stats.total_payload_bytes += u64::from(length - 12);

        let retain_record = record_sink
            .as_ref()
            .is_some_and(|sink| max_records.map_or(true, |limit| sink.len() < limit));

        if retain_record {
            let sink = record_sink.as_mut().expect("retain_record requires a sink");
            let mut payload = vec![0_u8; (length - 12) as usize];
            if let Err(error) = reader.read_exact(&mut payload) {
                stats.malformed = true;
                stats.warning = Some(format!("truncated record payload: {error}"));
                return stats;
            }
            (**sink).push(PacketLogRecord {
                source: source.to_owned(),
                record_index,
                timestamp_unix_ms: timestamp,
                payload,
            });
        } else {
            if record_sink.is_some() {
                stats.records_skipped += 1;
            }
            let mut remaining = u64::from(length - 12);
            while remaining > 0 {
                let requested = remaining.min(discard_buffer.len() as u64) as usize;
                if let Err(error) = reader.read_exact(&mut discard_buffer[..requested]) {
                    stats.malformed = true;
                    stats.warning = Some(format!("truncated record payload: {error}"));
                    return stats;
                }
                remaining -= requested as u64;
            }
        }
        record_index += 1;
    }

    stats
}

fn source_report(
    source: String,
    format: SourceFormat,
    materialized_dat: Option<String>,
    stats: PacketLogStats,
) -> PacketLogSourceReport {
    PacketLogSourceReport {
        source,
        format: format.as_str().to_owned(),
        materialized_dat,
        record_count: stats.record_count,
        records_skipped: stats.records_skipped,
        total_payload_bytes: stats.total_payload_bytes,
        first_timestamp_unix_ms: stats.first_timestamp_unix_ms,
        last_timestamp_unix_ms: stats.last_timestamp_unix_ms,
        malformed: stats.malformed,
        warning: stats.warning,
    }
}

fn cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CACHE_DIRECTORY))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{inspect_records, inspect_records_with_sink};
    use std::io::Cursor;

    #[test]
    fn reads_big_endian_length_and_timestamp_records() {
        let mut bytes = Vec::new();
        append_record(&mut bytes, 1_700_000_000_000, b"first");
        append_record(&mut bytes, 1_700_000_001_000, b"second");

        let stats = inspect_records(Cursor::new(bytes));

        assert_eq!(stats.record_count, 2);
        assert_eq!(stats.total_payload_bytes, 11);
        assert_eq!(stats.first_timestamp_unix_ms, Some(1_700_000_000_000));
        assert_eq!(stats.last_timestamp_unix_ms, Some(1_700_000_001_000));
        assert!(!stats.malformed);
    }

    #[test]
    fn flags_truncated_payload() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&14_u32.to_be_bytes());
        bytes.extend_from_slice(&1_700_000_000_000_u64.to_be_bytes());
        bytes.extend_from_slice(b"x");

        let stats = inspect_records(Cursor::new(bytes));

        assert_eq!(stats.record_count, 1);
        assert!(stats.malformed);
        assert!(stats.warning.is_some());
    }

    #[test]
    fn bounds_retained_records_but_scans_the_stream() {
        let mut bytes = Vec::new();
        append_record(&mut bytes, 1_700_000_000_000, b"first");
        append_record(&mut bytes, 1_700_000_001_000, b"second");
        append_record(&mut bytes, 1_700_000_002_000, b"third");

        let mut records = Vec::new();
        let stats = inspect_records_with_sink(
            Cursor::new(bytes),
            "example.dat",
            Some(&mut records),
            Some(2),
        );

        assert_eq!(stats.record_count, 3);
        assert_eq!(stats.records_skipped, 1);
        assert_eq!(records.len(), 2);
        assert!(!stats.malformed);
    }

    fn append_record(bytes: &mut Vec<u8>, timestamp: u64, payload: &[u8]) {
        bytes.extend_from_slice(&((payload.len() + 12) as u32).to_be_bytes());
        bytes.extend_from_slice(&timestamp.to_be_bytes());
        bytes.extend_from_slice(payload);
    }
}
