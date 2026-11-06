#!/usr/bin/env python3
"""Spec 733 one-shot synthetic-only sealed-box experiment. No GitHub writes or real Secrets."""
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

TEST_DATA = base64.b64encode(bytes([0xA7]) * 32)
EXPECTED_BYTES = len(TEST_DATA) + 48  # libsodium crypto_box_SEALBYTES
REPO = "lirtual/mcp-workers"
ENVIRONMENT = "ssh-mcp-worker"


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def b64(value):
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise RuntimeError("invalid_base64") from None


def sodium():
    path = ctypes.util.find_library("sodium")
    require(bool(path), "libsodium_unavailable")
    lib = ctypes.CDLL(path)
    require(lib.sodium_init() >= 0, "sodium_init_failed")
    lib.crypto_box_seal.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulonglong, ctypes.c_void_p]
    lib.crypto_box_seal.restype = ctypes.c_int
    lib.crypto_box_seal_open.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulonglong, ctypes.c_void_p, ctypes.c_void_p]
    lib.crypto_box_seal_open.restype = ctypes.c_int
    lib.crypto_box_keypair.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.crypto_box_keypair.restype = ctypes.c_int
    return lib


def seal(lib, plain, public_key):
    require(len(public_key) == 32, "public_key_size")
    output = ctypes.create_string_buffer(len(plain) + 48)
    message = ctypes.create_string_buffer(plain, len(plain))
    pk = ctypes.create_string_buffer(public_key, len(public_key))
    require(lib.crypto_box_seal(output, message, len(plain), pk) == 0, "seal_failed")
    return output.raw


def independent_fixture(lib):
    pk = ctypes.create_string_buffer(32)
    sk = ctypes.create_string_buffer(32)
    require(lib.crypto_box_keypair(pk, sk) == 0, "fixture_keypair")
    ciphertext = seal(lib, TEST_DATA, pk.raw)
    opened = ctypes.create_string_buffer(len(TEST_DATA))
    enc = ctypes.create_string_buffer(ciphertext, len(ciphertext))
    require(lib.crypto_box_seal_open(opened, enc, len(ciphertext), pk, sk) == 0,
            "synthetic_decrypt")
    require(hmac.compare_digest(opened.raw, TEST_DATA), "synthetic_byte_mismatch")
    require(not hmac.compare_digest(opened.raw, TEST_DATA[:-1] + b"X"),
            "synthetic_negative_comparison")
    enc_bad = bytearray(ciphertext)
    enc_bad[-1] ^= 1
    tampered = ctypes.create_string_buffer(bytes(enc_bad), len(enc_bad))
    reject = ctypes.create_string_buffer(len(TEST_DATA))
    require(lib.crypto_box_seal_open(reject, tampered, len(enc_bad), pk, sk) != 0,
            "tampered_ciphertext_accepted")


def protected_context():
    require(os.getenv("GITHUB_REPOSITORY") == REPO and
            os.getenv("GITHUB_REF") == "refs/heads/main" and
            os.getenv("GITHUB_ACTOR") == "lirtual" and
            re.fullmatch(r"[0-9a-f]{40}", os.getenv("GITHUB_SHA", "")),
            "protected_context_required")
    require("ENCRYPTION_KEY" not in os.environ and
            "SSH_ENCRYPTION_KEY" not in os.environ, "real_secret_injected")
    keyid = os.getenv("SPEC733_PUBLIC_KEY_ID", "")
    require(re.fullmatch(r"[A-Za-z0-9_-]{8,128}", keyid), "invalid_public_key_id")
    return keyid


def main():
    require(len(sys.argv) == 3 and sys.argv[1] in ("seal", "verify", "selftest"),
            "mode_invalid")
    mode, path = sys.argv[1:]
    lib = sodium()
    independent_fixture(lib)
    if mode == "selftest":
        print("SPEC733_SYNTHETIC_CRYPTO_FIXTURE_PASS")
        return
    keyid = protected_context()
    if mode == "seal":
        pk = b64(os.getenv("SPEC733_PUBLIC_KEY", ""))
        require(len(pk) == 32, "invalid_public_key")
        output = {
            "kind": "SPEC733_SYNTHETIC_ONLY_NEVER_SUBMIT",
            "key_id": keyid,
            "sha": os.environ["GITHUB_SHA"],
            "run_id": os.getenv("GITHUB_RUN_ID", ""),
            "encrypted_value": base64.b64encode(seal(lib, TEST_DATA, pk)).decode("ascii"),
        }
        target = Path(path)
        require(not target.exists(), "artifact_already_exists")
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(output, stream, separators=(",", ":"))
        print("SPEC733_SYNTHETIC_GITHUB_PUBLIC_KEY_CIPHERTEXT_PASS")
    else:
        obj = json.loads(Path(path).read_text())
        require(set(obj) == {"kind", "key_id", "sha", "run_id", "encrypted_value"}, "artifact_schema")
        require(obj["kind"] == "SPEC733_SYNTHETIC_ONLY_NEVER_SUBMIT", "artifact_kind")
        require(obj["key_id"] == keyid and obj["sha"] == os.environ["GITHUB_SHA"] and
                re.fullmatch(r"[0-9]+", str(obj["run_id"])) is not None, "artifact_identity")
        require(len(b64(obj["encrypted_value"])) == EXPECTED_BYTES, "artifact_ciphertext_size")
        require(TEST_DATA.decode() not in Path(path).read_text(), "plaintext_in_artifact")
        print("SPEC733_SYNTHETIC_INDEPENDENT_ARTIFACT_AND_BYTE_CHECK_PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("SPEC733_SYNTHETIC_GATE_FAILED", file=sys.stderr)
        sys.exit(1)
