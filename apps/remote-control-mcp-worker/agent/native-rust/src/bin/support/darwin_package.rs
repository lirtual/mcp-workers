//! The Rust-only extracted package has one exact private file inventory.
//! The caller verifies the pinned release archive before running its binary.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const APP: &str = "apps/remote-control-agent";
const BUILD: &str = "apps/remote-control-agent/.build";
pub(super) const ENTRY: &str = "apps/remote-control-agent/.build/rca-standard-darwin-candidate";
const HELPER: &str = "apps/remote-control-agent/.build/darwin-session-supervisor";
const FILES: [&str; 3] = ["bundle.json", ENTRY, HELPER];

pub(super) fn private_dir(path: &Path) -> Result<(), ()> {
    let info = fs::symlink_metadata(path).map_err(|_| ())?;
    if !info.is_dir() || info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o077 != 0 {
        return Err(());
    }
    Ok(())
}

fn open_file(path: &Path, mode: u32, max: u64) -> Result<File, ()> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| ())?;
    let m = file.metadata().map_err(|_| ())?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.nlink() != 1
        || m.mode() & 0o7777 != mode
        || m.len() == 0
        || m.len() > max
    {
        return Err(());
    }
    Ok(file)
}

fn exact_children(path: &Path, expected: &[&str]) -> Result<(), ()> {
    private_dir(path)?;
    let entries = fs::read_dir(path)
        .map_err(|_| ())?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    if entries.len() != expected.len()
        || expected.iter().any(|name| {
            !entries
                .iter()
                .any(|entry| entry == std::ffi::OsStr::new(name))
        })
    {
        return Err(());
    }
    Ok(())
}

pub(super) fn valid_version(version: &str) -> bool {
    let Some(number) = version.strip_prefix('v') else {
        return false;
    };
    let (base, candidate) = number
        .split_once('-')
        .map_or((number, None), |(a, b)| (a, Some(b)));
    let parts: Vec<_> = base.split('.').collect();
    parts.len() == 3
        && parts[0] == "0"
        && !parts[1].starts_with('0')
        && parts[1].parse::<u64>().is_ok_and(|n| n > 0)
        && parts[2].parse::<u64>().is_ok()
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
        && candidate.is_none_or(|c| {
            c.strip_prefix("rust-candidate.").is_some_and(|n| {
                !n.starts_with('0')
                    && n.bytes().all(|b| b.is_ascii_digit())
                    && n.parse::<u64>().is_ok_and(|n| n > 0)
            })
        })
        && version.len() <= 48
}

pub(super) fn forward_version(current: &str, next: &str) -> bool {
    fn order(value: &str) -> Option<(u64, u64, u64)> {
        if !valid_version(value) {
            return None;
        }
        let (base, suffix) = value
            .split_once('-')
            .map_or((value, None), |(a, b)| (a, Some(b)));
        let mut parts = base.split('.');
        parts.next()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        let candidate = match suffix {
            None => u64::MAX,
            Some(s) => {
                let number = s.strip_prefix("rust-candidate.")?.parse::<u64>().ok()?;
                if number == u64::MAX {
                    return None;
                }
                number
            }
        };
        Some((minor, patch, candidate))
    }
    matches!((order(current),order(next)),(Some(a),Some(b)) if b>a)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Package {
    pub version: String,
    pub source: String,
    pub target: String,
}

pub(super) fn verify(root: &Path, target: &str) -> Result<Package, ()> {
    exact_children(root, &["bundle.json", "apps"])?;
    exact_children(&root.join("apps"), &["remote-control-agent"])?;
    exact_children(&root.join(APP), &[".build"])?;
    exact_children(
        &root.join(BUILD),
        &["darwin-session-supervisor", "rca-standard-darwin-candidate"],
    )?;
    let cpu: u32 = match target {
        "darwin-arm64" => 0x0100000c,
        "darwin-x64" => 0x01000007,
        _ => return Err(()),
    };
    let mut raw = String::new();
    open_file(&root.join("bundle.json"), 0o600, 65536)?
        .take(65537)
        .read_to_string(&mut raw)
        .map_err(|_| ())?;
    if raw.len() > 65536 {
        return Err(());
    }
    let m: serde_json::Value = serde_json::from_str(&raw).map_err(|_| ())?;
    let version = m["version"]
        .as_str()
        .filter(|s| valid_version(s))
        .ok_or(())?;
    let source = m["source_commit"]
        .as_str()
        .filter(|s| {
            s.len() == 40
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or(())?;
    if m["name"] != "remote-control-agent"
        || m["target"] != target
        || m["artifact_schema"] != 1
        || m["device_protocol"] != 2
        || m["receipt_schema"] != 1
        || m["artifact_profile"] != "rust-native-only-v1"
        || m["agent_runtime"] != "rust-standard-darwin-v1"
        || m["runtime_profile"] != "standard-darwin-rust-runtime-v1"
        || m["candidate_profile"] != "darwin-permanent-local-v1"
        || m["native_supervisor"] != "darwin-owned-group-v1"
        || m["modules"].as_array().is_none_or(|a| !a.is_empty())
        || [
            "node",
            "browser_runtime",
            "session_runtime",
            "upgrade_protocol",
        ]
        .iter()
        .any(|k| m.get(*k).is_some())
    {
        return Err(());
    }
    for path in [ENTRY, HELPER] {
        let mut header = [0u8; 32];
        open_file(&root.join(path), 0o700, 180_000_000)?
            .read_exact(&mut header)
            .map_err(|_| ())?;
        if header[..4] != 0xfeedfacfu32.to_le_bytes()
            || header[4..8] != cpu.to_le_bytes()
            || header[12..16] != 2u32.to_le_bytes()
        {
            return Err(());
        }
    }
    Ok(Package {
        version: version.to_owned(),
        source: source.to_owned(),
        target: target.to_owned(),
    })
}

// Copy only this verified inventory into a new private staging directory.
// The final exclusive rename is the caller's existing Unix lifecycle gate.
pub(super) fn stage(root: &Path, programs: &Path, package: &Package) -> Result<PathBuf, ()> {
    if verify(root, &package.target)? != *package {
        return Err(());
    }
    private_dir(programs)?;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| ())?;
    let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let stage = programs.join(format!(".staging-{suffix}"));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&stage)
        .map_err(|_| ())?;
    let result = (|| {
        for directory in ["apps", APP, BUILD] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(stage.join(directory))
                .map_err(|_| ())?;
        }
        for path in FILES {
            let (mode, max) = if path == "bundle.json" {
                (0o600, 65536)
            } else {
                (0o700, 180_000_000)
            };
            let mut source = open_file(&root.join(path), mode, max)?;
            let mut dest = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(mode)
                .open(stage.join(path))
                .map_err(|_| ())?;
            let count = std::io::copy(&mut Read::by_ref(&mut source).take(max + 1), &mut dest)
                .map_err(|_| ())?;
            if count == 0 || count > max {
                return Err(());
            }
            dest.flush().and_then(|_| dest.sync_all()).map_err(|_| ())?;
        }
        if verify(&stage, &package.target)? != *package {
            return Err(());
        }
        for directory in [BUILD, APP, "apps", ""] {
            File::open(stage.join(directory))
                .and_then(|f| f.sync_all())
                .map_err(|_| ())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
        return Err(());
    }
    Ok(stage)
}

// Reuse an already staged immutable version only when the entire verified
// inventory has the same contents, not just a matching release name.
pub(super) fn same_package(left: &Path, right: &Path, package: &Package) -> Result<bool, ()> {
    use sha2::{Digest, Sha256};
    if verify(left, &package.target)? != *package || verify(right, &package.target)? != *package {
        return Ok(false);
    }
    for path in FILES {
        let (mode, max) = if path == "bundle.json" {
            (0o600, 65536)
        } else {
            (0o700, 180_000_000)
        };
        let digest = |root: &Path| -> Result<_, ()> {
            let file = open_file(&root.join(path), mode, max)?;
            let mut hash = Sha256::new();
            let count = std::io::copy(&mut file.take(max + 1), &mut hash).map_err(|_| ())?;
            if count == 0 || count > max {
                return Err(());
            }
            Ok(hash.finalize())
        };
        if digest(left)? != digest(right)? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn reviewed_programs(programs: &Path, target: &str) -> Result<Vec<PathBuf>, ()> {
    private_dir(programs)?;
    let mut roots = Vec::new();
    for entry in fs::read_dir(programs).map_err(|_| ())? {
        let entry = entry.map_err(|_| ())?;
        let root = entry.path();
        let package = verify(&root, target)?;
        if entry.file_name() != std::ffi::OsString::from(format!("{}-{}", package.version, target))
        {
            return Err(());
        }
        roots.push(root);
    }
    roots.sort();
    Ok(roots)
}

// Remove only the reviewed inventory, never a recursively discovered tree.
pub(super) fn remove_package(root: &Path, target: &str) -> Result<(), ()> {
    verify(root, target)?;
    for path in FILES {
        fs::remove_file(root.join(path)).map_err(|_| ())?;
    }
    for path in [BUILD, APP, "apps", ""] {
        fs::remove_dir(root.join(path)).map_err(|_| ())?;
    }
    File::open(root.parent().ok_or(())?)
        .and_then(|f| f.sync_all())
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn fixture(root: &Path, target: &str) {
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
        for path in ["apps", APP, BUILD] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(root.join(path))
                .unwrap();
        }
        let m = serde_json::json!({"name":"remote-control-agent","version":"v0.1.60",
            "target":target,"source_commit":"a".repeat(40),"artifact_schema":1,
            "device_protocol":2,"receipt_schema":1,"artifact_profile":"rust-native-only-v1",
            "agent_runtime":"rust-standard-darwin-v1","runtime_profile":"standard-darwin-rust-runtime-v1",
            "candidate_profile":"darwin-permanent-local-v1","native_supervisor":"darwin-owned-group-v1","modules":[]});
        fs::write(root.join("bundle.json"), m.to_string()).unwrap();
        fs::set_permissions(root.join("bundle.json"), fs::Permissions::from_mode(0o600)).unwrap();
        let cpu: u32 = if target == "darwin-arm64" {
            0x0100000c
        } else {
            0x01000007
        };
        let mut bytes = [0u8; 32];
        bytes[..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes());
        bytes[4..8].copy_from_slice(&cpu.to_le_bytes());
        bytes[12..16].copy_from_slice(&2u32.to_le_bytes());
        for path in [ENTRY, HELPER] {
            fs::write(root.join(path), bytes).unwrap();
            fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    #[test]
    fn reviewed_removal_preserves_unrelated_files_and_identity() {
        let home = tempfile::tempdir().unwrap();
        let programs = home.path().join("programs");
        fs::DirBuilder::new().mode(0o700).create(&programs).unwrap();
        let root = programs.join("v0.1.60-darwin-arm64");
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fixture(&root, "darwin-arm64");
        let identity = home.path().join("identity");
        fs::write(&identity, b"synthetic identity").unwrap();
        assert_eq!(
            reviewed_programs(&programs, "darwin-arm64").unwrap(),
            vec![root.clone()]
        );
        let foreign = root.join("unrelated");
        fs::write(&foreign, b"unrelated").unwrap();
        assert!(reviewed_programs(&programs, "darwin-arm64").is_err());
        assert!(remove_package(&root, "darwin-arm64").is_err());
        assert_eq!(fs::read(&foreign).unwrap(), b"unrelated");
        fs::remove_file(&foreign).unwrap();
        remove_package(&root, "darwin-arm64").unwrap();
        assert!(reviewed_programs(&programs, "darwin-arm64")
            .unwrap()
            .is_empty());
        assert_eq!(fs::read(identity).unwrap(), b"synthetic identity");
    }

    #[test]
    fn upgrade_requires_strict_forward_version() {
        for (old, new, expected) in [
            ("v0.1.60", "v0.1.61", true),
            ("v0.1.60", "v0.1.60", false),
            ("v0.1.60", "v0.1.59", false),
            ("v0.1.60", "v0.1.60-rust-candidate.2", false),
            (
                "v0.1.60-rust-candidate.2",
                "v0.1.60-rust-candidate.10",
                true,
            ),
            ("v0.1.60-rust-candidate.10", "v0.1.60", true),
            ("v0.1.60", "v0.2.0", true),
            ("v0.1.60", "v0.01.61", false),
            ("v0.1.60", "v0.1.61-node", false),
        ] {
            assert_eq!(forward_version(old, new), expected);
        }
    }

    #[test]
    fn native_package_stage_is_private_exact_and_does_not_replace_existing_version() {
        for target in ["darwin-arm64", "darwin-x64"] {
            let root = tempfile::tempdir().unwrap();
            let programs = tempfile::tempdir().unwrap();
            fs::set_permissions(programs.path(), fs::Permissions::from_mode(0o700)).unwrap();
            fixture(root.path(), target);
            let package = verify(root.path(), target).unwrap();
            let existing = programs
                .path()
                .join(format!("{}-{}", package.version, package.target));
            fs::create_dir(&existing).unwrap();
            fs::write(existing.join("unrelated"), b"retain").unwrap();
            let staged = stage(root.path(), programs.path(), &package).unwrap();
            assert_ne!(staged, existing);
            assert_eq!(
                verify(&staged, target),
                Ok(Package {
                    version: package.version.clone(),
                    source: package.source.clone(),
                    target: package.target.clone()
                })
            );
            assert!(same_package(root.path(), &staged, &package).unwrap());
            for path in FILES {
                assert_eq!(
                    fs::read(root.path().join(path)).unwrap(),
                    fs::read(staged.join(path)).unwrap()
                );
            }
            let mut different = fs::read(staged.join(ENTRY)).unwrap();
            different.push(1);
            fs::write(staged.join(ENTRY), different).unwrap();
            assert!(!same_package(root.path(), &staged, &package).unwrap());
            assert_eq!(fs::read(existing.join("unrelated")).unwrap(), b"retain");
        }
    }

    #[test]
    fn native_package_rejects_legacy_files_wrong_arch_and_linked_binary() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "darwin-arm64");
        assert!(verify(root.path(), "darwin-x64").is_err());
        fs::create_dir(root.path().join("bin")).unwrap();
        assert!(verify(root.path(), "darwin-arm64").is_err());
        fs::remove_dir(root.path().join("bin")).unwrap();
        let helper = root.path().join(HELPER);
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(verify(root.path(), "darwin-arm64").is_err());
        fs::remove_file(&helper).unwrap();
        symlink(root.path().join(ENTRY), &helper).unwrap();
        assert!(verify(root.path(), "darwin-arm64").is_err());
    }
}
