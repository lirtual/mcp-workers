#!/usr/bin/env python3
"""Render a short-lived local QR as SVG using the system libqrencode.

Reads the QR payload from stdin; never logs or persists the payload.
"""
import ctypes
import sys

class QRCode(ctypes.Structure):
    _fields_ = [("version", ctypes.c_int), ("width", ctypes.c_int), ("data", ctypes.POINTER(ctypes.c_ubyte))]

def main():
    raw = sys.stdin.buffer.read(4097)
    if not raw or len(raw) > 4096:
        raise SystemExit("QR_INPUT_INVALID")
    lib = ctypes.CDLL("libqrencode.so.4")
    lib.QRcode_encodeData.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int, ctypes.c_int]
    lib.QRcode_encodeData.restype = ctypes.POINTER(QRCode)
    lib.QRcode_free.argtypes = [ctypes.POINTER(QRCode)]
    data = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    qr = lib.QRcode_encodeData(len(raw), data, 0, 1)
    if not qr:
        raise SystemExit("QR_ENCODE_FAILED")
    try:
        width = qr.contents.width
        margin = 4
        paths = []
        for y in range(width):
            for x in range(width):
                if qr.contents.data[y * width + x] & 1:
                    paths.append(f"M{x + margin} {y + margin}h1v1h-1z")
        dimension = width + 2 * margin
        print(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dimension} {dimension}" width="320" height="320" role="img" aria-label="Weixin pairing QR code"><path fill="#fff" d="M0 0h{dimension}v{dimension}H0z"/><path fill="#111" d="{"".join(paths)}"/></svg>')
    finally:
        lib.QRcode_free(qr)

if __name__ == "__main__":
    main()
