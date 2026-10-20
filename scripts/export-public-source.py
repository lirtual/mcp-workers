#!/usr/bin/env python3
"""Create a secret-checked source-only public export from HEAD without Git history."""
import argparse
import ipaddress
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "scripts/public-template"
REPLACE = {
    b"rca.lirtual.dpdns.org": b"rca.example.test",
    b"aiyaya.workers.dev": b"example-account.workers.dev",
    b"RAY-WORKSPACE": b"EXAMPLE-DEVICE",
    b"CloudCone": b"ExampleProvider",
    b"cloudcone": b"example-provider",
}
BAD = {
    "GitHub credential": rb"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})\b",
    "AWS key": rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "Google key": rb"\bAIza[A-Za-z0-9_-]{35}\b",
    "Private key": rb"-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----",
    "JWT": rb"\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{12,}\b",
    "Private endpoint": rb"(?i)[a-z0-9.-]+\.lirtual\.dpdns\.org|aiyaya\.workers\.dev|RAY-WORKSPACE|cloudcone",
}
URL = re.compile(rb"\b(?:mysql|postgres(?:ql)?|redis|mongodb(?:\+srv)?)://[^\s\"'<>\x00`]+", re.I)
BANNED_EXT = (".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db", ".tfstate", ".bak", ".backup", ".dump")
BANNED_NAME = {"id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials.json", "known_hosts", ".npmrc", ".pypirc"}
GENERATED = {".git", ".wrangler", "node_modules", ".cache", "dist", ".build", "coverage"}
SPECIAL = {"README.md", "SECURITY.md", ".github/workflows/ci.yml"}


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], stderr=subprocess.PIPE)


def allowed(path):
    p = Path(path)
    name = p.name
    if name in BANNED_NAME or name.endswith(BANNED_EXT) or any(x in GENERATED for x in p.parts):
        raise ValueError(f"Private/generated file: {path}")
    if name == ".env" or name.startswith(".env.") and name != ".env.example":
        raise ValueError(f"Tracked secret env: {path}")
    if name == ".dev.vars" or name.startswith(".dev.vars.") and name != ".dev.vars.example":
        raise ValueError(f"Tracked Worker secret file: {path}")
    return not (p.parts[0] == ".github" or "docs" in p.parts or "public-template" in p.parts
                or name == "README.md" or name.lower().endswith((".md", ".markdown", ".rst"))
                and not name.upper().startswith("LICENSE"))


def scrub(data):
    if b"\x00" in data:
        raise ValueError("Binary content requires manual review")
    for original, replacement in REPLACE.items():
        data = data.replace(original, replacement)
    return re.sub(rb"(?i)([a-z0-9-]+)\.lirtual\.dpdns\.org", rb"\1.example.test", data)


def verify(path, data):
    if b"\x00" in data:
        raise ValueError(f"Binary content: {path}")
    for title, pattern in BAD.items():
        if re.search(pattern, data):
            raise ValueError(f"{title} in {path}")
    for raw in URL.findall(data):
        parsed = urlsplit(raw.decode("utf-8", "replace").rstrip('",);'))
        if not parsed.username or not parsed.password:
            continue
        host = (parsed.hostname or "").lower()
        safe = host in ("localhost", "127.0.0.1", "::1", "host.docker.internal", "host", "h")
        safe |= host.endswith((".test", ".example", ".example.com", ".invalid"))
        try:
            safe |= ipaddress.ip_address(host).is_loopback
        except ValueError:
            pass
        if not safe:
            raise ValueError(f"External credentialed database URL in {path}")


def export(output):
    if output.exists() or output == ROOT or ROOT in output.parents or output in ROOT.parents:
        raise ValueError("Output must be a nonexistent directory outside the repo")
    if git("status", "--porcelain", "--untracked-files=normal").strip():
        raise ValueError("Commit all tracked changes before exporting")
    output.mkdir(mode=0o700, parents=True)
    try:
        count = 0
        for record in git("ls-tree", "-r", "-z", "HEAD").split(b"\x00"):
            if not record:
                continue
            header, name = record.split(b"\t", 1)
            mode, kind, _ = header.decode().split()
            path = name.decode()
            if kind != "blob" or mode not in ("100644", "100755"):
                raise ValueError(f"Symlink or submodule: {path}")
            if not allowed(path):
                continue
            content = scrub(git("show", f"HEAD:{path}"))
            verify(path, content)
            dst = output / path
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(content)
            dst.chmod(0o755 if mode == "100755" else 0o644)
            count += 1
        for src, dstname in (("README.md", "README.md"), ("SECURITY.md", "SECURITY.md"),
                             ("ci.yml", ".github/workflows/ci.yml")):
            dest = output / dstname
            dest.parent.mkdir(parents=True, exist_ok=True)
            content = (TEMPLATE / src).read_bytes()
            verify(dstname, content)
            dest.write_bytes(content)
        for file in output.rglob("*"):
            if file.is_file():
                rel = file.relative_to(output).as_posix()
                if rel not in SPECIAL and not allowed(rel):
                    raise ValueError(f"Unexpected output: {rel}")
                verify(rel, file.read_bytes())
        if (output / ".git").exists() or (output / "docs").exists():
            raise ValueError("Private history/docs leaked")
        workflow = (output / ".github/workflows/ci.yml").read_text()
        if any(x in workflow for x in ("workflow_dispatch", "secrets.", "pull_request_target", "CLOUDFLARE_API_TOKEN")):
            raise ValueError("Privileged workflow in public export")
        for path in (".gitignore", "pnpm-lock.yaml", "README.md", "SECURITY.md"):
            if not (output / path).is_file():
                raise ValueError(f"Missing required file: {path}")
        print(f"PASS: {count} source/config files + 3 public templates, no history or private docs")
        print(f"Output: {output}")
    except Exception:
        shutil.rmtree(output)
        raise


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", required=True, type=Path)
    a = p.parse_args()
    try:
        export(a.output.resolve())
    except (ValueError, subprocess.CalledProcessError) as exc:
        sys.exit(f"Public export refused: {exc}")
