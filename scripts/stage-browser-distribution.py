#!/usr/bin/env python3
"""Stage only the verified extension ZIP and its public landing page for one Worker release."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "apps/browser-mcp-worker"
BUILDER = ROOT / "scripts/build-browser-extension.py"


def stage(artifact_dir: Path, out_dir: Path, *, require_clean: bool = False):
    archives = sorted(artifact_dir.glob("browser-mcp-extension-v*.zip"))
    if len(archives) != 1:
        raise ValueError("expected exactly one reviewed extension ZIP")
    archive = archives[0]
    spec = importlib.util.spec_from_file_location("browser_extension_builder", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify(archive)  # source, version, key, origin, ZIP bytes, provenance and sidecars
    meta = json.loads(Path(str(archive) + ".json").read_text())
    if require_clean and meta["source_dirty"]:
        raise ValueError("refusing a dirty production extension build")
    version = meta["version"]
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", digest) or digest != meta["sha256"]:
        raise ValueError("ZIP content hash mismatch")
    if archive.stat().st_size > 25 * 1024 * 1024:
        raise ValueError("public ZIP exceeds Cloudflare static asset limit")
    coordinator = (WORKER / "src/coordinator.ts").read_text()
    extension = (WORKER / "extension/background.js").read_text()
    worker_proto = re.search(r'v\.protocol !== (\d+) \|\| v\.extension_version !== "([0-9.]+)"', coordinator)
    client_proto = re.search(r'protocol:(\d+),extension_version:"([0-9.]+)"', extension)
    if not worker_proto or not client_proto or worker_proto.groups() != client_proto.groups() or worker_proto[2] != version:
        raise ValueError("Worker WSS and extension protocol/version mismatch")
    zip_name = f"browser-mcp-extension-v{version}-{digest}.zip"
    zip_path = f"/downloads/{zip_name}"
    template = (WORKER / "distribution/index.template.html").read_text()
    if any(template.count(mark) != 1 for mark in ("@@ZIP_PATH@@", "@@VERSION@@", "@@SHA256@@")):
        raise ValueError("invalid public landing page placeholders")
    page = template.replace("@@ZIP_PATH@@", zip_path).replace("@@VERSION@@", version).replace("@@SHA256@@", digest)
    if out_dir.exists() and any(out_dir.rglob("*")):
        raise ValueError("public asset directory must be empty (no stale/extra files)")
    (out_dir / "downloads").mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(page)
    shutil.copyfile(archive, out_dir / "downloads" / zip_name)
    expected = {"index.html", f"downloads/{zip_name}"}
    actual = {str(p.relative_to(out_dir)) for p in out_dir.rglob("*") if p.is_file()}
    if actual != expected or hashlib.sha256((out_dir / "downloads" / zip_name).read_bytes()).hexdigest() != digest:
        raise ValueError("public asset allowlist or staged ZIP mismatch")
    print(f"Staged Browser MCP v{version} / WSS {worker_proto[1]}: {zip_path} ({digest})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--require-clean", action="store_true")
    args = parser.parse_args()
    stage(args.artifact_dir, args.out_dir, require_clean=args.require_clean)
