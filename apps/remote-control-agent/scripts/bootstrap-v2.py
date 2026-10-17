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
    APP + "/scripts/install-v2.mjs", APP + "/.build/session-supervisor",
))
EXEC_FILES = frozenset(("bin/node", APP + "/.build/session-supervisor"))
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
        if not EXEC_FILES.issubset(names) or "bundle.json" not in names \
                or APP + "/src/v2-main.js" not in names \
                or APP + "/scripts/install-v2.mjs" not in names:
            raise ValueError("Incomplete Agent Release archive")
        manifest = json.load(tf.extractfile(tf.getmember("bundle.json")))
        if (manifest.get("artifact_schema") != 1 or manifest.get("name") != "remote-control-agent"
                or manifest.get("version") != tag or manifest.get("target") != target
                or not re.fullmatch(r"v24\.[0-9]+\.[0-9]+", str(manifest.get("node", "")))):
            raise ValueError("Bundle version, architecture, or runtime mismatch")
        machine = 62 if target.startswith("linux-x64-") else 183
        for binary in EXEC_FILES:
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
                if name in EXEC_FILES:
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


def preflight(tag, commit, endpoint):
    if (sys.platform != "linux" or os.getuid() == 0
            or not sys.stdin.isatty() or not sys.stdout.isatty()):
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


def install(tag, commit, endpoint, name=None):
    target = preflight(tag, commit, endpoint)
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
        pinned = resolve_pinned(tag, commit, target)
        archive_path = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".download-", dir=location, delete=False) as f:
                archive_path = pathlib.Path(f.name)
                os.chmod(archive_path, 0o600)
                data = fetch(pinned["download"], "application/octet-stream", MAX_ARCHIVE)
                if (len(data) != pinned["size"] or hashlib.sha256(data).hexdigest() != pinned["digest"]):
                    raise ValueError("Official GitHub SHA-256 or byte length mismatch")
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            records = inspect_archive(archive_path, tag, target)
            if version.exists() or version.is_symlink():
                verify_existing_program(archive_path, version, records)
            else:
                unpack_verified(archive_path, version, records, tag, target)
        finally:
            if archive_path is not None:
                archive_path.unlink(missing_ok=True)
        binary = version / "bin/node"
        command = [str(binary), str(version / APP / "scripts/install-v2.mjs"),
                   "--endpoint", endpoint]
        if name:
            command += ["--name", name]
        print("Verified GitHub Release " + tag + " for " + target
              + ". Local permanent/temporary pairing requires independent MCP approval.",
              flush=True)
        # Only the cryptographically checked, safe-unpacked program runs.
        os.execv(str(binary), command)


def main():
    parser = argparse.ArgumentParser(description="Verified Remote Control v2 GitHub Release bootstrap")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--name")
    args = parser.parse_args()
    try:
        install(args.tag, args.commit, args.endpoint, args.name)
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
