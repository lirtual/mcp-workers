#!/usr/bin/env python3
"""One-shot Workflow GitHub Environment Secret rename; never writes Secrets."""
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


TARGETS = {"portal": "WORKFLOW_MCP_PORTAL_CLIENT_SECRET",
           "session": "WORKFLOW_SESSION_RUNTIME_DATA_KEY"}


def require(condition):
    if not condition:
        raise ValueError("gate_failed")


def original_bytes(value, kind):
    require(isinstance(value, str) and len(value) > 0)
    raw = value.encode("utf-8")
    require(len(raw) <= 4096)
    if kind == "session":
        try:
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
    require(re.fullmatch(r"[a-f0-9]{40}", os.getenv("GITHUB_SHA", "")) is not None)
    require(re.fullmatch(r"[0-9]+", os.getenv("GITHUB_RUN_ID", "")) is not None)


def main():
    require(len(sys.argv) == 3 and sys.argv[1] in ("seal", "verify"))
    mode, path = sys.argv[1:]
    require((path == "-") == (mode == "verify"))
    protected_context()
    kind = os.getenv("SPEC733_WORKFLOW_SECRET_KIND", "")
    require(kind in TARGETS)
    old = original_bytes(os.getenv("SPEC733_OLD_SECRET"), kind)
    if mode == "verify":
        new = original_bytes(os.getenv("SPEC733_NEW_SECRET"), kind)
        require(hmac.compare_digest(old, new))
        print("SPEC733_WORKFLOW_" + kind.upper() + "_SECRET_EXACT_BYTES_EQUAL:PASS")
        return

    require("SPEC733_NEW_SECRET" not in os.environ)
    key_id = os.getenv("SPEC733_PUBLIC_KEY_ID", "")
    require(re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key_id) is not None)
    try:
        public_key = base64.b64decode(os.getenv("SPEC733_PUBLIC_KEY", ""), validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("invalid_public_key") from None
    require(len(public_key) == 32)
    lib_name = ctypes.util.find_library("sodium")
    require(bool(lib_name))
    lib = ctypes.CDLL(lib_name)
    require(lib.sodium_init() >= 0)
    lib.crypto_box_seal.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                    ctypes.c_ulonglong, ctypes.c_void_p]
    lib.crypto_box_seal.restype = ctypes.c_int
    ciphertext = ctypes.create_string_buffer(len(old) + 48)
    plain_buffer = ctypes.create_string_buffer(old, len(old))
    pk_buffer = ctypes.create_string_buffer(public_key, len(public_key))
    require(lib.crypto_box_seal(ciphertext, plain_buffer, len(old), pk_buffer) == 0)
    envelope = {
        "kind": "SPEC733_WORKFLOW_SECRET_RENAME_SEALED_V1",
        "target": TARGETS[kind],
        "source_sha": os.environ["GITHUB_SHA"],
        "source_run_id": os.environ["GITHUB_RUN_ID"],
        "key_id": key_id,
        "encrypted_value": base64.b64encode(ciphertext.raw).decode("ascii"),
    }
    output = Path(path)
    require(not output.exists())
    fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as stream:
        json.dump(envelope, stream, separators=(",", ":"))
    print("SPEC733_WORKFLOW_" + kind.upper() + "_GITHUB_CIPHERTEXT_CREATED:PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never expose the original, digest, ciphertext, or exception.
        print("SPEC733_WORKFLOW_SECRET_MIGRATION_GATE_FAILED", file=sys.stderr)
        sys.exit(1)
