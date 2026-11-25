//! Shared owner-local Unix identity storage. Callers own lifecycle exclusion
//! and interactive grant selection. Both platforms use exclusive atomic moves.
use rca_native_agent::identity::valid_device_id;
use std::ffi::OsStr;
use std::fs;
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub(super) fn sidecar(key: &Path, suffix: &str) -> PathBuf {
    let mut name = key.as_os_str().to_os_string();
    name.push(OsStr::new(suffix));
    PathBuf::from(name)
}

pub(super) fn pair_identity_at(
    key: &Path,
    resolve: impl FnOnce(&str, Option<&str>) -> Result<String, ()>,
) -> Result<String, ()> {
    use rca_native_agent::device_pairing::generate_private_pem;
    let id_path = sidecar(key, ".device-id");
    let existing = read_private(&id_path, 128)?;
    if existing
        .as_ref()
        .is_some_and(|id| !valid_device_id(id.trim()))
    {
        return Err(());
    }
    let pem = match read_private(key, 8192)? {
        Some(pem) => pem,
        None if existing.is_none() => {
            let pem = generate_private_pem().map_err(|_| ())?;
            write_new(key, pem.as_bytes())?;
            pem
        }
        None => return Err(()),
    };
    let id = resolve(&pem, existing.as_deref().map(str::trim))?;
    if !valid_device_id(&id) || existing.as_ref().is_some_and(|old| old.trim() != id) {
        return Err(());
    }
    if existing.is_none() {
        write_new(&id_path, format!("{id}\n").as_bytes())?;
    }
    Ok(id)
}

pub(super) fn read_private(path: &Path, limit: u64) -> Result<Option<String>, ()> {
    use std::io::Read;
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let info = file.metadata().map_err(|_| ())?;
    if !info.is_file()
        || info.uid() != unsafe { libc::geteuid() }
        || info.nlink() != 1
        || info.mode() & 0o777 != 0o600
        || info.len() == 0
        || info.len() > limit
    {
        return Err(());
    }
    let mut value = String::new();
    file.take(limit + 1)
        .read_to_string(&mut value)
        .map_err(|_| ())?;
    if value.len() as u64 != info.len() {
        return Err(());
    }
    Ok(Some(value))
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ()> {
    write_new_mode(path, bytes, 0o600)
}

fn write_new_mode(path: &Path, bytes: &[u8], mode: u32) -> Result<(), ()> {
    let directory = path.parent().ok_or(())?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| ())?;
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let temp = directory.join(format!(".pair-{suffix}.tmp"));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temp)
        .map_err(|_| ())?;
    let result = (|| {
        file.write_all(bytes).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        move_owned_exclusive(&temp, path)
    })();
    if result.is_err() && temp.exists() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(target_os = "macos")]
pub(super) fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), ()> {
    write_new_mode(path, bytes, 0o700)
}

pub(super) fn exists_owned_path(path: &Path) -> Result<bool, ()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(()),
    }
}

pub(super) fn move_owned_exclusive(from: &Path, to: &Path) -> Result<(), ()> {
    use std::os::unix::ffi::OsStrExt;
    let src = std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|_| ())?;
    let dst = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|_| ())?;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            src.as_ptr(),
            libc::AT_FDCWD,
            dst.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(src.as_ptr(), dst.as_ptr(), libc::RENAME_EXCL) };
    if result != 0 {
        return Err(());
    }
    for dir in [from.parent().ok_or(())?, to.parent().ok_or(())?] {
        fs::File::open(dir)
            .and_then(|f| f.sync_all())
            .map_err(|_| ())?;
    }
    Ok(())
}

pub(super) fn pair_or_repair(
    key: &Path,
    client: &rca_native_agent::device_pairing::PairingClient,
    resolve: impl Fn(&str, Option<&str>) -> Result<String, ()>,
    prepare_only: bool,
) -> Result<(), ()> {
    if !exists_owned_path(&sidecar(key, ".re-pair-transition"))?
        && !exists_owned_path(&sidecar(key, ".re-pair-new"))?
        && !exists_owned_path(&sidecar(key, ".re-pair-new.device-id"))?
    {
        if let Some(id) = read_private(&sidecar(key, ".device-id"), 128)? {
            let pem = read_private(key, 8192)?.ok_or(())?;
            let id = id.trim();
            if !valid_device_id(id) {
                return Err(());
            }
            match client.recover(&pem, Some(id)) {
                Ok(_) => return Ok(()),
                Err(rca_native_agent::session_recovery::SessionRecoveryError::Denied) => (),
                Err(_) => return Err(()),
            }
        } else {
            return pair_identity_at(key, &resolve).map(|_| ());
        }
    }
    // An explicit denial alone never authorizes replacing a key. The
    // independent signed negative-status response is mandatory.
    repair_identity(
        key,
        prepare_only,
        |pem, id| client.assert_revoked(pem, id).map_err(|_| ()),
        &resolve,
        |pem, id| client.recover(pem, Some(id)).map(|_| ()).map_err(|_| ()),
    )
}

// Call only under the existing installer lock, and with no process
// using this identity. Reuse the original Node five-prefix transaction
// and archive naming. No extra journal or credential format.
pub(super) fn repair_identity(
    key: &Path,
    prepare_only: bool,
    revoked: impl Fn(&str, &str) -> Result<(), ()>,
    pair: impl FnOnce(&str, Option<&str>) -> Result<String, ()>,
    approved: impl Fn(&str, &str) -> Result<(), ()>,
) -> Result<(), ()> {
    use serde_json::{json, Value};
    use std::os::unix::fs::DirBuilderExt;
    let parent = key.parent().ok_or(())?;
    let marker = sidecar(key, ".re-pair-transition");
    let id_path = sidecar(key, ".device-id");
    let stage = sidecar(key, ".re-pair-new");
    let stage_id = sidecar(&stage, ".device-id");
    let record: Value = if let Some(data) = read_private(&marker, 512)? {
        serde_json::from_str(&data).map_err(|_| ())?
    } else {
        let old = read_private(&id_path, 128)?.ok_or(())?;
        let old = old.trim();
        if !valid_device_id(old) {
            return Err(());
        }
        let pem = read_private(key, 8192)?.ok_or(())?;
        revoked(&pem, old)?;
        println!("Old identity is no longer approved; a replacement requires independent owner approval.");
        let next = pair_identity_at(&stage, pair)?;
        if next == old {
            return Err(());
        }
        let record = json!({"version":1,"old_id":old,"new_id":next});
        // As in the Node installer: after owner approval, before any
        // identity move. Every subsequent prefix can be resumed.
        write_new(&marker, format!("{record}\n").as_bytes())?;
        record
    };
    let fields = record.as_object().ok_or(())?;
    let old = fields.get("old_id").and_then(Value::as_str).ok_or(())?;
    let next = fields.get("new_id").and_then(Value::as_str).ok_or(())?;
    if fields.len() != 3
        || fields.get("version").and_then(Value::as_u64) != Some(1)
        || !valid_device_id(old)
        || !valid_device_id(next)
        || old == next
    {
        return Err(());
    }
    let archive = parent.join(format!("revoked-{old}"));
    let archived = archive.join("identity.pem");
    let archived_id = sidecar(&archived, ".device-id");
    let files = [
        key,
        id_path.as_path(),
        stage.as_path(),
        stage_id.as_path(),
        archived.as_path(),
        archived_id.as_path(),
    ];
    let present: Vec<bool> = files
        .iter()
        .map(|p| exists_owned_path(p))
        .collect::<Result<_, _>>()?;
    let phases = [
        [true, true, true, true, false, false],
        [false, true, true, true, true, false],
        [false, false, true, true, true, true],
        [true, false, false, true, true, true],
        [true, true, false, false, true, true],
    ];
    let phase = phases
        .iter()
        .position(|shape| shape.as_slice() == present.as_slice())
        .ok_or(())?;
    if exists_owned_path(&archive)? {
        rca_native_agent::upgrade_control::verify_upgrade_directory(&archived).map_err(|_| ())?;
        if fs::metadata(&archive).map_err(|_| ())?.mode() & 0o777 != 0o700
            || fs::canonicalize(&archive).ok().as_deref() != Some(archive.as_path())
        {
            return Err(());
        }
        // No unexpected archive entries, even on a resumed promotion.
        let expected = if phase == 0 {
            0
        } else if phase == 1 {
            1
        } else {
            2
        };
        if fs::read_dir(&archive).map_err(|_| ())?.count() != expected {
            return Err(());
        }
    } else if phase != 0 {
        return Err(());
    }
    let old_key = if phase == 0 { key } else { &archived };
    let old_id_file = if phase < 2 { &id_path } else { &archived_id };
    let new_key = if phase < 3 { &stage } else { key };
    let new_id_file = if phase < 4 { &stage_id } else { &id_path };
    let old_pem = read_private(old_key, 8192)?.ok_or(())?;
    let new_pem = read_private(new_key, 8192)?.ok_or(())?;
    if read_private(old_id_file, 128)?.ok_or(())?.trim() != old
        || read_private(new_id_file, 128)?.ok_or(())?.trim() != next
    {
        return Err(());
    }
    revoked(&old_pem, old)?;
    approved(&new_pem, next)?;
    if prepare_only {
        return Ok(());
    }
    if !exists_owned_path(&archive)? {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&archive)
            .map_err(|_| ())?;
        fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|_| ())?;
    }
    let steps = [
        (key, archived.as_path()),
        (id_path.as_path(), archived_id.as_path()),
        (stage.as_path(), key),
        (stage_id.as_path(), id_path.as_path()),
    ];
    for (from, to) in steps.iter().skip(phase) {
        move_owned_exclusive(from, to)?;
    }
    // The previous service must be absent before permanent promotion.
    // On interruption, the ordinary installer recovers the same approved
    // replacement and establishes a separate signed activation intent.
    fs::remove_file(marker).map_err(|_| ())?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| ())?;
    println!("Previous identity archived; approved replacement retained.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "123e4567-e89b-42d3-a456-426614174001";
    const NEW_ID: &str = "123e4567-e89b-42d3-a456-426614174002";

    #[test]
    fn exclusive_identity_publication_never_overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("identity.pem");
        write_new(&target, b"synthetic-original").unwrap();
        assert!(write_new(&target, b"synthetic-replacement").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"synthetic-original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn revoked_promotion_resumes_each_original_node_rename_prefix() {
        use std::os::unix::fs::DirBuilderExt;
        for prefix in 0..=4 {
            let dir = tempfile::tempdir().unwrap();
            // The entrypoint supplies a canonical identity parent. macOS
            // TMPDIR may instead be spelled through /var -> /private/var.
            let parent = fs::canonicalize(dir.path()).unwrap();
            let key = parent.join("v2-identity.pem");
            let id = sidecar(&key, ".device-id");
            let stage = sidecar(&key, ".re-pair-new");
            let stage_id = sidecar(&stage, ".device-id");
            let marker = sidecar(&key, ".re-pair-transition");
            let archive = parent.join(format!("revoked-{ID}"));
            let archived = archive.join("identity.pem");
            let archived_id = sidecar(&archived, ".device-id");
            fs::DirBuilder::new().mode(0o700).create(&archive).unwrap();
            // Independent fixture for each durable Node transaction prefix.
            let old_key_path = if prefix > 0 { &archived } else { &key };
            let old_id_path = if prefix > 1 { &archived_id } else { &id };
            let new_key_path = if prefix > 2 { &key } else { &stage };
            let new_id_path = if prefix > 3 { &id } else { &stage_id };
            write_new(old_key_path, b"old-pem").unwrap();
            write_new(old_id_path, ID.as_bytes()).unwrap();
            write_new(new_key_path, b"new-pem").unwrap();
            write_new(new_id_path, NEW_ID.as_bytes()).unwrap();
            write_new(
                &marker,
                format!(r#"{{"version":1,"old_id":"{ID}","new_id":"{NEW_ID}"}}"#).as_bytes(),
            )
            .unwrap();
            // A redirected spelling must still fail rather than weaken the
            // production archive check to make the temporary fixture pass.
            let link_root = tempfile::tempdir().unwrap();
            let alias = link_root.path().join("alias");
            std::os::unix::fs::symlink(&parent, &alias).unwrap();
            assert!(repair_identity(
                &alias.join("v2-identity.pem"),
                false,
                |_, _| panic!("redirected archive must be rejected before remote checks"),
                |_, _| panic!("unexpected pairing"),
                |_, _| panic!("redirected archive must be rejected before approval"),
            )
            .is_err());
            repair_identity(
                &key,
                false,
                |pem, device| {
                    assert_eq!((pem, device), ("old-pem", ID));
                    Ok(())
                },
                |_, _| panic!("resumed promotion must not request another grant"),
                |pem, device| {
                    assert_eq!((pem, device), ("new-pem", NEW_ID));
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(fs::read(&key).unwrap(), b"new-pem");
            assert_eq!(fs::read_to_string(&id).unwrap(), NEW_ID);
            assert_eq!(fs::read(&archived).unwrap(), b"old-pem");
            assert_eq!(fs::read_to_string(&archived_id).unwrap(), ID);
            assert!(!marker.exists() && !stage.exists() && !stage_id.exists());
        }
    }

    #[test]
    fn revoked_promotion_requires_both_remote_checks_and_preserves_old_key() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("v2-identity.pem");
        let id = sidecar(&key, ".device-id");
        let stage = sidecar(&key, ".re-pair-new");
        let marker = sidecar(&key, ".re-pair-transition");
        write_new(&key, b"old-pem").unwrap();
        write_new(&id, ID.as_bytes()).unwrap();
        assert!(repair_identity(
            &key,
            false,
            |_, _| Err(()),
            |_, _| panic!("unverified revoke"),
            |_, _| panic!("not paired")
        )
        .is_err());
        assert!(!marker.exists() && !stage.exists());
        assert!(repair_identity(
            &key,
            false,
            |_, _| Ok(()),
            |_, _| Err(()),
            |_, _| panic!("not approved")
        )
        .is_err());
        assert!(stage.exists() && !marker.exists());
        let staged = fs::read_to_string(&stage).unwrap();
        assert!(repair_identity(
            &key,
            false,
            |_, _| Ok(()),
            |pem, existing| {
                assert_eq!(pem, staged);
                assert!(existing.is_none());
                Ok(NEW_ID.to_owned())
            },
            |_, _| Err(())
        )
        .is_err());
        assert!(marker.exists());
        assert_eq!(fs::read(&key).unwrap(), b"old-pem");
        assert_eq!(fs::read_to_string(&id).unwrap(), ID);
        // Foreign archive contents must never be overwritten.
        let archive = dir.path().join(format!("revoked-{ID}"));
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&archive).unwrap();
        write_new(&archive.join("unrelated"), b"preserve").unwrap();
        assert!(repair_identity(
            &key,
            false,
            |_, _| Ok(()),
            |_, _| panic!("already paired"),
            |_, _| Ok(())
        )
        .is_err());
        assert_eq!(fs::read(archive.join("unrelated")).unwrap(), b"preserve");
        assert_eq!(fs::read(&key).unwrap(), b"old-pem");
        assert!(marker.exists());
    }
}
