#!/usr/bin/env python3
"""Verify the actual Node-free Linux bundle in an isolated, unpaired home."""
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

if len(sys.argv) != 4:
    raise SystemExit("usage: validate-local-archive.py <archive> <tag> <target>")
archive, tag, target = sys.argv[1:]
if {"x86_64": "linux-x64-glibc", "aarch64": "linux-arm64-glibc"}.get(platform.machine()) != target:
    raise SystemExit("Archive must be verified on its matching native architecture.")
if os.getuid() == 0:
    raise SystemExit("Use a disposable unprivileged build user.")

bootstrap = Path(__file__).with_name("bootstrap-v2.py")
spec = importlib.util.spec_from_file_location("local_bootstrap", bootstrap)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
records = module.inspect_archive(archive, tag, target)
with tempfile.TemporaryDirectory(prefix="rca-native-package-") as directory:
    home = Path(directory)
    programs = home / ".local/share/mcp-workers/remote-control/programs"
    programs.mkdir(parents=True, mode=0o700)
    programs.parent.chmod(0o700)
    root = programs / (tag + "-" + target)
    module.unpack_verified(archive, root, records, tag, target)
    manifest = json.loads((root / "bundle.json").read_text("utf8"))
    assert manifest["artifact_profile"] == "rust-native-only-v1"
    assert manifest["modules"] == [] and "node" not in manifest
    assert not (root / "bin/node").exists()
    app = root / "apps/remote-control-agent"
    assert not (app / "src").exists()
    assert (app / "scripts/bootstrap-v2.py").read_bytes() == bootstrap.read_bytes()
    manager = app / "scripts/rca.sh"
    helper = app / ".build/session-supervisor"
    assert manager.stat().st_mode & 0o777 == 0o700
    assert (app / "scripts/manage-v2.py").stat().st_mode & 0o777 == 0o700
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}

    def run(*argv):
        return subprocess.run([str(x) for x in argv], env=env,
                              stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, timeout=15, start_new_session=True)

    result = run(helper, "--probe")
    assert result.returncode == 0, result.stderr
    result = run(manager, "--version")
    assert result.returncode == 0 and result.stdout.strip() == tag, result.stderr
    result = run(manager, "status")
    assert result.returncode == 0, result.stderr
    state, _ = json.JSONDecoder().raw_decode(result.stdout)
    assert state["installed_versions"] == [root.name]
    assert state["local_permanent_service"] == "not_installed"
    assert state["cloud_authorization"] == "unconfirmed"
    assert state["signed_wss"] == "unconfirmed" and state["device_ids"] == {}
    result = run(manager)
    assert result.returncode == 1 and "refused unsafe or unavailable local state" in result.stderr, (result.returncode, result.stdout, result.stderr)
    assert not list(programs.parent.rglob("v2-identity.pem"))
    module.verify_existing_program(archive, root, records)
    try:
        module.unpack_verified(archive, root, records, tag, target)
    except ValueError:
        pass
    else:
        raise AssertionError("Repeated staging replaced a reviewed program.")
    print("PACKAGED_NATIVE_LINUX_OFFLINE_PASS", target)
