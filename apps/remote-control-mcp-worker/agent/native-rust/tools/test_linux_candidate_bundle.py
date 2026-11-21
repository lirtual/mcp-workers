import io
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest

import linux_candidate_bundle as bundle


def elf(machine=62):
    data = bytearray(80)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<HH", data, 16, 3, machine)
    return bytes(data)


class CandidateBundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.agent = self.root / "agent"
        self.helper = self.root / "helper"
        for path in (self.agent, self.helper):
            path.write_bytes(elf())
            path.chmod(0o700)
        self.output = self.root / "candidate.tar.gz"

    def test_roundtrip_and_no_overwrite(self):
        bundle.build(self.agent, self.helper, "linux-x64-glibc", self.output)
        self.assertEqual(bundle.verify(self.output, "linux-x64-glibc")["kind"],
                         "nonproduction-linux-rust-candidate")
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            bundle.build(self.agent, self.helper, "linux-x64-glibc", self.output)

    def test_wrong_architecture_and_symlink_are_rejected(self):
        with self.assertRaises(ValueError):
            bundle.build(self.agent, self.helper, "linux-arm64-glibc", self.output)
        self.assertFalse(self.output.exists())
        link = self.root / "link"
        link.symlink_to(self.agent)
        with self.assertRaises(ValueError):
            bundle.build(link, self.helper, "linux-x64-glibc", self.output)

    def test_changed_member_and_extra_path_are_rejected(self):
        bundle.build(self.agent, self.helper, "linux-x64-glibc", self.output)
        with tarfile.open(self.output, "r:gz") as source:
            entries = [(m, source.extractfile(m).read()) for m in source.getmembers()]
        entries[1] = (entries[1][0], entries[1][1][:-1] + b"x")
        corrupt = self.root / "corrupt.tar.gz"
        with tarfile.open(corrupt, "w:gz") as dest:
            for info, data in entries:
                dest.addfile(info, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            bundle.verify(corrupt, "linux-x64-glibc")

        extra = self.root / "extra.tar.gz"
        with tarfile.open(extra, "w:gz") as dest:
            for info, data in entries:
                dest.addfile(info, io.BytesIO(data))
            info = tarfile.TarInfo("../outside")
            info.size = 1
            dest.addfile(info, io.BytesIO(b"x"))
        with self.assertRaisesRegex(ValueError, "unexpected bundle members"):
            bundle.verify(extra, "linux-x64-glibc")


if __name__ == "__main__":
    unittest.main()
