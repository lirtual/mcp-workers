#!/usr/bin/env python3
"""Build/verify the same deterministic unpacked MV3 ZIP for Chrome and Edge."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "apps/browser-mcp-worker/extension"
FILES = ("background.js", "config.js", "manifest.json", "observation.js", "mutations.js", "options.html", "options.js", "INSTALL.md", "NOTICES.md")
# Public installation identity, never an authentication or signing secret.
KEY_SHA256 = "9785067d4ec625ebb231d29a2be4354c6d9622a68cc6ac6e5ad0105c0a353075"


def sources():
    files = {name: ((ROOT / "docs/browser-extension" / name) if name in ("INSTALL.md", "NOTICES.md") else (SOURCE / name)).read_bytes() for name in FILES}
    manifest = json.loads(files["manifest.json"])
    policy = json.loads((ROOT / "scripts/browser-extension-manifest.json").read_text())
    if set(policy) != {"key", "minimum_chrome_version"} or policy["minimum_chrome_version"] != "137":
        raise ValueError("invalid reviewed public manifest policy")
    if "key" in manifest and manifest["key"] != policy["key"]:
        raise ValueError("extension identity changed")
    manifest.update(policy)
    files["manifest.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    key = base64.b64decode(manifest.get("key", ""), validate=True)
    if manifest.get("manifest_version") != 3 or hashlib.sha256(key).hexdigest() != KEY_SHA256:
        raise ValueError("MV3 and unchanged public installation key required")
    version = manifest.get("version", "")
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}", version) or any(int(p) > 65535 for p in version.split(".")) or not any(int(p) for p in version.split(".")):
        raise ValueError("invalid Chrome manifest version")
    if manifest.get("minimum_chrome_version") != "137":
        raise ValueError("API floor must include Chrome 137 TabGroup.shared")
    if f'extension_version:"{version}"' not in files["background.js"].decode():
        raise ValueError("extension handshake version differs from manifest")
    package = json.loads((ROOT / "apps/browser-mcp-worker/package.json").read_text())
    coordinator = (ROOT / "apps/browser-mcp-worker/src/coordinator.ts").read_text()
    if package["version"] != version or f'v.extension_version !== "{version}"' not in coordinator:
        raise ValueError("Worker and extension release versions differ")
    if b'const BROWSER_MCP_SERVICE_ORIGIN = "https://browser.lirtual.dpdns.org";' not in files["config.js"]:
        raise ValueError("trusted production service origin is not configured")
    return files, manifest


def source_hash(files):
    source = hashlib.sha256()
    for name, content in files.items():
        source.update(name.encode() + b"\0" + content)
    return source.hexdigest()


def build(output):
    files, manifest = sources()
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"browser-mcp-extension-v{manifest['version']}.zip"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in files.items():
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    metadata = {
        "artifact": target.name, "sha256": digest, "source_sha256": source_hash(files),
        "version": manifest["version"], "minimum_chrome_version": manifest["minimum_chrome_version"],
        "browsers": ["Chrome", "Edge"], "unpacked": True,
        "manifest_key_sha256": KEY_SHA256,
        "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_dirty": bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=ROOT)),
        "source_files": {name: hashlib.sha256(content).hexdigest() for name, content in files.items()},
    }
    Path(str(target) + ".json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    Path(str(target) + ".sha256").write_text(f"{digest}  {target.name}\n")
    verify(target)
    return target


def verify(target):
    files, manifest = sources()
    metadata = json.loads(Path(str(target) + ".json").read_text())
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    expected = {"artifact": target.name, "sha256": digest, "source_sha256": source_hash(files),
                "version": manifest["version"], "minimum_chrome_version": "137",
                "browsers": ["Chrome", "Edge"], "unpacked": True, "manifest_key_sha256": KEY_SHA256,
                "source_files": {n: hashlib.sha256(c).hexdigest() for n, c in files.items()}}
    if any(metadata.get(k) != v for k, v in expected.items()) or target.name != f"browser-mcp-extension-v{manifest['version']}.zip":
        raise ValueError("artifact metadata, Version or source mismatch")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if metadata.get("source_revision") != revision or type(metadata.get("source_dirty")) is not bool:
        raise ValueError("build provenance missing")
    if Path(str(target) + ".sha256").read_text() != f"{digest}  {target.name}\n":
        raise ValueError("SHA256 sidecar mismatch")
    with zipfile.ZipFile(target) as archive:
        if archive.namelist() != list(FILES) or archive.testzip() is not None:
            raise ValueError("unexpected ZIP entries or corrupt ZIP")
        if any(archive.read(name) != content for name, content in files.items()):
            raise ValueError("ZIP differs from source")
    print(f"Verified {target}: SHA-256 {digest}; Version {manifest['version']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=ROOT / "apps/browser-mcp-worker/.build/extension")
    parser.add_argument("--verify", type=Path, help="Verify ZIP, sidecars and bytes against this source checkout")
    args = parser.parse_args()
    verify(args.verify) if args.verify else build(args.out_dir)
