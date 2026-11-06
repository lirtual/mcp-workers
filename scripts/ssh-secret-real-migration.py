#!/usr/bin/env python3
"""One-shot protected SSH GitHub Environment Secret rename; no Secret API writes."""
import base64
import binascii
import ctypes
import ctypes.util
import hmac
import json
import os
from pathlib import Path
import re
import sys


def require(ok):
    if not ok:
        raise ValueError("gate_failed")


def canonical_key(value):
    require(isinstance(value, str))
    try:
        raw = value.encode("ascii")
        decoded = base64.b64decode(raw, validate=True)
    except (UnicodeError, ValueError, binascii.Error):
        raise ValueError("invalid_key") from None
    require(len(raw) == 44 and len(decoded) == 32 and base64.b64encode(decoded) == raw)
    return raw


def protected_context():
    require(os.getenv("GITHUB_REPOSITORY") == "lirtual/mcp-workers")
    require(os.getenv("GITHUB_REF") == "refs/heads/main")
    require(os.getenv("GITHUB_ACTOR") == "lirtual")
    require(os.getenv("GITHUB_EVENT_NAME") == "workflow_dispatch")
    require(re.fullmatch("[0-9a-f]{40}", os.getenv("GITHUB_SHA", "")) is not None)


def main():
    require(len(sys.argv) == 3 and sys.argv[1] in ("seal", "verify"))
    mode, path = sys.argv[1:]
    require(path == "-" if mode == "verify" else path != "-")
    protected_context()
    old = canonical_key(os.getenv("SPEC733_OLD_KEY"))
    if mode == "verify":
        new = canonical_key(os.getenv("SPEC733_NEW_KEY"))
        require(hmac.compare_digest(old, new))
        print("SPEC733_SSH_REAL_SECRET_EXACT_BYTES_EQUAL:PASS")
        return
    require("SPEC733_NEW_KEY" not in os.environ)
    pk_b64 = os.getenv("SPEC733_PUBLIC_KEY", "")
    key_id = os.getenv("SPEC733_PUBLIC_KEY_ID", "")
    require(re.fullmatch("[A-Za-z0-9_-]{8,128}", key_id) is not None)
    try:
        pk = base64.b64decode(pk_b64, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("invalid_public_key") from None
    require(len(pk) == 32)
    libpath = ctypes.util.find_library("sodium")
    require(bool(libpath))
    lib = ctypes.CDLL(libpath)
    require(lib.sodium_init() >= 0)
    lib.crypto_box_seal.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulonglong, ctypes.c_void_p]
    lib.crypto_box_seal.restype = ctypes.c_int
    ciphertext = ctypes.create_string_buffer(len(old) + 48)
    plain_buffer = ctypes.create_string_buffer(old, len(old))
    pk_buffer = ctypes.create_string_buffer(pk, len(pk))
    require(lib.crypto_box_seal(ciphertext, plain_buffer, len(old), pk_buffer) == 0)
    # The only file ever created contains GitHub public-key encrypted bytes.
    envelope = {
        "kind": "SPEC733_SSH_SECRET_RENAME_SEALED_V1",
        "target": "SSH_ENCRYPTION_KEY",
        "source_sha": os.environ["GITHUB_SHA"],
        "source_run_id": os.environ.get("GITHUB_RUN_ID", ""),
        "key_id": key_id,
        "encrypted_value": base64.b64encode(ciphertext.raw).decode("ascii"),
    }
    require(re.fullmatch("[0-9]+", envelope["source_run_id"]) is not None)
    outfile = Path(path)
    require(not outfile.exists())
    fd = os.open(outfile, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as stream:
        json.dump(envelope, stream, separators=(",", ":"))
    print("SPEC733_SSH_REAL_GITHUB_PUBLIC_KEY_CIPHERTEXT_CREATED:PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never output original, digest, ciphertext, stack trace or command arguments.
        print("SPEC733_SSH_REAL_MIGRATION_GATE_FAILED", file=sys.stderr)
        sys.exit(1)
