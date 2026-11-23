#!/usr/bin/env python3
"""Isolated Linux Native handoff contract checks: no real systemd or cloud effects."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/bootstrap-v2.py"
spec = importlib.util.spec_from_file_location("rca_bootstrap", SCRIPT)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
APP = bootstrap.APP
ID = "123e4567-e89b-42d3-a456-426614174001"
ENDPOINT = "https://mcp.example.org/"


def owned_file(path, data=b"x", mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    path.chmod(mode)


def make_version(home, version, native):
    root = home / ".local/share/mcp-workers/remote-control/programs" / (version + "-linux-x64-glibc")
    root.mkdir(parents=True)
    manifest = {
        "name": "remote-control-agent", "artifact_schema": 1,
        "version": version, "target": "linux-x64-glibc", "device_protocol": 2,
        "receipt_schema": 1, "upgrade_profile": "paired-full-v1",
        "agent_runtime": "rust-standard-linux-v1" if native else "node-v2"
    }
    if native:
        manifest.update({"artifact_profile": "rust-native-only-v1",
                         "candidate_profile": "standard-linux-rust-runtime-v1",
                         "modules": []})
    owned_file(root / "bundle.json", json.dumps(manifest))
    owned_file(root / APP / ".build/session-supervisor", mode=0o700)
    owned_file(root / APP / "scripts/rca.sh", "#!/bin/sh\nexit 0\n", mode=0o700)
    if native:
        owned_file(root / APP / ".build/rca-standard-linux-candidate", mode=0o700)
        for script in ("bootstrap-v2.py", "manage-v2.py"):
            owned_file(root / APP / "scripts" / script)
    else:
        owned_file(root / "bin/node", mode=0o700)
        owned_file(root / APP / "src/v2-main.js",
                   'const V2_RUNTIME_PROFILE = "paired-full-v1";\n')
    bootstrap.validated_owned_version(root)
    return root


def fixture():
    ctx = tempfile.TemporaryDirectory(prefix="rca-handoff-isolated-")
    home = Path(ctx.name)
    home.chmod(0o700)
    base = home / ".local/share/mcp-workers/remote-control"
    base.mkdir(parents=True, mode=0o700)
    key = base / "v2-identity.pem"
    owned_file(key, "disposable-not-a-live-private-key")
    owned_file(Path(str(key) + ".device-id"), ID + "\n")
    old = make_version(home, "v0.1.56", False)
    new = make_version(home, "v0.1.57", True)
    unit = home / ".config/systemd/user/remote-control-agent.service"
    owned_file(unit, bootstrap.native_render_unit(old, ENDPOINT, key))
    launcher = home / ".local/bin/rca"
    launcher.parent.mkdir(parents=True)
    launcher.symlink_to(old / APP / "scripts/rca.sh")
    # Include preexisting SQLite history to ensure the transition never
    # substitutes or removes the existing receipt ledger.
    receipts = home / ".local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite"
    receipts.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with sqlite3.connect(receipts) as connection:
        connection.execute("PRAGMA user_version=1")
        connection.execute("CREATE TABLE historical (id TEXT)")
        connection.execute("INSERT INTO historical VALUES ('disposable-receipt-history')")
    receipts.chmod(0o600)
    return ctx, home, old, new, unit, launcher, key, receipts


def fake_services(home, old, new, proof_good=True, abort=False, rollback_failure=False):
    state = {"active": "old", "commands": [], "consents": []}

    def main_pid():
        return 100 if state["active"] == "old" else 200

    def executable(pid):
        if pid == 100:
            return old / "bin/node"
        if pid == 200:
            return new / APP / ".build/rca-standard-linux-candidate"
        raise ValueError("Unexpected process identity")

    def control(*args):
        state["commands"].append(args)
        if args[0] == "restart":
            if rollback_failure and state["active"] == "new":
                raise ValueError("Simulated rollback failure")
            content = (home / ".config/systemd/user/remote-control-agent.service").read_text()
            state["active"] = "new" if str(new) in content else "old"
            if abort and state["active"] == "new":
                raise KeyboardInterrupt("Simulated abruptly terminated updater")
        return ""

    def consent(key, action):
        state["consents"].append(action)
        return {"freeze": "ready", "verify-frozen": "ready",
                "release": "released"}[action]

    def verify(path, operation, device_id, target):
        assert path.name.endswith("native-upgrade-proof")
        assert len(operation) == 32 and device_id == ID and target == new.name
        assert Path(str(home / ".config/systemd/user/remote-control-agent.service") +
                    ".upgrade-backup").exists()
        if proof_good:
            bootstrap.native_create_file(path, json.dumps({
                "operation_id": operation, "device_id": device_id,
                "target_version": target, "status": "authenticated_wss"
            }).encode())
            assert bootstrap.native_wait_proof(path, operation, device_id, target, 1)
        return proof_good

    return state, {"native_main_pid": main_pid,
                   "native_process_executable": executable,
                   "native_systemctl": control,
                   "native_consent": consent}, verify


def verify_isolated():
    # Preserve the canonical systemd unit exactly across the language boundary.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        assert bootstrap.owned_unit_root(unit.read_text(), [old, new]) == old
        assert "ExecStart=" + str(new / APP / ".build/rca-standard-linux-candidate") in (
            bootstrap.native_render_unit(new, ENDPOINT, key))
        assert not bootstrap.native_wait_proof(key.parent / "missing-proof", "a" * 32,
                                               ID, new.name, 0)
    finally:
        ctx.cleanup()

    # A foreign/replayed proof or incompatible old receipt file must fail
    # before any service mutation or interpretation as a signed acceptance.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        proof = Path(str(key) + ".native-upgrade-proof")
        owned_file(proof, json.dumps({"operation_id":"f" * 32,
             "device_id":ID,"target_version":new.name,"status":"authenticated_wss"}))
        try:
            bootstrap.native_wait_proof(proof, "a" * 32, ID, new.name, 1)
            raise AssertionError("Mismatched operation proof was accepted")
        except ValueError:
            pass
        proof.unlink()
        owned_file(receipts, "not-a-valid-sqlite-database")
        state, mocks, verify = fake_services(home, old, new)
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
                raise AssertionError("Invalid preexisting SQLite was accepted")
            except ValueError as error:
                assert "SQLite" in str(error)
        assert not state["commands"] and not state["consents"]
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        assert unit.read_text() == bootstrap.native_render_unit(old, ENDPOINT, key)
    finally:
        ctx.cleanup()

    # On confirmed signed WSS, switch exactly one service and CLI, keep
    # old program, identity and the exact historical receipt bytes.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        state, mocks, verify = fake_services(home, old, new, proof_good=True)
        with patch.multiple(bootstrap, **mocks):
            result = bootstrap.native_cutover(home, new, ENDPOINT, verify)
        assert result["signed_wss"] and state["active"] == "new"
        assert launcher.readlink() == new / APP / "scripts/rca.sh"
        assert unit.read_text() == bootstrap.native_render_unit(new, ENDPOINT, key)
        assert b"disposable-receipt-history" in receipts.read_bytes()
        assert key.read_text() == "disposable-not-a-live-private-key"
        assert old.exists() and new.exists()
        assert not Path(str(unit) + ".upgrade-backup").exists()
        assert not Path(str(key) + ".native-upgrade-intent").exists()
    finally:
        ctx.cleanup()

    # Missing signed proof rolls back to original Node process & launcher,
    # preserving the same identity/receipts and clearing only resolved state.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        state, mocks, verify = fake_services(home, old, new, proof_good=False)
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
                raise AssertionError("Failed upgrade was accepted")
            except ValueError as e:
                assert "rolled back" in str(e)
        assert state["active"] == "old"
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        assert unit.read_text() == bootstrap.native_render_unit(old, ENDPOINT, key)
        assert b"disposable-receipt-history" in receipts.read_bytes()
        assert key.read_text() == "disposable-not-a-live-private-key"
        assert not Path(str(unit) + ".upgrade-backup").exists()
    finally:
        ctx.cleanup()

    # Abrupt process termination leaves durable original unit + matching
    # target intent for manual reconciliation; never claim Pass.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        state, mocks, verify = fake_services(home, old, new, abort=True)
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
                raise AssertionError("Unexpected cutover completion")
            except KeyboardInterrupt:
                pass
        assert state["active"] == "new"
        assert Path(str(unit) + ".upgrade-backup").read_text() == (
            bootstrap.native_render_unit(old, ENDPOINT, key))
        intent = json.loads(Path(str(key) + ".native-upgrade-intent").read_text())
        assert intent["device_id"] == ID and intent["target_version"] == new.name
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        assert b"disposable-receipt-history" in receipts.read_bytes()
        try:
            with patch.multiple(bootstrap, **mocks):
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
            raise AssertionError("Unreconciled backup permitted a second cutover")
        except ValueError:
            pass
    finally:
        ctx.cleanup()

    # Unknown rollback must retain the backup rather than invent success.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        state, mocks, verify = fake_services(home, old, new, proof_good=False,
                                             rollback_failure=True)
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
                raise AssertionError("Rollback failure was accepted")
            except ValueError as e:
                assert "rollback uncertain" in str(e)
        assert Path(str(unit) + ".upgrade-backup").exists()
        assert b"disposable-receipt-history" in receipts.read_bytes()
    finally:
        ctx.cleanup()
    print("ISOLATED_NATIVE_HANDOFF_CONTRACT_PASS")


if __name__ == "__main__":
    os.umask(0o077)  # Exactly the installed Agent's private program directories.
    if sys.argv[1:] == ["--units"]:
        ctx, home, old, new, unit, launcher, key, receipts = fixture()
        try:
            print(json.dumps({"home": str(home), "old": str(old), "new": str(new),
                              "key": str(key), "endpoint": ENDPOINT,
                              "old_unit": bootstrap.native_render_unit(old, ENDPOINT, key),
                              "new_unit": bootstrap.native_render_unit(new, ENDPOINT, key)}))
        finally:
            ctx.cleanup()
    else:
        verify_isolated()
