#!/usr/bin/env python3
"""Local-only Remote Control Agent manager. No cloud credentials or extra daemon."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

APP = Path("apps/remote-control-agent")
UNIT = "remote-control-agent.service"
VERSION = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
ASSET_SHA = re.compile(r"[0-9a-f]{64}\Z")


def local_runtime():
    if os.getuid() == 0:
        raise ValueError("Run under the device's ordinary Linux user, not root.")
    script = Path(__file__).resolve(strict=True)
    root = script.parents[3]
    home = Path.home()
    if not str(root).startswith(str(home / ".local/share/mcp-workers/remote-control/programs") + "/"):
        raise ValueError("Manager must run from a reviewed, versioned Agent installation.")
    manifest = root / "bundle.json"
    if not manifest.is_file() or manifest.is_symlink():
        raise ValueError("Versioned Agent bundle is missing.")
    info = json.loads(manifest.read_text("utf8"))
    if info.get("artifact_profile") != "rust-native-only-v1":
        raise ValueError("Unsupported installed Linux Agent; reinstall native Rust")
    source = script.with_name("bootstrap-v2.py")
    spec = importlib.util.spec_from_file_location("rc_agent_bootstrap", source)
    bootstrap = importlib.util.module_from_spec(spec)
    # This versioned tree must remain byte-for-byte equal to its verified
    # Release archive: Python must not write __pycache__ beside bootstrap.
    sys.dont_write_bytecode = True
    spec.loader.exec_module(bootstrap)
    # This rejects foreign, symlinked and unowned local installation paths.
    bootstrap.local_inventory(str(home))
    bootstrap.validated_owned_version(root)
    return root, info, bootstrap


def installed_endpoint(bootstrap):
    _, _, _, unit, _ = bootstrap.local_inventory(str(Path.home()))
    if not unit:
        return None
    lines = [s.removeprefix("Environment=REMOTE_CONTROL_AGENT_ENDPOINT=") for s in unit.splitlines()
             if s.startswith("Environment=REMOTE_CONTROL_AGENT_ENDPOINT=")]
    if len(lines) != 1:
        raise ValueError("Cannot establish a unique owned Worker endpoint.")
    from urllib.parse import urlsplit
    url = urlsplit(lines[0])
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ("", "/")):
        raise ValueError("Untrusted Worker endpoint in user service.")
    return lines[0]


def status(bootstrap, info):
    state = bootstrap.local_status(str(Path.home()))
    state["cli_version"] = info["version"]
    print(json.dumps(state, ensure_ascii=False, indent=2))
    print("Local service state is NOT proof of signed WSS, cloud approval or Shell rights.")


def logs(bootstrap):
    _, _, _, unit, _ = bootstrap.local_inventory(str(Path.home()))
    if not unit:
        print("No installer-owned v2 user service. Temporary mode has no journal service.")
        return
    if not sys.stdout.isatty():
        raise ValueError("Logs may contain sensitive local details; use a local terminal.")
    print("Showing local systemd logs only. Review/redact before sharing any excerpts.")
    subprocess.run(["journalctl", "--user", "--unit", UNIT, "--no-pager",
                    "--lines", "40", "--output", "short-iso"], check=False)


def pair(root, bootstrap, arguments):
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError("Pairing/repair requires a real local terminal.")
    temporary = bool(arguments) and arguments[0] == "--temporary"
    if temporary:
        arguments = arguments[1:]
    if len(arguments) > 1:
        raise ValueError("Usage: rca pair [--temporary] [https://approved-worker-origin/]")
    endpoint = installed_endpoint(bootstrap)
    if arguments:
        if not arguments[0].startswith("https://") or arguments[0].count("/") > 3:
            raise ValueError("Supply a clean HTTPS endpoint.")
        if endpoint and arguments[0] != endpoint and not temporary:
            raise ValueError("Existing device endpoint cannot be silently changed.")
        endpoint = arguments[0]
    if not endpoint:
        raise ValueError("Supply an approved HTTPS origin: pair https://example.org/")
    if temporary:
        return bootstrap.native_temporary(Path.home(), root, endpoint)
    if input("Type NATIVE-INSTALL for permanent pairing and activation: ").strip() != "NATIVE-INSTALL":
        raise ValueError("Native installation not confirmed")
    print(json.dumps(bootstrap.native_pair_or_install(Path.home(), root, endpoint), indent=2))
    return 0


def bootstrap_action(bootstrap, arguments):
    old = sys.argv
    try:
        sys.argv = ["bootstrap-v2.py", *arguments]
        return bootstrap.main()
    finally:
        sys.argv = old


def upgrade(bootstrap, arguments):
    if not arguments:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            raise ValueError("Upgrade requires local interactive confirmation.")
        endpoint = installed_endpoint(bootstrap)
        if not endpoint:
            raise ValueError("No installer-owned permanent service available to upgrade.")
        return bootstrap.native_upgrade_latest(endpoint)
    if (len(arguments) != 3 or not VERSION.fullmatch(arguments[0])
            or not SHA.fullmatch(arguments[1])
            or not ASSET_SHA.fullmatch(arguments[2])):
        raise ValueError("Usage: rca upgrade <published-tag> <reviewed-40-char-commit> <reviewed-64-char-asset-sha256>")
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError("Upgrade requires local interactive confirmation.")
    endpoint = installed_endpoint(bootstrap)
    if not endpoint:
        raise ValueError("No installer-owned permanent service available to upgrade.")
    print("Only immutable verified GitHub Releases are accepted. Identity and receipts are preserved.")
    return bootstrap_action(bootstrap, ["--tag", arguments[0], "--commit", arguments[1],
                                        "--endpoint", endpoint, "--native-upgrade",
                                        "--asset-sha256", arguments[2]])


def dispatch(command, args, root, info, bootstrap):
    if command in ("--help", "-h", "help"):
        print("Usage: rca [status|pair|logs|stop|start|update|recover|uninstall]")
        print("Permanent pairing / re-pair and pair --temporary are supported.")
        print("Without arguments: open the interactive local Agent manager.")
        print("Check the reviewed stable Latest without installing: rca update --check.")
        print("Automatic update consent: rca update --auto [on|off].")
        print("Update from the reviewed stable Latest: rca update (upgrade is an alias).")
        print("Explicit reviewed upgrade: upgrade <immutable-tag> <reviewed-40-char-commit> <reviewed-64-char-asset-sha256>.")
        return 0
    if command in ("--version", "version"):
        print(info["version"])
        return 0
    if command == "status":
        if args:
            raise ValueError("status takes no arguments")
        status(bootstrap, info)
        return 0
    if command == "logs":
        if args:
            raise ValueError("logs takes no arguments")
        logs(bootstrap)
        return 0
    if command == "pair":
        return pair(root, bootstrap, args)
    if command in ("stop", "start"):
        if args:
            raise ValueError("Stop/Start takes no arguments")
        print(json.dumps(bootstrap.native_owner_lifecycle(Path.home(), command)))
        return 0
    if command in ("update", "upgrade"):
        if args and args[0] == "--auto":
            if len(args) > 2 or (len(args) == 2 and args[1] not in ("on", "off")):
                raise ValueError("Usage: rca update --auto [on|off]")
            print(json.dumps(bootstrap.native_update_policy(Path.home(), args[1] if len(args) == 2 else None)))
            return 0
        if args == ["--check"]:
            endpoint = installed_endpoint(bootstrap)
            if not endpoint:
                raise ValueError("No installer-owned permanent service available to check.")
            result = bootstrap.native_check_latest(endpoint)
            print(json.dumps(result, ensure_ascii=False))
            return 1 if result["status"] == "unknown" else 0
        if args in (["--automatic"], ["--automatic-worker"]):
            return bootstrap.native_unattended_upgrade(root, worker=args == ["--automatic-worker"], automatic=True)
        if args in (["--unattended"], ["--unattended-worker"]):
            return bootstrap.native_unattended_upgrade(root, worker=args == ["--unattended-worker"])
        return upgrade(bootstrap, args)
    if command == "recover":
        if args:
            raise ValueError("recover takes no arguments")
        return bootstrap_action(bootstrap, ["--recover-native"])
    if command == "uninstall":
        if args:
            raise ValueError("uninstall takes no arguments")
        return bootstrap_action(bootstrap, ["--uninstall"])
    raise ValueError("Usage: rca [status|logs|pair|update|uninstall]")


def main():
    root, info, bootstrap = local_runtime()
    if len(sys.argv) > 1:
        return dispatch(sys.argv[1], sys.argv[2:], root, info, bootstrap)
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError("Interactive menu needs a local TTY; use 'status' for scripted checks.")
    while True:
        print("\nRemote Control Agent " + info["version"])
        print("1. Status   2. " + "Pair / repair" + "   3. Logs")
        print("4. Update   5. Uninstall       6. Exit")
        print("7. Recover interrupted installation/upgrade")
        choice = input("Choose an option: ").strip()
        if choice in ("6", "q", "Q"):
            return 0
        mapping = {"1": "status", "2": "pair", "3": "logs", "4": "upgrade",
                   "5": "uninstall"}
        mapping["7"] = "recover"
        if choice not in mapping:
            print("Choose 1–7.")
            continue
        action = mapping[choice]
        if action == "pair" and not installed_endpoint(bootstrap):
            args = [input("Approved HTTPS Worker origin: ").strip()]
        else:
            args = []
        try:
            result = dispatch(action, args, root, info, bootstrap)
            if action == "uninstall" and result == 0:
                return 0
            if result:
                print("Operation was not completed; existing identity was not discarded.")
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            print("Operation refused: " + str(exc), file=sys.stderr)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, json.JSONDecodeError, subprocess.SubprocessError):
        print("Remote Control Agent manager refused unsafe or unavailable local state.", file=sys.stderr)
        sys.exit(1)
