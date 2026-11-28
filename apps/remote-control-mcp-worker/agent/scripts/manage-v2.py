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
USAGE = "Usage: rca [status|doctor|pair|logs|stop|start|restart|update|recover|uninstall|secure-input REQUEST_ID|--version|--help]"
VERSION = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
ASSET_SHA = re.compile(r"[0-9a-f]{64}\Z")


def local_runtime():
    script = Path(__file__).resolve(strict=True)
    root = script.parents[3]
    source = script.with_name("bootstrap-v2.py")
    spec = importlib.util.spec_from_file_location("rc_agent_bootstrap", source)
    bootstrap = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(bootstrap)
    home = bootstrap.account_home()
    if not str(root).startswith(str(home / ".local/share/mcp-workers/remote-control/programs") + "/"):
        raise ValueError("Manager must run from a reviewed, versioned Agent installation.")
    manifest = root / "bundle.json"
    if not manifest.is_file() or manifest.is_symlink():
        raise ValueError("Versioned Agent bundle is missing.")
    info = json.loads(manifest.read_text("utf8"))
    if info.get("artifact_profile") != "rust-native-only-v1":
        raise ValueError("Unsupported installed Linux Agent; reinstall native Rust")
    _, _, _, unit, _ = bootstrap.local_inventory(home)
    if os.geteuid() == 0 and unit and not bootstrap.root_managed_unit(unit):
        raise ValueError("UID 0 manager refuses a service belonging to another OS identity")
    bootstrap.validated_owned_version(root)
    return root, info, bootstrap


def installed_endpoint(bootstrap):
    _, _, _, unit, _ = bootstrap.local_inventory(str(bootstrap.account_home()))
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


def status_facts(bootstrap, info):
    state = bootstrap.local_status(str(bootstrap.account_home()))
    state["cli_version"] = info["version"]
    state["platform"] = "linux"
    state["arch"] = {"linux-x64-glibc": "x64", "linux-arm64-glibc": "arm64"}.get(info["target"])
    state["device_id"] = state["device_ids"].get("permanent")
    state["identity_present"] = state["device_id"] is not None
    return state


def status(bootstrap, info, structured=False):
    state = status_facts(bootstrap, info)
    print(json.dumps(state, ensure_ascii=False, indent=None if structured else 2))
    if not structured:
        print("Local service state is NOT proof of signed WSS, cloud approval or Shell rights.")


def doctor(bootstrap, info, structured=False):
    state = status_facts(bootstrap, info)
    findings = []
    service = state["local_permanent_service"]
    if service == "not_installed":
        findings.append("permanent_service_not_installed")
    elif service != "active":
        findings.append("local_service_unconfirmed")
    if state["cloud_authorization"] == "unconfirmed":
        findings.append("cloud_authorization_unconfirmed")
    if state["signed_wss"] == "unconfirmed":
        findings.append("signed_wss_unconfirmed")
    if state["automatic_update_activity"] in ("unknown", "needs_attention"):
        findings.append("update_state_needs_review")
    print(json.dumps({"status": state, "findings": findings},
                     ensure_ascii=False, indent=None if structured else 2))
    if not structured:
        print("Read-only local diagnosis. No cloud or Latest check was performed.")


def logs(bootstrap):
    _, _, _, unit, ids = bootstrap.local_inventory(str(bootstrap.account_home()))
    if not unit:
        print("No installer-owned v2 user service. Temporary mode has no journal service.")
        return
    if not sys.stdout.isatty():
        raise ValueError("Logs may contain sensitive local details; use a local terminal.")
    print("Showing local systemd logs only. Review/redact before sharing any excerpts.")
    env = bootstrap.root_user_manager_environment() if os.geteuid() == 0 else None
    subprocess.run(["journalctl", "--user", "--unit", UNIT, "--no-pager",
                    "--lines", "40", "--output", "short-iso"], env=env, check=False)
    if "permanent" in ids:
        update_unit = "rca-upgrade-" + ids["permanent"].replace("-", "") + ".service"
        print("Showing the existing detached update worker journal, if present.")
        subprocess.run(["journalctl", "--user", "--unit", update_unit, "--no-pager",
                        "--lines", "40", "--output", "short-iso"], env=env, check=False)


def pair(root, bootstrap, arguments):
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError("Pairing/repair requires a real local terminal.")
    if arguments.count("--allow-root") > 1:
        raise ValueError("Duplicate --allow-root option")
    allow_root = "--allow-root" in arguments
    arguments = [item for item in arguments if item != "--allow-root"]
    temporary = bool(arguments) and arguments[0] == "--temporary"
    if temporary:
        arguments = arguments[1:]
    if len(arguments) > 1:
        raise ValueError("Usage: rca pair [--allow-root] [--temporary] [https://approved-worker-origin/]")
    root_authorized = (bootstrap.root_opt_in(allow_root, temporary=temporary)
                       if os.geteuid() == 0 or allow_root else False)
    endpoint = installed_endpoint(bootstrap)
    if arguments:
        if not arguments[0].startswith("https://") or arguments[0].count("/") > 3:
            raise ValueError("Supply a clean HTTPS endpoint.")
        if endpoint and arguments[0] != endpoint and not temporary:
            raise ValueError("Existing device endpoint cannot be silently changed.")
        endpoint = arguments[0]
    if not endpoint:
        mode = " --temporary" if temporary else ""
        print("No installed Worker origin. Usage: rca pair" + mode +
              " https://approved-worker-origin/", file=sys.stderr)
        return 1
    if temporary:
        return bootstrap.native_temporary(bootstrap.account_home(), root, endpoint,
                                          root_authorized=root_authorized)
    if not bootstrap.confirm_owner("Pair/activate the permanent Agent at " + endpoint + "?"):
        raise ValueError("Native installation not confirmed")
    print(json.dumps(bootstrap.native_pair_or_install(bootstrap.account_home(), root, endpoint,
                                                      root_authorized=root_authorized), indent=2))
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
        if args:
            raise ValueError("help takes no arguments")
        print(USAGE)
        print("Pairing / repair uses the browser authorization link shown by the Agent.")
        print("Usage: rca pair [--allow-root] [--temporary] [https://approved-worker-origin/].")
        print("Without an installed permanent service, provide the approved HTTPS origin explicitly.")
        print("Without arguments: open the interactive local Agent manager.")
        print("Check the reviewed stable Latest without installing: rca update --check.")
        print("Automatic update consent: rca update --auto [on|off].")
        print("status [--json] and doctor [--json] inspect local state without changing it.")
        print("Status reports local update activity/result; Latest refresh uses update --check.")
        print("Update from the reviewed stable Latest: rca update (upgrade is an alias).")
        print("Approved remote update of a running permanent stable Linux Agent: rca update --unattended.")
        print("Detached launch is not upgrade completion; recheck status after reconnect. Candidate promotion needs an attended upgrade.")
        print("Explicit reviewed upgrade: upgrade <immutable-tag> <reviewed-40-char-commit> <reviewed-64-char-asset-sha256>.")
        return 0
    if command in ("--version", "version"):
        if args:
            raise ValueError("version takes no arguments")
        print(info["version"])
        return 0
    if command in ("status", "doctor"):
        if args not in ([], ["--json"]):
            raise ValueError(command + " accepts only --json")
        (status if command == "status" else doctor)(bootstrap, info, structured=bool(args))
        return 0
    if command == "logs":
        if args:
            raise ValueError("logs takes no arguments")
        logs(bootstrap)
        return 0
    if command == "pair":
        return pair(root, bootstrap, args)
    if command == "secure-input":
        if len(args) != 1:
            raise ValueError("Usage: rca secure-input REQUEST_ID")
        # The reviewed Rust entry owns TTY, identity and request validation.
        # Replace this process so the original terminal and signals reach Rust.
        native = root / APP / ".build/rca-standard-linux-candidate"
        os.execv(str(native), [str(native)] + (["--root-managed"] if os.geteuid() == 0 else []) + ["--cli", command, args[0]])
    if command in ("stop", "start", "restart"):
        if args:
            raise ValueError("Lifecycle command takes no arguments")
        print(json.dumps(bootstrap.native_owner_lifecycle(bootstrap.account_home(), command)))
        return 0
    if command in ("update", "upgrade"):
        if args and args[0] == "--auto":
            if len(args) > 2 or (len(args) == 2 and args[1] not in ("on", "off")):
                raise ValueError("Usage: rca update --auto [on|off]")
            print(json.dumps(bootstrap.native_update_policy(bootstrap.account_home(), args[1] if len(args) == 2 else None)))
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
    raise ValueError(USAGE)


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
        print("7. Recover interrupted installation/upgrade   8. Doctor")
        print("9. Start   10. Stop   11. Restart")
        try:
            choice = input("Choose an option: ").strip()
        except EOFError:
            return 0
        if choice in ("6", "q", "Q"):
            return 0
        mapping = {"1": "status", "2": "pair", "3": "logs", "4": "update",
                   "5": "uninstall", "7": "recover", "8": "doctor",
                   "9": "start", "10": "stop", "11": "restart"}
        if choice not in mapping:
            print("Choose 1–11.")
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
    except (EOFError, KeyboardInterrupt):
        print("Local operation cancelled; check status for any already completed effects.", file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, KeyError, json.JSONDecodeError, subprocess.SubprocessError):
        print("Remote Control Agent manager refused unsafe or unavailable local state.", file=sys.stderr)
        sys.exit(1)
