import { renderInstallHome } from "./install-home.ts";
/**
 * Existing immutable, explicitly pinned Linux bootstrap and the public
 * onboarding page. Windows remains fail-closed without a new reviewed Release.
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
// Preview may serve the new pinned release only with preview flag, owner DO and token.
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
// Reviewed immutable v0.1.40 Linux Release, candidate CI #41196656774.
// Publication is guarded by the existing three-asset release pin workflow;
// the Windows installer retains a separately validated script SHA-256.
export const REVIEWED_PUBLIC_INSTALL_RELEASE_PIN: InstallReleasePin = Object.freeze({
  tag: "v0.1.40",
  pairingProtocol: "single-code-v1",
  upgradeMode: "explicit-v1",
  commit: "6b3dd437c828c89b33cfb5f49e610f16ff6ecfbc",
  x64Sha256: "a5094f2c75406eb5a1c5581e1db36e6cc3482c94b4bbce14965e1f78486187fa",
  arm64Sha256: "3f8c221f6ec73f98c203fd0848243e8fa058a9a5c549891142842ae9af2124c2",
});
/** Independent reviewed source and Release asset pins; both are required. */
export type WindowsInstallPin = Readonly<{
  tag: string; commit: string; scriptSha256: string; assetSha256: string;
}>;
// Public Windows bootstrap source is pinned to the exact immutable v0.1.40 Agent
// commit; the source hash is separate from the official Windows asset digest.
export const REVIEWED_WINDOWS_INSTALL_PIN: WindowsInstallPin = Object.freeze({
  tag: "v0.1.40",
  commit: "6b3dd437c828c89b33cfb5f49e610f16ff6ecfbc",
  scriptSha256: "94267de0bdb9c8e8776929190e92143128ec15dcb714ca9dd37d15ba97778cb2",
  assetSha256: "6553dd901bd5883f670a1ba8e517ab45caecfa03030b3c74eef8894182ef499f",
});

/** Staged macOS distribution contract. No production macOS pin is assigned
 * until native host acceptance, immutable five-asset Release and owner approval.
 * Independently pin both archives and the exact owner-local installer source. */
export type MacInstallPin = Readonly<{
  tag: string; commit: string; arm64Sha256: string; x64Sha256: string;
  scriptSha256: string;
}>;
function validMacPin(pin: MacInstallPin): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(pin.tag) &&
    /^[a-f0-9]{40}$/.test(pin.commit) &&
    [pin.arm64Sha256,pin.x64Sha256,pin.scriptSha256].every(s=>/^[a-f0-9]{64}$/.test(s));
}

/** HTTPS Worker script is the bootstrap trust root. Pinned GitHub source and
 * Release bytes are separately verified before executing any downloaded file.
 * The pinned macos-local.sh must support both install and temporary actions
 * before publication. The public route stays 503 while the pin is absent. */
export function renderAgentInstallMacShell(origin: string, pin: MacInstallPin): string {
  if (!validInstallerOrigin(origin) || !validMacPin(pin))
    throw new Error("Unapproved macOS release pin or origin");
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    "[ \"$#\" -eq 0 ] || { echo 'Unexpected installer arguments' >&2; exit 1; }",
    "[ \"$(uname -s)\" = Darwin ] || { echo 'macOS only' >&2; exit 1; }",
    "[ \"$(id -u)\" -ne 0 ] && [ -t 0 ] && [ -t 1 ] || { echo 'Ordinary interactive Terminal required' >&2; exit 1; }",
    "for tool in curl shasum tar mktemp uname id sw_vers awk; do command -v \"$tool\" >/dev/null 2>&1 || { echo 'Missing macOS installer tool' >&2; exit 1; }; done",
    "major=$(sw_vers -productVersion | awk -F. '{print $1}')",
    "case \"$major\" in ''|*[!0-9]*) exit 1 ;; esac",
    "[ \"$major\" -ge 15 ] || { echo 'Requires macOS 15 or newer' >&2; exit 1; }",
    "case \"$(uname -m)\" in",
    "  arm64) target=darwin-arm64; expected="+pin.arm64Sha256+" ;;",
    "  x86_64) target=darwin-x64; expected="+pin.x64Sha256+"; [ \"$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || :)\" != 1 ] || { echo 'Rosetta not supported' >&2; exit 1; } ;;",
    "  *) echo 'Unsupported macOS architecture' >&2; exit 1 ;;",
    "esac",
    "stage=$(mktemp -d \"${TMPDIR:-/tmp}/rca-macos.XXXXXXXX\")",
    "trap 'rm -rf -- \"$stage\"' EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    "archive=\"$stage/agent.tar.gz\"",
    "source=\"$stage/macos-local.sh\"",
    "download=https://github.com/lirtual/remote-control-agent/releases/download/"+pin.tag+"/remote-control-agent-"+pin.tag+"-$target.tar.gz",
    "echo 'Downloading pinned native macOS Agent...'",
    "effective=$(curl -fL --progress-bar --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --max-time 180 --max-filesize 180000000 -w '%{url_effective}' \"$download\" -o \"$archive\")",
    "case \"$effective\" in \"$download\"|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) ;; *) echo 'Unexpected Release redirect' >&2; exit 1 ;; esac",
    "[ \"$(shasum -a 256 \"$archive\" | awk '{print $1}')\" = \"$expected\" ] || { echo 'Release asset SHA-256 mismatch' >&2; exit 1; }",
    "script_url=https://raw.githubusercontent.com/lirtual/remote-control-agent/"+pin.commit+"/apps/remote-control-agent/scripts/macos-local.sh",
    "curl -fSs --proto '=https' --tlsv1.2 --max-redirs 0 --max-time 30 --max-filesize 30000 \"$script_url\" -o \"$source\"",
    "[ \"$(shasum -a 256 \"$source\" | awk '{print $1}')\" = '"+pin.scriptSha256+"' ] || { echo 'Installer source SHA-256 mismatch' >&2; exit 1; }",
    "printf 'Install mode: [1] Permanent (login LaunchAgent), [2] Temporary (24h foreground): ' > /dev/tty",
    "IFS= read -r choice < /dev/tty || { echo 'Owner selection cancelled' >&2; exit 1; }",
    "case \"$choice\" in 1) mode=install ;; 2) mode=temporary ;; *) echo 'No mode selected' >&2; exit 1 ;; esac",
    "echo 'Verified immutable archive and exact installer source.'",
    "sh \"$source\" \"$mode\" --archive \"$archive\" --sha256 \"$expected\" --source-sha '"+pin.commit+"' --endpoint '"+origin+"/' < /dev/tty",
    "",
  ].join("\n");
}

function validWindowsPin(pin: WindowsInstallPin): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(pin.tag) &&
    /^[a-f0-9]{40}$/.test(pin.commit) &&
    /^[a-f0-9]{64}$/.test(pin.scriptSha256) && /^[a-f0-9]{64}$/.test(pin.assetSha256);
}

/** Fetch reviewed source bytes, validate them before executing any PowerShell. */
export function renderAgentInstallPowerShell(origin: string, pin: WindowsInstallPin): string {
  if (!validInstallerOrigin(origin) || !validWindowsPin(pin)) {
    throw Error("Unapproved Windows installer pin or origin");
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    "$uri = 'https://raw.githubusercontent.com/lirtual/remote-control-agent/" + pin.commit + "/install.ps1'",
    "$response = Invoke-WebRequest -Uri $uri -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 30",
    "$source = [string]$response.Content",
    "$sha = [Security.Cryptography.SHA256]::Create()",
    "try { $actual = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }",
    "if ($actual -cne '" + pin.scriptSha256 + "') { throw 'Installer source SHA-256 mismatch' }",
    "& ([ScriptBlock]::Create($source)) -Version '" + pin.tag + "' -PinnedCommit '" + pin.commit + "' -PinnedReleaseSha256 '" + pin.assetSha256 + "'",
    "if (-not $?) { throw 'Windows onboarding failed' }",
    "",
  ].join("\n");
}

// Never trust request Host alone: the allowed origin is supplied by the
// deployment's validated Custom Domain binding, not a source-code hostname.
export function validInstallerOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 255) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !!u.hostname && !u.port &&
      !u.username && !u.password && !u.search && !u.hash &&
      u.pathname === "/" && u.origin === value;
  } catch { return false; }
}

function validPin(p: InstallReleasePin): boolean {
  return p.pairingProtocol === "single-code-v1" &&
    (p.upgradeMode === undefined || p.upgradeMode === "explicit-v1") && /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(p.tag)
    && /^[a-f0-9]{40}$/.test(p.commit)
    && /^[a-f0-9]{64}$/.test(p.x64Sha256)
    && /^[a-f0-9]{64}$/.test(p.arm64Sha256);
}

export function renderAgentInstallShell(origin: string, p: InstallReleasePin): string {
  if (!validInstallerOrigin(origin) || !validPin(p))
    throw new Error("Unapproved immutable Agent release or install origin");
  // All interpolation is restricted to validated ASCII pins and origin.
  return [
    "#!/bin/sh",
    "# Worker-origin Agent installer: published immutable GitHub archive only",
    "set -eu",
    "umask 077",
    'case "$#" in',
    "  0) ;;",
    ...(p.upgradeMode === "explicit-v1"
      ? ['  1) [ "$1" = "--upgrade" ] || { echo "Unsupported installer action" >&2; exit 1; } ;;']
      : []),
    '  *) echo "Unsupported installer action" >&2; exit 1 ;;',
    "esac",
    "if [ \"$(id -u)\" -eq 0 ] || [ ! -r /dev/tty ] || [ ! -t 1 ]; then",
    "  echo 'Requires an ordinary interactive Linux user' >&2; exit 1",
    "fi",
    "for tool in curl sha256sum tar mktemp uname id chmod flock rm readlink dirname; do",
    "  command -v \"$tool\" >/dev/null 2>&1 || { echo 'Missing Linux installer tool' >&2; exit 1; }",
    "done",
    "[ \"$(uname -s)\" = Linux ] || { echo 'Linux only' >&2; exit 1; }",
    "case \"$(uname -m)\" in",
    " x86_64) target=linux-x64-glibc; expected=" + p.x64Sha256 + " ;;",
    " aarch64) target=linux-arm64-glibc; expected=" + p.arm64Sha256 + " ;;",
    " *) echo 'Unsupported Linux CPU' >&2; exit 1 ;;",
    "esac",
    "echo '==> [1/5] Linux host and CPU checks passed'",
    "stage=$(mktemp -d /tmp/rca-stage.XXXXXXXX)",
    "trap 'rm -rf -- \"$stage\"' EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    "archive=\"$stage/agent.tar.gz\"",
    "download=\"https://github.com/lirtual/remote-control-agent/releases/download/" + p.tag + "/remote-control-agent-" + p.tag + "-$target.tar.gz\"",
    "echo '==> [2/5] Downloading Remote Control Agent " + p.tag + "...'",
    "effective=$(curl -fL --progress-bar --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --max-time 180 --max-filesize 180000000 -w '%{url_effective}' \"$download\" -o \"$archive\")",
    "# Curl writes its real download progress to stderr; stdout retains only the final verified URL.",
    "# GitHub may redirect immutable Release assets to its own CDN, never an arbitrary host.",
    "case \"$effective\" in",
    "  \"$download\"|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) ;;",
    "  *) echo 'Unexpected GitHub Release asset redirect' >&2; exit 1 ;;",
    "esac",
    "echo '==> [3/5] Verifying GitHub asset URL and SHA-256...'",
    "printf '%s  %s\\n' \"$expected\" \"$archive\" | sha256sum -c - >/dev/null || { echo 'Verified asset checksum mismatch' >&2; exit 1; }",
    "echo '==> SHA-256 verification passed'",
    "# The COMPLETE archive has been verified before any bundled byte executes.",
    "echo '==> [4/5] Extracting bundled Node.js and bootstrap...'",
    "tar -xOzf \"$archive\" bin/node > \"$stage/node\"",
    "tar -xOzf \"$archive\" apps/remote-control-agent/scripts/bootstrap-node.mjs > \"$stage/bootstrap-node.mjs\"",
    "chmod 700 \"$stage/node\"",
    "chmod 600 \"$stage/bootstrap-node.mjs\"",
    "unset NODE_OPTIONS NODE_PATH",
    "echo '==> [5/5] Launching interactive Agent installer...'",
    "\"$stage/node\" \"$stage/bootstrap-node.mjs\" --archive \"$archive\" --tag \"" + p.tag +
      "\" --commit \"" + p.commit + "\" --sha256 \"$expected\" --endpoint \"" + origin + "/\" \"$@\" < /dev/tty",
    "",
  ].join("\n");
}

export function handleAgentInstallerRequest(
  request: Request,
  release: InstallReleasePin | null = null,
  trustedOrigin?: string,
  windowsPin: WindowsInstallPin | null = null,
  macosPin: MacInstallPin | null = null,
): Response {
  const u = new URL(request.url);
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (!["/", "/install.sh", "/install.ps1", "/install-macos.sh"].includes(u.pathname)) return new Response("Not found.\n", { status:404, headers });
  // The public home page is static. Mobile/in-app links may append tracking
  // query parameters or send Origin; neither is read or reflected by the page.
  // Keep both restrictions for executable installer scripts.
  if (request.method !== "GET" ||
      (u.pathname !== "/" && (u.search || u.hash || request.headers.has("origin"))))
    return new Response("Invalid installation request.\n", { status:405, headers });
  if (!validInstallerOrigin(trustedOrigin))
    return new Response("Installer origin is not configured.\n", { status:503, headers });
  if (u.protocol !== "https:" || u.origin !== trustedOrigin ||
      (request.headers.has("host") && request.headers.get("host") !== u.host) ||
      request.headers.has("forwarded") || request.headers.has("x-forwarded-host"))
    return new Response("Unapproved Worker origin.\n", { status:403, headers });
  if (u.pathname === "/") {
    return new Response(renderInstallHome({linux:!!release && validPin(release),
      windows:!!windowsPin && validWindowsPin(windowsPin),
      macos:!!macosPin && validMacPin(macosPin)}), {status:200, headers:{...headers,
      "content-type":"text/html; charset=utf-8", "x-frame-options":"DENY",
      "referrer-policy":"no-referrer", "content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
  }
  if (u.pathname === "/install-macos.sh") {
    if (!macosPin || !validMacPin(macosPin))
      return new Response("Reviewed macOS Agent release is not published yet.\n",{status:503,headers});
    return new Response(renderAgentInstallMacShell(u.origin,macosPin),{
      status:200,headers:{...headers,"content-type":"text/x-shellscript; charset=utf-8","x-frame-options":"DENY"},
    });
  }
  if (u.pathname === "/install.ps1") {
    if (!windowsPin || !validWindowsPin(windowsPin)) {
      return new Response("Reviewed Windows installer is not published yet.\n", {status:503,headers});
    }
    return new Response(renderAgentInstallPowerShell(u.origin,windowsPin), {
      status:200, headers:{...headers,"content-type":"text/plain; charset=utf-8",
        "x-frame-options":"DENY"},
    });
  }
  if (!release || !validPin(release))
    return new Response("No reviewed Python-free Agent release is published yet.\n", { status:503, headers });
  return new Response(renderAgentInstallShell(u.origin,release), {
    status:200, headers: { ...headers, "content-type":"text/x-shellscript; charset=utf-8" },
  });
}
