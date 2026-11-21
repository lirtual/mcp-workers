#!/usr/bin/env python3
"""Build/check an unshipped Linux test bundle; this is not a release verifier."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tarfile

NAMES = ("rca-standard-linux-candidate", "session-supervisor")
MACHINES = {"linux-x64-glibc": 62, "linux-arm64-glibc": 183}
MAX_FILE = 128 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_elf(data, target):
    # 64-bit little-endian ELF executable or PIE for the specified machine.
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("expected a 64-bit little-endian ELF")
    kind, machine = struct.unpack_from("<HH", data, 16)
    if kind not in (2, 3) or machine != MACHINES[target]:
        raise ValueError("ELF type or machine does not match target")


def read_executable(path, target):
    # Resolve source explicitly; do not accept links or special files.
    st = path.lstat()
    if not path.is_file() or path.is_symlink() or not st.st_mode & 0o111 or not 0 < st.st_size <= MAX_FILE:
        raise ValueError("input must be an executable regular file within size limit")
    data = path.read_bytes()
    if len(data) != st.st_size:
        raise ValueError("input changed while reading")
    check_elf(data, target)
    return data


def build(agent, supervisor, target, output):
    binaries = {name: read_executable(path, target) for name, path in
                zip(NAMES, (agent, supervisor))}
    manifest = {"kind": "nonproduction-linux-rust-candidate", "schema": 1,
                "target": target, "files": {name: digest(data) for name, data in binaries.items()}}
    entries = {"candidate.json": (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode(),
               **binaries}
    # Exclusive creation prevents accidentally replacing any existing artifact.
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as raw:
        with tarfile.open(fileobj=raw, mode="w:gz") as archive:
            for name, data in entries.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o700 if name in NAMES else 0o600
                info.mtime = 0
                archive.addfile(info, io.BytesIO(data))
    return manifest


def verify(archive_path, target):
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        if len(members) != 3 or {m.name for m in members} != {"candidate.json", *NAMES}:
            raise ValueError("unexpected bundle members")
        data = {}
        for member in members:
            if not member.isfile() or not 0 < member.size <= MAX_FILE:
                raise ValueError("invalid bundle member")
            expected_mode = 0o700 if member.name in NAMES else 0o600
            if member.mode != expected_mode:
                raise ValueError("invalid bundle member permissions")
            f = archive.extractfile(member)
            if f is None:
                raise ValueError("unreadable bundle member")
            data[member.name] = f.read()
    manifest = json.loads(data["candidate.json"])
    if (set(manifest) != {"kind", "schema", "target", "files"}
            or manifest["kind"] != "nonproduction-linux-rust-candidate"
            or manifest["schema"] != 1 or manifest["target"] != target
            or set(manifest["files"]) != set(NAMES)):
        raise ValueError("invalid candidate manifest")
    for name in NAMES:
        check_elf(data[name], target)
        if digest(data[name]) != manifest["files"][name]:
            raise ValueError("candidate digest mismatch")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("build")
    create.add_argument("--agent", type=Path, required=True)
    create.add_argument("--supervisor", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    for cmd in (create, sub.add_parser("verify")):
        cmd.add_argument("--target", choices=MACHINES, required=True)
    sub.choices["verify"].add_argument("archive", type=Path)
    args = parser.parse_args()
    try:
        result = (build(args.agent, args.supervisor, args.target, args.output)
                  if args.action == "build" else verify(args.archive, args.target))
    except (OSError, ValueError, TypeError, KeyError, tarfile.TarError) as error:
        print(f"candidate bundle rejected: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
