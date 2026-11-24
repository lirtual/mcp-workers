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


def native_pair_fixture():
    ctx, home, node, old, unit, launcher, key, receipts = fixture()
    new = make_version(home, "v0.1.58", True)
    unit.write_text(bootstrap.native_render_unit(old, ENDPOINT, key))
    launcher.unlink()
    launcher.symlink_to(old / APP / "scripts/rca.sh")
    return ctx, home, old, new, unit, launcher, key, receipts


def fake_services(home, old, new, proof_good=True, abort=False, rollback_failure=False,
                  restart_after_proof=False):
    state = {"active": "old", "commands": [], "consents": [], "pid_generation": 0}

    def main_pid():
        return 100 if state["active"] == "old" else 200 + state["pid_generation"]

    def expected_executable(root):
        info = json.loads((root / "bundle.json").read_text())
        return (root / APP / ".build/rca-standard-linux-candidate"
                if info.get("artifact_profile") == "rust-native-only-v1"
                else root / "bin/node")

    def executable(pid):
        if pid == 100:
            return expected_executable(old)
        if pid in (200, 201):
            return expected_executable(new)
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

    def verify(path, operation, device_id, target, pid):
        assert path.name.endswith("native-upgrade-proof")
        assert len(operation) == 32 and device_id == ID and target == new.name
        assert Path(str(home / ".config/systemd/user/remote-control-agent.service") +
                    ".upgrade-backup").exists()
        if proof_good:
            owned_file(path, json.dumps({
                "operation_id": operation, "device_id": device_id,
                "target_version": target, "status": "authenticated_wss", "pid": pid
            }).encode())
            assert bootstrap.native_wait_proof(path, operation, device_id, target, pid, 1)
            if restart_after_proof:
                # The signed first Rust process exits before the installer commits.
                # A restarted process must authenticate independently.
                state["pid_generation"] = 1
        return proof_good

    return state, {"native_main_pid": main_pid,
                   "native_process_executable": executable,
                   "native_systemctl": control,
                   "native_consent": consent}, verify


def verify_temporary_install():
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        snapshot = (key.read_bytes(), unit.read_bytes(), launcher.readlink(), receipts.read_bytes())
        calls = []
        with (patch.object(bootstrap.sys.stdin, "isatty", return_value=True),
              patch.object(bootstrap.sys.stdout, "isatty", return_value=True),
              patch("builtins.input", return_value="TEMPORARY"),
              patch.object(bootstrap, "native_pair_local", side_effect=lambda *a, **kw: calls.append((a,kw)))):
            # Worker origins must not be checked against GitHub download hosts.
            assert bootstrap.native_temporary(home,new,ENDPOINT,"test",
                process_check=lambda versions:True) == 0
            assert calls == [((new,ENDPOINT,"test"),{"temporary":True})]
            try:
                bootstrap.native_temporary(home,new,ENDPOINT,
                    process_check=lambda versions:False)
                raise AssertionError("Active receipt owner allowed temporary pairing")
            except ValueError as e:
                assert "Running or uncertain Agent" in str(e)
            try:
                bootstrap.native_temporary(home,new,"https://user@example.org/",
                    process_check=lambda versions:True)
                raise AssertionError("Credential-bearing Worker URL accepted")
            except ValueError as e:
                assert "HTTPS Worker origin" in str(e)
        assert len(calls)==1
        assert (key.read_bytes(), unit.read_bytes(), launcher.readlink(), receipts.read_bytes()) == snapshot
    finally:
        ctx.cleanup()


def verify_initial_install():
    # Use the same package, identity, launcher and receipt contracts as an
    # upgrade, but no previously installed service or approved identity.
    for case in ("approved", "pair-denied", "no-proof", "foreign-service", "interrupted",
                 "temporary-launcher-approved", "temporary-launcher-no-proof",
                 "temporary-launcher-older-approved", "temporary-launcher-older-no-proof"):
        ctx, home, old, new, unit, launcher, key, receipts = fixture()
        try:
            unit.unlink()
            launcher.unlink()
            preexisting_launcher = case.startswith("temporary-launcher-")
            prior = make_version(home, "v0.1.55", True) if "older" in case else new
            if preexisting_launcher:
                launcher.symlink_to(prior / APP / "scripts/rca.sh")
            key.unlink()
            id_path = Path(str(key) + ".device-id")
            id_path.unlink()
            intent = Path(str(key) + ".native-upgrade-intent")
            proof = Path(str(key) + ".native-upgrade-proof")
            old_receipts = receipts.read_bytes()
            state = {"pid": 0, "pairs": 0, "commands": []}
            def control(*args):
                if args[0] == "show":
                    foreign = case == "foreign-service"
                    loaded = unit.exists() or foreign
                    return "\n".join((
                        "LoadState=" + ("loaded" if loaded else "not-found"),
                        "ActiveState=" + ("active" if state["pid"] else "inactive"),
                        "MainPID=" + str(state["pid"]),
                        "FragmentPath=" + ("/usr/lib/systemd/user/foreign.service" if foreign
                            else str(unit) if loaded else ""),
                        "DropInPaths="))
                state["commands"].append(args)
                if args[0] == "enable":
                    assert id_path.read_text().strip() == ID
                    assert intent.is_file() and launcher.exists() == preexisting_launcher
                    state["pid"] = 200
                    if case == "interrupted":
                        raise KeyboardInterrupt("installer terminated after start")
                if args[0] == "disable":
                    state["pid"] = 0
                return ""
            def pair(root, endpoint, name):
                state["pairs"] += 1
                assert root == new and endpoint == ENDPOINT
                assert not state["commands"] and not unit.exists()
                owned_file(key, "disposable-approved-key")
                if case == "pair-denied":
                    raise ValueError("Pairing refused")
                owned_file(id_path, ID + "\n")
            def verify(path, operation, device_id, target, pid):
                assert launcher.exists() == preexisting_launcher
                record = json.loads(intent.read_text())
                assert record["operation_id"] == operation and record["device_id"] == ID
                assert record["target_version"] == new.name and record["initial_endpoint"] == ENDPOINT
                assert device_id == ID and target == new.name and pid == 200
                if case in ("no-proof", "interrupted") or case.endswith("no-proof"):
                    return False
                owned_file(path, json.dumps({"operation_id":operation,"device_id":ID,
                    "target_version":target,"pid":pid,"status":"authenticated_wss"}))
                return bootstrap.native_wait_proof(path, operation, ID, target, pid, 1)
            mocks = {"native_systemctl":control, "native_main_pid":lambda: state["pid"],
                "native_process_executable":lambda pid: new / APP / ".build/rca-standard-linux-candidate",
                "native_consent":lambda key, action: "ready"}
            with patch.multiple(bootstrap, **mocks):
                if case.endswith("approved"):
                    result = bootstrap.native_first_install(home, new, ENDPOINT, pair=pair,
                        verify=verify, process_check=lambda versions: not state["pid"])
                    assert result["signed_wss"] is True
                    assert launcher.readlink() == new / APP / "scripts/rca.sh"
                    assert not intent.exists() and not proof.exists()
                    commands = state["commands"].copy()
                    assert bootstrap.native_first_install(home, new, ENDPOINT, pair=pair,
                        verify=verify)["status"] == "already_installed"
                    assert state["pairs"] == 1 and state["commands"] == commands
                else:
                    try:
                        bootstrap.native_first_install(home, new, ENDPOINT, pair=pair,
                            verify=verify, process_check=lambda versions: not state["pid"])
                        raise AssertionError("Unsafe first activation accepted: " + case)
                    except (ValueError, KeyboardInterrupt):
                        pass
                    assert launcher.exists() == preexisting_launcher
                    if case in ("no-proof", "interrupted") or case.endswith("no-proof"):
                        assert intent.exists() and unit.exists()
                        assert bootstrap.native_recover(home, process_check=lambda versions: not state["pid"])["status"] == "initial_service_removed"
                        assert not intent.exists() and not unit.exists() and not proof.exists()
                        assert launcher.exists() == preexisting_launcher
                        if preexisting_launcher:
                            assert launcher.readlink() == prior / APP / "scripts/rca.sh"
                        assert key.read_text() == "disposable-approved-key"
                        assert id_path.read_text().strip() == ID
                    else:
                        assert not state["commands"] and not unit.exists()
                        assert not id_path.exists() and not intent.exists()
                        if case == "foreign-service":
                            assert state["pairs"] == 0 and not key.exists()
            assert receipts.read_bytes() == old_receipts
        finally:
            ctx.cleanup()


def verify_permanent_repair():
    replacement = "123e4567-e89b-42d3-a456-426614174002"
    for case in ("healthy", "denied", "busy", "approved", "resume", "no-proof"):
        ctx, home, root, new, unit, launcher, key, receipts = native_pair_fixture()
        try:
            original = key.read_bytes()
            receipt_bytes = receipts.read_bytes()
            id_path = Path(str(key) + ".device-id")
            marker = Path(str(key) + ".re-pair-transition")
            staged_key = Path(str(key) + ".re-pair-new")
            staged_id = Path(str(staged_key) + ".device-id")
            intent = Path(str(key) + ".native-upgrade-intent")
            state = {"pid": 100, "events": []}

            def prepare():
                owned_file(staged_key, "replacement-approved-key")
                owned_file(staged_id, replacement + "\n")
                owned_file(marker, json.dumps({"version": 1, "old_id": ID, "new_id": replacement}))

            if case == "resume":
                prepare()
                unit.unlink()
                state["pid"] = 0

            def control(*args):
                if args[0] == "show":
                    return "\n".join(("LoadState=" + ("loaded" if unit.exists() else "not-found"),
                        "ActiveState=" + ("active" if state["pid"] else "inactive"),
                        "MainPID=" + str(state["pid"]),
                        "FragmentPath=" + (str(unit) if unit.exists() else ""), "DropInPaths="))
                state["events"].append(args[0])
                if args[0] == "disable":
                    assert marker.exists() or intent.exists()
                    state["pid"] = 0
                elif args[0] == "enable":
                    assert not marker.exists() and intent.exists()
                    assert id_path.read_text().strip() == replacement
                    state["pid"] = 200
                return ""

            def consent(_, action):
                state["events"].append(action)
                return "busy" if case == "busy" and action == "freeze" else "ready"

            def pair(program, endpoint, name, repair_phase=None, lock_fd=None):
                assert program == root and endpoint == ENDPOINT
                state["events"].append(repair_phase or "recover-approved")
                if repair_phase is not None:
                    assert lock_fd is not None
                    with open(key.parent / "v2-installer.lock", "rb") as independent:
                        try:
                            bootstrap.fcntl.flock(independent, bootstrap.fcntl.LOCK_EX | bootstrap.fcntl.LOCK_NB)
                            raise AssertionError("Parent installer lock not held")
                        except BlockingIOError:
                            pass
                if repair_phase == "prepare":
                    assert key.read_bytes() == original
                    if case == "denied":
                        raise ValueError("Signed replacement approval denied")
                    if case != "healthy" and not marker.exists():
                        prepare()
                    assert key.read_bytes() == original
                elif repair_phase == "promote":
                    assert not unit.exists() and not state["pid"]
                    assert key.read_bytes() == original and marker.exists()
                    archive = key.parent / ("revoked-" + ID)
                    archive.mkdir(mode=0o700)
                    key.rename(archive / "identity.pem")
                    id_path.rename(archive / "identity.pem.device-id")
                    staged_key.rename(key)
                    staged_id.rename(id_path)
                    marker.unlink()
                else:
                    assert id_path.read_text().strip() == replacement

            def verify(path, operation, device, target, pid):
                assert device == replacement and pid == 200 and target == root.name
                if case == "no-proof":
                    return False
                owned_file(path, json.dumps({"operation_id": operation, "device_id": device,
                    "target_version": target, "pid": pid, "status": "authenticated_wss"}))
                return bootstrap.native_wait_proof(path, operation, device, target, pid, 1)

            mocks = {"native_systemctl": control, "native_main_pid": lambda: state["pid"],
                     "native_process_executable": lambda pid: root / APP / ".build/rca-standard-linux-candidate",
                     "native_consent": consent}
            with (patch.multiple(bootstrap, **mocks),
                  patch.object(bootstrap.sys.stdin, "isatty", return_value=True),
                  patch.object(bootstrap.sys.stdout, "isatty", return_value=True)):
                if case in ("healthy", "approved", "resume"):
                    result = bootstrap.native_pair_or_install(home, root, ENDPOINT, "test",
                        pair=pair, verify=verify, process_check=lambda versions: not state["pid"])
                    if case == "healthy":
                        assert result["status"] == "already_installed" and state["events"] == ["prepare"]
                        assert key.read_bytes() == original
                    else:
                        assert result["signed_wss"] is True
                        assert result["identity_preserved"] is False and result["previous_identity_archived"] is True
                        events = state["events"]
                        assert events.index("prepare") < events.index("promote") < events.index("enable")
                        if case == "approved":
                            assert events.index("prepare") < events.index("freeze") < events.index("disable") < events.index("promote")
                        assert id_path.read_text().strip() == replacement
                else:
                    try:
                        bootstrap.native_pair_or_install(home, root, ENDPOINT, "test",
                            pair=pair, verify=verify, process_check=lambda versions: not state["pid"])
                        raise AssertionError("Unsafe re-pair accepted: " + case)
                    except ValueError:
                        pass
                    if case == "no-proof":
                        assert intent.exists() and not marker.exists()
                        assert bootstrap.native_recover(home, process_check=lambda versions: not state["pid"])["status"] == "initial_service_removed"
                        assert id_path.read_text().strip() == replacement
                    else:
                        assert unit.exists() and state["pid"] == 100 and key.read_bytes() == original
                        assert "disable" not in state["events"] and "promote" not in state["events"]
                assert launcher.readlink() == root / APP / "scripts/rca.sh"
                assert receipts.read_bytes() == receipt_bytes
        finally:
            ctx.cleanup()


def verify_service_start():
    expected = Path("/reviewed/agent")
    # Real Type=simple may expose no executable yet, then the same PID execs.
    with patch.object(bootstrap, "native_main_pid", return_value=200), patch.object(
            bootstrap, "native_process_executable",
            side_effect=[FileNotFoundError(), PermissionError(), expected]):
        assert bootstrap.native_wait_started(expected) == 200
    # Persistent permission denial is never treated as a successful start.
    with patch.object(bootstrap, "native_main_pid", return_value=200), patch.object(
            bootstrap, "native_process_executable", side_effect=PermissionError()):
        try:
            bootstrap.native_wait_started(expected, seconds=0)
            raise AssertionError("Inaccessible executable was accepted")
        except ValueError as e:
            assert "not established" in str(e)
    # A later systemd restart must never substitute a different PID.
    with patch.object(bootstrap, "native_main_pid", side_effect=[200, 201]), patch.object(
            bootstrap, "native_process_executable", return_value=expected):
        try:
            bootstrap.native_wait_started(expected)
            raise AssertionError("Replacement PID was accepted")
        except ValueError as e:
            assert "process changed" in str(e)
    # An existing foreign executable never establishes the reviewed process.
    with patch.object(bootstrap, "native_main_pid", return_value=200), patch.object(
            bootstrap, "native_process_executable", return_value=Path("/foreign/agent")):
        try:
            bootstrap.native_wait_started(expected, seconds=0)
            raise AssertionError("Wrong executable was accepted")
        except ValueError as e:
            assert "not established" in str(e)
    # A transient missing executable in both directions must not turn a
    # successful activation or verified rollback into an uncertain result.
    for proof_good in (True, False):
        ctx, home, old, new, unit, launcher, key, receipts = fixture()
        try:
            state, mocks, verify = fake_services(home, old, new, proof_good=proof_good)
            control = mocks["native_systemctl"]
            executable = mocks["native_process_executable"]
            pending = set()
            def delayed_control(*args):
                result = control(*args)
                if args[0] == "restart":
                    pending.add(mocks["native_main_pid"]())
                return result
            def delayed_executable(pid):
                if pid in pending:
                    pending.remove(pid)
                    raise PermissionError()
                return executable(pid)
            with patch.multiple(bootstrap, **{**mocks,
                    "native_systemctl": delayed_control, "native_process_executable": delayed_executable}):
                if proof_good:
                    assert bootstrap.native_cutover(home, new, ENDPOINT, verify)["signed_wss"]
                else:
                    try:
                        bootstrap.native_cutover(home, new, ENDPOINT, verify)
                        raise AssertionError("Missing WSS proof was accepted")
                    except ValueError as e:
                        assert "safely rolled back (stage=signed-wss)" in str(e)
                assert not pending
            assert state["active"] == ("new" if proof_good else "old")
            assert not Path(str(unit) + ".upgrade-backup").exists()
            assert not Path(str(key) + ".native-upgrade-intent").exists()
        finally:
            ctx.cleanup()


def verify_isolated():
    verify_permanent_repair()
    verify_initial_install()
    verify_temporary_install()
    # Preserve the canonical systemd unit exactly across the language boundary.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        assert bootstrap.owned_unit_root(unit.read_text(), [old, new]) == old
        assert "ExecStart=" + str(new / APP / ".build/rca-standard-linux-candidate") in (
            bootstrap.native_render_unit(new, ENDPOINT, key))
        assert not bootstrap.native_wait_proof(key.parent / "missing-proof", "a" * 32,
                                               ID, new.name, 200, 0)
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
            bootstrap.native_wait_proof(proof, "a" * 32, ID, new.name, 200, 1)
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

    # Native-to-native: reuse the SAME signed WSS commit and owner-local
    # rollback transaction. A verified prior Rust service is no longer Node.
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        old_unit = unit.read_text()
        original_key, original_receipts = key.read_bytes(), receipts.read_bytes()
        state, mocks, verify = fake_services(home, old, new)
        with patch.multiple(bootstrap, **mocks):
            result = bootstrap.native_cutover(home, new, ENDPOINT, verify)
        assert result["status"] == "active" and result["signed_wss"] is True
        assert result["identity_preserved"] is True
        assert state["active"] == "new"
        assert launcher.readlink() == new / APP / "scripts/rca.sh"
        assert unit.read_text() == bootstrap.native_render_unit(new, ENDPOINT, key)
        assert unit.read_text() != old_unit
        assert key.read_bytes() == original_key
        assert receipts.read_bytes() == original_receipts
        assert old.exists() and new.exists()
        assert not Path(str(unit) + ".upgrade-backup").exists()
        assert not Path(str(key) + ".native-upgrade-intent").exists()
        assert not Path(str(key) + ".native-upgrade-proof").exists()
    finally:
        ctx.cleanup()

    # Missing WSS proof MUST restore the previously active Rust executable,
    # not the historical Node version still present among managed programs.
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        original_unit, original_receipts = unit.read_text(), receipts.read_bytes()
        state, mocks, verify = fake_services(home, old, new, proof_good=False)
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
                raise AssertionError("Unauthenticated Rust-to-Rust upgrade committed")
            except ValueError as error:
                assert "rolled back" in str(error)
        assert state["active"] == "old"
        assert unit.read_text() == original_unit
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        assert receipts.read_bytes() == original_receipts
        assert not Path(str(unit) + ".upgrade-backup").exists()
        assert not Path(str(key) + ".native-upgrade-intent").exists()
    finally:
        ctx.cleanup()

    # An interrupted Rust-to-Rust switch must be recoverable using the
    # exact same attended recovery command; the oldest Node stays untouched.
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        original_unit = unit.read_text()
        unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
        state, mocks, verify = fake_services(home, old, new)
        state["active"] = "new"
        owned_file(Path(str(unit) + ".upgrade-backup"),
                                     original_unit.encode())
        owned_file(Path(str(key) + ".native-upgrade-intent"),
            json.dumps({"operation_id": "d" * 32, "device_id": ID,
                        "target_version": new.name}).encode())
        original_key, original_receipts = key.read_bytes(), receipts.read_bytes()
        with patch.multiple(bootstrap, **mocks):
            result = bootstrap.native_recover(home)
        assert result["status"] == "previous_service_restored"
        assert result["version"] == old.name and result["signed_wss"] == "unconfirmed"
        assert state["active"] == "old"
        assert unit.read_text() == original_unit
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        assert key.read_bytes() == original_key
        assert receipts.read_bytes() == original_receipts
        assert not Path(str(unit) + ".upgrade-backup").exists()
        assert not Path(str(key) + ".native-upgrade-intent").exists()
    finally:
        ctx.cleanup()

    # A process-killed updater can leave only its intent before the service
    # switch, or only its backup after verified commit/rollback cleanup.
    # Reconcile only an exact owned, running service and matching launcher.
    for phase in ("intent-only", "backup-only-old", "backup-only-new"):
        ctx, home, old, new, unit, launcher, key, receipts = fixture()
        try:
            state, mocks, verify = fake_services(home, old, new)
            original_unit = unit.read_text()
            original_receipts = receipts.read_bytes()
            if phase == "intent-only":
                owned_file(Path(str(key) + ".native-upgrade-intent"),
                    json.dumps({"operation_id": "e" * 32, "device_id": ID,
                                "target_version": new.name}).encode())
            else:
                owned_file(Path(str(unit) + ".upgrade-backup"),
                                             original_unit.encode())
                if phase == "backup-only-new":
                    unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
                    launcher.unlink()
                    launcher.symlink_to(new / APP / "scripts/rca.sh")
                    state["active"] = "new"
            active = state["active"]
            with patch.multiple(bootstrap, **mocks):
                result = bootstrap.native_recover(home)
            assert result["signed_wss"] == "unconfirmed"
            assert state["active"] == active and not state["commands"]
            assert receipts.read_bytes() == original_receipts
            assert not Path(str(unit) + ".upgrade-backup").exists()
            assert not Path(str(key) + ".native-upgrade-intent").exists()
        finally:
            ctx.cleanup()

    # A lone backup must not be discarded if the running service and CLI
    # disagree (for example, an interrupted switch before launcher commit).
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        state, mocks, verify = fake_services(home, old, new)
        backup = Path(str(unit) + ".upgrade-backup")
        owned_file(backup, unit.read_bytes())
        unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
        state["active"] = "new"
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_recover(home)
                raise AssertionError("Ambiguous backup was discarded")
            except ValueError:
                pass
        assert backup.exists() and not state["commands"] and not state["consents"]
    finally:
        ctx.cleanup()

    # A killed installer during freeze leaves intent even before backup
    # creation. Its ordinary attended recovery must release the freeze.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        state, mocks, verify = fake_services(home, old, new)
        original_consent = mocks["native_consent"]
        def interrupted_freeze(key, action):
            if action == "freeze":
                raise KeyboardInterrupt("killed during freeze")
            return original_consent(key, action)
        with patch.multiple(bootstrap, **{**mocks, "native_consent": interrupted_freeze}):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
                raise AssertionError("Interrupted freeze unexpectedly completed")
            except KeyboardInterrupt:
                pass
        assert Path(str(key) + ".native-upgrade-intent").exists()
        assert not Path(str(unit) + ".upgrade-backup").exists()
        with patch.multiple(bootstrap, **mocks):
            result = bootstrap.native_recover(home)
        assert result["status"] == "active_service_reconciled"
        assert not state["commands"]
    finally:
        ctx.cleanup()

    # Two additional interruption points in the same transaction:
    # unit published before restart, and proof visible before its JSON write.
    for phase in ("unit-before-restart", "partial-proof", "rollback-before-restart"):
        ctx, home, old, new, unit, launcher, key, receipts = fixture()
        try:
            state, mocks, verify = fake_services(home, old, new)
            original_unit = unit.read_bytes()
            original_receipts = receipts.read_bytes()
            backup = Path(str(unit) + ".upgrade-backup")
            intent = Path(str(key) + ".native-upgrade-intent")
            proof = Path(str(key) + ".native-upgrade-proof")
            owned_file(backup, original_unit)
            owned_file(intent, json.dumps({"operation_id": "e" * 32,
                       "device_id": ID, "target_version": new.name}))
            unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
            if phase == "partial-proof":
                state["active"] = "new"
                owned_file(proof, '{"operation_id":')
            elif phase == "rollback-before-restart":
                unit.write_bytes(original_unit)
                state["active"] = "new"
                launcher.unlink()
                launcher.symlink_to(new / APP / "scripts/rca.sh")
            with patch.multiple(bootstrap, **mocks):
                result = bootstrap.native_recover(home)
            assert result["status"] == "previous_service_restored"
            assert result["signed_wss"] == "unconfirmed"
            assert state["active"] == "old"
            assert unit.read_bytes() == original_unit
            assert launcher.readlink() == old / APP / "scripts/rca.sh"
            assert receipts.read_bytes() == original_receipts
            assert not any(p.exists() for p in (backup, intent, proof))
        finally:
            ctx.cleanup()

    # A process can authenticate and exit before the installer first observes
    # MainPID. The replacement has the same executable but not the proof PID.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        state, mocks, verify = fake_services(home, old, new)
        def stale_proof(path, operation, device_id, target, pid):
            owned_file(path, json.dumps({
                "operation_id": operation, "device_id": device_id,
                "target_version": target, "status": "authenticated_wss", "pid": pid - 1
            }).encode())
            return bootstrap.native_wait_proof(path, operation, device_id, target, pid, 1)
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, stale_proof)
                raise AssertionError("Proof for a replaced process accepted")
            except ValueError:
                pass
        assert state["active"] == "old"
    finally:
        ctx.cleanup()

    # A valid proof from an earlier Rust PID must not approve its replacement.
    # The original Node process must be recovered instead.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        state, mocks, verify = fake_services(home, old, new, restart_after_proof=True)
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
                raise AssertionError("Stale Rust process WSS proof accepted after restart")
            except ValueError as error:
                assert "rolled back" in str(error)
        assert state["active"] == "old"
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        assert unit.read_text() == bootstrap.native_render_unit(old, ENDPOINT, key)
        assert b"disposable-receipt-history" in receipts.read_bytes()
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

    # An owner-local native upgrade holds the existing installer lock. A
    # concurrent uninstall must fail before stopping or deleting any service,
    # even when its durable intent has not yet been created.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        # Simulate a completed first native upgrade: the native Python
        # manager owns this CLI, while a next-version upgrade holds the lock.
        unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
        launcher.unlink()
        launcher.symlink_to(new / APP / "scripts/rca.sh")
        import fcntl
        lock_file = key.parent / "v2-installer.lock"
        with lock_file.open("w+b") as lock:
            lock_file.chmod(0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            calls = []
            try:
                bootstrap.local_uninstall(home, True,
                    systemctl=lambda args: calls.append(args),
                    process_check=lambda versions: True)
                raise AssertionError("Uninstall bypassed active native upgrade lock")
            except ValueError as error:
                assert "installer" in str(error).lower()
            assert not calls and old.exists() and new.exists()
            assert unit.exists() and launcher.is_symlink()
    finally:
        ctx.cleanup()

    # An interrupted cutover owns both old and new programs until its
    # durable backup is reconciled; even a confirmed local uninstall must
    # not destroy the rollback binary in this state.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
        launcher.unlink()
        launcher.symlink_to(new / APP / "scripts/rca.sh")
        backup = Path(str(unit) + ".upgrade-backup")
        intent = Path(str(key) + ".native-upgrade-intent")
        owned_file(backup, bootstrap.native_render_unit(old, ENDPOINT, key))
        owned_file(intent, '{"operation_id":"recovery-pending"}')
        calls = []
        try:
            bootstrap.local_uninstall(home, True,
                systemctl=lambda args: calls.append(args),
                process_check=lambda versions: True)
            raise AssertionError("Uninstall destroyed an interrupted native cutover")
        except ValueError as error:
            assert "Unreconciled native upgrade" in str(error)
        assert not calls and old.exists() and new.exists()
        assert backup.exists() and intent.exists()
    finally:
        ctx.cleanup()

    # The published v0.1.56 Node recovery script cannot recognize the
    # new native systemd unit. The verified native Python bootstrap restores
    # the original unit and CLI with the same identity and receipt history.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        old_unit = unit.read_text("utf8")
        unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
        state, mocks, verify = fake_services(home, old, new)
        state["active"] = "new"
        owned_file(Path(str(unit) + ".upgrade-backup"),
                                     old_unit.encode())
        owned_file(Path(str(key) + ".native-upgrade-intent"),
            json.dumps({"operation_id": "a" * 32, "device_id": ID,
                        "target_version": new.name}).encode())
        original_key, original_receipts = key.read_bytes(), receipts.read_bytes()
        with patch.multiple(bootstrap, **mocks):
            result = bootstrap.native_recover(home)
        assert result["status"] == "previous_service_restored"
        assert result["signed_wss"] == "unconfirmed"
        assert state["active"] == "old"
        assert unit.read_text("utf8") == old_unit
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        assert key.read_bytes() == original_key
        assert receipts.read_bytes() == original_receipts
        assert not Path(str(unit) + ".upgrade-backup").exists()
        assert not Path(str(key) + ".native-upgrade-intent").exists()
        assert old.exists() and new.exists()
    finally:
        ctx.cleanup()

    # A forged recovery binding cannot affect either service or ledger.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        old_unit = unit.read_text("utf8")
        unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
        state, mocks, verify = fake_services(home, old, new)
        state["active"] = "new"
        backup = Path(str(unit) + ".upgrade-backup")
        owned_file(backup, old_unit.encode())
        owned_file(Path(str(key) + ".native-upgrade-intent"),
            json.dumps({"operation_id": "b" * 32, "device_id": ID,
                        "target_version": old.name}).encode())
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_recover(home)
                raise AssertionError("Wrong native recovery version accepted")
            except ValueError as error:
                assert "intent" in str(error)
        assert unit.read_text("utf8") != old_unit
        assert backup.exists() and not state["commands"]
    finally:
        ctx.cleanup()

    # A failed service restart after installing the old unit must retain
    # the recovery backup and keep the still-running Rust process frozen.
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        old_unit = unit.read_text("utf8")
        unit.write_text(bootstrap.native_render_unit(new, ENDPOINT, key))
        backup = Path(str(unit) + ".upgrade-backup")
        owned_file(backup, old_unit.encode())
        owned_file(Path(str(key) + ".native-upgrade-intent"),
            json.dumps({"operation_id": "c" * 32, "device_id": ID,
                        "target_version": new.name}).encode())
        state, mocks, verify = fake_services(home, old, new, rollback_failure=True)
        state["active"] = "new"
        with patch.multiple(bootstrap, **mocks):
            try:
                bootstrap.native_recover(home)
                raise AssertionError("Failed recovery restart reported success")
            except ValueError as error:
                assert "uncertain" in str(error)
        assert state["active"] == "new"
        assert "freeze" in state["consents"]
        assert "release" not in state["consents"]
        assert backup.exists()
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
        verify_service_start()
        verify_isolated()
