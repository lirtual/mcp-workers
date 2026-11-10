import { validInstallerOrigin } from "./install-bootstrap.ts";
import { renderClientReleaseManifestShell } from "./release-manifest-shell.ts";

const ARCHIVE_AWK = String.raw`/(^\/|(^|\/)\.\.?($|\/)|[^A-Za-z0-9._\/-])/ {bad=1}
  !($0 ~ /^bin\/?$/ || $0=="bin/node" ||
    $0 ~ /^apps\/?$/ || $0 ~ /^apps\/remote-control-agent\/?$/ ||
    $0 ~ /^apps\/remote-control-agent\/src\/?$/ ||
    $0 ~ /^apps\/remote-control-agent\/src\/[a-z0-9-]+\.js$/ ||
    $0 ~ /^apps\/remote-control-agent\/scripts\/?$/ ||
    ($0=="apps/remote-control-agent/scripts/macos-local.mjs" ||
     $0=="apps/remote-control-agent/scripts/macos-remote-upgrade.mjs") ||
    $0 ~ /^apps\/remote-control-agent\/\.build\/?$/ ||
    $0=="apps/remote-control-agent/.build/darwin-session-supervisor" ||
    $0=="apps/remote-control-agent/package.json" || $0=="bundle.json") {bad=1}
  END {exit bad}`;

const IDENTITY_PROGRAM = String.raw`const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const version=process.argv[2],target=process.argv[3];if(m.name!=="remote-control-agent"||m.version!==version||m.target!==target||m.artifact_schema!==1||m.device_protocol!==2||m.receipt_schema!==1||m.candidate_profile!=="darwin-permanent-local-v1"||m.native_supervisor!=="darwin-owned-group-v1"||!Array.isArray(m.modules)||!m.modules.includes("macos-permanent.ts")||!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(m.version)||!/^[a-f0-9]{40}$/.test(m.source_commit))process.exit(2);process.stdout.write(m.source_commit);`;

function shellQuote(value: string): string {
  if (!/^[\x21-\x7E]+$/.test(value) || value.includes("'")) {
    throw new Error("Unsafe macOS installer literal");
  }
  return `'${value}'`;
}

/** Static bootstrap; the owner Mac reads one immutable GitHub manifest. */
export function renderLatestMacInstallShell(origin: string): string {
  if (!validInstallerOrigin(origin)) throw new Error("Unapproved macOS install origin");
  const endpoint = origin + "/";
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    'case "$#" in',
    "  0) mode= ;;",
    '  1) case "$1" in --upgrade) mode=upgrade ;; --remote-upgrade) mode=remote-upgrade ;; *) echo "Unsupported installer action" >&2; exit 1 ;; esac ;;',
    '  *) echo "Unsupported installer action" >&2; exit 1 ;;',
    "esac",
    "[ \"$(uname -s)\" = Darwin ] || { echo 'macOS only' >&2; exit 1; }",
    "[ \"$(id -u)\" -ne 0 ] || { echo 'Non-root macOS owner required' >&2; exit 1; }",
    'if [ "$mode" != remote-upgrade ]; then',
    '  [ -t 0 ] && [ -t 1 ] || { echo "Ordinary interactive Terminal required" >&2; exit 1; }',
    "fi",
    "for tool in curl shasum tar mktemp uname id sw_vers awk wc sort uniq tr; do command -v \"$tool\" >/dev/null 2>&1 || { echo 'Missing macOS installer tool' >&2; exit 1; }; done",
    "major=$(sw_vers -productVersion | awk -F. '{print $1}')",
    "case \"$major\" in ''|*[!0-9]*) exit 1 ;; esac",
    "[ \"$major\" -ge 15 ] || { echo 'Requires macOS 15 or newer' >&2; exit 1; }",
    "case \"$(uname -m)\" in",
    "  arm64) target=darwin-arm64 ;;",
    "  x86_64) target=darwin-x64; [ \"$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || :)\" != 1 ] || { echo 'Rosetta not supported' >&2; exit 1; } ;;",
    "  *) echo 'Unsupported macOS architecture' >&2; exit 1 ;;",
    "esac",
    "stage=$(mktemp -d \"${TMPDIR:-/tmp}/rca-macos.XXXXXXXX\")",
    "trap 'rm -rf -- \"$stage\"' EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    ...renderClientReleaseManifestShell(),
    "archive=\"$stage/agent.tar.gz\"",
    "echo 'Downloading the latest stable native macOS Agent...'",
    "effective=$(curl -fL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --max-time 180 --max-filesize 180000000 -w '%{url_effective}' \"$download\" -o \"$archive\")",
    "case \"$effective\" in",
    "  \"$download\"|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) ;;",
    "  *) echo 'Unexpected Release redirect' >&2; exit 1 ;;",
    "esac",
    "bytes=$(wc -c < \"$archive\" | tr -d ' ')",
    "[ \"$bytes\" = \"$expected_size\" ] || { echo 'Release asset size mismatch' >&2; exit 1; }",
    "[ \"$(shasum -a 256 \"$archive\" | awk '{print $1}')\" = \"$expected\" ] || { echo 'Release asset SHA-256 mismatch' >&2; exit 1; }",
    "members=\"$stage/members\"",
    "types=\"$stage/types\"",
    "tar -tzf \"$archive\" > \"$members\"",
    "tar -tvzf \"$archive\" > \"$types\"",
    "awk '" + ARCHIVE_AWK + "' \"$members\" || { echo 'Untrusted archive member.' >&2; exit 1; }",
    "[ \"$(sort \"$members\" | uniq -d | wc -l | tr -d ' ')\" -eq 0 ] || { echo 'Untrusted archive member.' >&2; exit 1; }",
    "awk '{if (substr($1,1,1)!=\"-\" && substr($1,1,1)!=\"d\") exit 1}' \"$types\" || { echo 'Unsafe archive member type.' >&2; exit 1; }",
    "mkdir \"$stage/unpacked\"",
    "chmod 700 \"$stage/unpacked\"",
    "tar -xzf \"$archive\" -C \"$stage/unpacked\"",
    "node=\"$stage/unpacked/bin/node\"",
    "[ -x \"$node\" ] && [ -f \"$node\" ] && [ ! -L \"$node\" ] || exit 1",
    "if ! identity=$(\"$node\" -e '" + IDENTITY_PROGRAM + "' \"$stage/unpacked/bundle.json\" \"$tag\" \"$target\"); then",
    "  echo 'Verified archive identity does not match this Mac or Release.' >&2",
    "  exit 1",
    "fi",
    'if [ "$mode" != upgrade ] && [ "$mode" != remote-upgrade ]; then',
    "  printf 'Install mode: [1] Permanent (login LaunchAgent), [2] Temporary (24h foreground): ' > /dev/tty",
    "  IFS= read -r choice < /dev/tty || { echo 'Owner selection cancelled' >&2; exit 1; }",
    '  case "$choice" in 1) mode=install ;; 2) mode=temporary ;; *) echo "No mode selected" >&2; exit 1 ;; esac',
    "fi",
    'if [ "$mode" = remote-upgrade ]; then',
    "  entry=\"$stage/unpacked/apps/remote-control-agent/scripts/macos-remote-upgrade.mjs\"",
    "  [ -f \"$entry\" ] && [ ! -L \"$entry\" ] || exit 1",
    "  if ! result=$(\"$node\" \"$entry\" dispatch --bundle \"$stage/unpacked\" --source-sha \"$identity\" --endpoint " + shellQuote(endpoint) + "); then",
    "    echo 'macOS upgrade stopped; local recovery evidence retained.' >&2",
    "    exit 1",
    "  fi",
    "else",
    "  entry=\"$stage/unpacked/apps/remote-control-agent/scripts/macos-local.mjs\"",
    "  [ -f \"$entry\" ] && [ ! -L \"$entry\" ] || exit 1",
    "  if ! result=$(\"$node\" \"$entry\" \"$mode\" --bundle \"$stage/unpacked\" --source-sha \"$identity\" --endpoint " + shellQuote(endpoint) + " < /dev/tty); then",
    "    echo 'macOS upgrade stopped; local recovery evidence retained.' >&2",
    "    exit 1",
    "  fi",
    "fi",
    "case \"$result\" in",
    "  '{\"status\":\"launched\"'*|'{\"status\":\"connected_observed\"'*|'{\"status\":\"stopped_preserved\"'*|'{\"status\":\"temporary_session_ended\"'*) ;;",
    "  *) echo 'Unknown macOS installer result; local recovery evidence retained.' >&2; exit 1 ;;",
    "esac",
    "",
  ].join("\n");
}

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** Reject a bad latest-install request before any GitHub lookup. Null means proceed. */
export function rejectLatestInstallRequest(request: Request, trustedOrigin: string | undefined): Response | null {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.search || url.hash || request.headers.has("origin")) {
    return new Response("Invalid installation request.\n", { status: 405, headers: NO_STORE });
  }
  if (!validInstallerOrigin(trustedOrigin)) {
    return new Response("Installer origin is not configured.\n", { status: 503, headers: NO_STORE });
  }
  if (url.protocol !== "https:" || url.origin !== trustedOrigin ||
      (request.headers.has("host") && request.headers.get("host") !== url.host) ||
      request.headers.has("forwarded") || request.headers.has("x-forwarded-host")) {
    return new Response("Unapproved Worker origin.\n", { status: 403, headers: NO_STORE });
  }
  return null;
}

export function handleLatestMacInstallRequest(
  request: Request,
  trustedOrigin: string | undefined,
): Response {
  const rejected = rejectLatestInstallRequest(request, trustedOrigin);
  if (rejected) return rejected;
  return new Response(renderLatestMacInstallShell(trustedOrigin as string), {
    status: 200,
    headers: {
      ...NO_STORE,
      "content-type": "text/x-shellscript; charset=utf-8",
      "x-frame-options": "DENY",
    },
  });
}
