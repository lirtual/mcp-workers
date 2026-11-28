"""Issue #39: isolated immutable Linux one-shot staging checks.

No Github request, systemd command, Service mutation, device or release is used.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "bootstrap-v2.py"
SPEC = importlib.util.spec_from_file_location("rca_bootstrap_v2_stage", SOURCE)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)
TAG = "v0.1.33"
COMMIT = "a" * 40
ENDPOINT = "https://rca.example.org/"
TARGET = "linux-x64-glibc"


def archive_bytes():
    raw = json.dumps({
        "name": "remote-control-agent", "version": TAG, "target": TARGET,
        "upgrade_profile": "paired-full-v1", "artifact_profile": "rust-native-only-v1",
        "agent_runtime": "rust-standard-linux-v1", "candidate_profile": "standard-linux-rust-runtime-v1", "modules": [],
        "device_protocol": 2, "receipt_schema": 1,
    }).encode("utf8")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        item = tarfile.TarInfo("bundle.json")
        item.size = len(raw)
        tar.addfile(item, io.BytesIO(raw))
    return buf.getvalue()


class LinuxStageOnly(unittest.TestCase):
    def stage(self, data, expected=None):
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()):
            with (mock.patch.object(bootstrap, "preflight", return_value=TARGET),
                  mock.patch.object(bootstrap, "program_home", return_value=pathlib.Path(folder)),
                  mock.patch.object(bootstrap, "resolve_pinned", return_value={
                      "download": "https://github.com/test/release.tar.gz",
                      "size": len(data), "digest": digest,
                  }),
                  mock.patch.object(bootstrap, "fetch", return_value=data) as download,
                  mock.patch.object(bootstrap, "inspect_archive", return_value=[]) as inspect,
                  mock.patch.object(bootstrap, "unpack_verified") as unpack,
                  mock.patch.object(bootstrap.os, "execv", side_effect=AssertionError("No Agent launch"))):
                bootstrap.install(TAG, COMMIT, ENDPOINT, stage_only=True,
                                  asset_sha256=expected if expected is not None else digest)
                download.assert_called_once()
                inspect.assert_called_once()
                unpack.assert_called_once()
                staged_path = unpack.call_args.args[1]
                self.assertEqual(staged_path.name, TAG + "-" + TARGET)

    def test_legacy_explicit_target_and_no_latest(self):
        with mock.patch.object(bootstrap, "json_api", side_effect=AssertionError("No Latest request")):
            with self.assertRaises(ValueError):
                bootstrap.resolve_latest_native(bootstrap.LEGACY_TARGET)
        with mock.patch.object(bootstrap, "root_opt_in"), mock.patch.object(bootstrap.platform, "machine", return_value="x86_64"), mock.patch.object(bootstrap.platform, "release", return_value="4.18.0"), mock.patch.object(bootstrap, "runtime_glibc", return_value=("glibc", "2.28")):
            self.assertEqual(bootstrap.preflight(TAG, COMMIT, ENDPOINT, stage_only=True, legacy=True), bootstrap.LEGACY_TARGET)
            with self.assertRaises(ValueError):
                bootstrap.preflight(TAG, COMMIT, ENDPOINT, stage_only=True)
            with self.assertRaises(ValueError):
                bootstrap.preflight(TAG, COMMIT, ENDPOINT, stage_only=True, legacy=True, latest_archive=True)

    def test_legacy_release_must_be_non_latest_prerelease(self):
        with mock.patch.object(bootstrap, "json_api", return_value={"tag_name": TAG + "-legacy", "immutable": True, "draft": False, "prerelease": False, "id": 1}) as api:
            with self.assertRaises(ValueError):
                bootstrap.resolve_pinned(TAG, COMMIT, bootstrap.LEGACY_TARGET)
            api.assert_called_once_with("/releases/tags/" + TAG + "-legacy")
        with mock.patch.object(bootstrap, "json_api", side_effect=AssertionError("No metadata request")):
            with self.assertRaises(ValueError):
                bootstrap.resolve_pinned(TAG + "-rust-candidate.1", COMMIT, bootstrap.LEGACY_TARGET)

    def test_legacy_pin_uses_separate_immutable_tag_and_numeric_asset_version(self):
        release_tag = TAG + "-legacy"
        name = "remote-control-agent-" + TAG + "-" + bootstrap.LEGACY_TARGET + ".tar.gz"
        url = "https://github.com/" + bootstrap.OWNER + "/releases/download/" + release_tag + "/" + name
        asset = {"name": name, "digest": "sha256:" + "b" * 64,
                 "state": "uploaded", "id": 9, "size": 1024,
                 "url": bootstrap.API + "/releases/assets/9", "browser_download_url": url}
        release = {"tag_name": release_tag, "immutable": True, "draft": False,
                   "prerelease": True, "id": 1, "assets": [asset]}
        reference = {"ref": "refs/tags/" + release_tag,
                     "object": {"type": "commit", "sha": COMMIT}}
        def metadata(path):
            return {"/releases/tags/" + release_tag: release,
                    "/git/ref/tags/" + release_tag: reference}[path]
        with mock.patch.object(bootstrap, "json_api", side_effect=metadata) as api:
            self.assertEqual(bootstrap.resolve_pinned(TAG, COMMIT, bootstrap.LEGACY_TARGET),
                             {"download": url, "size": 1024, "digest": "b" * 64})
            self.assertEqual(api.call_count, 2)
            with self.assertRaises(ValueError):
                bootstrap.resolve_pinned(TAG, "c" * 40, bootstrap.LEGACY_TARGET)
            self.assertEqual(api.call_count, 4)
            with self.assertRaises(ValueError):
                bootstrap.resolve_pinned(release_tag, COMMIT, TARGET)
            self.assertEqual(api.call_count, 4)

    def test_legacy_kernel_flag_requires_kernel_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = pathlib.Path(folder) / "42"
            proc.mkdir()
            status = "State:\tS (sleeping)\n"
            (proc / "stat").write_text("42 (with ) in name) S 1 2 3 4 5 2097152\n")
            self.assertTrue(bootstrap.proc_has_no_live_userspace(status, proc))
            self.assertFalse(bootstrap.proc_has_no_live_userspace(status + "Kthread:\t0\n", proc))
            (proc / "stat").write_text("99 (wrong pid) S 1 2 3 4 5 2097152\n")
            self.assertFalse(bootstrap.proc_has_no_live_userspace(status, proc))
            (proc / "stat").write_text("42 (user) S 1 2 3 4 5 0\n")
            self.assertFalse(bootstrap.proc_has_no_live_userspace(status, proc))

    def test_only_stage_only_bypasses_tty_not_non_root_or_runtime_safety(self):
        with (mock.patch.object(bootstrap.sys, "platform", "linux"),
              mock.patch.object(bootstrap.os, "geteuid", return_value=1001),
              mock.patch.object(bootstrap.sys, "stdin", mock.Mock(isatty=lambda: False)),
              mock.patch.object(bootstrap.sys, "stdout", mock.Mock(isatty=lambda: False)),
              mock.patch.object(bootstrap.platform, "machine", return_value="x86_64"),
              mock.patch.object(bootstrap.platform, "release", return_value="6.9.0"),
              mock.patch.object(bootstrap, "runtime_glibc", return_value=("glibc", "2.39"))):
            self.assertEqual(bootstrap.preflight(TAG, COMMIT, ENDPOINT, stage_only=True), TARGET)
            with self.assertRaisesRegex(ValueError, "real interactive terminal"):
                bootstrap.preflight(TAG, COMMIT, ENDPOINT, stage_only=False)
            with mock.patch.object(bootstrap.os, "geteuid", return_value=0):
                with self.assertRaisesRegex(ValueError, "non-root"):
                    bootstrap.preflight(TAG, COMMIT, ENDPOINT, stage_only=True)
            with mock.patch.object(bootstrap, "runtime_glibc", return_value=("glibc", "2.27")):
                with self.assertRaisesRegex(ValueError, "glibc 2.28"):
                    bootstrap.preflight(TAG, COMMIT, ENDPOINT, stage_only=True)

    def test_reviewed_sha_and_protocol_stage_without_install(self):
        self.stage(archive_bytes())

    def test_wrong_independent_pin_never_downloads_or_modifies_program(self):
        data = archive_bytes()
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as folder:
            with (mock.patch.object(bootstrap, "preflight", return_value=TARGET),
                  mock.patch.object(bootstrap, "program_home", return_value=pathlib.Path(folder)),
                  mock.patch.object(bootstrap, "resolve_pinned", return_value={
                      "download": "https://github.com/test/release.tar.gz",
                      "size": len(data), "digest": digest,
                  }),
                  mock.patch.object(bootstrap, "fetch") as download,
                  mock.patch.object(bootstrap, "unpack_verified") as unpack,
                  contextlib.redirect_stdout(io.StringIO())):
                with self.assertRaisesRegex(ValueError, "Reviewed SHA-256"):
                    bootstrap.install(TAG, COMMIT, ENDPOINT, stage_only=True,
                                      asset_sha256="f" * 64)
                download.assert_not_called()
                unpack.assert_not_called()

    def test_non_stage_call_refuses_sha_and_stage_refuses_install_options(self):
        for overrides in [
            {"stage_only": True, "asset_sha256": None},
            {"stage_only": True, "asset_sha256": "F" * 64},
            {"stage_only": True, "asset_sha256": "a" * 64, "upgrade": True},
            {"stage_only": True, "asset_sha256": "a" * 64, "name": "wrong"},
        ]:
            with mock.patch.object(bootstrap, "preflight") as preflight:
                with self.assertRaisesRegex(ValueError, "Stage-only|stage-only"):
                    bootstrap.install(TAG, COMMIT, ENDPOINT, **overrides)
                preflight.assert_not_called()

    def test_native_install_digest_and_action_boundaries(self):
        for overrides, message in [
            ({"asset_sha256": "a" * 64}, "exactly one native staging, install or upgrade action"),
            ({"temporary": True}, "Temporary mode requires --native-install"),
            ({"temporary": True, "stage_only": True, "asset_sha256": "a" * 64}, "Temporary mode requires --native-install"),
            ({"native_install": True}, "Native install requires a reviewed SHA-256"),
            ({"native_install": True, "asset_sha256": "F" * 64}, "Native install requires a reviewed SHA-256"),
            ({"native_install": True, "asset_sha256": "a" * 64, "upgrade": True}, "Native install requires a reviewed SHA-256"),
        ]:
            with mock.patch.object(bootstrap, "preflight") as preflight:
                with self.assertRaisesRegex(ValueError, message):
                    bootstrap.install(TAG, COMMIT, ENDPOINT, **overrides)
                preflight.assert_not_called()


if __name__ == "__main__":
    unittest.main()
