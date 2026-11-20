//! Existing Node Agent file browsing output, bounded to the authenticated read-result wire.
//! All three tools are read-only. Path validation remains owned by native_read.
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, DirEntry, FileType, Metadata};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_DIRECTORY_ENTRIES: usize = 100;
const MAX_RESULT_CHARS: usize = 200_000;

#[derive(Debug)]
pub enum BrowseCommand {
    Multiple { paths: Vec<String> },
    Directory { path: String, depth: usize },
    Info { path: String },
}

fn local_path(value: &Value) -> Option<String> {
    let path = value.as_str()?;
    crate::native_read::permitted_path(path).then(|| path.to_owned())
}

pub fn parse_browse_options(tool: &str, args: &Value) -> Option<BrowseCommand> {
    let object = args.as_object()?;
    match tool {
        "read_multiple_files" => {
            if object.len() != 1 {
                return None;
            }
            let values = object.get("paths")?.as_array()?;
            if values.is_empty() || values.len() > 8 {
                return None;
            }
            let paths: Option<Vec<String>> = values.iter().map(local_path).collect();
            Some(BrowseCommand::Multiple { paths: paths? })
        }
        "list_directory" => {
            if object.keys().any(|key| key != "path" && key != "depth") {
                return None;
            }
            let path = local_path(object.get("path")?)?;
            let depth = match object.get("depth") {
                None => 1,
                Some(value) => crate::native_read::integer_in_range(value, 1, 3)? as usize,
            };
            Some(BrowseCommand::Directory { path, depth })
        }
        "get_file_info" => {
            if object.len() != 1 {
                return None;
            }
            let path = local_path(object.get("path")?)?;
            Some(BrowseCommand::Info { path })
        }
        _ => None,
    }
}

fn kind(file_type: FileType) -> &'static str {
    if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_file() {
        "file"
    } else {
        "other"
    }
}

fn list_directory(path: &str, depth: usize) -> Result<String, ()> {
    let info = fs::symlink_metadata(path).map_err(|_| ())?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(());
    }
    let mut lines = Vec::new();
    let mut seen = HashSet::<PathBuf>::new();
    let truncated = visit_directory(Path::new(path), "", depth, &mut seen, &mut lines)?;
    Ok(format!(
        "depth: {depth}\ntruncated: {truncated}\n{}",
        lines.join("\n")
    ))
}

// Depth-first pre-order, matching Node's UTF-16 lexicographic name order.
// DirEntry.file_type() does not follow symlinks, including directory links.
fn visit_directory(
    directory: &Path,
    relative: &str,
    depth_left: usize,
    seen: &mut HashSet<PathBuf>,
    lines: &mut Vec<String>,
) -> Result<bool, ()> {
    let identity = fs::canonicalize(directory).map_err(|_| ())?;
    if !seen.insert(identity) {
        return Ok(false);
    }
    let mut entries: Vec<DirEntry> = fs::read_dir(directory)
        .map_err(|_| ())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    entries.sort_by(|left, right| {
        left.file_name()
            .to_string_lossy()
            .encode_utf16()
            .cmp(right.file_name().to_string_lossy().encode_utf16())
    });
    for entry in entries {
        if lines.len() >= MAX_DIRECTORY_ENTRIES {
            return Ok(true);
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let relative_path = if relative.is_empty() {
            name.into_owned()
        } else {
            format!("{relative}/{name}")
        };
        let file_type = entry.file_type().map_err(|_| ())?;
        let entry_kind = kind(file_type);
        lines.push(format!("{entry_kind} {relative_path}"));
        if file_type.is_dir()
            && depth_left > 1
            && visit_directory(&entry.path(), &relative_path, depth_left - 1, seen, lines)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn file_mode(metadata: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(windows)]
    {
        // Windows std::fs does not expose all Node's libuv mode bits.
        // Standard Windows permissions are 0666 for files and 0777 for directories.
        if metadata.permissions().readonly() {
            0o444
        } else if metadata.is_dir() {
            0o777
        } else {
            0o666
        }
    }
}

fn file_info(path: &str) -> Result<String, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    let modified = metadata.modified().map_err(|_| ())?;
    let mtime_ms: i128 = match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i128,
        Err(error) => -(error.duration().as_millis() as i128),
    };
    Ok(format!(
        "type: {}\nsize: {}\nmode: {:03o}\nmtime_ms: {}",
        kind(metadata.file_type()),
        metadata.len(),
        file_mode(&metadata),
        mtime_ms
    ))
}

fn multiple_files(paths: &[String]) -> Result<String, ()> {
    let mut blocks = Vec::new();
    let mut chars = 0usize;
    let mut truncated = false;
    for (index, path) in paths.iter().enumerate() {
        let body = match crate::native_read::read_default_path(path) {
            Ok(text) => format!("status: ok\n{text}"),
            Err(()) => "status: failed\nmessage: The file read failed.".to_owned(),
        };
        let block = format!("# file {}\n{body}", index + 1);
        let count = block.encode_utf16().count() + 1;
        if chars + count > MAX_RESULT_CHARS {
            truncated = true;
            break;
        }
        blocks.push(block);
        chars += count;
    }
    Ok(format!("{}\ntruncated: {truncated}", blocks.join("\n")))
}

pub(crate) fn execute_browse(command: &BrowseCommand) -> Result<String, ()> {
    match command {
        BrowseCommand::Multiple { paths } => multiple_files(paths),
        BrowseCommand::Directory { path, depth } => list_directory(path, *depth),
        BrowseCommand::Info { path } => file_info(path),
    }
}
