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


def make_version(home, version):
    root = home / ".local/share/mcp-workers/remote-control/programs" / (version + "-linux-x64-glibc")
    root.mkdir(parents=True)
    manifest = {
        "name": "remote-control-agent", "artifact_schema": 1,
        "version": version, "target": "linux-x64-glibc", "device_protocol": 2,
        "receipt_schema": 1, "upgrade_profile": "paired-full-v1",
        "agent_runtime": "rust-standard-linux-v1"
    }
    manifest.update({"artifact_profile": "rust-native-only-v1",
                     "candidate_profile": "standard-linux-rust-runtime-v1",
                     "modules": []})
    owned_file(root / "bundle.json", json.dumps(manifest))
    owned_file(root / APP / ".build/session-supervisor", mode=0o700)
    owned_file(root / APP / "scripts/rca.sh", "#!/bin/sh\nexit 0\n", mode=0o700)
    owned_file(root / APP / ".build/rca-standard-linux-candidate", mode=0o700)
    for script in ("bootstrap-v2.py", "manage-v2.py"):
        owned_file(root / APP / "scripts" / script)
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
    old = make_version(home, "v0.1.56")
    new = make_version(home, "v0.1.57")
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
    ctx, home, previous, old, unit, launcher, key, receipts = fixture()
    new = make_version(home, "v0.1.58")
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
        return root / APP / ".build/rca-standard-linux-candidate"

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


def verify_owner_confirmation():
    with (patch.object(sys.stdin, "isatty", return_value=True),
          patch.object(sys.stdout, "isatty", return_value=True)):
        for answer in ("y", "Y", "yes", " YES "):
            with patch("builtins.input", return_value=answer) as read:
                assert bootstrap.confirm_owner("Confirm test action?")
                assert read.call_args.args[0].endswith("[y/N] ")
        for answer in ("", "n", "No", "maybe", "TEMPORARY", "NATIVE-INSTALL"):
            with patch("builtins.input", return_value=answer):
                assert not bootstrap.confirm_owner("Confirm test action?")
        with patch("builtins.input", side_effect=EOFError):
            assert not bootstrap.confirm_owner("Confirm test action?")
    with (patch.object(sys.stdin, "isatty", return_value=False),
          patch("builtins.input", side_effect=AssertionError("must not read piped input"))):
        assert not bootstrap.confirm_owner("Confirm test action?")
    print("OWNER_CONFIRMATION_CONTRACT_PASS")


def verify_temporary_install():
    ctx, home, old, new, unit, launcher, key, receipts = fixture()
    try:
        snapshot = (key.read_bytes(), unit.read_bytes(), launcher.readlink(), receipts.read_bytes())
        calls = []
        with (patch.object(bootstrap.sys.stdin, "isatty", return_value=True),
              patch.object(bootstrap.sys.stdout, "isatty", return_value=True),
              patch("builtins.input", return_value="y"),
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
            prior = make_version(home, "v0.1.55") if "older" in case else new
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
                    assert bootstrap.native_update_policy(home)["automatic_update"] == "on"
                    assert launcher.readlink() == new / APP / "scripts/rca.sh"
                    assert not intent.exists() and not proof.exists()
                    commands = state["commands"].copy()
                    assert bootstrap.native_first_install(home, new, ENDPOINT, pair=pair,
                        verify=verify)["status"] == "already_installed"
                    assert state["pairs"] == 1 and state["commands"] == commands
                    assert bootstrap.native_update_policy(home)["automatic_update"] == "on"
                else:
                    try:
                        bootstrap.native_first_install(home, new, ENDPOINT, pair=pair,
                            verify=verify, process_check=lambda versions: not state["pid"])
                        raise AssertionError("Unsafe first activation accepted: " + case)
                    except (ValueError, KeyboardInterrupt):
                        pass
                    assert launcher.exists() == preexisting_launcher
                    assert not Path(str(key) + ".automatic-update").exists()
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
    # rollback transaction. A verified prior Rust service remains recoverable.
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
    # not the earlier version still present among managed programs.
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
    # exact same attended recovery command; the oldest installed Rust stays untouched.
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
    # The original Rust process must be recovered instead.
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

    # Missing signed proof rolls back to original Rust process & launcher,
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

    # The native recovery restores the original unit and CLI with the
    # same identity and receipt history.
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



def verify_public_native_archive():
    import hashlib
    import struct
    import tarfile
    from unittest.mock import Mock
    # The verified public archive path does not resolve or fetch a second
    # Release. Real staging/ABI checks run; only owner effects are mocked.
    with tempfile.TemporaryDirectory(prefix="rca-public-native-") as tmp:
        root = Path(tmp)
        source = root / "source"
        source.mkdir(mode=0o700)
        tag = "v0.1.58"
        packed_root = make_version(source, tag)
        manifest = packed_root / "bundle.json"
        meta = json.loads(manifest.read_text())
        meta["glibc_min"] = "2.28"
        manifest.write_text(json.dumps(meta))
        elf = bytearray(80)
        elf[:4] = b"\x7fELF"
        elf[4:6] = b"\x02\x01"
        target = "linux-x64-glibc" if bootstrap.platform.machine() == "x86_64" else "linux-arm64-glibc"
        struct.pack_into("<H", elf, 18, 62 if target == "linux-x64-glibc" else 183)
        meta["target"] = target
        manifest.write_text(json.dumps(meta))
        for name in ("session-supervisor", "rca-standard-linux-candidate"):
            owned_file(packed_root / APP / ".build" / name, bytes(elf), mode=0o700)
        archive = root / "verified.tar.gz"
        with tarfile.open(archive, "w:gz", format=tarfile.USTAR_FORMAT) as tar:
            for child in packed_root.iterdir():
                tar.add(child, arcname=child.name)
        archive.chmod(0o600)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        home = root / "owner"
        home.mkdir(mode=0o700)
        pair = Mock(return_value={"status":"fixture"})
        temporary = Mock(return_value=0)
        with patch.dict(os.environ, {"HOME":str(home)}), patch.object(
                sys.stdin, "isatty", return_value=True), patch.object(
                sys.stdout, "isatty", return_value=True), patch.multiple(
                    bootstrap, resolve_pinned=Mock(side_effect=AssertionError("no second Release lookup")),
                    fetch=Mock(side_effect=AssertionError("no second download")),
                    native_pair_or_install=pair, native_temporary=temporary):
            for invalid_tag, invalid_digest in [(tag,"0"*64), (tag+"-rust-candidate.1",digest)]:
                try:
                    bootstrap.install(invalid_tag, None, ENDPOINT, native_install=True,
                                      asset_sha256=invalid_digest, latest_archive=archive)
                    raise AssertionError("Invalid public archive admitted")
                except ValueError:
                    pass
            assert not pair.called and not temporary.called
            with patch("builtins.input", side_effect=["1","y"]):
                bootstrap.install(tag, None, ENDPOINT, native_install=True,
                                  asset_sha256=digest, latest_archive=archive)
            dest = bootstrap.program_home(home) / (tag+"-"+target)
            assert (dest / APP / ".build/rca-standard-linux-candidate").is_file()
            assert not (dest / "bin/node").exists()
            pair.assert_called_once_with(home, dest, ENDPOINT, None)
            with patch("builtins.input", return_value="2"):
                bootstrap.install(tag, None, ENDPOINT, native_install=True,
                                  asset_sha256=digest, latest_archive=archive)
            temporary.assert_called_once_with(home, dest, ENDPOINT, None)
    for old, new, expected in [
            ("v0.1.56","v0.1.58",True), ("v0.1.58-rust-candidate.5","v0.1.58",True),
            ("v0.1.58","v0.1.58",False), ("v0.1.59","v0.1.58",False),
            ("v0.1.58-rust-candidate.3","v0.1.58-rust-candidate.5",False)]:
        assert bootstrap.public_forward_version(old,new) == expected
    print("PUBLIC_NATIVE_ARCHIVE_CONTRACT_PASS")


def verify_native_owner_lifecycle():
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        marker = Path(str(key) + ".owner-stopped")
        original = key.read_bytes()
        state = {"active": True, "events": [], "cloud_failure": True, "start_failure": False}

        def intent(root, endpoint, action, lock):
            assert root == old and endpoint == ENDPOINT and lock.fileno() >= 0
            assert marker.read_bytes() == b"stopped\n"
            state["events"].append(action)
            if state["cloud_failure"]:
                raise ValueError("Fixture offline")

        def control(*args):
            if args[0] == "show":
                return ("ActiveState=active\nMainPID=100\n" if state["active"]
                        else "ActiveState=inactive\nMainPID=0\n")
            state["events"].append("systemd-" + args[0])
            if args[0] == "stop":
                assert marker.read_bytes() == b"stopped\n"
                state["active"] = False
            elif args[0] == "start":
                assert not marker.exists()
                state["active"] = True
                if state["start_failure"]:
                    raise ValueError("Fixture start uncertain")
            else:
                raise AssertionError(args)
            return ""

        def refused(action):
            try:
                bootstrap.native_owner_lifecycle(home, action)
            except ValueError:
                return
            raise AssertionError("Unsafe owner lifecycle admitted")

        with patch.object(sys.stdin, "isatty", return_value=True), patch.object(
                sys.stdout, "isatty", return_value=True), patch.multiple(
                    bootstrap, native_signed_owner_intent=intent, native_systemctl=control,
                    native_wait_started=lambda entry: 100):
            refused("start")
            assert not state["events"]
            stopped = bootstrap.native_owner_lifecycle(home, "stop")
            assert stopped == {"local": "stopped", "cloud": "unconfirmed"}
            assert state["events"] == ["stop", "systemd-stop"]
            assert not state["active"] and marker.stat().st_mode & 0o777 == 0o600
            refused("start")
            assert marker.read_bytes() == b"stopped\n" and not state["active"]
            state["cloud_failure"] = False
            pending = Path(str(key) + ".native-upgrade-intent")
            owned_file(pending)
            before = list(state["events"])
            refused("start")
            assert state["events"] == before
            pending.unlink()
            state["start_failure"] = True
            refused("start")
            assert state["events"][-4:] == ["stop", "resume", "systemd-start", "systemd-stop"]
            assert marker.read_bytes() == b"stopped\n" and not state["active"]
            state["start_failure"] = False
            started = bootstrap.native_owner_lifecycle(home, "start")
            assert started["cloud"] == "resume_pending_signed_WSS"
            assert state["events"][-3:] == ["stop", "resume", "systemd-start"]
            assert state["active"] and not marker.exists()
            stopped = bootstrap.native_owner_lifecycle(home, "stop")
            assert stopped == {"local": "stopped", "cloud": "confirmed"}
            assert not state["active"] and marker.read_bytes() == b"stopped\n"
            assert bootstrap.native_owner_lifecycle(home, "stop") == stopped
            bootstrap.native_owner_lifecycle(home, "start")
            assert key.read_bytes() == original and b"disposable-receipt-history" in receipts.read_bytes()
        with patch.object(sys.stdin, "isatty", return_value=False):
            refused("stop")
        assert not marker.exists()
    finally:
        ctx.cleanup()
    print("NATIVE_OWNER_LIFECYCLE_CONTRACT_PASS")


def verify_automatic_update_policy():
    import contextlib
    import io
    from unittest.mock import Mock
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        manager_spec = importlib.util.spec_from_file_location("rca_manager", SCRIPT.with_name("manage-v2.py"))
        manager = importlib.util.module_from_spec(manager_spec)
        manager_spec.loader.exec_module(manager)
        info = json.loads((old / "bundle.json").read_text("utf8"))
        def cli(*args):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                result = manager.dispatch("update", list(args), old, info, bootstrap)
            assert result == 0
            return json.loads(out.getvalue())["automatic_update"]
        def refused(*args):
            try:
                cli(*args)
            except ValueError:
                return
            raise AssertionError("Unsafe policy change accepted")
        service = unit.read_bytes()
        identity = key.read_bytes()
        history = receipts.read_bytes()
        with patch.dict(os.environ, {"HOME": str(home)}), patch.object(
                bootstrap, "native_systemctl", Mock(side_effect=AssertionError("Policy changed service"))):
            assert cli("--auto") == "off"
            assert cli("--auto", "on") == "on"
            assert cli("--auto") == "on"
            with patch.object(bootstrap.subprocess, "run", return_value=Mock(returncode=0)), patch.object(
                    bootstrap, "native_update_job_state", return_value="absent"):
                assert bootstrap.local_status(home)["automatic_update"] == "on"
            assert cli("--auto", "off") == "off"
            assert cli("--auto") == "off"
            assert cli("--auto", "on") == "on"
            id_path = Path(str(key) + ".device-id")
            id_path.write_text("123e4567-e89b-42d3-a456-426614174002\n")
            assert cli("--auto") == "off"
            id_path.write_text(ID + "\n")
            pending = Path(str(key) + ".native-upgrade-intent")
            owned_file(pending)
            refused("--auto", "on")
            assert cli("--auto", "off") == "off"
            pending.unlink()
            lock_path = key.parent / "v2-installer.lock"
            with lock_path.open("r+b") as lock:
                bootstrap.fcntl.flock(lock, bootstrap.fcntl.LOCK_EX)
                refused("--auto", "on")
            assert cli("--auto") == "off"
            unit.unlink()
            refused("--auto", "on")
            unit.write_bytes(service)
            candidate = make_version(home, "v0.1.58-rust-candidate.6")
            unit.write_text(bootstrap.native_render_unit(candidate, ENDPOINT, key))
            refused("--auto", "on")
            unit.write_bytes(service)
            policy = Path(str(key) + ".automatic-update")
            policy.write_text("invalid JSON")
            assert cli("--auto") == "unknown"
            assert cli("--auto", "off") == "off"
        assert key.read_bytes() == identity and receipts.read_bytes() == history
        assert unit.read_bytes() == service
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        # Ordinary uninstall retains identity and consent; explicit identity
        # purge removes consent with that identity, never shared receipts.
        bootstrap.local_uninstall(home, True, systemctl=lambda args: None,
                                  process_check=lambda _: True)
        assert policy.exists()
        assert policy in bootstrap.local_identity_purge_plan(home)[0]
        bootstrap.local_identity_purge(home, True, process_check=lambda: True)
        assert not policy.exists() and not key.exists() and receipts.read_bytes() == history
    finally:
        ctx.cleanup()
    print("NATIVE_AUTOMATIC_UPDATE_POLICY_CONTRACT_PASS")


def stable_release_fixture(tag):
    targets = ("linux-x64-glibc", "linux-arm64-glibc", "windows-x64",
               "darwin-arm64", "darwin-x64")
    assets = []
    for target in targets:
        name = "remote-control-agent-" + tag + "-" + target + (
            ".zip" if target == "windows-x64" else ".tar.gz")
        assets.append({"name":name, "state":"uploaded", "size":2048,
                       "digest":"sha256:"+"ab"*32,
                       "browser_download_url":"https://github.com/"+bootstrap.OWNER+
                       "/releases/download/"+tag+"/"+name})
    return {"tag_name":tag, "immutable":True, "draft":False,
            "prerelease":False, "assets":assets}


def verify_read_only_update_check():
    import contextlib
    import io
    from unittest.mock import Mock
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        manager_spec = importlib.util.spec_from_file_location("rca_manager", SCRIPT.with_name("manage-v2.py"))
        manager = importlib.util.module_from_spec(manager_spec)
        manager_spec.loader.exec_module(manager)
        info = json.loads((old / "bundle.json").read_text("utf8"))
        original_unit = unit.read_bytes()
        original_identity = key.read_bytes()
        original_receipts = receipts.read_bytes()
        original_launcher = launcher.readlink()
        original_programs = sorted(p.name for p in old.parent.iterdir())
        metadata = Mock()
        no_download = Mock(side_effect=AssertionError("Check downloaded an archive"))
        no_install = Mock(side_effect=AssertionError("Check attempted installation"))
        with patch.dict(os.environ, {"HOME": str(home)}), patch.multiple(
                bootstrap, json_api=metadata, fetch=no_download, install=no_install), patch.object(
                sys.stdin, "isatty", return_value=False), patch.object(sys.stdout, "isatty", return_value=False):
            for tag, expected in (("v0.1.57", "up_to_date"),
                                  ("v0.1.58", "update_available"),
                                  ("v0.1.56", "older_latest")):
                metadata.reset_mock()
                metadata.return_value = stable_release_fixture(tag)
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    result = manager.dispatch("update", ["--check"], old, info, bootstrap)
                assert result == 0
                actual = json.loads(out.getvalue())
                assert actual == {"installed_version": "v0.1.57", "latest_version": tag, "status": expected}, actual
                metadata.assert_called_once_with("/releases/latest")
            for invalid in ({**stable_release_fixture("v0.1.58"), "immutable": False}, {"assets": []}):
                metadata.return_value = invalid
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    assert manager.dispatch("update", ["--check"], old, info, bootstrap) == 1
                assert json.loads(out.getvalue()) == {"installed_version": "v0.1.57", "latest_version": None, "status": "unknown"}
            metadata.side_effect = OSError("unavailable")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                assert manager.dispatch("update", ["--check"], old, info, bootstrap) == 1
            assert json.loads(out.getvalue()) == {"installed_version": "v0.1.57", "latest_version": None, "status": "unknown"}
        no_download.assert_not_called()
        no_install.assert_not_called()
        assert unit.read_bytes() == original_unit and key.read_bytes() == original_identity
        assert receipts.read_bytes() == original_receipts and launcher.readlink() == original_launcher
        assert sorted(p.name for p in old.parent.iterdir()) == original_programs
        # Historical candidates must retain their actual labels. A version
        # outside the reviewed forward-upgrade scheme is not an older Latest.
        with patch.dict(os.environ, {"HOME": str(home)}), patch.multiple(
                bootstrap, json_api=Mock(return_value=stable_release_fixture("v0.1.58")),
                fetch=no_download, install=no_install):
            for version, expected, code in (("v0.1.58-rust-candidate.6", "update_available", 0),
                                            ("v0.1.57-custom", "unknown", 1)):
                candidate = make_version(home, version)
                unit.write_text(bootstrap.native_render_unit(candidate, ENDPOINT, key))
                candidate_info = json.loads((candidate / "bundle.json").read_text("utf8"))
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    assert manager.dispatch("update", ["--check"], candidate, candidate_info, bootstrap) == code
                assert json.loads(out.getvalue()) == {"installed_version": version,
                    "latest_version": "v0.1.58", "status": expected}
        no_download.assert_not_called()
        no_install.assert_not_called()
    finally:
        ctx.cleanup()
    print("NATIVE_READ_ONLY_UPDATE_CHECK_PASS")


def verify_latest_selection():
    import copy
    from unittest.mock import Mock
    tag = "v0.1.58"
    targets = ("linux-x64-glibc", "linux-arm64-glibc", "windows-x64",
               "darwin-arm64", "darwin-x64")
    release = stable_release_fixture(tag)
    assets = release["assets"]
    lookup = Mock(return_value=release)
    with patch.object(bootstrap, "json_api", lookup):
        chosen = bootstrap.resolve_latest_native(targets[0])
        assert chosen["tag"] == tag and chosen["digest"] == "ab"*32
        lookup.assert_called_once_with("/releases/latest")
    invalid = []
    for name, value in [("immutable",False),("prerelease",True),("draft",True),
                        ("tag_name",tag+"-rust-candidate.1")]:
        invalid.append({**release,name:value})
    invalid.extend([{**release,"assets":assets[:-1]},
                    {**release,"assets":assets+[assets[0]]}])
    wrong = copy.deepcopy(release)
    wrong["assets"][0]["browser_download_url"] = "https://example.invalid/asset"
    invalid.append(wrong)
    bad = copy.deepcopy(release)
    bad["assets"][1]["digest"] = "sha256:bad"
    invalid.append(bad)
    for value in invalid:
        with patch.object(bootstrap, "json_api", return_value=value):
            try:
                bootstrap.resolve_latest_native(targets[0])
            except ValueError:
                continue
            raise AssertionError("Invalid five-platform Latest accepted")
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        import hashlib
        manager_spec = importlib.util.spec_from_file_location("rca_manager", SCRIPT.with_name("manage-v2.py"))
        manager = importlib.util.module_from_spec(manager_spec)
        manager_spec.loader.exec_module(manager)
        with patch.dict(os.environ, {"HOME": str(home)}):
            assert manager.installed_endpoint(bootstrap) == ENDPOINT
        data = b"disposable-verified-archive"
        selected = {"tag":tag, "download":assets[0]["browser_download_url"],
                    "size":len(data), "digest":hashlib.sha256(data).hexdigest()}

        def install_checked(tag, commit, endpoint, **kwargs):
            assert tag == selected["tag"] and commit is None and endpoint == ENDPOINT
            assert kwargs["asset_sha256"] == selected["digest"] and kwargs["native_upgrade"] is True
            assert kwargs["latest_archive"].read_bytes() == data
            assert kwargs["latest_archive"].stat().st_mode & 0o777 == 0o600
            return 0

        # The actual archive staging, confirmation, and cutover are already
        # exercised by verify_public_native_archive/verify_isolated. Here
        # observe the newly restored no-argument command's trust boundary.
        lookup = Mock(return_value=selected)
        download = Mock(return_value=data)
        install = Mock(side_effect=install_checked)
        with patch.dict(os.environ, {"HOME":str(home)}), patch.object(
                sys.stdin, "isatty", return_value=True), patch.object(
                sys.stdout, "isatty", return_value=True), patch.multiple(
                    bootstrap, resolve_latest_native=lookup, fetch=download,
                    preflight=Mock(return_value=targets[0]), install=install):
            assert bootstrap.native_upgrade_latest(ENDPOINT) == 0
            lookup.assert_called_once_with(targets[0])
            download.assert_called_once_with(selected["download"], "application/octet-stream", len(data))
            assert install.call_count == 1
            assert not install.call_args.kwargs["latest_archive"].exists()
            download.reset_mock()
            install.reset_mock()
            lookup.return_value = {**selected,"tag":"v0.1.57"}
            assert bootstrap.native_upgrade_latest(ENDPOINT) == 0
            download.assert_not_called()
            install.assert_not_called()
            lookup.return_value = {**selected,"tag":"v0.1.56"}
            try:
                bootstrap.native_upgrade_latest(ENDPOINT)
            except ValueError:
                pass
            else:
                raise AssertionError("Latest downgrade accepted")
            download.assert_not_called()
            lookup.return_value = {**selected,"digest":"0"*64}
            try:
                bootstrap.native_upgrade_latest(ENDPOINT)
            except ValueError:
                pass
            else:
                raise AssertionError("Bad Latest archive digest accepted")
            install.assert_not_called()
    finally:
        ctx.cleanup()
    print("NATIVE_LATEST_SELECTION_CONTRACT_PASS")


def verify_download_binding():
    import hashlib
    from unittest.mock import Mock
    for change in ("identity", "key", "version", "none"):
        ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
        try:
            data = b"reviewed archive fixture"
            state, mocks, verify = fake_services(home, old, new)
            selected = {"tag": "v0.1.58", "download": "fixture",
                        "size": len(data), "digest": hashlib.sha256(data).hexdigest()}
            def fetch(*args):
                if change == "identity":
                    owned_file(Path(str(key) + ".device-id"), b"123e4567-e89b-42d3-a456-426614174002\n")
                elif change == "key":
                    owned_file(key, b"changed-identity")
                elif change == "version":
                    replacement = old.parent / "v0.1.56-linux-x64-glibc"
                    unit.write_text(bootstrap.native_render_unit(replacement, ENDPOINT, key))
                    launcher.unlink()
                    launcher.symlink_to(replacement / APP / "scripts/rca.sh")
                return data
            def install(*args, **kwargs):
                binding = kwargs.get("expected_binding")
                assert binding is not None, "Download did not preserve its original device binding"
                return bootstrap.native_cutover(home, new, ENDPOINT, verify,
                                                expected_binding=binding)
            with patch.dict(os.environ, {"HOME": str(home)}), patch.object(
                    sys.stdin, "isatty", return_value=True), patch.object(
                    sys.stdout, "isatty", return_value=True), patch.multiple(
                    bootstrap, **mocks, resolve_latest_native=Mock(return_value=selected),
                    fetch=fetch, preflight=Mock(return_value="linux-x64-glibc"), install=install):
                try:
                    result = bootstrap.native_upgrade_latest(ENDPOINT)
                except ValueError:
                    assert change != "none"
                else:
                    assert change == "none" and result["signed_wss"]
            if change != "none":
                assert not state["commands"] and not state["consents"]
                assert not Path(str(key) + ".native-upgrade-intent").exists()
        finally:
            ctx.cleanup()
    print("NATIVE_DOWNLOAD_BINDING_PASS")


def verify_online_socket_peer():
    import socket
    import threading
    with tempfile.TemporaryDirectory() as tmp:
        key = Path(tmp) / "identity.pem"
        endpoint = key.with_name("upgrade.sock")
        received = []
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(endpoint))
            endpoint.chmod(0o600)
            server.listen(2)
            server.settimeout(3)
            def serve():
                for _ in range(2):
                    conn, _ = server.accept()
                    with conn:
                        conn.settimeout(3)
                        request = conn.recv(64)
                        received.append(request)
                        if request:
                            conn.sendall(b"ready\n")
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            rejected = False
            with patch.object(bootstrap, "native_main_pid", return_value=os.getpid()+1):
                try:
                    bootstrap.native_consent(key, "verify-online")
                except ValueError:
                    rejected = True
            with patch.object(bootstrap, "native_main_pid", return_value=os.getpid()):
                assert bootstrap.native_consent(key, "verify-online") == "ready"
            thread.join(4)
            assert not thread.is_alive()
            assert rejected and received == [b"", b"verify-online\n"], received
    print("NATIVE_ONLINE_SOCKET_PEER_PASS")


def verify_unknown_freeze_never_releases_and_preserves_evidence():
    # A reply can be lost after admission. Observation alone cannot prove
    # who acquired Freeze, including when another operation already owns it.
    for observed in ("ready", "busy", "unknown"):
        ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
        try:
            state, mocks, verify = fake_services(home, old, new)
            original = mocks["native_consent"]
            def lost_reply(key, action):
                if action == "freeze":
                    state["consents"].append(action)
                    raise ValueError("Simulated lost freeze response")
                if action == "verify-frozen":
                    state["consents"].append(action)
                    return observed
                return original(key, action)
            with patch.multiple(bootstrap, **{**mocks, "native_consent": lost_reply}):
                try:
                    bootstrap.native_cutover(home, new, ENDPOINT, verify)
                except ValueError:
                    pass
                else:
                    raise AssertionError("Lost freeze response accepted")
            assert state["commands"] == []
            assert state["consents"] == ["freeze"], state["consents"]
            assert Path(str(key) + ".native-upgrade-intent").exists()
            assert launcher.resolve() == old / APP / "scripts/rca.sh"
        finally:
            ctx.cleanup()
    print("NATIVE_UNKNOWN_FREEZE_OWNERSHIP_PASS")


def verify_cutover_rechecks_pending_identity_lifecycle():
    for suffix in (".activation-pending", ".re-pair-transition", ".re-pair-new",
                   ".re-pair-new.device-id"):
        for during_lock in (False, True):
            ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
            try:
                state, mocks, verify = fake_services(home, old, new)
                marker = Path(str(key) + suffix)
                original_lock = bootstrap.fcntl.flock
                def lock(fd, flags):
                    result = original_lock(fd, flags)
                    if during_lock:
                        owned_file(marker, b"unresolved fixture")
                    return result
                if not during_lock:
                    owned_file(marker, b"unresolved fixture")
                with patch.multiple(bootstrap, **mocks), patch.object(bootstrap.fcntl, "flock", side_effect=lock):
                    try:
                        bootstrap.native_cutover(home, new, ENDPOINT, verify)
                    except ValueError as error:
                        assert "Unreconciled" in str(error), str(error)
                    else:
                        raise AssertionError("Pending lifecycle admitted: " + suffix)
                assert state["consents"] == [] and state["commands"] == []
                assert marker.exists()
                assert not Path(str(key) + ".native-upgrade-intent").exists()
            finally:
                ctx.cleanup()
    print("NATIVE_PENDING_IDENTITY_LIFECYCLE_PASS")


def verify_logs_include_existing_update_worker_journal():
    import contextlib
    import importlib.util
    import io
    from unittest.mock import Mock
    manager_spec = importlib.util.spec_from_file_location("rca_logs_manager", SCRIPT.with_name("manage-v2.py"))
    manager = importlib.util.module_from_spec(manager_spec)
    manager_spec.loader.exec_module(manager)
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return Mock(returncode=0)
    class TTYBuffer(io.StringIO):
        def isatty(self):
            return True
    with patch.object(bootstrap, "local_inventory", return_value=(
            Path("/tmp"), [], None, "managed unit", {"permanent": ID})), patch.object(
                manager.subprocess, "run", side_effect=run), patch.object(
                    manager.sys, "stdout", TTYBuffer()):
        manager.logs(bootstrap)
    expected = "rca-upgrade-" + ID.replace("-", "") + ".service"
    assert calls[0][calls[0].index("--unit") + 1] == "remote-control-agent.service"
    assert calls[1][calls[1].index("--unit") + 1] == expected
    print("NATIVE_UPDATE_LOG_JOURNAL_PASS")


def verify_status_reports_upgrade_result_and_identity_purge_removes_it():
    from unittest.mock import Mock
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        policy = Path(str(key) + ".automatic-update")
        result_path = bootstrap.native_upgrade_result_path(key)
        bootstrap.native_write_auto_policy(key, ID, True)
        bootstrap.native_write_upgrade_result(key, ID, "a" * 32, "v0.1.58", "v0.1.56", "failed_recovered")
        absent = Mock(returncode=0, stdout=b"LoadState=not-found\n")
        with patch.object(bootstrap.subprocess, "run", side_effect=[
                Mock(returncode=0), absent]):
            state = bootstrap.local_status(home)
        assert state["automatic_update"] == "on"
        assert state["automatic_update_activity"] == "recovered"
        result = state["automatic_update_result"]
        assert {key: result[key] for key in ("status", "target_version", "installed_version")} == {
            "status": "failed_recovered", "target_version": "v0.1.58",
            "installed_version": "v0.1.56"}
        assert type(result["updated_at_unix_ms"]) is int
        assert 0 <= bootstrap.time.time_ns() // 1_000_000 - result["updated_at_unix_ms"] <= 5_000
        valid_result = json.loads(bootstrap.native_owned_file(result_path, 512))
        for invalid_timestamp in (True, -1, 9_007_199_254_740_992, None):
            corrupted = dict(valid_result)
            if invalid_timestamp is None:
                corrupted.pop("updated_at_unix_ms")
            else:
                corrupted["updated_at_unix_ms"] = invalid_timestamp
            bootstrap.native_atomic_file(result_path, json.dumps(corrupted).encode())
            with patch.object(bootstrap.subprocess, "run", side_effect=[Mock(returncode=0), absent]):
                unknown = bootstrap.local_status(home)
            assert unknown["automatic_update_activity"] == "unknown"
            assert unknown["automatic_update_result"] == {"status": "unknown"}
        bootstrap.native_atomic_file(result_path, json.dumps(valid_result, separators=(",", ":")).encode())
        active = Mock(returncode=0, stdout=(
            b"LoadState=loaded\nActiveState=active\nTransient=yes\n"
            b"Description=RCA detached update\n"))
        with patch.object(bootstrap.subprocess, "run", side_effect=[
                Mock(returncode=0), active]):
            state = bootstrap.local_status(home)
        assert state["automatic_update_activity"] == "upgrading"
        failed = Mock(returncode=0, stdout=(
            b"LoadState=loaded\nActiveState=failed\nTransient=yes\n"
            b"Description=RCA detached update\n"))
        with patch.object(bootstrap.subprocess, "run", side_effect=[
                Mock(returncode=0), failed]):
            state = bootstrap.local_status(home)
        assert state["automatic_update_activity"] == "needs_attention"
        owned_file(Path(str(key) + ".native-upgrade-intent"), b"pending")
        with patch.object(bootstrap.subprocess, "run", side_effect=[
                Mock(returncode=0), absent]):
            state = bootstrap.local_status(home)
        assert state["automatic_update_activity"] == "needs_attention"
        with patch.object(bootstrap.subprocess, "run", side_effect=[
                Mock(returncode=0), Mock(returncode=1, stdout=b""),
                Mock(returncode=1, stdout=b"")]):
            state = bootstrap.local_status(home)
        assert state["automatic_update_activity"] == "unknown"
        Path(str(key) + ".native-upgrade-intent").unlink()
        bootstrap.native_update_policy(home, "off")
        assert bootstrap.native_upgrade_result(key, ID)["status"] == "failed_recovered"
        assert result_path in bootstrap.local_identity_purge_plan(
            (lambda: (bootstrap.local_uninstall(home, True, systemctl=lambda args: None,
                                               process_check=lambda _: True), home)[1])())[0]
        bootstrap.local_identity_purge(home, True, process_check=lambda: True)
        assert not policy.exists() and not result_path.exists()
        assert receipts.read_bytes().find(b"disposable-receipt-history") >= 0
    finally:
        ctx.cleanup()
    print("NATIVE_STATUS_RESULT_AND_PURGE_PASS")


def verify_busy_freeze_does_not_release_another_admission():
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        state, mocks, verify = fake_services(home, old, new)
        intent = Path(str(key) + ".native-upgrade-intent")
        before = (unit.read_bytes(), launcher.readlink(), key.read_bytes(), receipts.read_bytes())
        original = mocks["native_consent"]
        def busy(key, action):
            if action == "freeze":
                state["consents"].append(action)
                return "busy"
            return original(key, action)
        with patch.multiple(bootstrap, **{**mocks, "native_consent": busy}):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
            except ValueError:
                pass
            else:
                raise AssertionError("Busy Agent accepted")
        assert state["consents"] == ["freeze"], state["consents"]
        assert not state["commands"] and not intent.exists()
        assert before == (unit.read_bytes(), launcher.readlink(), key.read_bytes(), receipts.read_bytes())
    finally:
        ctx.cleanup()
    print("NATIVE_BUSY_FREEZE_OWNERSHIP_PASS")


def verify_detached_idle_wait():
    from unittest.mock import Mock
    for eventually_idle in (True, False):
        ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
        try:
            state, mocks, verify = fake_services(home, old, new)
            original = mocks["native_consent"]
            if not eventually_idle:
                bootstrap.native_update_policy(home, "on")
            def consent(key, action):
                if action == "verify-online":
                    return "ready"
                if action == "freeze" and (not eventually_idle or not state["consents"]):
                    state["consents"].append(action)
                    return "busy"
                return original(key, action)
            sleep = Mock()
            clock = (Mock(wraps=bootstrap.time.monotonic) if eventually_idle else Mock(side_effect=[0, 61]))
            with patch.multiple(bootstrap, **{**mocks, "native_consent": consent}), patch.object(
                    bootstrap.time, "monotonic", clock), patch.object(bootstrap.time, "sleep", sleep), patch.object(
                    bootstrap, "native_cutover", wraps=bootstrap.native_cutover) as cutover:
                # Use the existing transaction and only retry known no-effect Busy.
                result = bootstrap.native_cutover_when_idle(
                    home, new, ENDPOINT, verify=verify, automatic=not eventually_idle)
            if eventually_idle:
                assert cutover.call_count == 2 and result["signed_wss"] is True
                assert state["consents"][:2] == ["freeze", "freeze"]
                sleep.assert_called_once()
            else:
                assert cutover.call_count == 1 and result == {
                    "status": "waiting_idle", "installed_version": "v0.1.57",
                    "target_version": "v0.1.58"}
                assert not state["commands"] and state["consents"] == ["freeze"]
                assert not Path(str(key) + ".native-upgrade-intent").exists()
                saved = bootstrap.native_upgrade_result(key, ID)
                assert saved["status"] == "waiting_idle"
                assert saved["target_version"] == "v0.1.58"
                assert saved["installed_version"] == "v0.1.57"
                # A different Latest can be busy without clearing the last
                # recovered target (e.g. a later re-mark of Latest).
                bootstrap.native_write_upgrade_result(key, ID, "b" * 32,
                    "v0.1.59", "v0.1.57", "failed_recovered")
                with patch.multiple(bootstrap, **{**mocks, "native_consent": consent}), patch.object(
                        bootstrap.time, "monotonic", Mock(side_effect=[0, 61])):
                    assert bootstrap.native_cutover_when_idle(
                        home, new, ENDPOINT, verify=verify, automatic=True)["status"] == "waiting_idle"
                assert bootstrap.native_upgrade_result(key, ID)["target_version"] == "v0.1.59"
                assert bootstrap.native_upgrade_result(key, ID)["status"] == "failed_recovered"
                bootstrap.native_write_upgrade_result(key, ID, "c" * 32,
                    "v0.1.58", "v0.1.57", "waiting_idle")
                bootstrap.native_update_policy(home, "off")
                assert bootstrap.native_upgrade_result(key, ID) is None
        finally:
            ctx.cleanup()
    print("NATIVE_DETACHED_IDLE_WAIT_PASS")


def verify_automatic_cutover_admission_and_recovery():
    for case in ("missing-policy", "disabled-at-lock", "offline", "disconnect-before-switch",
                 "recovered", "unknown-recovery", "success"):
        ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
        try:
            state, mocks, verify = fake_services(home, old, new,
                                                proof_good=case not in ("recovered", "unknown-recovery"))
            before = unit.read_bytes()
            history = receipts.read_bytes()
            policy = Path(str(key) + ".automatic-update")
            result_path = Path(str(key) + ".native-upgrade-result")
            intent = Path(str(key) + ".native-upgrade-intent")
            backup = Path(str(unit) + ".upgrade-backup")
            if case != "missing-policy":
                bootstrap.native_update_policy(home, "on")
            original = mocks["native_consent"]
            online_checks = []
            def consent(key, action):
                if action == "verify-online":
                    online_checks.append(action)
                    if case == "offline" or (case == "disconnect-before-switch" and len(online_checks) > 1):
                        return "busy"
                    return "ready"
                return original(key, action)
            def restored_online(key, pid, executable, seconds=30):
                assert pid == 100 and executable == old / APP / ".build/rca-standard-linux-candidate"
                assert state["active"] == "old"
                return case != "unknown-recovery"
            original_flock = bootstrap.fcntl.flock
            def acquire(fd, flags):
                value = original_flock(fd, flags)
                if case == "disabled-at-lock":
                    owned_file(policy, json.dumps({"device_id": ID, "enabled": False}))
                return value
            with patch.multiple(bootstrap, **{**mocks, "native_consent": consent,
                                             "native_wait_online": restored_online}, create=True), patch.object(
                    bootstrap.fcntl, "flock", side_effect=acquire):
                try:
                    response = bootstrap.native_cutover(home, new, ENDPOINT, verify, automatic=True)
                except ValueError:
                    assert case != "success"
                else:
                    assert case == "success" and response["signed_wss"] is True
                if case in ("missing-policy", "disabled-at-lock", "offline", "disconnect-before-switch"):
                    assert state["active"] == "old" and not state["commands"]
                    assert unit.read_bytes() == before and not intent.exists() and not result_path.exists()
                elif case == "unknown-recovery":
                    assert state["active"] == "old" and intent.exists() and backup.exists()
                    assert not result_path.exists()
                elif case == "recovered":
                    assert state["active"] == "old" and unit.read_bytes() == before
                    assert not intent.exists() and not backup.exists()
                    final = json.loads(result_path.read_text())
                    assert final["status"] == "failed_recovered" and final["target_version"] == "v0.1.58"
                    calls = list(state["commands"])
                    try:
                        bootstrap.native_cutover(home, new, ENDPOINT, verify, automatic=True)
                    except ValueError:
                        pass
                    else:
                        raise AssertionError("Recovered failed target retried automatically")
                    assert state["commands"] == calls
                else:
                    final = json.loads(result_path.read_text())
                    assert final["status"] == "success" and final["target_version"] == "v0.1.58"
                    assert state["active"] == "new" and not intent.exists()
                assert receipts.read_bytes() == history
        finally:
            ctx.cleanup()
    print("NATIVE_AUTOMATIC_CUTOVER_ADMISSION_RECOVERY_PASS")


def verify_owner_stop_at_cutover_lock():
    # Reproduce STOP committed by the other owner operation immediately
    # before the upgrade obtains the shared lock. An uncertain systemd stop
    # can leave the old process alive: the durable OFF intent is authoritative.
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        state, mocks, verify = fake_services(home, old, new)
        marker = Path(str(key) + ".owner-stopped")
        before = unit.read_bytes()
        original_flock = bootstrap.fcntl.flock
        def acquire(fd, flags):
            result = original_flock(fd, flags)
            owned_file(marker, b"stopped\n")
            return result
        with patch.multiple(bootstrap, **mocks), patch.object(
                bootstrap.fcntl, "flock", side_effect=acquire):
            try:
                bootstrap.native_cutover(home, new, ENDPOINT, verify)
            except ValueError as error:
                assert "Owner Stop" in str(error), str(error)
            else:
                raise AssertionError("Cutover ignored an Owner STOP committed at lock acquisition")
        assert marker.read_bytes() == b"stopped\n"
        assert state["active"] == "old" and not state["commands"] and not state["consents"]
        assert unit.read_bytes() == before
        assert launcher.readlink() == old / APP / "scripts/rca.sh"
        assert not Path(str(key) + ".native-upgrade-intent").exists()
        assert b"disposable-receipt-history" in receipts.read_bytes()
    finally:
        ctx.cleanup()
    print("NATIVE_OWNER_STOP_LOCK_CONTRACT_PASS")


def verify_automatic_detached_admission():
    import contextlib
    import io
    from unittest.mock import Mock
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        command = Mock(return_value=Mock(returncode=0))
        upgrade = Mock(return_value=0)
        online = Mock(return_value="ready")
        with patch.dict(os.environ, {"HOME": str(home)}), patch.multiple(
                bootstrap, native_main_pid=Mock(return_value=42),
                native_process_executable=Mock(return_value=old / APP / ".build/rca-standard-linux-candidate"),
                native_upgrade_latest=upgrade, native_consent=online), patch.object(
                    bootstrap.subprocess, "run", command):
            assert bootstrap.native_unattended_upgrade(old, automatic=True) == 0
            assert not command.called and not upgrade.called and not online.called
            bootstrap.native_update_policy(home, "on")
            online.return_value = "busy"
            try:
                bootstrap.native_unattended_upgrade(old, automatic=True)
            except ValueError:
                pass
            else:
                raise AssertionError("Offline automatic launch accepted")
            assert not command.called
            online.return_value = "ready"
            assert bootstrap.native_unattended_upgrade(old, automatic=True) == 0
            argv = command.call_args.args[0]
            unit_name = "rca-upgrade-" + ID.replace("-", "")
            assert "--unit=" + unit_name in argv
            assert argv[-2:] == ["update", "--automatic-worker"]
            command.return_value.returncode = 1
            out = io.StringIO()
            with patch.object(bootstrap, "native_systemctl", return_value=
                    "LoadState=loaded\nActiveState=active\nTransient=yes\nDescription=RCA detached update\n"), contextlib.redirect_stdout(out):
                assert bootstrap.native_unattended_upgrade(old, automatic=True) == 0
            assert json.loads(out.getvalue()) == {"status": "existing", "unit": unit_name}
            assert not upgrade.called
            with patch.object(bootstrap, "approved_native_detached_worker", return_value=True):
                assert bootstrap.native_unattended_upgrade(old, worker=True, automatic=True) == 0
            upgrade.assert_called_once_with(ENDPOINT, detached_upgrade=True, expected_root=old, automatic=True)
            bootstrap.native_update_policy(home, "off")
            upgrade.reset_mock()
            with patch.object(bootstrap, "approved_native_detached_worker", return_value=True):
                assert bootstrap.native_unattended_upgrade(old, worker=True, automatic=True) == 0
            assert not upgrade.called
    finally:
        ctx.cleanup()
    print("NATIVE_AUTOMATIC_DETACHED_ADMISSION_PASS")


def verify_native_detached_upgrade():
    import re
    from unittest.mock import Mock
    ctx, home, old, new, unit, launcher, key, receipts = native_pair_fixture()
    try:
        marker = Path(str(key) + ".owner-stopped")
        command = Mock(return_value=type("Result", (), {"returncode": 0})())
        upgrade = Mock(return_value=0)

        def refused(action):
            try:
                action()
            except ValueError:
                return
            raise AssertionError("Unsafe detached native upgrade admitted")

        with patch.dict(os.environ, {"HOME": str(home)}), patch.multiple(
                bootstrap, native_main_pid=Mock(return_value=42),
                native_process_executable=Mock(return_value=old / APP / ".build/rca-standard-linux-candidate"),
                native_upgrade_latest=upgrade), patch.object(bootstrap.subprocess, "run", command):
            with patch.object(bootstrap, "approved_native_detached_worker", return_value=False):
                refused(lambda: bootstrap.native_unattended_upgrade(old, worker=True))
                refused(lambda: bootstrap.install("v0.1.58", None, ENDPOINT,
                        native_upgrade=True, latest_archive=old / "bundle.json",
                        asset_sha256="a"*64, detached_upgrade=True))
            refused(lambda: bootstrap.native_unattended_upgrade(new))
            owned_file(marker, b"stopped\n")
            refused(lambda: bootstrap.native_unattended_upgrade(old))
            marker.unlink()
            pending = Path(str(key) + ".native-upgrade-intent")
            owned_file(pending)
            refused(lambda: bootstrap.native_unattended_upgrade(old))
            pending.unlink()
            assert not command.called and not upgrade.called
            assert bootstrap.native_unattended_upgrade(old) == 0
            argv = command.call_args.args[0]
            assert argv[0] == "/usr/bin/systemd-run"
            assert "--user" in argv and "--no-block" in argv
            assert "--property=RuntimeMaxSec=600" in argv
            assert "--property=NoNewPrivileges=yes" in argv
            assert any(re.fullmatch(r"--unit=rca-upgrade-[a-f0-9]{32}", a) for a in argv)
            assert argv[-6:] == ["/usr/bin/python3", "-I", "-B",
                                str(old / APP / "scripts/manage-v2.py"), "upgrade", "--unattended-worker"]
            assert not upgrade.called
            with patch.object(bootstrap, "approved_native_detached_worker", return_value=True):
                assert bootstrap.native_unattended_upgrade(old, worker=True) == 0
            upgrade.assert_called_once_with(ENDPOINT, detached_upgrade=True, expected_root=old, automatic=False)
            assert command.call_count == 1
            assert not marker.exists() and b"disposable-receipt-history" in receipts.read_bytes()
    finally:
        ctx.cleanup()
    # A caller-supplied env flag and invocation ID are not sufficient.
    with patch.dict(os.environ, {"RCA_UNATTENDED_UPGRADE": "owner-approved-task-v1",
                                 "INVOCATION_ID": "a"*32}):
        with patch.object(bootstrap.pathlib.Path, "read_text", return_value="0::/user.slice/other.service\n"):
            assert not bootstrap.approved_native_detached_worker()
        with patch.object(bootstrap.pathlib.Path, "read_text",
                          return_value="0::/user.slice/rca-upgrade-" + "a"*32 + ".service\n"):
            assert bootstrap.approved_native_detached_worker()
            assert not bootstrap.approved_native_detached_worker(ID)
        with patch.object(bootstrap.pathlib.Path, "read_text",
                          return_value="0::/user.slice/rca-upgrade-" + ID.replace("-", "") + ".service\n"):
            assert bootstrap.approved_native_detached_worker(ID)
    print("NATIVE_DETACHED_UPGRADE_CONTRACT_PASS")


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
        verify_owner_confirmation()
        verify_service_start()
        verify_public_native_archive()
        verify_native_owner_lifecycle()
        verify_automatic_update_policy()
        verify_read_only_update_check()
        verify_latest_selection()
        verify_download_binding()
        verify_online_socket_peer()
        verify_unknown_freeze_never_releases_and_preserves_evidence()
        verify_cutover_rechecks_pending_identity_lifecycle()
        verify_logs_include_existing_update_worker_journal()
        verify_status_reports_upgrade_result_and_identity_purge_removes_it()
        verify_busy_freeze_does_not_release_another_admission()
        verify_detached_idle_wait()
        verify_automatic_cutover_admission_and_recovery()
        verify_owner_stop_at_cutover_lock()
        verify_native_detached_upgrade()
        verify_automatic_detached_admission()
        verify_isolated()
