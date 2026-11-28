#!/usr/bin/env python3
"""Pinned, public-GitHub-only bootstrap for the standalone v2 Agent.

Install or upgrade only a verified immutable native Rust Release.
Python 3 stdlib is the management dependency; no target-host Node, Git,
pnpm or compiler is required.
"""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import pwd
import re
import secrets
import subprocess
import shutil
import ssl
import stat
import struct
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

OWNER = "lirtual/mcp-workers"
API = "https://api.github.com/repos/" + OWNER
APP = "apps/remote-control-agent"
LEGACY_TARGET = "linux-x64-legacy-glibc"
STANDARD_LINUX_TARGETS = ("linux-x64-glibc", "linux-arm64-glibc")
LINUX_TARGETS = STANDARD_LINUX_TARGETS + (LEGACY_TARGET,)
MAX_ARCHIVE = 180 * 1024 * 1024
MAX_UNPACK = 240 * 1024 * 1024
MAX_FILES = 80
META_LIMIT = 1024 * 1024
ALLOWED_HOSTS = frozenset((
    "api.github.com", "github.com",
    "release-assets.githubusercontent.com", "objects.githubusercontent.com"
))
ALLOWED_DIRS = frozenset(("apps", APP, APP + "/scripts", APP + "/.build"))
ELF_FILES = frozenset((APP + "/.build/session-supervisor",
                        APP + "/.build/rca-standard-linux-candidate",
                        APP + "/.build/rca-session-linux-candidate"))
ALLOWED_FILES = ELF_FILES | frozenset((
    "bundle.json", APP + "/scripts/bootstrap-v2.py",
    APP + "/scripts/manage-v2.py", APP + "/scripts/rca.sh",
))
TAG = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
HASH = re.compile(r"sha256:([0-9a-f]{64})\Z")



def root_account_home():
    if os.geteuid() != 0:
        raise ValueError("Root account home is available only to UID 0")
    home = pathlib.Path(pwd.getpwuid(0).pw_dir)
    if not home.is_absolute() or os.environ.get("HOME") != str(home):
        raise ValueError("Root HOME must match the UID 0 OS account; use sudo -H")
    for item in reversed((home, *home.parents)):
        info = item.lstat()
        if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022):
            raise ValueError("Unsafe or writable UID 0 home parent")
        if item == home and stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError("Root HOME must be private to UID 0")
    if (os.environ.get("XDG_RUNTIME_DIR") not in (None, "/run/user/0")
            or os.environ.get("DBUS_SESSION_BUS_ADDRESS") not in
               (None, "unix:path=/run/user/0/bus")):
        raise ValueError("Inherited non-root XDG runtime or DBus session refused")
    return home


def account_home():
    return root_account_home() if os.geteuid() == 0 else pathlib.Path.home()


def root_user_manager_environment():
    home = root_account_home()
    runtime = pathlib.Path("/run/user/0")
    bus = runtime / "bus"
    try:
        for item in (pathlib.Path("/run"), pathlib.Path("/run/user"), runtime):
            info = item.lstat()
            private_mode = stat.S_IMODE(info.st_mode)
            if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                    or info.st_uid != 0 or private_mode & 0o022
                    or (item == runtime and private_mode != 0o700)):
                raise ValueError("Root user-manager runtime directory is not private and UID 0 owned")
        info = bus.lstat()
    except OSError as error:
        raise ValueError("Trusted UID 0 systemd --user runtime is not available") from error
    # systemd may expose the bus socket as 0666. Access is bounded by the
    # UID 0-owned 0700 runtime directory validated above, so socket mode bits
    # alone do not establish that another UID can reach it.
    if not stat.S_ISSOCK(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
        raise ValueError("Root user-manager DBus socket is not UID 0 owned")
    env = dict(os.environ)
    env.update({"HOME": str(home), "XDG_RUNTIME_DIR": str(runtime),
                "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(bus)})
    try:
        linger = subprocess.run(["loginctl", "show-user", "0", "-p", "Linger", "--value"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                env=env, timeout=5, check=False)
        if linger.returncode or linger.stdout.decode("ascii", errors="replace").strip() != "yes":
            raise ValueError("Permanent root service requires existing UID 0 linger; enable it explicitly")
        manager = subprocess.run(["systemctl", "--user", "show-environment"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 env=env, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("Trusted UID 0 systemd --user manager is not available") from error
    if manager.returncode:
        raise ValueError("A trusted UID 0 systemd --user manager is not available")
    return env


def root_managed_unit(unit):
    commands = [line[len("ExecStart="):] for line in (unit or "").splitlines()
                if line.startswith("ExecStart=")]
    return len(commands) == 1 and commands[0].endswith(" --root-managed")


def root_identity_modes(home, ids):
    """Return only existing UID 0 identities whose private key and ID agree."""
    base = pathlib.Path(home) / STORE
    verified = set()
    for mode, relative in (("permanent", "v2-identity.pem"),
                           ("temporary", "temporary/v2-identity.pem")):
        if mode not in ids:
            continue
        key = base / relative
        try:
            native_owned_file(key, 8192)
            device_id = native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip()
        except (OSError, ValueError, UnicodeError):
            raise ValueError("Existing Root device identity is incomplete or untrusted")
        if device_id != ids[mode]:
            raise ValueError("Existing Root device identity does not match its private key metadata")
        verified.add(mode)
    return verified


def root_recovery_preflight(home):
    """Admit the existing Root service or a protected initial-install intent."""
    root_user_manager_environment()
    _, _, _, unit, ids = local_inventory(home)
    if "permanent" not in root_identity_modes(home, ids):
        raise ValueError("Root recovery requires a verified UID 0 permanent identity")
    if root_managed_unit(unit):
        return
    key = pathlib.Path(home) / STORE / "v2-identity.pem"
    intent = pathlib.Path(str(key) + ".native-upgrade-intent")
    if not os.path.lexists(intent):
        raise ValueError("Root recovery requires an existing managed service or initial activation intent")
    record = json.loads(native_owned_file(intent, 512))
    if not isinstance(record, dict) or not isinstance(record.get("initial_endpoint"), str):
        raise ValueError("Root recovery has no protected initial activation intent")
    # native_recover validates the complete transaction proof, service state,
    # executable ownership and rollback before performing any recovery action.


def root_opt_in(allow_root, stage_only=False, temporary=False, upgrade=False):
    if os.geteuid() != 0:
        if allow_root:
            raise ValueError("--allow-root is only valid under effective UID 0")
        return False
    if stage_only:
        raise ValueError("Stage-only verification requires a non-root account")
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError("Root installation requires a real local terminal")
    home = root_account_home()
    if upgrade:
        if allow_root:
            raise ValueError("--allow-root is only for first installation, not upgrades")
        _, _, _, unit, _ = local_inventory(home)
        if not root_managed_unit(unit):
            raise ValueError("Root upgrade requires an existing installer-owned UID 0 service")
        root_user_manager_environment()
        return True
    _, _, _, unit, ids = local_inventory(home)
    identity_modes = root_identity_modes(home, ids)
    if allow_root and (root_managed_unit(unit) or identity_modes):
        raise ValueError("--allow-root is only for the first UID 0 identity; omit it for an existing Root Agent")
    if not allow_root:
        if temporary and identity_modes:
            return True
        if root_managed_unit(unit) or identity_modes:
            # Uninstall intentionally preserves the private identity and its
            # original first-use authorization. Reinstall still performs the
            # ordinary pairing confirmation and signed Owner Grant flow.
            root_user_manager_environment()
            return True
        raise ValueError("Root installation requires --allow-root and local confirmation")
    if not temporary:
        root_user_manager_environment()
    print("WARNING: this Agent runs as UID 0 and its remote Shell/file operations have root privileges.", flush=True)
    if not confirm_owner("Allow the Agent's remote Shell and file operations to run with UID 0 privileges on this device?"):
        raise ValueError("Root installation not confirmed")
    return True

def https_origin(url):
    parsed = urllib.parse.urlsplit(url)
    return (parsed.scheme == "https"
            and parsed.hostname in ALLOWED_HOSTS
            and not parsed.username and not parsed.password
            and not parsed.fragment and parsed.port in (None, 443))


class StrictRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not https_origin(newurl) or getattr(self, "hops", 0) >= 3:
            raise ValueError("Release redirect outside trusted HTTPS hosts or limit")
        self.hops = getattr(self, "hops", 0) + 1
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, accept="application/vnd.github+json", limit=META_LIMIT):
    if not https_origin(url):
        raise ValueError("Untrusted release URL")
    handler = StrictRedirects()
    client = urllib.request.build_opener(handler)
    headers = {
        "Accept": accept, "User-Agent": "mcp-workers-agent-bootstrap",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    req = urllib.request.Request(url, headers=headers)
    with client.open(req, timeout=25) as response:
        if response.status != 200:
            raise ValueError("GitHub metadata or release asset not available")
        if response.headers.get("Content-Length"):
            size = int(response.headers["Content-Length"])
            if size > limit:
                raise ValueError("Release response exceeds byte limit")
        parts = []
        total = 0
        while True:
            block = response.read(min(65536, limit + 1 - total))
            if not block:
                return b"".join(parts)
            total += len(block)
            if total > limit:
                raise ValueError("Release response exceeds byte limit")
            parts.append(block)


def json_api(path):
    return json.loads(fetch(API + path).decode("utf-8"))


def resolve_pinned(tag, commit, target):
    if not TAG.fullmatch(tag) or not SHA.fullmatch(commit) or target not in LINUX_TARGETS:
        raise ValueError("Pinned tag/commit/target missing or invalid")
    if target == LEGACY_TARGET and not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Legacy requires a reviewed numeric version")
    # Keep the bundle's numeric version independent from the immutable GitHub
    # prerelease tag; a Legacy publication must not consume the Standard tag.
    release_tag = tag + "-legacy" if target == LEGACY_TARGET else tag
    if target != LEGACY_TARGET and tag.endswith("-legacy"):
        raise ValueError("Legacy Release cannot supply a Standard target")
    release = json_api("/releases/tags/" + release_tag)
    if (release.get("immutable") is not True
            or (target == LEGACY_TARGET and release.get("prerelease") is not True)
            or release.get("draft") is not False
            or ("-rust-candidate" in tag and release.get("prerelease") is not True)
            or release.get("tag_name") != release_tag
            or not isinstance(release.get("id"), int)):
        raise ValueError("This Release is not published and immutable")
    reference = json_api("/git/ref/tags/" + release_tag)
    if reference.get("ref") != "refs/tags/" + release_tag:
        raise ValueError("Git tag reference mismatch")
    obj = reference["object"]
    if obj.get("type") == "tag":
        if not SHA.fullmatch(str(obj.get("sha", ""))):
            raise ValueError("Invalid annotated Git tag")
        obj = json_api("/git/tags/" + obj["sha"])["object"]
    if obj.get("type") != "commit" or obj.get("sha") != commit:
        raise ValueError("Git Release tag does not match reviewed commit")
    name = "remote-control-agent-" + tag + "-" + target + ".tar.gz"
    assets = [a for a in release.get("assets", []) if a.get("name") == name]
    if len(assets) != 1:
        raise ValueError("Missing or duplicate Release asset")
    asset = assets[0]
    digest = HASH.fullmatch(str(asset.get("digest", "")))
    download = "https://github.com/" + OWNER + "/releases/download/" + release_tag + "/" + name
    if (not digest or asset.get("state") != "uploaded"
            or not isinstance(asset.get("id"), int) or asset["id"] < 1
            or not isinstance(asset.get("size"), int)
            or not 1024 <= asset["size"] <= MAX_ARCHIVE
            or asset.get("url") != API + "/releases/assets/" + str(asset["id"])
            or asset.get("browser_download_url") != download):
        raise ValueError("Release asset digest, ID, URL or length invalid")
    return {"download": download, "size": asset["size"], "digest": digest.group(1)}


def resolve_latest_native(target):
    """One stable five-platform snapshot; select only the installed Linux target."""
    if target not in STANDARD_LINUX_TARGETS:
        raise ValueError("Legacy has no Latest selection; supply a reviewed fixed version")
    release = json_api("/releases/latest")
    if not isinstance(release, dict):
        raise ValueError("Invalid stable Agent Release")
    tag = release.get("tag_name")
    if (not isinstance(tag, str)
            or not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag)
            or release.get("immutable") is not True
            or release.get("draft") is not False
            or release.get("prerelease") is not False
            or release.get("html_url", "https://github.com/" + OWNER + "/releases/tag/" + tag)
            != "https://github.com/" + OWNER + "/releases/tag/" + tag
            or not isinstance(release.get("assets"), list)):
        raise ValueError("Invalid stable Agent Release")
    targets = ("linux-x64-glibc", "linux-arm64-glibc", "windows-x64",
               "darwin-arm64", "darwin-x64")
    expected = {"remote-control-agent-" + tag + "-" + item +
                (".zip" if item == "windows-x64" else ".tar.gz"): item
                for item in targets}
    selected = {}
    for asset in release["assets"]:
        if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
            raise ValueError("Invalid stable Agent asset")
        name = asset["name"]
        platform_target = expected.get(name)
        if platform_target is None:
            if re.fullmatch(r"remote-control-agent-v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?-"
                            r"(?:linux-x64-glibc|linux-arm64-glibc|windows-x64|darwin-arm64|darwin-x64)"
                            r"\.(?:tar\.gz|zip)", name):
                raise ValueError("Unexpected stable Agent platform asset")
            continue
        url = "https://github.com/" + OWNER + "/releases/download/" + tag + "/" + name
        digest = HASH.fullmatch(str(asset.get("digest", "")))
        size = asset.get("size")
        if (platform_target in selected or asset.get("state") != "uploaded"
                or asset.get("browser_download_url") != url
                or type(size) is not int or not 1 <= size <= 180_000_000 or not digest):
            raise ValueError("Invalid or duplicate stable Agent asset")
        selected[platform_target] = {"tag": tag, "download": url, "size": size,
                                     "digest": digest.group(1)}
    if set(selected) != set(targets) or target not in STANDARD_LINUX_TARGETS:
        raise ValueError("Incomplete stable Agent Release")
    return selected[target]


def safe_member(name, directory):
    name = name[:-1] if directory and name.endswith("/") else name
    if (not name or len(name) > 160 or name.startswith("/")
            or "\\" in name or any(part in ("", ".", "..") for part in name.split("/"))
            or not re.fullmatch(r"[A-Za-z0-9._/-]+", name)):
        raise ValueError("Unsafe archive pathname")
    if directory:
        if name not in ALLOWED_DIRS:
            raise ValueError("Unexpected archive directory")
    elif name not in ALLOWED_FILES:
        raise ValueError("Unexpected archive file")
    return name


def native_program_files(manifest, target):
    files = {"bundle.json", APP + "/.build/session-supervisor",
             APP + "/.build/rca-standard-linux-candidate",
             APP + "/scripts/bootstrap-v2.py", APP + "/scripts/manage-v2.py",
             APP + "/scripts/rca.sh"}
    if target == LEGACY_TARGET:
        if (manifest.get("native_supervisor") != "legacy-live-group-v1"
                or manifest.get("glibc_min") != "2.28"
                or manifest.get("session_runtime") != "rust-session-v1"):
            raise ValueError("Unreviewed Legacy runtime profile")
    elif "native_supervisor" in manifest:
        raise ValueError("Unexpected Standard Linux supervisor profile")
    if "session_runtime" in manifest:
        if target not in ("linux-x64-glibc", LEGACY_TARGET) or manifest["session_runtime"] != "rust-session-v1":
            raise ValueError("Unreviewed packaged Session runtime")
        files.add(APP + "/.build/rca-session-linux-candidate")
    return files


def runtime_glibc():
    # Query the running C library, not strings in the Python executable.
    try:
        result = os.confstr("CS_GNU_LIBC_VERSION")
    except (OSError, ValueError):
        return "", ""
    m = re.fullmatch(r"glibc ([0-9]+\.[0-9]+)", result or "")
    return ("glibc", m.group(1)) if m else ("", "")


def inspect_archive(archive, tag, target):
    records = []
    names = set()
    cumulative = 0
    with tarfile.open(archive, "r:gz") as tf:
        for member in tf:
            if len(records) >= MAX_FILES or (not member.isfile() and not member.isdir()):
                raise ValueError("Too many entries or archive link/special file")
            name = safe_member(member.name, member.isdir())
            if name in names or member.pax_headers:
                raise ValueError("Duplicate or extended archive metadata")
            names.add(name)
            if member.isfile():
                cumulative += member.size
                if member.size < 0 or cumulative > MAX_UNPACK:
                    raise ValueError("Oversized uncompressed archive")
            records.append((name, member))
        if "bundle.json" not in names:
            raise ValueError("Incomplete Agent Release archive")
        manifest = json.load(tf.extractfile(tf.getmember("bundle.json")))
        if (manifest.get("artifact_schema") != 1
                or manifest.get("name") != "remote-control-agent"
                or manifest.get("version") != tag or manifest.get("target") != target
                or target not in LINUX_TARGETS
                or manifest.get("artifact_profile") != "rust-native-only-v1"
                or manifest.get("agent_runtime") != "rust-standard-linux-v1"
                or manifest.get("candidate_profile") != "standard-linux-rust-runtime-v1"
                or manifest.get("upgrade_profile") != "paired-full-v1"
                or manifest.get("device_protocol") != 2 or manifest.get("receipt_schema") != 1
                or manifest.get("modules") != [] or "node" in manifest
                or "upgrade_protocol" in manifest):
            raise ValueError("Unreviewed Linux Rust bundle version or runtime profile")
        files = {name for name, member in records if member.isfile()}
        if files != native_program_files(manifest, target):
            raise ValueError("Native-only archive must contain only reviewed Rust files")
        # The official manifest is covered by the GitHub asset SHA-256.
        # Refuse ABI-incompatible binaries before unpacking or executing the native Agent.
        minimum = str(manifest.get("glibc_min", ""))
        if not re.fullmatch(r"[0-9]+\.[0-9]+", minimum):
            raise ValueError("Missing or invalid Release glibc ABI requirement")
        host_libc, host_version = runtime_glibc()
        if (host_libc != "glibc" or not re.fullmatch(r"[0-9]+\.[0-9]+", host_version)
                or tuple(map(int, host_version.split("."))) <
                   tuple(map(int, minimum.split(".")))):
            raise ValueError("Release requires a newer glibc ABI; no execution attempted")
        machine = 62 if target.startswith("linux-x64-") else 183
        for binary in ELF_FILES:
            if binary not in names:
                continue
            b = tf.extractfile(tf.getmember(binary)).read(64)
            if (len(b) < 64 or b[:4] != b"\x7fELF" or b[4:6] != b"\x02\x01"
                    or struct.unpack_from("<H", b, 18)[0] != machine):
                raise ValueError("Prebuilt executable ELF architecture mismatch")
    return records


def private_dir(path):
    path = pathlib.Path(path)
    if path.is_symlink() or (path.exists() and (not path.is_dir()
            or path.stat().st_uid != os.geteuid()
            or stat.S_IMODE(path.stat().st_mode) & 0o077)):
        raise ValueError("Unsafe installer-owned directory or symlink")
    if not path.exists():
        path.mkdir(mode=0o700)
    return path


def program_home(home):
    # Do not follow a symlink from HOME through a privilege-bearing directory.
    home = pathlib.Path(home)
    if not home.is_dir() or home.is_symlink() or home.stat().st_uid != os.geteuid():
        raise ValueError("Invalid device HOME")
    node = home
    for name in (".local", "share"):
        node = node / name
        if node.is_symlink():
            raise ValueError("Symlink in installer parent path")
        if not node.exists():
            node.mkdir(mode=0o700)
        info = node.stat()
        if (not node.is_dir() or info.st_uid != os.geteuid()
                or (os.geteuid() == 0 and stat.S_IMODE(info.st_mode) & 0o022)):
            raise ValueError("Invalid or writable installer parent")
    for name in ("mcp-workers", "remote-control", "programs"):
        node = private_dir(node / name)
    return node


def unpack_verified(archive, destination, records, tag, target):
    if destination.exists() or destination.is_symlink():
        raise ValueError("This version is already installed: review before changing files")
    stage = pathlib.Path(tempfile.mkdtemp(prefix=".unverified-", dir=str(destination.parent)))
    try:
        os.chmod(stage, 0o700)
        with tarfile.open(archive, "r:gz") as tf:
            for name, member in records:
                output = stage / name
                if member.isdir():
                    output.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                try:
                    with os.fdopen(fd, "wb") as stream:
                        reader = tf.extractfile(member)
                        remaining = member.size
                        while remaining:
                            data = reader.read(min(65536, remaining))
                            if not data:
                                raise ValueError("Truncated archive entry")
                            stream.write(data)
                            remaining -= len(data)
                        stream.flush()
                        os.fsync(stream.fileno())
                except Exception:
                    raise
                if name in ELF_FILES or name in (
                        APP + "/scripts/manage-v2.py", APP + "/scripts/rca.sh"):
                    output.chmod(0o700)
        # Under this private parent and exclusive flock, only the current user
        # can create destination; never replace it, even on a repeated run.
        if destination.exists() or destination.is_symlink():
            raise ValueError("Version became installed concurrently")
        stage.rename(destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def verify_existing_program(archive, destination, records):
    """Rerun only if on-disk program matches the SAME officially verified asset.

    Local modification or a foreign file never causes silent replacement.
    All private identity and SQLite state stay outside this program directory.
    """
    root = pathlib.Path(destination)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Existing program is not an owned directory")
    names = {name for name, _ in records}
    actual = {str(p.relative_to(root)) for p in root.rglob("*")}
    if actual != names:
        raise ValueError("Existing program has missing or unexpected files")
    with tarfile.open(archive, "r:gz") as tf:
        for name, member in records:
            item = root / name
            st = item.lstat()
            if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) & 0o077:
                raise ValueError("Existing program has unsafe file permissions")
            if member.isdir():
                if not stat.S_ISDIR(st.st_mode):
                    raise ValueError("Existing program directory was replaced")
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_size != member.size:
                raise ValueError("Existing executable or JS does not match the reviewed Release")
            with open(item, "rb") as installed:
                expected = tf.extractfile(member)
                remaining = member.size
                while remaining:
                    old = installed.read(min(65536, remaining))
                    new = expected.read(len(old))
                    if not old or old != new:
                        raise ValueError("Existing program modified since trusted Release")
                    remaining -= len(old)
    return True


def clean_orphaned_staging(parent):
    """Remove only known owner-private interrupted archives, never identity data."""
    for entry in pathlib.Path(parent).iterdir():
        if not entry.name.startswith((".unverified-", ".download-")):
            continue
        st = entry.lstat()
        if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) & 0o077                 or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
            raise ValueError("Untrusted leftover staging file needs manual review")
        if stat.S_ISDIR(st.st_mode):
            shutil.rmtree(entry)
        else:
            entry.unlink()


def worker_origin(endpoint):
    uri = urllib.parse.urlsplit(endpoint)
    return (uri.scheme == "https" and bool(uri.hostname)
            and not (uri.username or uri.password or uri.query or uri.fragment)
            and uri.path in ("", "/"))


def approved_native_detached_worker(device_id=None):
    # Same admission boundary as the original one-shot Linux manager.
    if (sys.platform != "linux" or os.geteuid() == 0
            or os.environ.get("RCA_UNATTENDED_UPGRADE") != "owner-approved-task-v1"
            or not re.fullmatch(r"[a-f0-9]{32}", os.environ.get("INVOCATION_ID", ""))):
        return False
    try:
        cgroups = pathlib.Path("/proc/self/cgroup").read_text("ascii")
    except (OSError, UnicodeError):
        return False
    match = re.search(r"(?:^|/)rca-upgrade-([a-f0-9]{32})\.service(?:$|/)", cgroups, re.M)
    return bool(match and (device_id is None or match[1] == device_id.replace("-", "")))


def preflight(tag, commit, endpoint, stage_only=False, latest_archive=False,
              detached_upgrade=False, allow_root=False, temporary=False, native_upgrade=False, legacy=False):
    if detached_upgrade and (stage_only or not latest_archive or not approved_native_detached_worker()):
        raise ValueError("Detached native upgrade requires an admitted systemd worker")
    if sys.platform != "linux":
        raise ValueError("Linux only")
    if legacy and (latest_archive or detached_upgrade or temporary or (os.geteuid() != 0 and not stage_only)):
        raise ValueError("Legacy requires a pinned attended Root installation or upgrade")
    root_opt_in(allow_root, stage_only=stage_only, temporary=temporary,
                upgrade=native_upgrade and not detached_upgrade)
    if (not stage_only and not detached_upgrade and
            not (sys.stdin.isatty() and sys.stdout.isatty())):
        raise ValueError("Run in a real interactive terminal")
    cpu = platform.machine().lower()
    if cpu not in ("x86_64", "aarch64"):
        raise ValueError("Only Linux x86_64 and ARM64 are supported")
    kernel = re.match(r"^([0-9]+)\.([0-9]+)", platform.release())
    if legacy and (cpu != "x86_64" or not kernel or (int(kernel[1]), int(kernel[2])) < (4, 18)):
        raise ValueError("Legacy requires Linux x86_64 kernel 4.18+")
    if not legacy and (not kernel or (int(kernel[1]), int(kernel[2])) < (6, 9)):
        raise ValueError("Linux kernel 6.9+ is needed for pidfd group safety")
    libc, ver = runtime_glibc()
    if libc != "glibc" or not re.match(r"^\d+\.\d+$", ver) \
            or tuple(map(int, ver.split("."))) < (2, 28):
        raise ValueError("glibc 2.28+ required; musl is unsupported")
    if not worker_origin(endpoint):
        raise ValueError("Supply the reviewed HTTPS Worker origin, without credentials")
    if latest_archive:
        if commit is not None or not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
            raise ValueError("Public archive requires the stable Release tag, not a source pin")
    elif not TAG.fullmatch(tag) or not SHA.fullmatch(commit):
        raise ValueError("Pinned Release tag and commit are required")
    return LEGACY_TARGET if legacy else "linux-" + ("x64" if cpu == "x86_64" else "arm64") + "-glibc"


def native_latest_status(installed, target):
    """Classify a reviewed forward update without normalizing away its label."""
    stable = r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    old = re.fullmatch(stable + r"(?:-rust-candidate\.[1-9][0-9]*)?", installed)
    new = re.fullmatch(stable, target)
    if not old or not new:
        return "unknown"
    old_number, new_number = tuple(map(int, old.groups())), tuple(map(int, new.groups()))
    if installed == target:
        return "up_to_date"
    return "update_available" if new_number >= old_number else "older_latest"


def public_forward_version(installed, target):
    return native_latest_status(installed, target) == "update_available"


def native_latest_context(endpoint, expected_root=None):
    """Validate the same installed service for read-only checks and upgrades."""
    home = account_home()
    _, versions, _, unit, ids = local_inventory(home)
    root = owned_unit_root(unit, versions)
    if root is None or "permanent" not in ids or (expected_root is not None and root != expected_root):
        raise ValueError("No matching existing paired managed Linux Agent")
    validated_owned_version(root)
    info = json.loads((root / "bundle.json").read_text("utf8"))
    if info.get("artifact_profile") != "rust-native-only-v1":
        raise ValueError("Latest native upgrade requires the installed native-only manager")
    if unit != native_render_unit(root, endpoint, home / STORE / "v2-identity.pem"):
        raise ValueError("Untrusted installed Worker origin")
    key = home / STORE / "v2-identity.pem"
    device_id = native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip()
    if device_id != ids["permanent"]:
        raise ValueError("Existing device identity has changed")
    binding = (root, device_id, hashlib.sha256(native_owned_file(key, 8192)).hexdigest())
    return info, binding


def confirm_owner(question):
    """One attended confirmation; absent/closed input never authorizes an effect."""
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return False
    try:
        return input(question + " [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


def native_check_latest(endpoint):
    """Observe metadata only; never stage, lock or switch an installation."""
    info, _ = native_latest_context(endpoint)
    installed = info["version"]
    try:
        selected = resolve_latest_native(info["target"])
    except (ValueError, OSError):
        return {"installed_version": installed, "latest_version": None, "status": "unknown"}
    latest = selected["tag"]
    return {"installed_version": installed, "latest_version": latest,
            "status": native_latest_status(installed, latest)}


def native_upgrade_latest(endpoint, *, detached_upgrade=False, expected_root=None, automatic=False):
    if automatic and not detached_upgrade:
        raise ValueError("Automatic update requires an admitted detached worker")
    if detached_upgrade:
        if not approved_native_detached_worker() or expected_root is None:
            raise ValueError("Detached native upgrade requires an admitted systemd worker")
    elif not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError("Upgrade requires local interactive confirmation")
    info, binding = native_latest_context(endpoint, expected_root)
    if detached_upgrade and not approved_native_detached_worker(binding[1]):
        raise ValueError("Detached worker belongs to a different device")
    if automatic:
        key = account_home() / STORE / "v2-identity.pem"
        device_id = binding[1]
        if native_auto_policy(key, device_id) != "on":
            return 0
    selected = resolve_latest_native(info["target"])
    tag = selected["tag"]
    status = native_latest_status(info["version"], tag)
    if status == "up_to_date":
        print("Already up to date with the reviewed Release (" + tag + ").")
        return 0
    if status != "update_available":
        raise ValueError("Silent downgrade or same-version replacement refused")
    if automatic:
        native_require_automatic_update(key, device_id, info["version"], tag)
    if preflight(tag, None, endpoint, latest_archive=True,
                 detached_upgrade=detached_upgrade) != info["target"]:
        raise ValueError("Installed Agent target does not match host")
    data = fetch(selected["download"], "application/octet-stream", selected["size"])
    if len(data) != selected["size"] or hashlib.sha256(data).hexdigest() != selected["digest"]:
        raise ValueError("Official GitHub asset length or SHA-256 mismatch")
    # Use the existing verified local archive and signed cutover path. No
    # second Latest lookup, no executable metadata, and no persistent pin.
    with tempfile.TemporaryDirectory(prefix="rca-latest-") as directory:
        archive = pathlib.Path(directory) / "agent.tar.gz"
        fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        return install(tag, None, endpoint, asset_sha256=selected["digest"],
                       native_upgrade=True, latest_archive=archive,
                       detached_upgrade=detached_upgrade, automatic=automatic,
                       expected_binding=binding)


def native_unattended_upgrade(root, *, worker=False, automatic=False):
    """Explicit owner-approved remote command; never pair or resume a stopped Agent."""
    if sys.platform != "linux" or os.geteuid() == 0 or (worker and not approved_native_detached_worker()):
        raise ValueError("Detached upgrade requires the reviewed owner systemd context")
    home = account_home()
    _, versions, unit_file, unit, ids = local_inventory(home)
    current = owned_unit_root(unit, versions)
    if current is None or current != root or "permanent" not in ids:
        raise ValueError("Detached upgrade requires the currently installed paired Agent")
    validated_owned_version(current)
    info = json.loads((current / "bundle.json").read_text("utf8"))
    if (info.get("artifact_profile") != "rust-native-only-v1"
            or not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", info["version"])):
        raise ValueError("Detached upgrade requires a stable native Agent; use attended upgrade")
    key = home / STORE / "v2-identity.pem"
    native_owned_file(key, 8192)
    if native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != ids["permanent"]:
        raise ValueError("Existing device identity has changed")
    pending = (*native_pending_lifecycle(key, unit_file),
               pathlib.Path(str(key) + ".owner-stopped"))
    if any(os.path.lexists(path) for path in pending):
        raise ValueError("Owner STOP or unreconciled lifecycle blocks detached upgrade")
    endpoint = next(line[len("Environment=REMOTE_CONTROL_AGENT_ENDPOINT="):]
                    for line in unit.splitlines()
                    if line.startswith("Environment=REMOTE_CONTROL_AGENT_ENDPOINT="))
    if native_process_executable(native_main_pid()) != current / APP / ".build/rca-standard-linux-candidate":
        raise ValueError("Detached upgrade requires the running owned Agent")
    if automatic:
        if native_auto_policy(key, ids["permanent"]) != "on":
            return 0
        if native_consent(key, "verify-online") != "ready":
            raise ValueError("Automatic update requires a current signed Agent connection")
    if worker:
        return native_upgrade_latest(endpoint, detached_upgrade=True, expected_root=current,
                                     automatic=automatic)
    # One transient unit per identity, shared by automatic and explicit
    # remote updates. systemd atomically refuses duplicate starts.
    unit_name = "rca-upgrade-" + ids["permanent"].replace("-", "")
    try:
        result = subprocess.run([
            "/usr/bin/systemd-run", "--user", "--no-block", "--collect", "--quiet",
            "--service-type=exec", "--unit=" + unit_name, "--description=RCA detached update",
            "--property=RuntimeMaxSec=600",
            "--property=UMask=0077", "--property=NoNewPrivileges=yes",
            "--setenv=RCA_UNATTENDED_UPGRADE=owner-approved-task-v1",
            "--", "/usr/bin/python3", "-I", "-B", str(current / APP / "scripts/manage-v2.py"),
            * (["update", "--automatic-worker"] if automatic else ["upgrade", "--unattended-worker"])
        ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
           timeout=15, check=False)
        if result.returncode:
            raise ValueError("systemd launch unconfirmed")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        try:
            observed = native_systemctl("show", unit_name + ".service", "-p", "LoadState",
                                        "-p", "ActiveState", "-p", "Transient", "-p", "Description")
            state = dict(line.split("=", 1) for line in observed.splitlines() if "=" in line)
            if (state.get("LoadState") == "loaded" and state.get("Transient") == "yes"
                    and state.get("Description") == "RCA detached update"
                    and state.get("ActiveState") in ("activating", "active", "deactivating", "reloading")):
                print(json.dumps({"status": "existing", "unit": unit_name}))
                return 0
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        print(json.dumps({"status": "launch_unconfirmed", "unit": unit_name}))
        raise ValueError("Detached upgrade launch unconfirmed; inspect the unit before retry") from error
    print(json.dumps({"status": "launched", "unit": unit_name,
                      "verification": "signed WSS and unchanged identity required"}))
    return 0


def install(tag, commit, endpoint, name=None, upgrade=False,
            stage_only=False, asset_sha256=None, native_upgrade=False, native_install=False, temporary=False,
            latest_archive=None, detached_upgrade=False, automatic=False, expected_binding=None,
            allow_root=False, legacy=False):
    if automatic and not detached_upgrade:
        raise ValueError("Automatic update requires an admitted detached worker")
    if detached_upgrade and (not native_upgrade or native_install or stage_only
                             or latest_archive is None or not approved_native_detached_worker()):
        raise ValueError("Detached native upgrade requires the reviewed stable worker")
    if temporary and not native_install:
        raise ValueError("Temporary mode requires --native-install")
    if sum(bool(action) for action in (stage_only, native_upgrade, native_install)) != 1:
        raise ValueError("Linux requires exactly one native staging, install or upgrade action")
    if ((name is not None and not native_install) or upgrade or
            not isinstance(asset_sha256, str) or
            not re.fullmatch(r"[0-9a-f]{64}", asset_sha256)):
        scope = "Stage-only" if stage_only else "Native install" if native_install else "Native upgrade"
        raise ValueError(scope + " requires a reviewed SHA-256 and no legacy install action")
    if latest_archive is not None and (stage_only or not (native_upgrade or native_install)):
        raise ValueError("Public archive requires an attended native install or upgrade")
    target = preflight(tag, commit, endpoint, stage_only=stage_only,
                       latest_archive=latest_archive is not None, detached_upgrade=detached_upgrade,
                       allow_root=allow_root, temporary=temporary, native_upgrade=native_upgrade, legacy=legacy)
    # The owned service template uses a canonical origin with a trailing slash.
    if not endpoint.endswith("/"):
        endpoint += "/"
    if native_upgrade and expected_binding is None:
        current_info, expected_binding = native_latest_context(endpoint)
        if current_info["target"] != target:
            raise ValueError("Cross-target upgrade refused")
        if legacy and not public_forward_version(current_info["version"], tag):
            raise ValueError("Legacy upgrade requires a later reviewed version")
    print("==> Detected Linux target: " + target + " | Release " + tag, flush=True)
    location = program_home(account_home())
    version = location / (tag + "-" + target)
    # Existing lock + protected OS state: no new installer state database.
    with open(location / "install.lock", "a+b") as lock:
        os.chmod(location / "install.lock", 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another v2 standalone installer is already running")
        clean_orphaned_staging(location)
        pinned = None
        if latest_archive is None:
            print("==> Resolving immutable GitHub Release and exact source commit", flush=True)
            pinned = resolve_pinned(tag, commit, target)
            if (stage_only or native_upgrade or native_install) and pinned["digest"] != asset_sha256:
                raise ValueError("Reviewed SHA-256 differs from immutable GitHub Release metadata")
        archive_path = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".download-", dir=location, delete=False) as f:
                archive_path = pathlib.Path(f.name)
                os.chmod(archive_path, 0o600)
                if latest_archive is not None:
                    # Public shell has verified the immutable manifest's asset.
                    # Copy the checked bytes once into the private installer lock
                    # domain and reverify before any extraction or activation.
                    data = native_owned_file(latest_archive, MAX_ARCHIVE)
                    digest = asset_sha256
                else:
                    print("==> Downloading verified native Agent package", flush=True)
                    data = fetch(pinned["download"], "application/octet-stream", MAX_ARCHIVE)
                    if len(data) != pinned["size"]:
                        raise ValueError("Official GitHub byte length mismatch")
                    digest = pinned["digest"]
                if hashlib.sha256(data).hexdigest() != digest:
                    raise ValueError("Official GitHub SHA-256 mismatch")
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            print("==> SHA-256 verified; inspecting archive and system ABI", flush=True)
            records = inspect_archive(archive_path, tag, target)
            if version.exists() or version.is_symlink():
                verify_existing_program(archive_path, version, records)
            else:
                unpack_verified(archive_path, version, records, tag, target)
        finally:
            if archive_path is not None:
                try:
                    archive_path.unlink()
                except FileNotFoundError:
                    pass
        print("==> Verified runtime staged: " + str(version), flush=True)
        if stage_only:
            # No systemctl, identity mutation, approval or pairing.
            return
        if native_install:
            if temporary:
                return native_temporary(account_home(), version, endpoint, name,
                                        root_authorized=os.geteuid() == 0)
            if not confirm_owner("Pair/activate the permanent Agent at " + endpoint + "?"):
                raise ValueError("Native installation not confirmed")
            result = native_pair_or_install(account_home(), version, endpoint, name,
                                             root_authorized=os.geteuid() == 0)
            print(json.dumps(result, indent=2))
            if result.get("status") in ("active", "already_installed"):
                print('Local manager: rca --help; if not on PATH, run "$HOME/.local/bin/rca" --help.',
                      file=sys.stderr, flush=True)
            return
        if native_upgrade:
            if latest_archive is not None:
                _, versions, _, current, _ = local_inventory(account_home())
                old_root = owned_unit_root(current, versions) if current else None
                if old_root is None:
                    raise ValueError("No existing paired managed Linux Agent")
                installed = json.loads((old_root / "bundle.json").read_text("utf8"))["version"]
                if not public_forward_version(installed, tag):
                    raise ValueError("Silent downgrade or same-version replacement refused")
                if detached_upgrade and not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", installed):
                    raise ValueError("Detached upgrade refused for this package; use attended upgrade")
            print("Signed WSS must be proven after switch; identity and SQLite remain unchanged.")
            if detached_upgrade:
                if not approved_native_detached_worker(expected_binding[1]):
                    raise ValueError("Detached worker admission lost")
            elif not confirm_owner("Switch the local Agent to " + tag + "?"):
                raise ValueError("Native service switch not confirmed")
            if detached_upgrade:
                result = native_cutover_when_idle(account_home(), version, endpoint,
                                                 automatic=automatic, expected_binding=expected_binding)
            else:
                result = native_cutover(account_home(), version, endpoint,
                                        expected_binding=expected_binding)
            print(json.dumps(result, indent=2))
            return


def native_render_unit(root, endpoint, key, root_managed=None):
    if not all(re.fullmatch(r"/[A-Za-z0-9_./-]+", str(p)) for p in (root, key)):
        raise ValueError("Unsupported systemd path character")
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?/", endpoint):
        raise ValueError("Untrusted canonical service endpoint")
    manifest = json.loads((root / "bundle.json").read_text("utf8"))
    if manifest.get("artifact_profile") != "rust-native-only-v1":
        raise ValueError("Only a native Rust installation is supported")
    if root_managed is None:
        root_managed = os.geteuid() == 0
    program = root / APP / ".build/rca-standard-linux-candidate"
    lines = [MARKER, "[Unit]", "Description=Remote Control Agent (signed outbound WSS)",
             "StartLimitIntervalSec=0", "", "[Service]", "Type=simple",
             "WorkingDirectory=" + str(root / APP)]
    if root_managed:
        lines.extend(("Environment=HOME=" + str(account_home()),
                      "Environment=XDG_RUNTIME_DIR=/run/user/0",
                      "Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus"))
    lines.extend(("Environment=REMOTE_CONTROL_AGENT_ENDPOINT=" + endpoint,
                  "Environment=REMOTE_CONTROL_AGENT_KEY_PATH=" + str(key), "UMask=0077",
                  "ExecStartPre=/usr/bin/test -r " + str(key),
                  "ExecStartPre=/usr/bin/test -r " + str(key) + ".device-id",
                  "ExecStartPre=/usr/bin/test -x " + str(root / APP / ".build/session-supervisor"),
                  "ExecStart=" + str(program) + (" --root-managed" if root_managed else ""),
                  "Restart=on-failure", "RestartSec=15s", "TimeoutStopSec=15s",
                  "", "[Install]", "WantedBy=default.target", ""))
    return "\n".join(lines)


def native_owned_file(path, max_bytes=4096):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or info.st_mode & 0o777 != 0o600
                or not 0 < info.st_size <= max_bytes):
            raise ValueError("Unsafe owner-local upgrade evidence")
        content = stream.read(max_bytes + 1)
        if len(content) != info.st_size:
            raise ValueError("Owner-local upgrade evidence changed during read")
        return content


def native_sync_parent(path):
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def native_atomic_file(path, data):
    fd, temporary = tempfile.mkstemp(prefix=".rca-upgrade-", dir=path.parent)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        native_sync_parent(path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def native_auto_policy_path(key):
    return pathlib.Path(str(key) + ".automatic-update")


def native_auto_policy(key, device_id):
    """Absent, invalid or different-identity consent never authorizes updates."""
    try:
        value = json.loads(native_owned_file(native_auto_policy_path(key), 256))
    except FileNotFoundError:
        return "off"
    except (OSError, ValueError):
        return "unknown"
    if (not isinstance(value, dict) or set(value) != {"device_id", "enabled"}
            or type(value["enabled"]) is not bool or not isinstance(value["device_id"], str)):
        return "unknown"
    return "on" if value["device_id"] == device_id and value["enabled"] else "off"


def native_write_auto_policy(key, device_id, enabled):
    native_atomic_file(native_auto_policy_path(key), json.dumps({
        "device_id": device_id, "enabled": enabled
    }, separators=(",", ":")).encode())


def native_upgrade_result_path(key):
    return pathlib.Path(str(key) + ".native-upgrade-result")


def native_upgrade_result(key, device_id):
    try:
        result = json.loads(native_owned_file(native_upgrade_result_path(key), 512))
    except FileNotFoundError:
        return None
    if (not isinstance(result, dict) or set(result) != {
            "device_id", "operation_id", "target_version", "installed_version", "status",
            "updated_at_unix_ms"}
            or not isinstance(result["device_id"], str)
            or not isinstance(result["operation_id"], str)
            or not re.fullmatch(r"[a-f0-9]{32}", result["operation_id"])
            or type(result["updated_at_unix_ms"]) is not int
            or not 0 <= result["updated_at_unix_ms"] <= 9_007_199_254_740_991
            or not all(isinstance(result[field], str) and
                       native_latest_status(result[field], result[field]) == "up_to_date"
                       for field in ("target_version", "installed_version"))
            or result["status"] not in ("success", "failed_recovered", "waiting_idle")
            or (result["status"] == "success"
                and result["installed_version"] != result["target_version"])
            or (result["status"] in ("failed_recovered", "waiting_idle")
                and result["installed_version"] == result["target_version"])):
        raise ValueError("Unrecognized final upgrade evidence")
    return result if result["device_id"] == device_id else None


def native_update_job_state(device_id):
    unit = "rca-upgrade-" + device_id.replace("-", "") + ".service"
    try:
        env = root_user_manager_environment() if os.geteuid() == 0 else None
        observed = subprocess.run([
            "systemctl", "--user", "show", unit, "-p", "LoadState",
            "-p", "ActiveState", "-p", "Transient", "-p", "Description"
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=5, check=False)
        if observed.returncode:
            listed = subprocess.run([
                "systemctl", "--user", "list-units", "--all", "--no-legend",
                "--plain", "--no-pager", unit
            ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=5, check=False)
            if listed.returncode or listed.stdout.strip():
                return "unknown"
            return "absent"
        if not isinstance(observed.stdout, bytes):
            return "unknown"
        state = dict(line.split("=", 1) for line in
                     observed.stdout.decode("ascii", errors="strict").splitlines() if "=" in line)
        if not state.get("LoadState"):
            listed = subprocess.run([
                "systemctl", "--user", "list-units", "--all", "--no-legend",
                "--plain", "--no-pager", unit
            ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=5, check=False)
            if listed.returncode or not isinstance(listed.stdout, bytes):
                return "unknown"
            return "absent" if not listed.stdout.strip() else "unknown"
    except (OSError, UnicodeError, subprocess.SubprocessError):
        return "unknown"
    if state.get("LoadState") == "not-found":
        return "absent"
    if (state.get("LoadState") != "loaded" or state.get("Transient") != "yes"
            or state.get("Description") != "RCA detached update"):
        return "unknown"
    if state.get("ActiveState") in ("activating", "active", "deactivating", "reloading"):
        return "upgrading"
    if state.get("ActiveState") == "failed":
        return "needs_attention"
    if state.get("ActiveState") == "inactive":
        return "absent"
    return "unknown"


def native_pending_lifecycle(key, unit_file):
    """One set of unresolved records for update admission and diagnosis."""
    return (pathlib.Path(str(unit_file) + ".upgrade-backup"), *(
        pathlib.Path(str(key) + suffix) for suffix in (
            ".native-upgrade-intent", ".native-upgrade-proof",
            ".activation-pending", ".re-pair-transition",
            ".re-pair-new", ".re-pair-new.device-id")))


def native_update_activity(home, key, device_id, policy, result, installed_version):
    job = native_update_job_state(device_id)
    if job in ("upgrading", "needs_attention", "unknown"):
        return job
    pending = native_pending_lifecycle(
        key, pathlib.Path(home) / ".config/systemd/user" / UNIT)
    if any(os.path.lexists(path) for path in pending):
        return "needs_attention"
    if policy == "unknown":
        return "unknown"
    if installed_version is None:
        return "disabled" if policy == "off" else "unknown"
    if result and result["installed_version"] == installed_version:
        if result["status"] == "waiting_idle" and policy == "off":
            return "disabled"
        return {"success": "success", "failed_recovered": "recovered",
                "waiting_idle": "waiting_idle"}.get(result["status"], "unknown")
    return "disabled" if policy == "off" else "idle"


def native_write_upgrade_result(key, device_id, operation, target, installed, status):
    native_atomic_file(native_upgrade_result_path(key), json.dumps({
        "device_id": device_id, "operation_id": operation, "target_version": target,
        "installed_version": installed, "status": status,
        "updated_at_unix_ms": (time.time_ns() // 1_000_000 if hasattr(time, "time_ns") else int(time.time() * 1000)),
    }, separators=(",", ":")).encode())


def native_require_automatic_update(key, device_id, installed, target):
    if native_auto_policy(key, device_id) != "on":
        raise ValueError("Automatic update policy is not enabled")
    if (native_latest_status(installed, installed) != "up_to_date"
            or native_latest_status(installed, target) != "update_available"):
        raise ValueError("Automatic update requires a later stable version")
    result = native_upgrade_result(key, device_id)
    if result and result["status"] == "failed_recovered" and result["target_version"] == target:
        raise ValueError("Previously recovered failed version suppressed for automatic update")


def native_update_policy(home, action=None):
    """Read or explicitly change continuing consent, not the device Grant."""
    if action not in (None, "on", "off") or (os.geteuid() == 0 and action == "on"):
        raise ValueError("Root automatic updates are disabled; use an attended upgrade")
    home = pathlib.Path(home)
    _, versions, _, unit, ids = local_inventory(home)
    root = owned_unit_root(unit, versions)
    if root is None or "permanent" not in ids:
        raise ValueError("Existing managed permanent service required")
    key = home / STORE / "v2-identity.pem"
    if action is None:
        return {"automatic_update": "off" if os.geteuid() == 0 else native_auto_policy(key, ids["permanent"])}
    base = private_dir(home / STORE)
    fd = os.open(base / "v2-installer.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("Untrusted v2 installer lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another owner installer is active")
        _, versions, unit_file, unit, ids = local_inventory(home)
        root = owned_unit_root(unit, versions)
        if root is None or "permanent" not in ids:
            raise ValueError("Existing managed permanent service required")
        validated_owned_version(root)
        native_owned_file(key, 8192)
        device_id = native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip()
        if device_id != ids["permanent"]:
            raise ValueError("Existing device identity has changed")
        if action == "on":
            manifest = json.loads((root / "bundle.json").read_text("utf8"))
            if native_latest_status(manifest["version"], manifest["version"]) != "up_to_date":
                raise ValueError("Automatic update requires a stable native Agent")
            pending = native_pending_lifecycle(key, unit_file)
            if any(os.path.lexists(path) for path in pending):
                raise ValueError("Unreconciled lifecycle; recover before enabling automatic update")
        native_write_auto_policy(key, device_id, action == "on")
        if action == "off":
            try:
                previous = native_upgrade_result(key, device_id)
            except (OSError, ValueError):
                previous = None
            if previous and previous["status"] == "waiting_idle":
                native_upgrade_result_path(key).unlink()
                native_sync_parent(native_upgrade_result_path(key))
        return {"automatic_update": action}


def native_systemctl(*args):
    env = root_user_manager_environment() if os.geteuid() == 0 else None
    completed = subprocess.run(["systemctl", "--user", *args],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=env, timeout=20, check=False)
    if completed.returncode:
        raise ValueError("Agent systemd action failed; inspect the preserved upgrade backup")
    return completed.stdout.decode("ascii", errors="strict")


def native_signed_owner_intent(root, endpoint, action, lock):
    entry = root / APP / ".build/rca-standard-linux-candidate"
    args = [str(entry), "--owner-intent", endpoint, action, str(lock.fileno())]
    if os.geteuid() == 0:
        args.insert(1, "--root-managed")
    result = subprocess.run(args, pass_fds=(lock.fileno(),),
                            timeout=45, check=False)
    if result.returncode != 0:
        raise ValueError("Signed owner intent not confirmed")


def native_verify_stopped():
    output = native_systemctl("show", UNIT, "-p", "ActiveState", "-p", "MainPID")
    rows = dict(line.split("=", 1) for line in output.strip().splitlines()
                if "=" in line)
    if (set(rows) != {"ActiveState", "MainPID"}
            or rows["ActiveState"] not in ("inactive", "failed") or rows["MainPID"] != "0"):
        raise ValueError("Managed systemd stop unconfirmed")


def native_owner_lifecycle(home, action):
    """Retain the signed owner STOP/Resume and systemd lifecycle contract."""
    if action not in ("stop", "start", "restart") or not (
            sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError("Owner-local lifecycle requires a real terminal")
    if os.geteuid() == 0:
        root_user_manager_environment()
    home = pathlib.Path(home)
    _, _, _, unit, ids = local_inventory(home)
    if not unit or "permanent" not in ids:
        raise ValueError("Existing managed permanent service required")
    base = private_dir(home / STORE)
    fd = os.open(base / "v2-installer.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("Untrusted v2 installer lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another owner installer is active")
        _, versions, unit_file, unit, ids = local_inventory(home)
        root = owned_unit_root(unit, versions)
        if root is None or "permanent" not in ids:
            raise ValueError("Existing managed permanent service required")
        validated_owned_version(root)
        manifest = json.loads((root / "bundle.json").read_text("utf8"))
        if manifest.get("artifact_profile") != "rust-native-only-v1":
            raise ValueError("Native lifecycle requires the current native-only service")
        key = base / "v2-identity.pem"
        native_owned_file(key, 8192)
        if native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != ids["permanent"]:
            raise ValueError("Existing device identity has changed")
        endpoint = next(line[len("Environment=REMOTE_CONTROL_AGENT_ENDPOINT="):] for line in unit.splitlines()
                        if line.startswith("Environment=REMOTE_CONTROL_AGENT_ENDPOINT="))
        pending = native_pending_lifecycle(key, unit_file)
        if any(os.path.lexists(path) for path in pending):
            raise ValueError("Unreconciled identity or activation; recover before lifecycle change")
        marker = pathlib.Path(str(key) + ".owner-stopped")
        saved = native_owned_file(marker, 32) if os.path.lexists(marker) else None
        if saved is not None and saved != b"stopped\n":
            raise ValueError("Unexpected owner STOP intent")
        if action == "restart":
            if saved is not None:
                raise ValueError("Owner STOP blocks normal restart; use start to explicitly resume")
            # Restart keeps the same service, key, version and authorization.
            # Use the existing lock and idle admission, never STOP + Resume.
            exe = root / APP / ".build/rca-standard-linux-candidate"
            pid = native_main_pid()
            original_key = native_owned_file(key, 8192)
            if native_process_executable(pid) != exe or native_consent(key, "verify-online") != "ready":
                raise ValueError("Current owned signed Agent not established")
            if native_consent(key, "freeze") != "ready":
                raise ValueError("Agent busy or freeze ownership uncertain")
            try:
                if (native_consent(key, "verify-frozen") != "ready" or native_main_pid() != pid
                        or native_process_executable(pid) != exe
                        or unit_file.read_text("utf8") != unit or os.path.lexists(marker)
                        or native_owned_file(key, 8192) != original_key
                        or native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != ids["permanent"]):
                    raise ValueError("Restart target changed during freeze")
                native_systemctl("restart", UNIT)
                next_pid = native_wait_started(exe)
                if next_pid == pid:
                    raise ValueError("Replacement process not established")
                if (native_owned_file(key, 8192) != original_key
                        or native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != ids["permanent"]):
                    raise ValueError("Restart identity changed")
                if not native_wait_online(key, next_pid, exe):
                    raise ValueError("Local restart observed; current signed WSS unconfirmed")
                return {"local": "restarted", "signed_wss": "connected_observed"}
            finally:
                # Release only the same process that granted this freeze.
                # Never release an unknown freeze or a replacement process.
                try:
                    same = native_main_pid() == pid and native_process_executable(pid) == exe
                except (OSError, ValueError, subprocess.SubprocessError):
                    same = False
                if same and native_consent(key, "release") != "released":
                    raise ValueError("Restart freeze release unconfirmed")
        if action == "stop":
            if saved is None:
                native_atomic_file(marker, b"stopped\n")
            cloud = "unconfirmed"
            try:
                native_signed_owner_intent(root, endpoint, "stop", lock)
                cloud = "confirmed"
            except (OSError, ValueError, subprocess.SubprocessError):
                pass  # Local OFF remains authoritative if the network fails.
            native_systemctl("stop", UNIT)
            native_verify_stopped()
            return {"local": "stopped", "cloud": cloud}
        if saved is None:
            raise ValueError("Local owner STOP is not recorded; Start cannot bypass pairing")
        native_verify_stopped()
        # Reconcile an earlier offline Stop; Resume never removes the
        # durable marker until both exact signed responses are confirmed.
        native_signed_owner_intent(root, endpoint, "stop", lock)
        native_signed_owner_intent(root, endpoint, "resume", lock)
        try:
            marker.unlink()
            native_sync_parent(marker)
            native_systemctl("start", UNIT)
            native_wait_started(root / APP / ".build/rca-standard-linux-candidate")
        except (OSError, ValueError, subprocess.SubprocessError):
            if not os.path.lexists(marker):
                native_atomic_file(marker, b"stopped\n")
            # A timed-out start may have had an effect. Keep local STOP and
            # confirm the same managed service has stopped before returning.
            native_systemctl("stop", UNIT)
            native_verify_stopped()
            raise
        return {"local": "started", "cloud": "resume_pending_signed_WSS"}


def native_main_pid():
    output = native_systemctl("show", UNIT, "-p", "ActiveState",
                              "-p", "SubState", "-p", "MainPID")
    rows = dict(line.split("=", 1) for line in output.strip().splitlines()
                if "=" in line)
    if (set(rows) != {"ActiveState", "SubState", "MainPID"}
            or rows["ActiveState"] != "active" or rows["SubState"] != "running"
            or not rows["MainPID"].isdigit() or int(rows["MainPID"]) < 1):
        raise ValueError("Active owner Agent process cannot be established")
    return int(rows["MainPID"])


def native_process_executable(pid):
    return pathlib.Path("/proc/%d/exe" % pid).resolve(strict=True)


def native_wait_started(expected, seconds=3):
    """Wait for exec of this systemd start, never a replacement MainPID."""
    pid = native_main_pid()
    deadline = time.monotonic() + seconds
    while True:
        try:
            executable = native_process_executable(pid)
        except (FileNotFoundError, PermissionError):
            # Before exec, systemd's child may not yet expose /proc/PID/exe.
            # Neither missing nor inaccessible evidence establishes identity.
            executable = None
        if native_main_pid() != pid:
            raise ValueError("Agent process changed during service startup")
        if executable == expected:
            return pid
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("Reviewed Agent executable was not established after service start")
        time.sleep(min(0.025, remaining))


def native_consent(key, action):
    import socket
    endpoint = key.with_name("upgrade.sock")
    info = endpoint.lstat()
    if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_mode & 0o077):
        raise ValueError("Untrusted Agent freeze socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect(str(endpoint))
        if action == "verify-online":
            # Bind signed-transport evidence to the owned systemd process.
            peer_pid, peer_uid, _ = struct.unpack("3i", client.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            if peer_uid != os.geteuid() or peer_pid != native_main_pid():
                raise ValueError("Online evidence is not from the active Agent")
        client.sendall((action + "\n").encode("ascii"))
        answer = bytearray()
        while len(answer) <= 32 and b"\n" not in answer:
            part = client.recv(33 - len(answer))
            if not part:
                break
            answer.extend(part)
        if bytes(answer) not in (b"ready\n", b"busy\n", b"released\n"):
            raise ValueError("Invalid Agent freeze response")
        return answer.decode("ascii").strip()


def native_launcher(home, old_root, new_root=None):
    launcher = home / ".local/bin/rca"
    previous = old_root / APP / "scripts/rca.sh"
    # Only the exact reviewed launcher can participate in this transaction.
    allowed = (str(previous),)
    if not launcher.is_symlink() or os.readlink(launcher) not in allowed:
        raise ValueError("Foreign or missing installed Agent launcher")
    if new_root is None:
        return
    next_target = new_root / APP / "scripts/rca.sh"
    if not next_target.is_file() or next_target.is_symlink():
        raise ValueError("Native CLI was not verified")
    stage = launcher.with_name("rca.native-upgrade-" + secrets.token_hex(8))
    os.symlink(str(next_target), stage)
    try:
        os.replace(stage, launcher)
        native_sync_parent(launcher)
    finally:
        if stage.is_symlink():
            stage.unlink()


def native_restore_launcher(home, old_root, new_root):
    launcher = home / ".local/bin/rca"
    original = str(old_root / APP / "scripts/rca.sh")
    next_target = str(new_root / APP / "scripts/rca.sh")
    if not launcher.is_symlink():
        raise ValueError("Installed launcher disappeared during rollback")
    current = os.readlink(launcher)
    if current == original:
        return
    if current != next_target:
        raise ValueError("Installed launcher changed during rollback")
    stage = launcher.with_name("rca.native-rollback-" + secrets.token_hex(8))
    os.symlink(original, stage)
    try:
        os.replace(stage, launcher)
        native_sync_parent(launcher)
    finally:
        if stage.is_symlink():
            stage.unlink()


def native_wait_online(key, pid, executable, seconds=60):
    """A restored owned process must report a currently authenticated transport."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if (native_main_pid() != pid or native_process_executable(pid) != executable):
                return False
            if native_consent(key, "verify-online") == "ready":
                return native_main_pid() == pid and native_process_executable(pid) == executable
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        time.sleep(0.25)
    return False


def native_wait_proof(path, operation, device_id, version, pid, seconds=90):
    import time
    expires = time.monotonic() + seconds
    while time.monotonic() < expires:
        if path.exists() or path.is_symlink():
            try:
                proof = json.loads(native_owned_file(path, 512))
            except json.JSONDecodeError:
                # A create-new proof is visible before the Rust writer syncs;
                # it is not accepted until the complete JSON is present.
                time.sleep(0.25)
                continue
            if (set(proof) != {"operation_id", "device_id", "target_version", "status", "pid"}
                    or proof["operation_id"] != operation
                    or proof["device_id"] != device_id
                    or proof["target_version"] != version
                    or proof["status"] != "authenticated_wss"
                    or type(proof["pid"]) is not int or proof["pid"] != pid):
                raise ValueError("Signed Rust WSS proof does not match this attempt")
            return True
        time.sleep(0.25)
    return False


def native_receipts_compatible(home):
    # Match Rust standard_receipts(): validate every existing path component
    # before pairing can write identity or activation state. Do not create
    # missing directories here; the Agent remains the sole receipt owner.
    directory = home / ".local/state/mcp-workers/remote-control-agent"
    current = pathlib.Path(home)
    for component in (".local", "state", "mcp-workers", "remote-control-agent"):
        current = current / component
        try:
            info = current.lstat()
        except FileNotFoundError:
            return
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o022):
            raise ValueError("Untrusted SQLite receipt directory path")
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_mode & 0o077):
        raise ValueError("Untrusted existing SQLite receipt directory")
    file = directory / "operation-receipts.sqlite"
    if not file.exists():
        if (file.is_symlink()
                or any(os.path.lexists(directory / item) for item in
                       ("operation-receipts.json", "operation-receipts.pre-sqlite.json"))):
            raise ValueError("Missing SQLite with historical receipt data")
        return
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or
                metadata.st_uid != os.geteuid() or
                metadata.st_nlink != 1 or metadata.st_mode & 0o077):
            raise ValueError("Untrusted SQLite receipt file")
        header = os.read(fd, 100)
        if (len(header) != 100 or header[:16] != b"SQLite format 3\x00"
                or int.from_bytes(header[60:64], "big") not in (0, 1)):
            raise ValueError("Incompatible SQLite receipt schema")
    finally:
        os.close(fd)


def native_initial_state(home, root, endpoint, allow_repair=False):
    """Validate exact owned initial-install state; never adopt a foreign unit."""
    _, versions, unit, current, ids = local_inventory(home)
    if root not in versions:
        raise ValueError("Unknown staged Agent version")
    validated_owned_version(root)
    manifest = json.loads((root / "bundle.json").read_text("utf8"))
    if manifest.get("target") == LEGACY_TARGET and os.geteuid() != 0:
        raise ValueError("Legacy permanent service requires the approved UID 0 identity")
    if manifest.get("artifact_profile") != "rust-native-only-v1":
        raise ValueError("First install needs a reviewed native-only bundle")
    key = home / STORE / "v2-identity.pem"
    for directory in (home, home / ".local", home / ".local/bin", home / ".config",
                      unit.parent.parent, unit.parent):
        if directory.is_symlink() or (directory.exists() and (
                not directory.is_dir() or directory.stat().st_uid != os.geteuid()
                or directory.stat().st_mode & 0o022)):
            raise ValueError("Unsafe initial service or launcher directory")
    rendered = native_render_unit(root, endpoint, key)
    intent = pathlib.Path(str(key) + ".native-upgrade-intent")
    proof = pathlib.Path(str(key) + ".native-upgrade-proof")
    forbidden = (pathlib.Path(str(unit) + ".upgrade-backup"),
                 unit.parent / (UNIT + ".d"), unit.parent / "remote-control-v2-agent.service",
                 pathlib.Path(str(key) + ".owner-stopped"),
                 pathlib.Path(str(key) + ".activation-pending"))
    if not allow_repair:
        forbidden += tuple(pathlib.Path(str(key) + suffix) for suffix in
                           (".re-pair-transition", ".re-pair-new", ".re-pair-new.device-id"))
    if any(os.path.lexists(p) for p in forbidden):
        raise ValueError("Conflicting or unresolved Agent lifecycle state")
    record = json.loads(native_owned_file(intent, 512)) if os.path.lexists(intent) else None
    if os.path.lexists(intent) and (not isinstance(record, dict)
            or set(record) not in ({"operation_id", "device_id", "target_version", "initial_endpoint"},
                                   {"operation_id", "device_id", "target_version", "initial_endpoint", "initial_launcher"})
            or ("initial_launcher" in record and not isinstance(record["initial_launcher"], str))
            or not isinstance(record["operation_id"], str)
            or not re.fullmatch(r"[0-9a-f]{32}", record["operation_id"])
            or not ids.get("permanent") or record["device_id"] != ids["permanent"]
            or record["target_version"] != root.name or record["initial_endpoint"] != endpoint):
        raise ValueError("Unresolved or different initial activation")
    if (current is not None and current != rendered
            or (os.path.lexists(proof) and record is None)):
        raise ValueError("Existing or unresolved service requires its own lifecycle action")
    launcher = owned_manager_launcher(home, versions)
    target = str(root / APP / "scripts/rca.sh")
    # A temporary installation may already have published the owner-local
    # command. It is not evidence of permanent service activation.
    previous_launcher = record.get("initial_launcher") if record else None
    if previous_launcher is not None:
        previous_root = next((v for v in versions if v.name == previous_launcher), None)
        if previous_root is None or launcher is None:
            raise ValueError("Prior temporary launcher is not established")
        validated_owned_version(previous_root)
        if json.loads((previous_root / "bundle.json").read_text("utf8")).get("artifact_profile") != "rust-native-only-v1":
            raise ValueError("Prior temporary launcher is not native-only")
        previous_target = str(previous_root / APP / "scripts/rca.sh")
        if os.readlink(launcher) not in (previous_target, target):
            raise ValueError("Prior temporary launcher changed")
    elif launcher is not None:
        if current is not None or record is not None:
            if os.readlink(launcher) != target or current is None:
                raise ValueError("Existing launcher requires its own lifecycle action")
        elif not any(os.readlink(launcher) == str(v / APP / "scripts/rca.sh")
                     for v in versions if json.loads((v / "bundle.json").read_text("utf8")).get("artifact_profile") == "rust-native-only-v1"):
            raise ValueError("Existing launcher requires its own lifecycle action")
    # Do not adopt a unit from another systemd search path or drop-in.
    output = native_systemctl("show", UNIT, "-p", "LoadState", "-p", "ActiveState",
                              "-p", "MainPID", "-p", "FragmentPath", "-p", "DropInPaths")
    state = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    if (set(state) != {"LoadState", "ActiveState", "MainPID", "FragmentPath", "DropInPaths"}
            or state["DropInPaths"] or state["LoadState"] not in ("loaded", "not-found")
            or (state["LoadState"] == "loaded" and state["FragmentPath"] != str(unit))
            or (current is None and state["LoadState"] != "not-found"
                and ((record is None and not (allow_repair and
                        os.path.lexists(pathlib.Path(str(key) + ".re-pair-transition"))))
                     or state["ActiveState"] not in ("inactive", "failed")))
            or not state["MainPID"].isdigit()):
        raise ValueError("Foreign or uncertain systemd service")
    pid = int(state["MainPID"])
    if state["ActiveState"] not in ("active", "inactive", "failed") or (
            (state["ActiveState"] == "active") != (pid > 0)):
        raise ValueError("Agent service transition is not yet settled")
    if pid and (current is None or
                native_process_executable(pid) != root / APP / ".build/rca-standard-linux-candidate"):
        raise ValueError("Unexpected running Agent executable")
    return versions, unit, current, ids, key, intent, proof, record, launcher, rendered, pid


def native_pair_local(root, endpoint, name, temporary=False, repair_phase=None, lock_fd=None):
    import socket
    suggested = socket.gethostname()
    label = name if name is not None else input("Device name [" + suggested + "]: ").strip() or suggested
    binary = root / APP / ".build/rca-standard-linux-candidate"
    try:
        probe = subprocess.run([str(root / APP / ".build/session-supervisor"), "--probe"],
                               start_new_session=True, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=5, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError("Required native supervisor safety probe timed out") from error
    if probe.returncode:
        raise ValueError("Required native supervisor safety probe failed")
    command = "--temporary-local" if temporary else "--pair-local"
    pass_fds = ()
    if repair_phase is not None:
        if temporary or repair_phase not in ("prepare", "promote") or lock_fd is None:
            raise ValueError("Invalid permanent re-pair phase")
        command = "--" + repair_phase + "-permanent-repair"
        pass_fds = (lock_fd,)
    args = [str(binary)]
    if os.geteuid() == 0:
        args.append("--root-managed")
    args.extend((command, endpoint, label))
    if repair_phase is not None:
        args.append(str(lock_fd))
    if subprocess.run(args, check=False, pass_fds=pass_fds).returncode:
        raise ValueError("Native pairing or foreground session not completed; identity retained")


def native_temporary(home, root, endpoint, name=None, process_check=None, root_authorized=False):
    """Owner-local foreground only; no permanent service or identity mutation."""
    if ((os.geteuid() == 0 and not root_authorized)
            or (os.geteuid() != 0 and root_authorized)
            or not (sys.stdin.isatty() and sys.stdout.isatty())):
        raise ValueError("Temporary Agent requires its matching owner identity and a real local terminal")
    if not worker_origin(endpoint):
        raise ValueError("Supply the reviewed HTTPS Worker origin")
    home = pathlib.Path(home)
    root = pathlib.Path(root)
    _, versions, _, _, _ = local_inventory(home)
    if root not in versions:
        raise ValueError("Unknown staged Agent version")
    validated_owned_version(root)
    manifest = json.loads((root / "bundle.json").read_text("utf8"))
    if manifest.get("target") == LEGACY_TARGET or manifest.get("artifact_profile") != "rust-native-only-v1":
        raise ValueError("Temporary install needs a reviewed Standard native-only bundle")
    # The existing operation receipt ledger has exactly one writer. Avoid
    # registering a new temporary key when an existing installed Agent is
    # already running; never stop that Agent to make room.
    if not (process_check or no_running_programs)(versions):
        raise ValueError("Running or uncertain Agent owns the local runtime; no temporary pairing")
    native_receipts_compatible(home)
    if not confirm_owner("Start a 24h foreground Agent at " + endpoint + " (no service installed)?"):
        raise ValueError("Temporary pairing not confirmed")
    print("Foreground only; no service will be installed. Closing the terminal disconnects, not revokes.")
    print("Reviewed local manager: " + str(root / APP / "scripts/rca.sh"), flush=True)
    print("Temporary mode does not install a new short command on PATH. "
          "Use the reviewed manager path above with --help; "
          "without a permanent service, pair requires an explicit approved HTTPS origin.", flush=True)
    # Rust holds the existing installer lock from identity recovery through
    # the end of foreground execution; no additional process manager.
    native_pair_local(root, endpoint, name, temporary=True)
    return 0


def native_pair_or_install(home, root, endpoint, name=None,
                           pair=native_pair_local, verify=native_wait_proof, process_check=None,
                           root_authorized=False):
    """Use the existing identity transaction, then the signed activation path."""
    if ((os.geteuid() == 0 and not root_authorized)
            or (os.geteuid() != 0 and root_authorized)
            or not (sys.stdin.isatty() and sys.stdout.isatty())):
        raise ValueError("Permanent pairing requires its matching owner identity and a real local terminal")
    if os.geteuid() == 0:
        root_user_manager_environment()
    home, root = pathlib.Path(home), pathlib.Path(root)
    process_check = process_check or no_running_programs
    _, _, current, ids, key, _, _, record, _, _, _ = native_initial_state(home, root, endpoint, allow_repair=True)
    marker = pathlib.Path(str(key) + ".re-pair-transition")
    pending = any(os.path.lexists(pathlib.Path(str(key) + suffix)) for suffix in
                  (".re-pair-transition", ".re-pair-new", ".re-pair-new.device-id"))
    if record is not None and pending:
        raise ValueError("Conflicting native activation and identity transaction")
    repaired = False
    # A preserved key/ID with no installed service is a normal reinstall.
    # Let the ordinary native pairing path recover that exact identity; the
    # old/new repair transaction is only for an installed service or an
    # already durable identity transition.
    if record is None and (current is not None or pending):
        import socket
        if name is None:
            name = socket.gethostname()
        fd = os.open(key.parent / "v2-installer.lock",
                     os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(fd, "r+b") as lock:
            info = os.fstat(lock.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
                raise ValueError("Unsafe installer lock")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("Another owner installer is active")
            versions, unit, current, ids, key, _, _, record, launcher, rendered, pid = (
                native_initial_state(home, root, endpoint, allow_repair=True))
            if record is not None:
                raise ValueError("Native activation changed before re-pair")
            if current is not None and not ids.get("permanent") and not marker.exists():
                raise ValueError("Installed Agent identity missing; no automatic replacement")
            native_receipts_compatible(home)
            pair(root, endpoint, name, repair_phase="prepare", lock_fd=lock.fileno())
            if not marker.exists():
                _, _, current, _, _, _, _, _, launcher, _, pid = (
                    native_initial_state(home, root, endpoint, allow_repair=True))
                if current is not None:
                    if launcher is None:
                        raise ValueError("Existing service without confirmed launcher")
                    return {"status": "already_installed", "signed_wss": "unconfirmed",
                            "local_service": "active" if pid else "inactive"}
            else:
                # Signed old/new approval precedes service mutation.
                versions, unit, current, ids, key, _, _, _, _, rendered, pid = (
                    native_initial_state(home, root, endpoint, allow_repair=True))
                if pid:
                    if native_consent(key, "freeze") != "ready":
                        raise ValueError("Running or uncertain operations block re-pair")
                    try:
                        if (native_consent(key, "verify-frozen") != "ready"
                                or native_main_pid() != pid or unit.read_text("utf8") != rendered):
                            raise ValueError("Agent changed during re-pair freeze")
                        native_systemctl("disable", "--now", UNIT)
                    except Exception:
                        try:
                            native_consent(key, "release")
                        except Exception:
                            pass
                        raise
                elif current is not None:
                    native_systemctl("disable", "--now", UNIT)
                if not process_check(versions):
                    raise ValueError("Prior Agent exit not established; identity retained")
                if current is not None:
                    if unit.read_text("utf8") != rendered:
                        raise ValueError("Agent unit changed during re-pair")
                    unit.unlink()
                    native_sync_parent(unit)
                native_systemctl("daemon-reload")
                after = native_initial_state(home, root, endpoint, allow_repair=True)
                if after[2] is not None or after[-1] or not process_check(versions):
                    raise ValueError("Uncertain prior service; identity retained")
                pair(root, endpoint, name, repair_phase="promote", lock_fd=lock.fileno())
                if os.path.lexists(marker):
                    raise ValueError("Identity promotion incomplete; retry locally")
                repaired = True
    result = native_first_install(home, root, endpoint, name, pair=pair, verify=verify,
                                  process_check=process_check)
    if repaired:
        result.update(identity_preserved=False, previous_identity_archived=True)
    return result


def native_first_install(home, root, endpoint, name=None,
                         pair=native_pair_local, verify=native_wait_proof,
                         process_check=None):
    """Fresh permanent install; only the exact authenticated PID may commit."""
    home = pathlib.Path(home)
    root = pathlib.Path(root)
    if process_check is None:
        process_check = no_running_programs
    state = native_initial_state(home, root, endpoint)
    versions, _, current, _, key, _, _, record, launcher, _, pid = state
    if current is not None and record is None:
        if launcher is None:
            raise ValueError("Existing service without confirmed launcher; manual review required")
        return {"status": "already_installed", "signed_wss": "unconfirmed",
                "local_service": "active" if pid else "inactive"}
    # Only a genuinely new identity may receive the disclosed default.
    # An interrupted activation, re-pair or existing install never migrates
    # missing consent implicitly.
    new_stable_policy = (os.geteuid() != 0 and current is None and record is None
                         and not os.path.lexists(key)
                         and "permanent" not in state[3])
    manifest = json.loads((root / "bundle.json").read_text("utf8"))
    new_stable_policy = (new_stable_policy and
                         native_latest_status(manifest["version"], manifest["version"]) == "up_to_date")
    if new_stable_policy:
        print("Automatic updates for this new permanent device default to on after signed activation; "
              "disable with rca update --auto off.", flush=True)
    if record is None:
        if not process_check(versions):
            raise ValueError("Running or uncertain Agent blocks first pairing")
        native_receipts_compatible(home)
        pair(root, endpoint, name)
    # Rust pairing uses this same lock. Re-read state under lock before
    # service mutation; never act on a stale snapshot.
    fd = os.open(key.parent / "v2-installer.lock",
                 os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or info.st_mode & 0o777 != 0o600):
            raise ValueError("Unsafe installer lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another owner installer is active")
        versions, unit, current, ids, key, intent, proof, record, launcher, rendered, pid = (
            native_initial_state(home, root, endpoint))
        device_id = ids.get("permanent")
        if not device_id:
            raise ValueError("Pairing has not recovered an approved identity")
        key_digest = hashlib.sha256(native_owned_file(key, 8192)).hexdigest()
        if record is None:
            if current is not None or not process_check(versions):
                raise ValueError("Agent state changed during pairing")
            record = {"operation_id": secrets.token_hex(16), "device_id": device_id,
                      "target_version": root.name, "initial_endpoint": endpoint}
            if launcher is not None:
                prior = next(v for v in versions if os.readlink(launcher) == str(v / APP / "scripts/rca.sh"))
                record["initial_launcher"] = prior.name
            native_atomic_file(intent, json.dumps(record, separators=(",", ":")).encode())
        if launcher is not None and "initial_launcher" not in record and not os.path.lexists(proof):
            # Launcher publication follows a verified proof. Interrupted
            # cleanup can leave the initial intent alone. No new WSS claim.
            intent.unlink()
            native_sync_parent(intent)
            return {"status": "already_installed", "signed_wss": "unconfirmed",
                    "local_service": "active" if pid else "inactive"}
        binary = root / APP / ".build/rca-standard-linux-candidate"
        if not pid:
            if os.path.lexists(proof):
                raise ValueError("Stale activation evidence; use attended native recovery")
            if not process_check(versions):
                raise ValueError("Unconfirmed prior Agent process; use attended native recovery")
            if current is None:
                unit.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                native_atomic_file(unit, rendered.encode())
            native_systemctl("daemon-reload")
            native_systemctl("enable", "--now", UNIT)
            pid = native_wait_started(binary)
        if native_process_executable(pid) != binary:
            raise ValueError("Initial service did not activate the reviewed executable")
        if not verify(proof, record["operation_id"], device_id, root.name, pid):
            raise ValueError("Signed activation unconfirmed; retain initial activation for recovery")
        if (native_main_pid() != pid or native_process_executable(pid) != binary
                or unit.read_text("utf8") != rendered
                or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_digest
                or native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != device_id):
            raise ValueError("Initial Agent changed during activation")
        # Publish only after authentication. Never replace a foreign command.
        if owned_manager_launcher(home, versions) is None:
            target = home / ".local/bin/rca"
            target.parent.mkdir(mode=0o700, exist_ok=True)
            os.symlink(str(root / APP / "scripts/rca.sh"), target)
            native_sync_parent(target)
        if "initial_launcher" in record:
            prior = next(v for v in versions if v.name == record["initial_launcher"])
            if os.readlink(home / ".local/bin/rca") != str(root / APP / "scripts/rca.sh"):
                native_launcher(home, prior, root)
            native_launcher(home, root)
            # The existing intent is the commit boundary, not the preexisting
            # command. Only after verified activation retire this distinction.
            del record["initial_launcher"]
            native_atomic_file(intent, json.dumps(record, separators=(",", ":")).encode())
        native_launcher(home, root)
        if new_stable_policy:
            native_write_auto_policy(key, device_id, True)
        for item in (proof, intent):
            item.unlink()
            native_sync_parent(item)
        return {"status": "active", "version": root.name, "signed_wss": True,
                "identity_preserved": True}


def native_recover_initial(home, versions, record, process_check):
    """Abort an interrupted initial activation, never discard its identity."""
    root = next((v for v in versions if v.name == record.get("target_version")), None)
    if root is None:
        raise ValueError("Unknown initial activation target")
    endpoint = record.get("initial_endpoint")
    if not isinstance(endpoint, str):
        raise ValueError("Unknown initial activation endpoint")
    versions, unit, current, ids, key, intent, proof, _, launcher, rendered, pid = (
        native_initial_state(home, root, endpoint))
    if launcher is not None and "initial_launcher" not in record:
        # The first install already passed its signed activation and published
        # the CLI. Recovery must not stop this committed service.
        raise ValueError("Initial launcher committed; repeat the same pinned native install")
    if pid:
        if native_consent(key, "freeze") != "ready":
            raise ValueError("Running or uncertain operations block initial recovery")
        try:
            if (native_consent(key, "verify-frozen") != "ready"
                    or native_main_pid() != pid or unit.read_text("utf8") != rendered):
                raise ValueError("Initial service changed during freeze")
            native_systemctl("disable", "--now", UNIT)
        except Exception:
            try:
                native_consent(key, "release")
            except Exception:
                pass
            raise
    elif current is not None:
        native_systemctl("disable", "--now", UNIT)
    if not process_check(versions):
        raise ValueError("Initial service exit not established; evidence retained")
    if current is not None:
        if unit.read_text("utf8") != rendered:
            raise ValueError("Initial unit changed; evidence retained")
        unit.unlink()
        native_sync_parent(unit)
    native_systemctl("daemon-reload")
    if "initial_launcher" in record:
        prior = next(v for v in versions if v.name == record["initial_launcher"])
        if prior != root:
            native_restore_launcher(home, prior, root)
    for item in (proof, intent):
        if os.path.lexists(item):
            item.unlink()
            native_sync_parent(item)
    return {"status": "initial_service_removed", "identity_preserved": True,
            "signed_wss": "unconfirmed", "cloud_revocation": "NOT_PERFORMED"}


class NativeUpgradeBusy(ValueError):
    """Confirmed no-effect admission refusal, safe for a bounded later check."""


def native_cutover_when_idle(home, new_root, endpoint, verify=native_wait_proof, *, automatic=False,
                             expected_binding=None):
    deadline = time.monotonic() + 60
    while True:
        try:
            return native_cutover(home, new_root, endpoint, verify, automatic=automatic,
                                  expected_binding=expected_binding, idle_deadline=deadline)
        except NativeUpgradeBusy:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"status": "waiting_idle"}
            time.sleep(min(2, remaining))


def native_cutover(home, new_root, endpoint, verify=native_wait_proof, *, automatic=False,
                   expected_binding=None, idle_deadline=None):
    """Accept only a pinned staged Rust bundle; preserve old identity and SQLite."""
    home = pathlib.Path(home)
    _, versions, unit_file, current, ids = local_inventory(home)
    if not current or "permanent" not in ids:
        raise ValueError("No existing paired managed Linux Agent")
    old_root = owned_unit_root(current, versions)
    if old_root == new_root:
        raise ValueError("Target Agent is already running")
    validated_owned_version(old_root)
    validated_owned_version(new_root)
    manifest = json.loads((new_root / "bundle.json").read_text("utf8"))
    old_manifest = json.loads((old_root / "bundle.json").read_text("utf8"))
    if manifest.get("target") != old_manifest.get("target"):
        raise ValueError("Cross-target upgrade refused")
    if manifest.get("target") == LEGACY_TARGET and (os.geteuid() != 0 or automatic):
        raise ValueError("Legacy upgrade requires the approved attended Root identity")
    if (manifest.get("artifact_profile") != "rust-native-only-v1"
            or manifest.get("agent_runtime") != "rust-standard-linux-v1"):
        raise ValueError("Upgrade target must be the reviewed Node-free Rust archive")
    key = home / STORE / "v2-identity.pem"
    key_before = hashlib.sha256(native_owned_file(key, 8192)).hexdigest()
    device_id = native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip()
    if ids["permanent"] != device_id:
        raise ValueError("Existing device identity has changed")
    if expected_binding is not None and expected_binding != (old_root, device_id, key_before):
        raise ValueError("Installed Agent or identity changed during update preparation")
    native_receipts_compatible(home)
    if current != native_render_unit(old_root, endpoint, key):
        raise ValueError("Unknown or modified installed systemd unit")
    next_unit = native_render_unit(new_root, endpoint, key)
    if (unit_file.parent / (UNIT + ".d")).exists() or (unit_file.parent / (UNIT + ".d")).is_symlink():
        raise ValueError("Unexpected systemd drop-ins")
    if (unit_file.parent / "remote-control-v2-agent.service").exists():
        raise ValueError("Conflicting historical Agent service")
    stopped = pathlib.Path(str(key) + ".owner-stopped")
    if os.path.lexists(stopped):
        raise ValueError("Owner Stop cannot silently become online")
    native_launcher(home, old_root)
    backup = pathlib.Path(str(unit_file) + ".upgrade-backup")
    intent = pathlib.Path(str(key) + ".native-upgrade-intent")
    proof = pathlib.Path(str(key) + ".native-upgrade-proof")
    if any(os.path.lexists(item) for item in native_pending_lifecycle(key, unit_file)):
        raise ValueError("Unreconciled previous upgrade; preserve evidence for recovery")
    # Pairing, repair and lifecycle changes share this installer lock.
    lock_path = home / STORE / "v2-installer.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o777 != 0o600):
            raise ValueError("Untrusted v2 installer lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another owner installer is active")
        # Owner Stop/Start and re-pair use this same lock. The durable OFF
        # marker remains authoritative even if the old process is still alive.
        if os.path.lexists(stopped):
            raise ValueError("Owner Stop cannot silently become online")
        if (unit_file.read_text("utf8") != current
                or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_before
                or native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != device_id):
            raise ValueError("Installed Agent or identity changed before upgrade lock")
        # Recheck pending transaction after acquiring the shared installer lock.
        if any(os.path.lexists(item) for item in native_pending_lifecycle(key, unit_file)):
            raise ValueError("Unreconciled previous upgrade; preserve evidence for recovery")
        pid = native_main_pid()
        # The service entrypoint must be the version whose socket we freeze.
        expected_binary = old_root / APP / ".build/rca-standard-linux-candidate"
        if native_process_executable(pid) != expected_binary:
            raise ValueError("Service process differs from frozen Agent")
        installed_version = json.loads((old_root / "bundle.json").read_text("utf8"))["version"]
        target_version = manifest["version"]
        if automatic:
            native_require_automatic_update(key, device_id, installed_version, target_version)
            if native_consent(key, "verify-online") != "ready":
                raise ValueError("Automatic update requires a current signed Agent connection")
        switched = False
        committed = False
        operation = secrets.token_hex(16)
        # Publish intent before freezing so a killed installer cannot leave
        # a frozen old service with no recoverable record.
        native_atomic_file(intent, json.dumps({
            "operation_id": operation, "device_id": device_id,
            "target_version": new_root.name
        }, separators=(",", ":")).encode())
        stage = "freeze"
        freeze_answer = None
        try:
            freeze_answer = native_consent(key, "freeze")
            if freeze_answer != "ready":
                raise ValueError("Agent has running or unknown operations; upgrade refused")
            stage = "verify-frozen"
            if (native_consent(key, "verify-frozen") != "ready"
                    or native_main_pid() != pid
                    or unit_file.read_text("utf8") != current
                    or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_before
                    or native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != device_id):
                raise ValueError("Agent changed during freeze")
            if automatic:
                native_require_automatic_update(key, device_id, installed_version, target_version)
                if native_consent(key, "verify-online") != "ready":
                    raise ValueError("Signed Agent connection lost before automatic switch")
            stage = "publish-service"
            native_atomic_file(backup, current.encode())
            native_atomic_file(unit_file, next_unit.encode())
            switched = True
            stage = "reload-service"
            native_systemctl("daemon-reload")
            stage = "restart-service"
            native_systemctl("restart", UNIT)
            stage = "verify-started-executable"
            new_pid = native_wait_started(new_root / APP / ".build/rca-standard-linux-candidate")
            stage = "signed-wss"
            if not verify(proof, operation, device_id, new_root.name, new_pid):
                raise ValueError("New Rust Agent signed WSS was not confirmed")
            # A proof from a Rust process that exited/restarted during the
            # handshake does not authenticate its replacement. Keep the
            # systemd instance that produced the signed WSS evidence.
            stage = "verify-authenticated-process"
            if (native_main_pid() != new_pid
                    or native_process_executable(new_pid) != (
                        new_root / APP / ".build/rca-standard-linux-candidate")
                    or unit_file.read_text("utf8") != next_unit
                    or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_before
                    or native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != device_id):
                raise ValueError("Rust process, identity or systemd unit changed after WSS")
            stage = "publish-launcher"
            native_launcher(home, old_root, new_root)
            committed = True
            if automatic:
                native_write_upgrade_result(key, device_id, operation, target_version,
                                            target_version, "success")
            stage = "retire-evidence"
            # Keep the original unit until the final cleanup step; only
            # an already reconciled service/launcher may leave backup alone.
            for item in (proof, intent, backup):
                item.unlink()
                native_sync_parent(item)
            return {"status": "active", "version": new_root.name,
                    "signed_wss": True, "identity_preserved": True}
        except Exception as error:
            if committed:
                raise ValueError("Native Agent activated; recovery record cleanup uncertain") from error
            if switched or backup.exists():
                rollback_stage = "restore-unit"
                try:
                    native_atomic_file(unit_file, current.encode())
                    rollback_stage = "reload-service"
                    native_systemctl("daemon-reload")
                    rollback_stage = "restart-service"
                    native_systemctl("restart", UNIT)
                    rollback_stage = "verify-started-executable"
                    restored_pid = native_wait_started(expected_binary)
                    rollback_stage = "verify-restored-state"
                    if (native_main_pid() != restored_pid
                            or native_process_executable(restored_pid) != expected_binary
                            or unit_file.read_text("utf8") != current
                            or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_before):
                        raise ValueError("Rollback process, identity or unit mismatch")
                    rollback_stage = "restore-launcher"
                    native_restore_launcher(home, old_root, new_root)
                    if automatic:
                        rollback_stage = "verify-restored-signed-connection"
                        if (not native_wait_online(key, restored_pid, expected_binary)
                                or native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != device_id
                                or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_before
                                or unit_file.read_text("utf8") != current):
                            raise ValueError("Restored signed Agent connection unconfirmed")
                        rollback_stage = "record-recovered-target"
                        native_write_upgrade_result(key, device_id, operation, target_version,
                                                    installed_version, "failed_recovered")
                except Exception:
                    # Only fixed stage names are safe to disclose; no raw exception.
                    raise ValueError("Native upgrade failed; rollback uncertain; backup retained "
                                     "(upgrade=" + stage + ", rollback=" + rollback_stage + ")") from None
            # Only an affirmative reply to this request establishes that
            # this transaction owns Freeze. A subsequent state observation
            # cannot attribute ownership or rule out a queued request.
            if not switched and not backup.exists():
                if freeze_answer not in ("ready", "busy"):
                    raise ValueError(
                        "Native upgrade refused; freeze ownership unknown; intent retained") from error
                if freeze_answer == "ready":
                    try:
                        if native_consent(key, "release") != "released":
                            raise ValueError("Freeze release unconfirmed")
                    except Exception:
                        raise ValueError(
                            "Native upgrade refused; freeze release uncertain; intent retained") from error
            # No service switch or a verified old unit: evidence can be retired.
            for item in (proof, intent, backup):
                if os.path.lexists(item):
                    item.unlink()
                    native_sync_parent(item)
            if freeze_answer == "busy":
                if automatic and idle_deadline is not None and time.monotonic() >= idle_deadline:
                    # Keep the last recovered failure authoritative until a
                    # different version actually succeeds; a Busy observation
                    # must not erase failed-target suppression.
                    previous = native_upgrade_result(key, device_id)
                    if not previous or previous["status"] != "failed_recovered":
                        native_write_upgrade_result(key, device_id, operation, target_version,
                                                    installed_version, "waiting_idle")
                    return {"status": "waiting_idle", "installed_version": installed_version,
                            "target_version": target_version}
                raise NativeUpgradeBusy("Agent is busy; no service switch was admitted") from error
            raise ValueError("Native upgrade refused or safely rolled back (stage=" + stage + ")") from error

def native_recover(home, process_check=None):
    """Attended recovery of one interrupted, owner-frozen Node-free switch."""
    home = pathlib.Path(home)
    local_inventory(home)
    key = home / STORE / "v2-identity.pem"
    unit = home / ".config/systemd/user" / UNIT
    backup = pathlib.Path(str(unit) + ".upgrade-backup")
    intent = pathlib.Path(str(key) + ".native-upgrade-intent")
    proof = pathlib.Path(str(key) + ".native-upgrade-proof")
    lock_path = home / STORE / "v2-installer.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("Untrusted owner installer lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another owner installer is active")
        _, versions, unit, current, ids = local_inventory(home)
        has_backup = os.path.lexists(backup)
        has_intent = os.path.lexists(intent)
        if has_intent and not has_backup:
            record = json.loads(native_owned_file(intent, 512))
            if isinstance(record, dict) and "initial_endpoint" in record:
                return native_recover_initial(home, versions, record,
                                              process_check or no_running_programs)
        if (not current or not (has_backup or has_intent)
                or (unit.parent / (UNIT + ".d")).exists()
                or (unit.parent / (UNIT + ".d")).is_symlink()
                or pathlib.Path(str(key) + ".owner-stopped").exists()
                or pathlib.Path(str(key) + ".owner-stopped").is_symlink()):
            raise ValueError("No safe interrupted native upgrade to recover")
        previous = native_owned_file(backup, 8192).decode("utf8") if has_backup else current
        old = owned_unit_root(previous, versions)
        new = owned_unit_root(current, versions)
        if old is None or new is None:
            raise ValueError("Unknown service version during recovery")
        validated_owned_version(old)
        validated_owned_version(new)
        new_info = json.loads((new / "bundle.json").read_text("utf8"))
        if old != new and new_info.get("artifact_profile") != "rust-native-only-v1":
            raise ValueError("Current service is not Node-free Rust")
        endpoints = [line.split("=", 2)[2] for line in previous.splitlines()
                     if line.startswith("Environment=REMOTE_CONTROL_AGENT_ENDPOINT=")]
        if len(endpoints) != 1:
            raise ValueError("Ambiguous recovery endpoint")
        endpoint = endpoints[0]
        if (previous != native_render_unit(old, endpoint, key)
                or current != native_render_unit(new, endpoint, key)):
            raise ValueError("Modified service template blocks recovery")
        key_digest = hashlib.sha256(native_owned_file(key, 8192)).hexdigest()
        device_id = native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip()
        if ids.get("permanent") != device_id:
            raise ValueError("Recovery device identity mismatch")
        record = json.loads(native_owned_file(intent, 512)) if has_intent else None
        if has_intent and (not isinstance(record, dict)
                or set(record) != {"operation_id", "device_id", "target_version"}
                or not isinstance(record["operation_id"], str)
                or not re.fullmatch(r"[0-9a-f]{32}", record["operation_id"])
                or record["device_id"] != device_id
                or record["target_version"] not in {v.name for v in versions}
                or (old != new and record["target_version"] != new.name)):
            raise ValueError("Recovery intent or device identity mismatch")
        partial = not (has_backup and has_intent)
        target = new
        if not partial:
            target = next(v for v in versions if v.name == record["target_version"])
            validated_owned_version(target)
            if (target == old or new not in (old, target)
                    or json.loads((target / "bundle.json").read_text("utf8")).get("artifact_profile")
                    != "rust-native-only-v1"):
                raise ValueError("Recovery target does not match the reviewed native switch")
        if os.path.lexists(proof):
            if partial:
                raise ValueError("Incomplete recovery records with activation proof")
            raw_proof = native_owned_file(proof, 512)
            try:
                signed = json.loads(raw_proof)
            except json.JSONDecodeError:
                # A killed Rust writer may leave an incomplete private proof.
                # It never approves activation; the validated backup and
                # intent still allow a safe, attended rollback.
                pass
            else:
                if (not isinstance(signed, dict)
                        or set(signed) not in (set(record) | {"status"}, set(record) | {"status", "pid"})
                        or any(signed.get(field) != value for field, value in record.items())
                        or signed["status"] != "authenticated_wss"):
                    raise ValueError("Recovery proof does not match this attempt")
        native_receipts_compatible(home)
        launcher = home / ".local/bin/rca"
        if (not launcher.is_symlink()
                or os.readlink(launcher) not in
                {str(root / APP / "scripts/rca.sh") for root in (old, target)}):
            raise ValueError("Unreviewed recovery launcher")
        # Before any switch, intent can exist alone. After a verified commit
        # or rollback, backup can remain alone. Never guess which program to
        # restart: reconcile only if the running unit and CLI already agree.
        if partial and (os.readlink(launcher) != str(new / APP / "scripts/rca.sh")
                        or (has_intent and record["target_version"] == new.name)):
            raise ValueError("Incomplete recovery records do not match the active launcher")
        pid = native_main_pid()
        current_exe = new / APP / ".build/rca-standard-linux-candidate"
        old_exe = old / APP / ".build/rca-standard-linux-candidate"
        target_exe = target / APP / ".build/rca-standard-linux-candidate"
        active_exe = native_process_executable(pid)
        # The unit and the actual service can be one step apart if killed
        # between atomic unit replacement and the following restart.
        if active_exe != current_exe and (partial or active_exe not in (old_exe, target_exe)):
            raise ValueError("Recovery process does not match its systemd unit or transaction")
        answer = native_consent(key, "freeze")
        if answer != "ready" and native_consent(key, "verify-frozen") != "ready":
            raise ValueError("Operations still active; recovery refused")
        stage = "verify-frozen-state"
        try:
            if (native_main_pid() != pid or native_process_executable(pid) != active_exe
                    or unit.read_text("utf8") != current
                    or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_digest):
                raise ValueError("Recovery state changed while frozen")
            if partial:
                stage = "reconcile-active-service"
                if (native_process_executable(pid) != current_exe
                        or not launcher.is_symlink()
                        or os.readlink(launcher) != str(new / APP / "scripts/rca.sh")):
                    raise ValueError("Recovery launcher or process changed while frozen")
                if native_consent(key, "release") != "released":
                    raise ValueError("Active Agent could not be unfrozen")
                for item in (intent, backup):
                    if os.path.lexists(item):
                        item.unlink()
                        native_sync_parent(item)
                return {"status": "active_service_reconciled", "version": new.name,
                        "identity_preserved": True, "signed_wss": "unconfirmed"}
            if current != previous or active_exe != old_exe:
                stage = "restore-unit"
                native_atomic_file(unit, previous.encode())
                stage = "reload-unit"
                native_systemctl("daemon-reload")
                stage = "restart-previous-service"
                native_systemctl("restart", UNIT)
                stage = "verify-started-executable"
                native_wait_started(old_exe)
            else:
                stage = "release-freeze"
                native_consent(key, "release")
            stage = "verify-previous-process"
            if (native_process_executable(native_main_pid()) != old_exe
                    or unit.read_text("utf8") != previous
                    or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_digest):
                raise ValueError("Previous Agent was not restored")
            stage = "restore-launcher"
            native_restore_launcher(home, old, target)
            stage = "verify-receipts"
            native_receipts_compatible(home)
            stage = "retire-evidence"
            for item in (proof, intent, backup):
                if os.path.lexists(item):
                    item.unlink()
                    native_sync_parent(item)
            return {"status": "previous_service_restored", "version": old.name,
                    "identity_preserved": True, "signed_wss": "unconfirmed"}
        except Exception:
            raise ValueError("Native recovery uncertain at " + stage + "; preserve remaining recovery evidence") from None
        finally:
            # Never release a Rust process if the on-disk systemd unit was
            # switched but restart failed. Keep it frozen for attended repair.
            try:
                if (unit.read_text("utf8") == current and native_main_pid() == pid
                        and native_process_executable(pid) == current_exe):
                    native_consent(key, "release")
            except Exception:
                pass


UNIT = "remote-control-agent.service"
MARKER = "# Managed by Remote Control Agent installer."
STORE = pathlib.Path(".local/share/mcp-workers/remote-control")


def local_inventory(home):
    home = pathlib.Path(home)
    if os.geteuid() == 0 and home != root_account_home():
        raise ValueError("UID 0 installation must use the UID 0 OS account home")
    if home.is_symlink() or not home.is_dir() or home.stat().st_uid != os.geteuid():
        raise ValueError("Untrusted account home")
    base = home / STORE
    # Never follow a link in any trusted uninstall root component.
    for relative in (".local", ".local/share", ".local/share/mcp-workers",
                     str(STORE), str(STORE / "programs"),
                     ".config", ".config/systemd", ".config/systemd/user"):
        item = home / relative
        if item.is_symlink() or (item.exists() and (
                not item.is_dir() or item.stat().st_uid != os.geteuid()
                or (os.geteuid() == 0 and stat.S_IMODE(item.stat().st_mode) & 0o022))):
            raise ValueError("Linked, unowned or writable path in v2 install tree")
    programs = base / "programs"
    unit_file = home / ".config/systemd/user" / UNIT
    if programs.is_symlink() or unit_file.is_symlink():
        raise ValueError("Untrusted v2 installation symlink")
    versions = []
    if programs.exists():
        if not programs.is_dir() or programs.stat().st_uid != os.geteuid():
            raise ValueError("Untrusted program directory")
        for p in programs.iterdir():
            if p.name == "install.lock" or p.name.startswith((".download-", ".unverified-")):
                continue
            if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?-linux-(?:x64(?:-legacy)?|arm64)-glibc", p.name) \
                    or p.is_symlink() or not p.is_dir() or p.stat().st_uid != os.geteuid():
                raise ValueError("Unknown version entry: do not remove")
            versions.append(p)
    unit = None
    if unit_file.exists():
        info = unit_file.lstat()
        if info.st_uid != os.geteuid() or not stat.S_ISREG(info.st_mode):
            raise ValueError("Unowned v2 user service")
        if os.geteuid() == 0 and (info.st_mode & 0o077 or info.st_nlink != 1):
            raise ValueError("Untrusted Root user service")
        unit = unit_file.read_text("utf8")
        if not unit.startswith(MARKER + "\n"):
            raise ValueError("Foreign user service; do not remove")
        if (os.geteuid() == 0 and not root_managed_unit(unit)) or (
                os.geteuid() != 0 and root_managed_unit(unit)):
            raise ValueError("User service belongs to a different Agent OS identity")
    ids = {}
    for mode, relative in (("permanent", "v2-identity.pem"),
                           ("temporary", "temporary/v2-identity.pem")):
        f = pathlib.Path(str(base / relative) + ".device-id")
        if f.is_symlink():
            raise ValueError("Linked identity ID")
        if f.exists():
            st = f.stat()
            if not f.is_file() or st.st_uid != os.geteuid() or st.st_mode & 0o077:
                raise ValueError("Unsafe identity metadata")
            value = f.read_text("utf8").strip()
            if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value):
                raise ValueError("Invalid device ID")
            ids[mode] = value
    return programs, versions, unit_file, unit, ids


def local_status(home):
    programs, versions, unit_file, unit, ids = local_inventory(home)
    service = "not_installed"
    if unit:
        try:
            env = root_user_manager_environment() if os.geteuid() == 0 else None
            result = subprocess.run(["systemctl", "--user", "is-active", "--quiet", UNIT],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    env=env, timeout=5, check=False)
            service = "active" if result.returncode == 0 else "inactive_or_unconfirmed"
        except (OSError, ValueError, subprocess.SubprocessError):
            service = "inactive_or_unconfirmed"
    key = pathlib.Path(home) / STORE / "v2-identity.pem"
    policy = ("off" if os.geteuid() == 0 else native_auto_policy(key, ids["permanent"])) if "permanent" in ids else "off"
    update_result = None
    activity = "disabled"
    installed_version = None
    if "permanent" in ids:
        try:
            result = native_upgrade_result(key, ids["permanent"])
            root = owned_unit_root(unit, versions) if unit else None
            installed_version = None
            if root is not None:
                validated_owned_version(root)
                installed_version = json.loads((root / "bundle.json").read_text("utf8"))["version"]
            if result is not None:
                update_result = {field: result[field] for field in (
                    "status", "target_version", "installed_version", "updated_at_unix_ms")}
                update_result["current"] = installed_version == result["installed_version"]
            activity = native_update_activity(
                home, key, ids["permanent"], policy, result, installed_version)
        except (OSError, ValueError):
            update_result = {"status": "unknown"}
            activity = "unknown"
    local_service = {"active": "running_unverified",
                     "inactive_or_unconfirmed": "unconfirmed",
                     "not_installed": "not_installed"}[service]
    return {"installed_versions": sorted(x.name for x in versions),
            "installed_version": installed_version, "local_service": local_service,
            "local_permanent_service": service, "device_ids": ids,
            "automatic_update": policy, "automatic_update_activity": activity,
            "automatic_update_result": update_result,
            "cloud_authorization": "unconfirmed", "signed_wss": "unconfirmed",
            "read_only_access": "unconfirmed", "cloud_revoke": "not_performed",
            "temporary_expires_at": "server_authoritative_unconfirmed",
            "sqlite_receipts": "preserved"}


def validated_owned_version(p):
    f = p / "bundle.json"
    if f.is_symlink() or not f.is_file():
        raise ValueError("Missing/linked runtime manifest")
    manifest = json.loads(f.read_text("utf8"))
    if (manifest.get("name") != "remote-control-agent"
            or manifest.get("artifact_schema") != 1 or manifest.get("device_protocol") != 2
            or manifest.get("receipt_schema") != 1
            or manifest.get("artifact_profile") != "rust-native-only-v1"
            or manifest.get("agent_runtime") != "rust-standard-linux-v1"
            or manifest.get("candidate_profile") != "standard-linux-rust-runtime-v1"
            or manifest.get("target") not in LINUX_TARGETS
            or manifest.get("modules") != [] or "node" in manifest
            or "upgrade_protocol" in manifest
            or manifest.get("upgrade_profile") != "paired-full-v1"
            or p.name != manifest.get("version", "") + "-" + manifest.get("target", "")):
        raise ValueError("Unsupported installed Linux Agent; reinstall native Rust")
    candidate = p / APP / ".build/rca-standard-linux-candidate"
    try:
        candidate_info = candidate.lstat()
    except OSError:
        raise ValueError("Untrusted native Agent executable")
    if (not stat.S_ISREG(candidate_info.st_mode)
            or candidate_info.st_uid != os.geteuid()
            or candidate_info.st_nlink != 1 or candidate_info.st_mode & 0o077
            or not candidate_info.st_mode & 0o111):
        raise ValueError("Untrusted native Agent executable")
    observed = set()
    for parent, dirs, files in os.walk(p, followlinks=False):
        for name in dirs + files:
            file = pathlib.Path(parent) / name
            st = file.lstat()
            if st.st_uid != os.geteuid() or st.st_mode & 0o077 or not (
                    stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                raise ValueError("Untrusted file in v2 program")
            if stat.S_ISREG(st.st_mode):
                observed.add(file.relative_to(p).as_posix())
    expected = native_program_files(manifest, manifest.get("target"))
    if observed != expected:
        raise ValueError("Native-only program contains missing or unexpected files")
    if "session_runtime" in manifest:
        st = (p / APP / ".build/rca-session-linux-candidate").lstat()
        if st.st_nlink != 1 or not st.st_mode & 0o111:
            raise ValueError("Untrusted installed Session entry")
    return True


def owned_unit_root(unit, versions):
    if not unit:
        return None
    lines = unit.splitlines()
    cwd = [line.partition("=")[2] for line in lines if line.startswith("WorkingDirectory=")]
    start = [line.partition("=")[2] for line in lines if line.startswith("ExecStart=")]
    if len(cwd) != 1 or len(start) != 1:
        raise ValueError("Ambiguous v2 user service")
    root = pathlib.Path(cwd[0]).parent.parent
    if root not in versions:
        raise ValueError("Current v2 service does not belong to standalone installer")
    try:
        manifest = json.loads((root / "bundle.json").read_text("utf8"))
    except (OSError, ValueError):
        raise ValueError("Current v2 service manifest is unavailable")
    if manifest.get("artifact_profile") != "rust-native-only-v1":
        raise ValueError("Unsupported installed Linux Agent; reinstall native Rust")
    expected = str(root / APP / ".build/rca-standard-linux-candidate")
    if os.geteuid() == 0:
        expected += " --root-managed"
    if start[0] != expected:
        raise ValueError("Current v2 service runtime does not match its manifest")
    endpoint_lines = [line for line in lines
                      if line.startswith("Environment=REMOTE_CONTROL_AGENT_ENDPOINT=")]
    if len(endpoint_lines) != 1:
        raise ValueError("Ambiguous Rust service endpoint")
    endpoint = endpoint_lines[0][len("Environment=REMOTE_CONTROL_AGENT_ENDPOINT="):]
    home = pathlib.Path(root).parents[5]
    key = home / STORE / "v2-identity.pem"
    if unit != native_render_unit(root, endpoint, key):
        raise ValueError("Modified or foreign Rust service directives")
    dropins = home / ".config/systemd/user" / (UNIT + ".d")
    if dropins.exists() or dropins.is_symlink():
        raise ValueError("Rust service drop-ins must be reviewed")
    return root


def proc_has_no_live_userspace(status, process=None):
    if re.search(r"^State:[ \t]*Z\b", status, re.MULTILINE):
        return True
    kthread = re.search(r"^Kthread:[ \t]*(.*)$", status, re.MULTILINE)
    if kthread is not None:
        return kthread.group(1).strip() == "1"
    # Legacy kernels lack the status field; use the kernel task flags only.
    if process is None:
        return False
    try:
        data = (process / "stat").read_bytes()
        pid, _, tail = data.partition(b" (")
        if not tail or pid != os.fsencode(process.name):
            return False
        _, sep, fields = tail.rpartition(b") ")
        if not sep:
            return False
        flags = fields.split()[6]
        if not flags.isdigit():
            return False
        return bool(int(flags) & 0x00200000)  # Linux PF_KTHREAD
    except (OSError, ValueError, IndexError):
        return False


def no_running_programs(versions, proc_root=pathlib.Path("/proc")):
    """Fail closed on owned processes even when argv hides the executable.

    The local v2 unit is stopped before uninstall. A manually started Agent
    may still have its /proc/PID/exe or cwd within an installed version,
    regardless of how its command line was changed.
    """
    if not versions:
        return True
    prefixes = tuple(os.fsencode(str(v) + "/") for v in versions)
    for p in proc_root.iterdir():
        if not p.name.isdigit() or int(p.name) == os.getpid():
            continue
        try:
            if p.stat().st_uid != os.geteuid():
                continue
            status = (p / "status").read_text("ascii")
            if proc_has_no_live_userspace(status, p):
                continue  # Kernel thread or exited zombie cannot run the Agent.
            argv = (p / "cmdline").read_bytes().split(b"\0")
            if any(arg.startswith(prefix) for arg in argv for prefix in prefixes):
                return False
            # On systemd Linux, the exact per-user session managers may have
            # unreadable /proc/PID/exe and cwd. The exact manager identities below
            # are not Agent executables. Do not mistake their EACCES for an Agent.
            proc_name = re.search(r"^Name:\s*([^\n]+)", status, re.MULTILINE)
            if proc_name and argv and (proc_name.group(1).strip(), argv[0]) in (
                    ("systemd", b"/usr/lib/systemd/systemd"),
                    ("(sd-pam)", b"(sd-pam)")):
                continue
            for link in ("exe", "cwd"):
                resolved = os.fsencode(os.readlink(p / link))
                if any(resolved.startswith(prefix) for prefix in prefixes):
                    return False
        except (FileNotFoundError, ProcessLookupError):
            if p.exists():
                return False  # Process remains but its executable state vanished.
            continue  # Process exited during inspection.
        except OSError:
            return False  # Can't establish process ownership/state.
    return True


def owned_manager_launcher(home, versions):
    """Only an exact owned CLI symlink may be removed; foreign bin entries fail closed."""
    home = pathlib.Path(home)
    parent = home / ".local"
    directory = parent / "bin"
    for path in (parent, directory):
        if path.is_symlink() or (path.exists() and (
                not path.is_dir() or path.stat().st_uid != os.geteuid()
                or (os.geteuid() == 0 and path.stat().st_mode & 0o022))):
            raise ValueError("Untrusted user-local command directory")
    launcher = directory / "rca"
    if launcher.is_symlink():
        info = launcher.lstat()
        expected = [str(v / APP / "scripts/rca.sh") for v in versions]
        if info.st_uid != os.geteuid() or os.readlink(launcher) not in expected:
            raise ValueError("Foreign Agent manager launcher: refuse uninstall")
        return launcher
    if launcher.exists():
        raise ValueError("Foreign command named rca: refuse uninstall")
    return None


def local_uninstall(home, confirm, systemctl=None, process_check=no_running_programs):
    if not confirm:
        raise ValueError("Owner-only explicit local uninstall required")
    if os.geteuid() == 0:
        _, _, _, unit, _ = local_inventory(home)
        if unit:
            if not root_managed_unit(unit):
                raise ValueError("Refusing to uninstall a non-root-managed service as UID 0")
            root_user_manager_environment()
    # Native upgrades already hold this installer lock. Checking only durable
    # intent would race with an upgrade about to create that intent.
    local_inventory(home)
    base = pathlib.Path(home) / STORE
    if not base.exists():
        return _local_uninstall_locked(home, systemctl, process_check)
    private_dir(base)
    fd = os.open(base / "v2-installer.lock",
                 os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("Untrusted v2 installer lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another owner installer is active")
        return _local_uninstall_locked(home, systemctl, process_check)


def _local_uninstall_locked(home, systemctl, process_check):
    programs, versions, unit_file, unit, ids = local_inventory(home)
    # A cutover interrupted after freezing the current Agent can still need
    # both program versions for recovery. Never erase either one while its
    # durable intent, signed proof or original service backup is present.
    key = pathlib.Path(home) / STORE / "v2-identity.pem"
    pending_upgrade = (pathlib.Path(str(unit_file) + ".upgrade-backup"),
                       pathlib.Path(str(key) + ".native-upgrade-intent"),
                       pathlib.Path(str(key) + ".native-upgrade-proof"))
    if any(os.path.lexists(item) for item in pending_upgrade):
        raise ValueError("Unreconciled native upgrade; uninstall would destroy recovery")
    # Reject unknown program contents BEFORE recognizing or removing the CLI.
    for version in versions:
        validated_owned_version(version)
    launcher = owned_manager_launcher(home, versions)
    owned = owned_unit_root(unit, versions)
    # For an owned permanent user service, its explicit stop is required first;
    # refuse cleanup if any Agent remains after stopping it.
    if owned is None and not process_check(versions):
        raise ValueError("Active or uncertain v2 process; do not delete")
    if owned is not None:
        if systemctl is None:
            raise ValueError("Cannot stop owned service")
        systemctl(["--user", "disable", "--now", UNIT])
        if not process_check(versions):
            raise ValueError("v2 Agent still active after service stop")
        unit_file.unlink()
        systemctl(["--user", "daemon-reload"])
    for version in versions:
        shutil.rmtree(version)
    if launcher is not None:
        launcher.unlink()
    return {"removed_versions": [v.name for v in versions],
            "removed_owned_v2_service": owned is not None,
            "preserved_device_ids": ids, "preserved_keys_and_sqlite": True,
            "cloud_revocation": "NOT_PERFORMED"}


def local_identity_purge_plan(home):
    """Review exact v2 identity files; NEVER remove shared SQLite receipts."""
    programs, versions, unit_file, unit, ids = local_inventory(home)
    if versions or unit or unit_file.is_symlink():
        raise ValueError("Uninstall installer-owned v2 software before purging identity")
    base = pathlib.Path(home) / STORE
    if base.is_symlink():
        raise ValueError("Linked v2 identity directory")
    if not base.exists():
        return [], ids
    info = base.stat()
    if not base.is_dir() or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("Untrusted v2 identity directory")
    for relative in ("temporary",):
        directory = base / relative
        if directory.is_symlink() or (directory.exists() and (
                not directory.is_dir() or directory.stat().st_uid != os.geteuid()
                or stat.S_IMODE(directory.stat().st_mode) & 0o077)):
            raise ValueError("Unsafe v2 identity subdirectory")
    # A re-pair transaction or archived key requires deliberate operator
    # reconciliation. Never discard old or pending evidence implicitly.
    for item in base.iterdir():
        if item.name.startswith("revoked-") or item.name.endswith(
                (".re-pair-new", ".re-pair-transition", ".re-pair-new.device-id")):
            raise ValueError("Unresolved v2 re-pair/archive state; purge blocked")
    files = []
    for relative in ("v2-identity.pem", "v2-identity.pem.device-id",
                     "v2-identity.pem.automatic-update",
                     "v2-identity.pem.native-upgrade-result",
                     "temporary/v2-identity.pem",
                     "temporary/v2-identity.pem.device-id"):
        file = base / relative
        if file.is_symlink():
            raise ValueError("Linked identity file; purge blocked")
        if not file.exists():
            continue
        info = file.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("Untrusted v2 identity file; purge blocked")
        files.append(file)
    return files, ids


def local_identity_purge(home, confirm, process_check=None):
    if not confirm:
        raise ValueError("Explicit v2 identity purge confirmation required")
    files, ids = local_identity_purge_plan(home)
    if process_check is None:
        process_check = no_live_v2_identity_processes
    if not process_check():
        raise ValueError("Active or uncertain v2 pairing/Agent process; purge blocked")
    for file in files:
        file.unlink()
    return {"removed_identity_paths": [str(f) for f in files],
            "preserved_sqlite_receipts": True, "cloud_revocation": "NOT_PERFORMED",
            "previous_device_ids": ids}


def no_live_v2_identity_processes(proc_root=pathlib.Path("/proc")):
    # Purge is destructive even after uninstall: a detached or manually
    # started process can outlive its installed directory. Check the actual
    # executable as well as argv, and refuse uncertain same-user processes.
    # Old executable names remain negative safety checks, not upgrade support.
    def agent_path(value):
        if value.endswith(b" (deleted)"):
            value = value[:-len(b" (deleted)")]
        return (value.rsplit(b"/", 1)[-1] == b"rca-standard-linux-candidate"
                or b"/remote-control-agent/scripts/bootstrap-v2.py" in value
                or b"/remote-control-agent/src/v2-main." in value
                or b"/remote-control-agent/scripts/install-v2.mjs" in value
                or b"/remote-control-agent/src/pair-device." in value)

    for process in proc_root.iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            if process.stat().st_uid != os.geteuid():
                continue
            status = (process / "status").read_text("ascii")
            if proc_has_no_live_userspace(status, process):
                continue
            argv = (process / "cmdline").read_bytes().split(b"\0")
            if any(agent_path(arg) for arg in argv):
                return False
            # Same exact systemd user-manager exception as no_running_programs.
            proc_name = re.search(r"^Name:\s*([^\n]+)", status, re.MULTILINE)
            if proc_name and argv and (proc_name.group(1).strip(), argv[0]) in (
                    ("systemd", b"/usr/lib/systemd/systemd"),
                    ("(sd-pam)", b"(sd-pam)")):
                continue
            if agent_path(os.fsencode(os.readlink(process / "exe"))):
                return False
        except (FileNotFoundError, ProcessLookupError):
            if process.exists():
                return False
        except OSError:
            return False
    return True


def systemctl_user(args):
    env = root_user_manager_environment() if os.geteuid() == 0 else None
    result = subprocess.run(["systemctl"] + args, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, env=env, timeout=15, check=False)
    if result.returncode:
        raise ValueError("Owned v2 systemd user service action failed")


def main():
    parser = argparse.ArgumentParser(description="Verified Remote Control v2 GitHub Release bootstrap")
    parser.add_argument("--legacy", action="store_true", help="explicit pinned Linux x64 Legacy target")
    parser.add_argument("--tag")
    parser.add_argument("--commit")
    parser.add_argument("--endpoint")
    actions=parser.add_mutually_exclusive_group()
    actions.add_argument("--latest-archive", help="stable native archive verified by the public installer")
    actions.add_argument("--status", action="store_true")
    actions.add_argument("--stage-only", action="store_true",
                         help="verify and stage a separately pinned immutable Linux upgrade; never switch")
    actions.add_argument("--native-install", action="store_true",
                         help="owner-local Node-free Rust first install (permanent unless --temporary)")
    actions.add_argument("--native-upgrade", action="store_true",
                         help="owner-local native Rust signed WSS cutover")
    actions.add_argument("--uninstall", action="store_true")
    actions.add_argument("--recover-native", action="store_true",
                         help="owner-confirmed recovery of one interrupted native upgrade")
    actions.add_argument("--purge-local-identity", action="store_true",
                         help="separate explicit v2 key/ID purge after uninstall; shared SQLite retained")
    parser.add_argument("--temporary", action="store_true", help="native install in the foreground with a 24h grant")
    parser.add_argument("--name")
    parser.add_argument("--upgrade", action="store_true", help="manual owned v2 program upgrade only")
    parser.add_argument("--asset-sha256", help="independently reviewed SHA-256 for native staging, install or switch")
    parser.add_argument("--allow-root", action="store_true",
                        help="explicit local UID 0 first-install opt-in; independent terminal confirmation required")
    args = parser.parse_args()
    try:
        if args.legacy and (args.latest_archive is not None or not (args.stage_only or args.native_install or args.native_upgrade)):
            raise ValueError("Legacy requires an explicit pinned action")
        if args.status:
            print(json.dumps(local_status(str(account_home())), indent=2))
        elif args.recover_native:
            if not (sys.stdin.isatty() and sys.stdout.isatty()):
                raise ValueError("Native recovery requires an owner interactive terminal")
            if os.geteuid() == 0:
                root_recovery_preflight(account_home())
            print("Recover the previous local Agent service, or remove an interrupted first activation; identity retained.")
            if not confirm_owner("Recover the local Agent service?"):
                raise ValueError("Native recovery not confirmed")
            print(json.dumps(native_recover(account_home()), indent=2))
        elif args.uninstall:
            if not (sys.stdin.isatty() and sys.stdout.isatty()):
                raise ValueError("Local uninstall requires an interactive terminal")
            _, versions, _, _, ids = local_inventory(str(account_home()))
            print("Owned local v2 versions:", ", ".join(v.name for v in versions))
            print("Device IDs (cloud grants will NOT be revoked):", ids)
            print("Private keys and SQLite receipts will be retained; use MCP revoke_device separately.")
            if not confirm_owner("Remove the listed local Agent installations?"):
                raise ValueError("Local uninstall not confirmed")
            print(json.dumps(local_uninstall(str(account_home()), True, systemctl_user), indent=2))
        elif args.purge_local_identity:
            if not (sys.stdin.isatty() and sys.stdout.isatty()):
                raise ValueError("Local identity purge requires an interactive terminal")
            home = str(account_home())
            local_inventory(home)  # Reject unowned path components before opening lock.
            base = pathlib.Path(home) / STORE
            if not base.is_dir() or base.is_symlink() or base.stat().st_uid != os.geteuid() \
                    or stat.S_IMODE(base.stat().st_mode) & 0o077:
                raise ValueError("No safe v2 identity directory to purge")
            # Existing v2 installer flock: avoid racing local pairing or re-pair.
            fd = os.open(base / "v2-installer.lock",
                         os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "r+b") as lock:
                info = os.fstat(lock.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() \
                        or stat.S_IMODE(info.st_mode) != 0o600:
                    raise ValueError("Untrusted v2 installer lock")
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise ValueError("Another v2 installer is running")
                files, ids = local_identity_purge_plan(home)
                print("Exact v2-only identity files:", *(str(f) for f in files),
                      sep="\\n  ")
                print("Device IDs:", ids)
                print("Cloud authorization has NOT been revoked. In authenticated MCP,",
                      "call revoke_device separately BEFORE discarding the local key.")
                print("SQLite receipts and historical/local operation evidence are",
                      "shared and WILL NOT be deleted. Already executed effects persist.")
                if not confirm_owner("Irreversibly remove only the listed keys/IDs?"):
                    raise ValueError("Local identity purge not confirmed")
                print(json.dumps(local_identity_purge(home, True), indent=2))
        elif args.latest_archive is not None:
            if not args.tag or not args.endpoint or args.commit or args.name:
                raise ValueError("Public archive requires stable tag, origin and reviewed SHA-256")
            if args.temporary and args.upgrade:
                raise ValueError("Temporary mode is only available for first installation")
            install(args.tag, None, args.endpoint, asset_sha256=args.asset_sha256,
                    native_upgrade=args.upgrade, native_install=not args.upgrade,
                    temporary=args.temporary, latest_archive=args.latest_archive,
                    allow_root=args.allow_root)
        else:
            if not args.tag or not args.commit or not args.endpoint:
                raise ValueError("Pinned --tag, --commit, and --endpoint are required")
            install(args.tag, args.commit, args.endpoint, args.name, args.upgrade,
                    args.stage_only, args.asset_sha256, args.native_upgrade, args.native_install,
                    args.temporary, allow_root=args.allow_root, legacy=args.legacy)
    except (EOFError, KeyboardInterrupt):
        print("Local operation cancelled; check status for any already completed effects.", file=sys.stderr)
        return 1
    except ValueError as exc:
        # Only messages from explicitly authored validation branches.
        print("Standalone v2 install refused: " + str(exc), file=sys.stderr)
        return 1
    except (OSError, KeyError, json.JSONDecodeError, tarfile.TarError,
            urllib.error.URLError):
        # Network errors may include signed GitHub redirect URLs; never log them.
        print("Standalone v2 install refused: release network, filesystem or archive error.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
