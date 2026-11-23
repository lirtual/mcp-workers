#!/usr/bin/env python3
"""Pinned, public-GitHub-only bootstrap for the standalone v2 Agent.

Reviewed source MUST be fetched from an immutable commit URL, not 'main' or
'latest'. Python 3 stdlib is the initial bootstrap dependency; no local Node,
git, pnpm or compiler is required on the target host. This entrypoint is not
advertised until a real immutable Release is explicitly approved.
"""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import platform
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
import urllib.error
import urllib.parse
import urllib.request

OWNER = "lirtual/mcp-workers"
API = "https://api.github.com/repos/" + OWNER
APP = "apps/remote-control-agent"
MAX_ARCHIVE = 180 * 1024 * 1024
MAX_UNPACK = 240 * 1024 * 1024
MAX_FILES = 80
META_LIMIT = 1024 * 1024
ALLOWED_HOSTS = frozenset((
    "api.github.com", "github.com",
    "release-assets.githubusercontent.com", "objects.githubusercontent.com"
))
ALLOWED_DIRS = frozenset((
    "bin", "apps", APP, APP + "/src",
    APP + "/scripts", APP + "/.build"
))
ALLOWED_FILES = frozenset((
    "bin/node", "bundle.json", APP + "/package.json",
    APP + "/.build/rca-standard-linux-candidate",
    APP + "/scripts/install-v2.mjs", APP + "/scripts/bootstrap-v2.py",
    APP + "/scripts/manage-v2.py", APP + "/.build/session-supervisor",
    APP + "/scripts/bootstrap-node.mjs", APP + "/scripts/manage-v2.mjs",
    APP + "/scripts/lifecycle-v2.mjs", APP + "/scripts/upgrade-v2.mjs",
    APP + "/scripts/upgrade-existing-service.mjs",
    APP + "/scripts/linux-upgrade-detached.mjs",
    APP + "/scripts/linux-upgrade-watchdog.mjs",
    APP + "/scripts/verify-v2-release.mjs", APP + "/scripts/rca.sh",
))
ELF_FILES = frozenset(("bin/node", APP + "/.build/session-supervisor",
                        APP + "/.build/rca-standard-linux-candidate"))
EXEC_FILES = frozenset(("bin/node", APP + "/.build/session-supervisor"))
NODE_REQUIRED = frozenset((
    APP + "/scripts/bootstrap-node.mjs", APP + "/scripts/manage-v2.mjs",
    APP + "/scripts/lifecycle-v2.mjs", APP + "/scripts/upgrade-v2.mjs",
    APP + "/scripts/verify-v2-release.mjs", APP + "/scripts/rca.sh",
))
LEGACY_REQUIRED = frozenset((
    APP + "/scripts/bootstrap-v2.py", APP + "/scripts/manage-v2.py",
))
TAG = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
HASH = re.compile(r"sha256:([0-9a-f]{64})\Z")


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
    if not TAG.fullmatch(tag) or not SHA.fullmatch(commit) or target not in (
            "linux-x64-glibc", "linux-arm64-glibc"):
        raise ValueError("Pinned tag/commit/target missing or invalid")
    release = json_api("/releases/tags/" + tag)
    if (release.get("immutable") is not True
            or release.get("draft") is not False
            or ("-rust-candidate" in tag and release.get("prerelease") is not True)
            or release.get("tag_name") != tag
            or not isinstance(release.get("id"), int)):
        raise ValueError("This Release is not published and immutable")
    reference = json_api("/git/ref/tags/" + tag)
    if reference.get("ref") != "refs/tags/" + tag:
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
    download = "https://github.com/" + OWNER + "/releases/download/" + tag + "/" + name
    if (not digest or asset.get("state") != "uploaded"
            or not isinstance(asset.get("id"), int) or asset["id"] < 1
            or not isinstance(asset.get("size"), int)
            or not 1024 <= asset["size"] <= MAX_ARCHIVE
            or asset.get("url") != API + "/releases/assets/" + str(asset["id"])
            or asset.get("browser_download_url") != download):
        raise ValueError("Release asset digest, ID, URL or length invalid")
    return {"download": download, "size": asset["size"], "digest": digest.group(1)}


def safe_member(name, directory):
    name = name[:-1] if directory and name.endswith("/") else name
    if (not name or len(name) > 160 or name.startswith("/")
            or "\\" in name or any(part in ("", ".", "..") for part in name.split("/"))
            or not re.fullmatch(r"[A-Za-z0-9._/-]+", name)):
        raise ValueError("Unsafe archive pathname")
    if directory:
        if name not in ALLOWED_DIRS:
            raise ValueError("Unexpected archive directory")
    elif name not in ALLOWED_FILES and not re.fullmatch(
            re.escape(APP) + r"/src/[a-z0-9-]+\.js", name):
        raise ValueError("Unexpected archive file")
    return name


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
        agent_runtime = manifest.get("agent_runtime", "node-v2")
        rust_candidate = agent_runtime == "rust-standard-linux-v1"
        native_only = manifest.get("artifact_profile") == "rust-native-only-v1"
        native_files = {"bundle.json", APP + "/.build/session-supervisor",
                        APP + "/.build/rca-standard-linux-candidate",
                        APP + "/scripts/bootstrap-v2.py", APP + "/scripts/manage-v2.py",
                        APP + "/scripts/rca.sh"}
        if native_only:
            files = {name for name, member in records if member.isfile()}
            if files != native_files:
                raise ValueError("Native-only archive must contain only reviewed Rust files")
        else:
            if not EXEC_FILES.issubset(names) or APP + "/src/v2-main.js" not in names \
                    or APP + "/scripts/install-v2.mjs" not in names:
                raise ValueError("Incomplete Agent Release archive")
            # Historical reviewed Node and mixed Rust-Node migration layouts.
            node_profile = bool(names & NODE_REQUIRED)
            required = NODE_REQUIRED if node_profile else LEGACY_REQUIRED
            if not required.issubset(names):
                raise ValueError("Missing reviewed Agent manager/bootstrap files")
        if (manifest.get("artifact_schema") != 1 or manifest.get("name") != "remote-control-agent"
                or manifest.get("version") != tag or manifest.get("target") != target
                or (native_only and (not rust_candidate
                    or manifest.get("node") is not None
                    or manifest.get("modules") != []
                    or "upgrade_protocol" in manifest))
                or (not native_only and (
                    not re.fullmatch(r"v24\.[0-9]+\.[0-9]+", str(manifest.get("node", "")))
                    or "artifact_profile" in manifest))
                or agent_runtime not in ("node-v2", "rust-standard-linux-v1")
                or (rust_candidate and (
                    manifest.get("candidate_profile") != "standard-linux-rust-runtime-v1"
                    or (not native_only and not re.search(r"-rust-candidate(?:\.|$)", tag))
                    or not target.startswith("linux-")
                    or APP + "/.build/rca-standard-linux-candidate" not in names
                    or APP + "/scripts/manage-v2.py" not in names))
                or (not rust_candidate and (
                    manifest.get("candidate_profile") == "standard-linux-rust-runtime-v1"
                    or APP + "/.build/rca-standard-linux-candidate" in names))):
            raise ValueError("Bundle version, runtime profile, or architecture mismatch")
        # A remote-capable archive must contain the complete packaged
        # stage/rollback implementation; old local-only Releases still work.
        if "upgrade_protocol" in manifest:
            required_one_shot = {APP + "/scripts/" + item for item in (
                "bootstrap-v2.py", "linux-upgrade-detached.mjs",
                "linux-upgrade-watchdog.mjs")}
            if (manifest["upgrade_protocol"] != "owner-one-shot-v1"
                    or not required_one_shot.issubset(names)):
                raise ValueError("Incomplete reviewed Linux one-shot Release")
        # The official manifest is covered by the GitHub asset SHA-256.
        # Refuse ABI-incompatible binaries before unpacking OR executing Node.
        minimum = str(manifest.get("glibc_min", ""))
        if not re.fullmatch(r"[0-9]+\.[0-9]+", minimum):
            raise ValueError("Missing or invalid Release glibc ABI requirement")
        host_libc, host_version = platform.libc_ver()
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
            or path.stat().st_uid != os.getuid()
            or stat.S_IMODE(path.stat().st_mode) & 0o077)):
        raise ValueError("Unsafe installer-owned directory or symlink")
    if not path.exists():
        path.mkdir(mode=0o700)
    return path


def program_home(home):
    # Do not follow a symlink from HOME through a privilege-bearing directory.
    home = pathlib.Path(home)
    if not home.is_dir() or home.is_symlink() or home.stat().st_uid != os.getuid():
        raise ValueError("Invalid device HOME")
    node = home
    for name in (".local", "share"):
        node = node / name
        if node.is_symlink():
            raise ValueError("Symlink in installer parent path")
        if not node.exists():
            node.mkdir(mode=0o700)
        if not node.is_dir() or node.stat().st_uid != os.getuid():
            raise ValueError("Invalid installer parent ownership")
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
                if name in EXEC_FILES or name == APP + "/.build/rca-standard-linux-candidate" or name in (
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
            if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
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
        if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077                 or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
            raise ValueError("Untrusted leftover staging file needs manual review")
        if stat.S_ISDIR(st.st_mode):
            shutil.rmtree(entry)
        else:
            entry.unlink()


def preflight(tag, commit, endpoint, stage_only=False):
    # Remote staging is data-only; the existing manual installer still demands
    # a real console, and no noninteractive path may pair or switch systemd.
    if (sys.platform != "linux" or os.getuid() == 0
            or (not stage_only and
                (not sys.stdin.isatty() or not sys.stdout.isatty()))):
        raise ValueError("Run as a non-root Linux user in a real interactive terminal")
    cpu = platform.machine().lower()
    if cpu not in ("x86_64", "aarch64"):
        raise ValueError("Only Linux x86_64 and ARM64 are supported")
    kernel = re.match(r"^([0-9]+)\.([0-9]+)", platform.release())
    if not kernel or (int(kernel[1]), int(kernel[2])) < (6, 9):
        raise ValueError("Linux kernel 6.9+ is needed for pidfd group safety")
    libc, ver = platform.libc_ver()
    if libc != "glibc" or not re.match(r"^\d+\.\d+$", ver) \
            or tuple(map(int, ver.split("."))) < (2, 28):
        raise ValueError("glibc 2.28+ required; musl is unsupported")
    uri = urllib.parse.urlsplit(endpoint)
    if (uri.scheme != "https" or not uri.hostname or uri.username or uri.password
            or uri.query or uri.fragment or uri.path not in ("", "/")):
        raise ValueError("Supply the reviewed HTTPS Worker origin, without credentials")
    if not TAG.fullmatch(tag) or not SHA.fullmatch(commit):
        raise ValueError("Pinned Release tag and commit are required")
    return "linux-" + ("x64" if cpu == "x86_64" else "arm64") + "-glibc"


def install(tag, commit, endpoint, name=None, upgrade=False,
            stage_only=False, asset_sha256=None, native_upgrade=False):
    if stage_only or native_upgrade:
        if (name is not None or upgrade or
                not isinstance(asset_sha256, str) or
                not re.fullmatch(r"[0-9a-f]{64}", asset_sha256)):
            scope = "Stage-only" if stage_only else "Native upgrade"
            raise ValueError(scope + " requires a reviewed SHA-256 and no Node install action")
    elif asset_sha256 is not None:
        raise ValueError("An asset SHA-256 is only accepted for stage-only or native upgrade")
    target = preflight(tag, commit, endpoint, stage_only=stage_only)
    print("==> Detected Linux target: " + target + " | Release " + tag, flush=True)
    location = program_home(os.path.expanduser("~"))
    version = location / (tag + "-" + target)
    # Existing lock + protected OS state: no new installer state database.
    with open(location / "install.lock", "a+b") as lock:
        os.chmod(location / "install.lock", 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another v2 standalone installer is already running")
        clean_orphaned_staging(location)
        print("==> Resolving immutable GitHub Release and exact source commit", flush=True)
        pinned = resolve_pinned(tag, commit, target)
        # Release API metadata is insufficient by itself: independent owner
        # review of the exact architecture's asset SHA-256 is mandatory.
        if (stage_only or native_upgrade) and pinned["digest"] != asset_sha256:
            raise ValueError("Reviewed SHA-256 differs from immutable GitHub Release metadata")
        archive_path = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".download-", dir=location, delete=False) as f:
                archive_path = pathlib.Path(f.name)
                os.chmod(archive_path, 0o600)
                print("==> Downloading verified native Agent package", flush=True)
                data = fetch(pinned["download"], "application/octet-stream", MAX_ARCHIVE)
                if (len(data) != pinned["size"] or hashlib.sha256(data).hexdigest() != pinned["digest"]):
                    raise ValueError("Official GitHub SHA-256 or byte length mismatch")
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            print("==> SHA-256 verified; inspecting archive and system ABI", flush=True)
            records = inspect_archive(archive_path, tag, target)
            with tarfile.open(archive_path, "r:gz") as tf:
                manifest = json.load(tf.extractfile(tf.getmember("bundle.json")))
            native_only = manifest.get("artifact_profile") == "rust-native-only-v1"
            if native_only and not (stage_only or native_upgrade):
                raise ValueError("Native-only Rust requires explicit trusted handoff")
            if native_upgrade and not native_only:
                raise ValueError("Native handoff requires a Node-free Rust archive")
            if stage_only and (manifest.get("upgrade_profile") != "paired-full-v1" or
                    manifest.get("device_protocol") != 2 or
                    manifest.get("receipt_schema") != 1 or
                    (not native_only and
                     manifest.get("upgrade_protocol") != "owner-one-shot-v1")):
                raise ValueError("Linux release lacks reviewed protocol readiness for staging")
            if version.exists() or version.is_symlink():
                verify_existing_program(archive_path, version, records)
            else:
                unpack_verified(archive_path, version, records, tag, target)
        finally:
            if archive_path is not None:
                archive_path.unlink(missing_ok=True)
        print("==> Verified runtime staged: " + str(version), flush=True)
        if stage_only:
            # No install-v2, systemctl, identity mutation, approval or pairing.
            return
        if native_upgrade:
            print("Signed WSS must be proven after switch; identity and SQLite remain unchanged.")
            if input("Type NATIVE-UPGRADE for this owner-local service switch: ").strip() != "NATIVE-UPGRADE":
                raise ValueError("Native service switch not confirmed")
            result = native_cutover(pathlib.Path.home(), version, endpoint)
            print(json.dumps(result, indent=2))
            return
        binary = version / "bin/node"
        command = [str(binary), str(version / APP / "scripts/install-v2.mjs"),
                   "--endpoint", endpoint]
        if name:
            command += ["--name", name]
        if upgrade:
            command += ["--upgrade"]
        print("Verified GitHub Release " + tag + " for " + target
              + ". Local permanent/temporary pairing requires independent MCP approval.",
              flush=True)
        # Only the cryptographically checked, safe-unpacked program runs.
        os.execv(str(binary), command)



# One owner-approved Linux service transaction, reused for later Node-free
# upgrades. There is no second Agent runtime, receipt ledger, or daemon.
def native_render_unit(root, endpoint, key):
    if not all(re.fullmatch(r"/[A-Za-z0-9_./-]+", str(p))
               for p in (root, key)):
        raise ValueError("Unsupported systemd path character")
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?/", endpoint):
        raise ValueError("Untrusted canonical service endpoint")
    manifest = json.loads((root / "bundle.json").read_text("utf8"))
    native = manifest.get("artifact_profile") == "rust-native-only-v1"
    if native:
        program = root / APP / ".build/rca-standard-linux-candidate"
    elif manifest.get("agent_runtime", "node-v2") == "node-v2":
        program = str(root / "bin/node") + " " + str(root / APP / "src/v2-main.js")
    else:
        raise ValueError("Only an installed Node or native-only Agent can transition")
    return "\n".join((
        MARKER, "[Unit]",
        "Description=Remote Control Agent (signed outbound WSS)",
        "StartLimitIntervalSec=0", "", "[Service]", "Type=simple",
        "WorkingDirectory=" + str(root / APP),
        "Environment=REMOTE_CONTROL_AGENT_ENDPOINT=" + endpoint,
        "Environment=REMOTE_CONTROL_AGENT_KEY_PATH=" + str(key),
        "UMask=0077",
        "ExecStartPre=/usr/bin/test -r " + str(key),
        "ExecStartPre=/usr/bin/test -r " + str(key) + ".device-id",
        "ExecStartPre=/usr/bin/test -x " + str(root / APP / ".build/session-supervisor"),
        "ExecStart=" + str(program), "Restart=on-failure", "RestartSec=15s",
        "TimeoutStopSec=15s", "", "[Install]", "WantedBy=default.target", ""
    ))


def native_owned_file(path, max_bytes=4096):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
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


def native_create_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        native_sync_parent(path)


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


def native_systemctl(*args):
    completed = subprocess.run(["systemctl", "--user", *args],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               timeout=20, check=False)
    if completed.returncode:
        raise ValueError("Agent systemd action failed; inspect the preserved upgrade backup")
    return completed.stdout.decode("ascii", errors="strict")


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


def native_consent(key, action):
    import socket
    endpoint = key.with_name("upgrade.sock")
    info = endpoint.lstat()
    if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077):
        raise ValueError("Untrusted Agent freeze socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect(str(endpoint))
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


def native_wait_proof(path, operation, device_id, version, seconds=90):
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
            if (set(proof) != {"operation_id", "device_id", "target_version", "status"}
                    or proof["operation_id"] != operation
                    or proof["device_id"] != device_id
                    or proof["target_version"] != version
                    or proof["status"] != "authenticated_wss"):
                raise ValueError("Signed Rust WSS proof does not match this attempt")
            return True
        time.sleep(0.25)
    return False


def native_receipts_compatible(home):
    # Match the existing Node installer read-only header contract. Do not
    # acquire a second SQLite writer while the old Agent remains online.
    directory = home / ".local/state/mcp-workers/remote-control-agent"
    if not directory.exists():
        if directory.is_symlink():
            raise ValueError("Redirected receipt directory")
        return
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
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
                metadata.st_uid != os.getuid() or
                metadata.st_nlink != 1 or metadata.st_mode & 0o077):
            raise ValueError("Untrusted SQLite receipt file")
        header = os.read(fd, 100)
        if (len(header) != 100 or header[:16] != b"SQLite format 3\x00"
                or int.from_bytes(header[60:64], "big") not in (0, 1)):
            raise ValueError("Incompatible SQLite receipt schema")
    finally:
        os.close(fd)


def native_cutover(home, new_root, endpoint, verify=native_wait_proof):
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
    if (manifest.get("artifact_profile") != "rust-native-only-v1"
            or manifest.get("agent_runtime") != "rust-standard-linux-v1"):
        raise ValueError("Upgrade target must be the reviewed Node-free Rust archive")
    key = home / STORE / "v2-identity.pem"
    key_before = hashlib.sha256(native_owned_file(key, 8192)).hexdigest()
    device_id = native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip()
    if ids["permanent"] != device_id:
        raise ValueError("Existing device identity has changed")
    native_receipts_compatible(home)
    if current != native_render_unit(old_root, endpoint, key):
        raise ValueError("Unknown or modified installed systemd unit")
    next_unit = native_render_unit(new_root, endpoint, key)
    if (unit_file.parent / (UNIT + ".d")).exists() or (unit_file.parent / (UNIT + ".d")).is_symlink():
        raise ValueError("Unexpected systemd drop-ins")
    if (unit_file.parent / "remote-control-v2-agent.service").exists():
        raise ValueError("Conflicting historical Agent service")
    if pathlib.Path(str(key) + ".owner-stopped").exists():
        raise ValueError("Owner Stop cannot silently become online")
    native_launcher(home, old_root)
    backup = pathlib.Path(str(unit_file) + ".upgrade-backup")
    intent = pathlib.Path(str(key) + ".native-upgrade-intent")
    proof = pathlib.Path(str(key) + ".native-upgrade-proof")
    if any(os.path.lexists(item) for item in (backup, intent, proof)):
        raise ValueError("Unreconciled previous upgrade; preserve evidence for recovery")
    # The Node installer owns this existing lock. Never race its pairing/repair.
    lock_path = home / STORE / "v2-installer.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o777 != 0o600):
            raise ValueError("Untrusted v2 installer lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another owner installer is active")
        pid = native_main_pid()
        # The service entrypoint must be the version whose socket we freeze.
        expected_binary = old_root / ("apps/remote-control-agent/.build/rca-standard-linux-candidate"
                                     if "rust-native-only-v1" ==
                                     json.loads((old_root / "bundle.json").read_text("utf8")).get("artifact_profile")
                                     else "bin/node")
        if native_process_executable(pid) != expected_binary:
            raise ValueError("Service process differs from frozen Agent")
        if native_consent(key, "freeze") != "ready":
            raise ValueError("Agent has running or unknown operations; upgrade refused")
        switched = False
        operation = secrets.token_hex(16)
        try:
            if (native_consent(key, "verify-frozen") != "ready"
                    or native_main_pid() != pid
                    or unit_file.read_text("utf8") != current
                    or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_before):
                raise ValueError("Agent changed during freeze")
            native_create_file(intent, json.dumps({
                "operation_id": operation, "device_id": device_id,
                "target_version": new_root.name
            }, separators=(",", ":")).encode())
            native_create_file(backup, current.encode())
            native_atomic_file(unit_file, next_unit.encode())
            switched = True
            native_systemctl("daemon-reload")
            native_systemctl("restart", UNIT)
            new_pid = native_main_pid()
            if native_process_executable(new_pid) != (
                    new_root / APP / ".build/rca-standard-linux-candidate"):
                raise ValueError("systemd did not activate the native Rust executable")
            if not verify(proof, operation, device_id, new_root.name):
                raise ValueError("New Rust Agent signed WSS was not confirmed")
            # A proof from a Rust process that exited/restarted during the
            # handshake does not authenticate its replacement. Keep the
            # systemd instance that produced the signed WSS evidence.
            if (native_main_pid() != new_pid
                    or native_process_executable(new_pid) != (
                        new_root / APP / ".build/rca-standard-linux-candidate")
                    or unit_file.read_text("utf8") != next_unit
                    or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_before
                    or native_owned_file(pathlib.Path(str(key) + ".device-id"), 128).decode().strip() != device_id):
                raise ValueError("Rust process, identity or systemd unit changed after WSS")
            native_launcher(home, old_root, new_root)
            for item in (intent, proof, backup):
                item.unlink()
                native_sync_parent(item)
            return {"status": "active", "version": new_root.name,
                    "signed_wss": True, "identity_preserved": True}
        except Exception as error:
            if switched or backup.exists():
                try:
                    native_atomic_file(unit_file, current.encode())
                    native_systemctl("daemon-reload")
                    native_systemctl("restart", UNIT)
                    restored_pid = native_main_pid()
                    if (native_process_executable(restored_pid) != expected_binary
                            or unit_file.read_text("utf8") != current
                            or hashlib.sha256(native_owned_file(key, 8192)).hexdigest() != key_before):
                        raise ValueError("Rollback process, identity or unit mismatch")
                    native_restore_launcher(home, old_root, new_root)
                except Exception:
                    # The durable old unit remains available for attended recovery.
                    raise ValueError("Native upgrade failed; rollback uncertain; backup retained") from None
            # No service switch or a verified old unit: evidence can be retired.
            for item in (proof, backup, intent):
                if os.path.lexists(item):
                    item.unlink()
                    native_sync_parent(item)
            raise ValueError("Native upgrade refused or safely rolled back") from error
        finally:
            if not switched:
                try:
                    native_consent(key, "release")
                except Exception:
                    pass

UNIT = "remote-control-agent.service"
MARKER = "# Managed by Remote Control Agent installer."
STORE = pathlib.Path(".local/share/mcp-workers/remote-control")


def local_inventory(home):
    home = pathlib.Path(home)
    if home.is_symlink() or not home.is_dir() or home.stat().st_uid != os.getuid():
        raise ValueError("Untrusted account home")
    base = home / STORE
    # Never follow a link in any trusted uninstall root component.
    for relative in (".local", ".local/share", ".local/share/mcp-workers",
                     str(STORE), str(STORE / "programs"),
                     ".config", ".config/systemd", ".config/systemd/user"):
        item = home / relative
        if item.is_symlink() or (item.exists() and
                (not item.is_dir() or item.stat().st_uid != os.getuid())):
            raise ValueError("Linked or unowned path in v2 install tree")
    programs = base / "programs"
    unit_file = home / ".config/systemd/user" / UNIT
    if programs.is_symlink() or unit_file.is_symlink():
        raise ValueError("Untrusted v2 installation symlink")
    versions = []
    if programs.exists():
        if not programs.is_dir() or programs.stat().st_uid != os.getuid():
            raise ValueError("Untrusted program directory")
        for p in programs.iterdir():
            if p.name == "install.lock" or p.name.startswith((".download-", ".unverified-")):
                continue
            if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?-linux-(?:x64|arm64)-glibc", p.name) \
                    or p.is_symlink() or not p.is_dir() or p.stat().st_uid != os.getuid():
                raise ValueError("Unknown version entry: do not remove")
            versions.append(p)
    unit = None
    if unit_file.exists():
        if unit_file.stat().st_uid != os.getuid() or not unit_file.is_file():
            raise ValueError("Unowned v2 user service")
        unit = unit_file.read_text("utf8")
        if not unit.startswith(MARKER + "\n"):
            raise ValueError("Foreign user service; do not remove")
    ids = {}
    for mode, relative in (("permanent", "v2-identity.pem"),
                           ("temporary", "temporary/v2-identity.pem")):
        f = pathlib.Path(str(base / relative) + ".device-id")
        if f.is_symlink():
            raise ValueError("Linked identity ID")
        if f.exists():
            st = f.stat()
            if not f.is_file() or st.st_uid != os.getuid() or st.st_mode & 0o077:
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
        result = subprocess.run(["systemctl", "--user", "is-active", "--quiet", UNIT],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=5, check=False)
        service = "active" if result.returncode == 0 else "inactive_or_unconfirmed"
    return {"installed_versions": sorted(x.name for x in versions),
            "local_permanent_service": service, "device_ids": ids,
            "cloud_authorization": "unconfirmed", "signed_wss": "unconfirmed",
            "read_only_access": "unconfirmed", "cloud_revoke": "not_performed",
            "temporary_expires_at": "server_authoritative_unconfirmed",
            "sqlite_receipts": "preserved"}


def validated_owned_version(p):
    f = p / "bundle.json"
    source = p / APP / "src/v2-main.js"
    if f.is_symlink() or not f.is_file():
        raise ValueError("Missing/linked runtime manifest")
    manifest = json.loads(f.read_text("utf8"))
    agent_runtime = manifest.get("agent_runtime", "node-v2")
    native_only = manifest.get("artifact_profile") == "rust-native-only-v1"
    if native_only:
        if (agent_runtime != "rust-standard-linux-v1" or source.exists() or source.is_symlink()
                or manifest.get("modules") != [] or manifest.get("node") is not None
                or manifest.get("upgrade_protocol") is not None):
            raise ValueError("Untrusted native-only Rust program")
    elif source.is_symlink() or not source.is_file():
        raise ValueError("Missing/linked runtime source")
    if agent_runtime == "rust-standard-linux-v1":
        candidate = p / APP / ".build/rca-standard-linux-candidate"
        try:
            candidate_info = candidate.lstat()
        except OSError:
            raise ValueError("Untrusted Rust Agent candidate")
        if (manifest.get("candidate_profile") != "standard-linux-rust-runtime-v1"
                or not stat.S_ISREG(candidate_info.st_mode)
                or candidate_info.st_uid != os.getuid()
                or candidate_info.st_nlink != 1
                or candidate_info.st_mode & 0o077
                or not candidate_info.st_mode & 0o111):
            raise ValueError("Untrusted Rust Agent candidate")
    elif agent_runtime != "node-v2":
        raise ValueError("Unknown installed Agent runtime")
    if (manifest.get("artifact_schema") != 1 or manifest.get("device_protocol") != 2
            or manifest.get("receipt_schema") != 1
            or p.name != manifest.get("version") + "-" + manifest.get("target")
            or not (
                (native_only and manifest.get("upgrade_profile") == "paired-full-v1") or
                (manifest.get("upgrade_profile") == "read-only-no-shell-v1" and
                 re.search(r"readOnly:\s*true,\s*writeFile:\s*false,\s*shell:\s*false,",
                           source.read_text("utf8"))) or
                (not native_only and manifest.get("upgrade_profile") == "paired-full-v1" and
                 re.search(r'V2_RUNTIME_PROFILE\s*=\s*"paired-full-v1"',
                           source.read_text("utf8")) and
                 not re.search(r"(?:readOnly|writeFile|shell)\s*:",
                               source.read_text("utf8"))))):
        raise ValueError("Unverified or Shell-enabled Agent; cannot uninstall")
    observed = set()
    for parent, dirs, files in os.walk(p, followlinks=False):
        for name in dirs + files:
            file = pathlib.Path(parent) / name
            st = file.lstat()
            if st.st_uid != os.getuid() or st.st_mode & 0o077 or not (
                    stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                raise ValueError("Untrusted file in v2 program")
            if stat.S_ISREG(st.st_mode):
                observed.add(file.relative_to(p).as_posix())
    if native_only:
        expected = {"bundle.json", str(pathlib.Path(APP) / ".build/session-supervisor"),
                    str(pathlib.Path(APP) / ".build/rca-standard-linux-candidate"),
                    str(pathlib.Path(APP) / "scripts/bootstrap-v2.py"),
                    str(pathlib.Path(APP) / "scripts/manage-v2.py"), str(pathlib.Path(APP) / "scripts/rca.sh")}
        if observed != expected:
            raise ValueError("Native-only program contains missing or unexpected files")
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
    agent_runtime = manifest.get("agent_runtime", "node-v2")
    expected = (str(root / APP / ".build/rca-standard-linux-candidate")
                if agent_runtime == "rust-standard-linux-v1"
                else str(root / "bin/node") + " " + str(root / APP / "src/v2-main.js"))
    if start[0] != expected:
        raise ValueError("Current v2 service runtime does not match its manifest")
    if manifest.get("artifact_profile") == "rust-native-only-v1":
        # The Rust service must match the reviewed Node installer systemd
        # template byte-for-byte. No unknown ExecStopPost, drop-ins, etc.
        endpoint_lines = [line for line in lines
                          if line.startswith("Environment=REMOTE_CONTROL_AGENT_ENDPOINT=")]
        if len(endpoint_lines) != 1:
            raise ValueError("Ambiguous Rust service endpoint")
        endpoint = endpoint_lines[0].removeprefix("Environment=REMOTE_CONTROL_AGENT_ENDPOINT=")
        parsed = urllib.parse.urlsplit(endpoint)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment
                or parsed.path != "/" or "\n" in endpoint):
            raise ValueError("Untrusted Rust service endpoint")
        home = pathlib.Path(root).parents[5]
        key = home / STORE / "v2-identity.pem"
        app = root / APP
        expected_unit = "\n".join([
            MARKER, "[Unit]",
            "Description=Remote Control Agent (signed outbound WSS)",
            "StartLimitIntervalSec=0", "", "[Service]", "Type=simple",
            "WorkingDirectory=" + str(app),
            "Environment=REMOTE_CONTROL_AGENT_ENDPOINT=" + endpoint,
            "Environment=REMOTE_CONTROL_AGENT_KEY_PATH=" + str(key),
            "UMask=0077",
            "ExecStartPre=/usr/bin/test -r " + str(key),
            "ExecStartPre=/usr/bin/test -r " + str(key) + ".device-id",
            "ExecStartPre=/usr/bin/test -x " + str(app / ".build/session-supervisor"),
            "ExecStart=" + expected,
            "Restart=on-failure", "RestartSec=15s", "TimeoutStopSec=15s",
            "", "[Install]", "WantedBy=default.target", ""
        ])
        if unit != expected_unit:
            raise ValueError("Modified or foreign Rust service directives; refuse uninstall")
        dropins = home / ".config/systemd/user" / (UNIT + ".d")
        if dropins.exists() or dropins.is_symlink():
            raise ValueError("Rust service drop-ins must be reviewed before uninstall")
    return root


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
            if p.stat().st_uid != os.getuid():
                continue
            status = (p / "status").read_text("ascii")
            if re.search(r"^State:\s*Z\b", status, re.MULTILINE):
                continue  # Exited zombie is not a running Agent.
            argv = (p / "cmdline").read_bytes().split(b"\0")
            if any(arg.startswith(prefix) for arg in argv for prefix in prefixes):
                return False
            # On systemd Linux, the exact per-user session managers may have
            # unreadable /proc/PID/exe and cwd. They cannot run our bundled Node
            # as their executable. Do not mistake their EACCES for an Agent.
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
                not path.is_dir() or path.stat().st_uid != os.getuid())):
            raise ValueError("Untrusted user-local command directory")
    launcher = directory / "rca"
    if launcher.is_symlink():
        info = launcher.lstat()
        expected = [str(v / APP / "scripts/manage-v2.py") for v in versions]
        for version in versions:
            manifest = json.loads((version / "bundle.json").read_text("utf8"))
            if manifest.get("artifact_profile") == "rust-native-only-v1":
                expected.append(str(version / APP / "scripts/rca.sh"))
        if info.st_uid != os.getuid() or os.readlink(launcher) not in expected:
            raise ValueError("Foreign Agent manager launcher: refuse uninstall")
        return launcher
    if launcher.exists():
        raise ValueError("Foreign command named rca: refuse uninstall")
    return None


def local_uninstall(home, confirm, systemctl=None, process_check=no_running_programs):
    if os.getuid() == 0 or not confirm:
        raise ValueError("Owner-only explicit local uninstall required")
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
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("Untrusted v2 installer lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another owner installer is active")
        return _local_uninstall_locked(home, systemctl, process_check)


def _local_uninstall_locked(home, systemctl, process_check):
    programs, versions, unit_file, unit, ids = local_inventory(home)
    # A cutover interrupted after freezing the Node process can still need
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
    if not base.is_dir() or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("Untrusted v2 identity directory")
    for relative in ("temporary",):
        directory = base / relative
        if directory.is_symlink() or (directory.exists() and (
                not directory.is_dir() or directory.stat().st_uid != os.getuid()
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
                     "temporary/v2-identity.pem",
                     "temporary/v2-identity.pem.device-id"):
        file = base / relative
        if file.is_symlink():
            raise ValueError("Linked identity file; purge blocked")
        if not file.exists():
            continue
        info = file.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("Untrusted v2 identity file; purge blocked")
        files.append(file)
    return files, ids


def local_identity_purge(home, confirm, process_check=None):
    if os.getuid() == 0 or not confirm:
        raise ValueError("Non-root explicit v2 identity purge confirmation required")
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
    # No portable way to certify no copied key is in use. Refuse known local
    # CLI or Agent processes, including an active temporary foreground v2.
    for process in proc_root.iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            argv = (process / "cmdline").read_bytes()
            if (b"/remote-control-agent/src/v2-main." in argv
                    or b"/remote-control-agent/scripts/install-v2.mjs" in argv
                    or b"/remote-control-agent/src/pair-device." in argv):
                return False
        except (FileNotFoundError, ProcessLookupError):
            if process.exists():
                return False
        except OSError:
            return False
    return True


def systemctl_user(args):
    result = subprocess.run(["systemctl"] + args, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=15, check=False)
    if result.returncode:
        raise ValueError("Owned v2 systemd user service action failed")


def main():
    parser = argparse.ArgumentParser(description="Verified Remote Control v2 GitHub Release bootstrap")
    parser.add_argument("--tag")
    parser.add_argument("--commit")
    parser.add_argument("--endpoint")
    actions=parser.add_mutually_exclusive_group()
    actions.add_argument("--status", action="store_true")
    actions.add_argument("--stage-only", action="store_true",
                         help="verify and stage a separately pinned immutable Linux upgrade; never switch")
    actions.add_argument("--native-upgrade", action="store_true",
                         help="owner-local Node/native to Node-free Rust signed WSS cutover")
    actions.add_argument("--uninstall", action="store_true")
    actions.add_argument("--purge-local-identity", action="store_true",
                         help="separate explicit v2 key/ID purge after uninstall; shared SQLite retained")
    parser.add_argument("--name")
    parser.add_argument("--upgrade", action="store_true", help="manual owned v2 program upgrade only")
    parser.add_argument("--asset-sha256", help="independently reviewed SHA-256 for native staging or switch")
    args = parser.parse_args()
    try:
        if args.status:
            print(json.dumps(local_status(os.path.expanduser("~")), indent=2))
        elif args.uninstall:
            if os.getuid() == 0 or not (sys.stdin.isatty() and sys.stdout.isatty()):
                raise ValueError("Local uninstall requires a non-root interactive terminal")
            _, versions, _, _, ids = local_inventory(os.path.expanduser("~"))
            print("Owned local v2 versions:", ", ".join(v.name for v in versions))
            print("Device IDs (cloud grants will NOT be revoked):", ids)
            print("Private keys and SQLite receipts will be retained; use MCP revoke_device separately.")
            if input("Type UNINSTALL-V2 to confirm local removal: ").strip() != "UNINSTALL-V2":
                raise ValueError("Local uninstall not confirmed")
            print(json.dumps(local_uninstall(os.path.expanduser("~"), True, systemctl_user), indent=2))
        elif args.purge_local_identity:
            if os.getuid() == 0 or not (sys.stdin.isatty() and sys.stdout.isatty()):
                raise ValueError("Local identity purge requires a non-root interactive terminal")
            home = os.path.expanduser("~")
            local_inventory(home)  # Reject unowned path components before opening lock.
            base = pathlib.Path(home) / STORE
            if not base.is_dir() or base.is_symlink() or base.stat().st_uid != os.getuid() \
                    or stat.S_IMODE(base.stat().st_mode) & 0o077:
                raise ValueError("No safe v2 identity directory to purge")
            # Existing v2 installer flock: avoid racing local pairing or re-pair.
            fd = os.open(base / "v2-installer.lock",
                         os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "r+b") as lock:
                info = os.fstat(lock.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() \
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
                if input("Type PURGE-V2-IDENTITY to irreversibly remove only the listed keys/IDs: "
                         ).strip() != "PURGE-V2-IDENTITY":
                    raise ValueError("Local identity purge not confirmed")
                print(json.dumps(local_identity_purge(home, True), indent=2))
        else:
            if not args.tag or not args.commit or not args.endpoint:
                raise ValueError("Pinned --tag, --commit, and --endpoint are required")
            install(args.tag, args.commit, args.endpoint, args.name, args.upgrade,
                    args.stage_only, args.asset_sha256, args.native_upgrade)
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
