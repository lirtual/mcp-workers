import { validInstallerOrigin } from "../src/install-bootstrap.ts";

/**
 * Historical old-repository install pins and the retired macOS pin shell.
 * Public routes do not import this module. The hashes stay as audit evidence.
 */

export type InstallReleasePin = Readonly<{
  tag: string; commit: string; x64Sha256: string; arm64Sha256: string;
  pairingProtocol: "two-code-v1" | "single-code-v1";
  upgradeMode?: "explicit-v1";
}>;

// Verified against the published, immutable public GitHub v0.1.2 Pre-release
// and both official Release asset digests. This constant is NOT a deployment
// approval; the active endpoint remains deliberately disabled below.
export const REVIEWED_V012_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.2",
  pairingProtocol: "two-code-v1",
  commit: "00aaf200107e42a1b7cede3db51f9a16edea5b09",
  x64Sha256: "b895f8133a03a53f4eacbf4fa6d0619f59ad722064c5e2e8ca469f9fc637221a",
  arm64Sha256: "ec16343f50b20b762b04a06039164c0f3a7f42bdeb597ab8e04ecc4b3e40724c",
});

// Historical immutable v0.1.2 uses two-code and MUST NEVER be offered by
// a Worker that only accepts one-code signed pending enrollments.
// Historical pins are audit fixtures only; public routes never serve them.
// Reviewed immutable TEST prerelease; native x64 and ARM64 build #39096572744.
// The prior v0.1.2 is retained above only as an explicitly incompatible fixture.
export const REVIEWED_V014_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.4",
  pairingProtocol: "single-code-v1",
  commit: "c389485e6570f8975346baa6bc6b0e56746824a1",
  x64Sha256: "3b3fa8c77e1c69a3e1542923eb9203c11f782b33fa96a6db832c526a4f816d4a",
  arm64Sha256: "bd9761a0cc740265aa825bd538a7a934bac4e3562f88f90507af958c3bfbafb8",
});
// Reviewed immutable native TEST release with an explicitly selected legacy
// upgrade path. Never infer that a user's old Python rca can install it.
// Official SHA256SUMS was re-downloaded and verified after publication.
export const REVIEWED_V016_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.6",
  pairingProtocol: "single-code-v1",
  upgradeMode: "explicit-v1",
  commit: "db1194ee151d93b68d0b21b6f0c19ac8b64ac065",
  x64Sha256: "328b0407c71713f360221e6422b66ec07f96796aaa7fcce18e27ed690bc7b5e6",
  arm64Sha256: "66d53cf06b35ea941401fd12e06e69236829cd002d06d883e6d7f752936494d6",
});
// Public immutable TEST v0.1.7, fixed annotated tag -> Agent fd24296;
// dual-native CI #39114540808 and official uploaded SHA256SUMS independently verified.
export const REVIEWED_V017_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.7",
  pairingProtocol: "single-code-v1",
  upgradeMode: "explicit-v1",
  commit: "fd24296d58768fff7a23440b858774d9dfaa7632",
  x64Sha256: "2b37334ccee4ae32bd9e95dc53e6813d6ca9cb9d17c97f108c7bb8b54c635a86",
  arm64Sha256: "3fd1262303712080821d75a1b036e7bbc7a0354bcc2c59a8d70e3d61f3f78167",
});
// Immutable public v0.1.8 TEST release, native CI #39118555940 (x64+arm64).
// Exact annotated Git tag peels to reviewed Agent source 4d58ffe; official
// published SHA256SUMS re-downloaded and compared byte for byte.
export const REVIEWED_V018_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.8",
  pairingProtocol: "single-code-v1",
  upgradeMode: "explicit-v1",
  commit: "4d58ffe33e560d6f5f1c375aacf02a774b51a6c0",
  x64Sha256: "e9116c0b1df5566d0ec49a187bf79e7e69e66698183db0da938eb355f82ed79f",
  arm64Sha256: "73f159fe722cec4e8d354160f8975532b4f07fe9538772b6ed64c95ae4576184",
});
// Independently checked against the published immutable Agent v0.1.10 Release.
// Source is merged Agent PR #11; both native packages passed native CI and
// SHA-256 verification in release workflow #39372060345.
// This selects the Agent only for future first installs; never re-pairs existing IDs.
export const REVIEWED_V0110_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.10",
  pairingProtocol: "single-code-v1",
  upgradeMode: "explicit-v1",
  commit: "8b78294a2fbff18a53d6e3ce0a13e6992ea63478",
  x64Sha256: "ad995f987c6f2cc428baadae92a330fe43ef5f0d52652e1fe582e332b9e26ba9",
  arm64Sha256: "bdb52cb83d0186127fc0ea65248d97701fe6cbc2d0d1ac9984b9e8eedf9a7397",
});
// Official immutable v0.1.11 Release, exact reviewed source and dual-native assets.
// This is also the supported one-time v0.1.8 readonly -> paired-full migration
// entrypoint: /install.sh --upgrade. Never use the legacy installed rca upgrade.
export const REVIEWED_V0111_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.11",
  pairingProtocol: "single-code-v1",
  upgradeMode: "explicit-v1",
  commit: "c558ac6a9f2ecc0129234790bf4f3b3a3a4aa191",
  x64Sha256: "641efcefe08d8bd4a70a1b3511d498d48a21687f05f167122219262bda9db6ec",
  arm64Sha256: "45d17c77c8fe37f7838f8015ad14518412161552e2d01f48e021788fb9a088dd",
});
// Published immutable Linux v0.1.13 from reviewed Agent PR #21, release CI
// #39915698471. Explicit one-time offline transition from installed v0.1.11
// is owner-controlled; serving this installer NEVER stops or upgrades devices.
export const REVIEWED_AGENT_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.13",
  pairingProtocol: "single-code-v1",
  upgradeMode: "explicit-v1",
  commit: "1171542d2951042cc1e0992c8cb9b97d3284fe03",
  x64Sha256: "bcb932d9f3539233204decf70ed0a748e2e31ac2a069e5b8b29484ab8733a0e3",
  arm64Sha256: "bdbe443d6010e372a03bff773d0e0bce946ac7bbbd45d9d1b75c99477eb23aa9",
});
// Reviewed immutable v0.1.51 five-platform Agent Release (source 03a14fd).
// The published Linux/Windows asset digests and unchanged Windows installer
// source SHA-256 were independently verified; no device upgrades on Worker deploy.
export const REVIEWED_PUBLIC_INSTALL_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.51",
  pairingProtocol: "single-code-v1",
  upgradeMode: "explicit-v1",
  commit: "03a14fd4138ca8d77fa8aced78f7a53ccc51724e",
  x64Sha256: "5330d88b5f1df4f250f453ea70cf43fe14b4cf362c437f6aac84a7c24981bbfc",
  arm64Sha256: "5b52f3e873e510a2810f6f0c7ee3b69c9226a4e4d00ebe8b8b6aabd73e415566",
});
/** Independent reviewed source and Release asset pins; both are required. */
export type WindowsInstallPin = Readonly<{
  tag: string; commit: string; scriptSha256: string; assetSha256: string;
}>;
// Public Windows bootstrap source is pinned to the exact immutable v0.1.51 Agent
// commit; the source hash is separate from the official Windows asset digest.
export const REVIEWED_WINDOWS_INSTALL_PIN: WindowsInstallPin = Object.freeze({
  tag: "v0.1.51",
  commit: "03a14fd4138ca8d77fa8aced78f7a53ccc51724e",
  scriptSha256: "6026d0e1a6422bb89c43e0168f60304be04fdc3a2ee96c4bf3192b12628f323a",
  assetSha256: "03f11bca0f21b7f8fd4ed1343db79827bb9b36be3feda0284b4b75f82d917311",
});

/** Reviewed macOS distribution contract. Pin native architectures and exact
 * owner-local installer source separately from the trusted HTTPS Worker script. */
