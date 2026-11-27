import { validInstallerOrigin } from "./installer-origin.ts";
import { renderClientReleaseManifestShell } from "./release-manifest-shell.ts";

const ARCHIVE_AWK = String.raw`/(^\/|(^|\/)\.\.?($|\/)|[^A-Za-z0-9._\/-])/ {bad=1}
  !($0 ~ /^bin\/?$/ || $0=="bin/node" ||
    $0 ~ /^apps\/?$/ || $0 ~ /^apps\/remote-control-agent\/?$/ ||
    $0 ~ /^apps\/remote-control-agent\/src\/?$/ ||
    $0 ~ /^apps\/remote-control-agent\/src\/[a-z0-9-]+\.js$/ ||
    $0 ~ /^apps\/remote-control-agent\/scripts\/?$/ ||
    ($0=="apps/remote-control-agent/scripts/macos-local.mjs" ||
     $0=="apps/remote-control-agent/scripts/macos-remote-upgrade.mjs" ||
     $0=="apps/remote-control-agent/scripts/macos-update.sh") ||
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
  return renderMacInstaller(origin);
}

/** Build-time entrypoint for the runtime carried by the verified package. */
export function renderPackagedMacUpdateShell(options: { nativeOnly?: boolean } = {}): string {
  return options.nativeOnly ? renderNativeMacUpdateShell() : renderMacInstaller(null);
}

/**
 * Native-only updater: Latest selection and byte verification stay in the
 * Rust manager. This script only validates/extracts that exact local archive
 * and dispatches the verified Rust candidate; it never runs Node or fetches.
 */
const NATIVE_ARCHIVE_AWK = String.raw`{
  name=$0
  if (substr(name,length(name),1)=="/") name=substr(name,1,length(name)-1)
  n=split(name,parts,"/")
  if (name=="" || substr(name,1,1)=="/") bad=1
  for (i=1;i<=n;i++) if (parts[i]=="" || parts[i]=="." || parts[i]==".." || parts[i] !~ /^[A-Za-z0-9._-]+$/) bad=1
  if (!(name=="bundle.json" || name=="apps" || name=="apps/remote-control-agent" ||
    name=="apps/remote-control-agent/.build" || name=="apps/remote-control-agent/scripts" ||
    name=="apps/remote-control-agent/.build/darwin-session-supervisor" ||
    name=="apps/remote-control-agent/.build/rca-standard-darwin-candidate" ||
    name=="apps/remote-control-agent/scripts/macos-update.sh")) bad=1
}
END {exit bad}`;

function renderNativeMacUpdateShell(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    "LC_ALL=C; export LC_ALL",
    '[ "$#" -eq 7 ] || { [ "$#" -eq 8 ] && [ "$8" = --automatic ]; } || { echo "Invalid native update request." >&2; exit 2; }',
    "archive=$1; digest=$2; size=$3; tag=$4; target=$5; endpoint=$6; binding=$7",
    'automatic=; if [ "$#" -eq 8 ]; then automatic=--automatic; fi',
    '[ "$(uname -s)" = Darwin ] || { echo "Native macOS required." >&2; exit 1; }',
    '[ "$(id -u)" -ne 0 ] || { echo "Non-root owner required." >&2; exit 1; }',
    'case "$target:$(uname -m)" in darwin-arm64:arm64|darwin-x64:x86_64) ;; *) echo "Native target mismatch." >&2; exit 1 ;; esac',
    'case "$binding" in *[!a-f0-9]*|"") exit 1 ;; esac',
    '[ "${#binding}" -eq 64 ] || exit 1',
    'case "$digest" in *[!a-f0-9]*|"") exit 1 ;; esac',
    '[ "${#digest}" -eq 64 ] || exit 1',
    'case "$size" in ""|*[!0-9]*) exit 1 ;; esac',
    '[ "$size" -gt 0 ] && [ "$size" -le 180000000 ] || exit 1',
    'case "$archive" in /*) ;; *) exit 1 ;; esac',
    '[ -f "$archive" ] && [ ! -L "$archive" ] || exit 1',
    'for tool in shasum tar mktemp wc tr sort uniq awk; do command -v "$tool" >/dev/null 2>&1 || { echo "Missing macOS update tool." >&2; exit 1; }; done',
    "[ \"$(wc -c < \"$archive\" | tr -d \" \")\" = \"$size\" ] || { echo \"Release asset size mismatch.\" >&2; exit 1; }",
    "[ \"$(shasum -a 256 \"$archive\" | awk '{print $1}')\" = \"$digest\" ] || { echo \"Release asset SHA-256 mismatch.\" >&2; exit 1; }",
    'stage=$(mktemp -d "${TMPDIR:-/tmp}/rca-native-update.XXXXXXXX")',
    "trap 'rm -rf -- \"$stage\"' EXIT HUP INT TERM",
    'members="$stage/members"; types="$stage/types"',
    'tar -tzf "$archive" > "$members"',
    'tar -tvzf "$archive" > "$types"',
    "awk '" + NATIVE_ARCHIVE_AWK + "' \"$members\" || { echo 'Untrusted native archive member.' >&2; exit 1; }",
    '[ "$(sort "$members" | uniq -d | wc -l | tr -d " ")" -eq 0 ] || { echo "Duplicate native archive member." >&2; exit 1; }',
    "awk '{if (substr($1,1,1)!=\"-\" && substr($1,1,1)!=\"d\") exit 1}' \"$types\" || { echo \"Unsafe native archive member type.\" >&2; exit 1; }",
    'mkdir "$stage/unpacked"; chmod 700 "$stage/unpacked"',
    'tar -xzf "$archive" -C "$stage/unpacked"',
    'candidate="$stage/unpacked/apps/remote-control-agent/.build/rca-standard-darwin-candidate"',
    '[ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -L "$candidate" ] || exit 1',
    'source=$("$candidate" --verify-bundle "$tag" "$target")',
    'case "$source" in *[!a-f0-9]*|"") exit 1 ;; esac',
    '[ "${#source}" -eq 40 ] || exit 1',
    'if [ "$automatic" = --automatic ]; then',
    '  exec "$candidate" --upgrade-local "$endpoint" "$tag" "$source" "$binding" --automatic',
    'fi',
    'exec "$candidate" --upgrade-local "$endpoint" "$tag" "$source" "$binding"',
    "",
  ].join("\n");
}

function renderMacInstaller(origin: string | null): string {
  const packaged = origin === null;
  const endpoint = packaged ? '"$endpoint"' : shellQuote(origin + "/");
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    ...(packaged ? [
      '[ "$#" -eq 3 ] || { [ "$#" -eq 4 ] && [ "$4" = --automatic ]; } || { echo "Use rca update" >&2; exit 1; }',
      "mode=upgrade; endpoint=$1; installed=$2; binding=$3",
      'if [ "$#" -eq 4 ]; then mode=automatic-upgrade; fi',
      "case \"$binding\" in *[!a-f0-9]*|'') exit 1 ;; esac",
      "[ \"${#binding}\" -eq 64 ] || exit 1",
    ] : [
    'case "$#" in',
    "  0) mode= ;;",
    '  1) case "$1" in --upgrade) mode=upgrade ;; --remote-upgrade) mode=remote-upgrade ;; *) echo "Unsupported installer action" >&2; exit 1 ;; esac ;;',
    '  *) echo "Unsupported installer action" >&2; exit 1 ;;',
    "esac",
    ]),
    "[ \"$(uname -s)\" = Darwin ] || { echo 'macOS only' >&2; exit 1; }",
    "[ \"$(id -u)\" -ne 0 ] || { echo 'Non-root macOS owner required' >&2; exit 1; }",
    'if [ "$mode" != remote-upgrade ] && [ "$mode" != automatic-upgrade ]; then',
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
    ...(packaged ? [
      'if [ "$tag" = "$installed" ]; then echo "Already up to date: $tag"; exit 0; fi',
    ] : []),
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
    ...(packaged ? [
      "awk '" + ARCHIVE_AWK + "' \"$members\" || { echo 'Untrusted archive member.' >&2; exit 1; }",
    ] : [
      "if awk '$0==\"bin/node\"{found=1} END {exit !found}' \"$members\"; then",
      "  runtime=node",
      "  awk '" + ARCHIVE_AWK + "' \"$members\" || { echo 'Untrusted Node archive member.' >&2; exit 1; }",
      "else",
      "  runtime=rust",
      "  awk '" + NATIVE_ARCHIVE_AWK + "' \"$members\" || { echo 'Untrusted native archive member.' >&2; exit 1; }",
      "fi",
    ]),
    "[ \"$(sort \"$members\" | uniq -d | wc -l | tr -d ' ')\" -eq 0 ] || { echo 'Untrusted archive member.' >&2; exit 1; }",
    "awk '{if (substr($1,1,1)!=\"-\" && substr($1,1,1)!=\"d\") exit 1}' \"$types\" || { echo 'Unsafe archive member type.' >&2; exit 1; }",
    "mkdir \"$stage/unpacked\"",
    "chmod 700 \"$stage/unpacked\"",
    "tar -xzf \"$archive\" -C \"$stage/unpacked\"",
    ...(!packaged ? [
      'if [ "$runtime" = rust ]; then',
      '  case "$mode" in upgrade|remote-upgrade) echo "Use installed rca update for Rust-to-Rust upgrades; old Node requires manual replacement. No cross-runtime change made." >&2; exit 1 ;; esac',
      '  candidate="$stage/unpacked/apps/remote-control-agent/.build/rca-standard-darwin-candidate"',
      '  [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -L "$candidate" ] || exit 1',
      '  if ! identity=$("$candidate" --verify-bundle "$tag" "$target"); then echo "Untrusted native package." >&2; exit 1; fi',
      '  case "$identity" in *[!a-f0-9]*|"") exit 1 ;; esac',
      '  [ "${#identity}" -eq 40 ] || exit 1',
      '  if [ -z "$mode" ]; then',
      '    printf "Install mode: [1] Permanent (login LaunchAgent), [2] Temporary (24h foreground): " > /dev/tty',
      '    IFS= read -r choice < /dev/tty || { echo "Owner selection cancelled" >&2; exit 1; }',
      '    case "$choice" in 1) mode=install ;; 2) mode=temporary ;; *) echo "No mode selected" >&2; exit 1 ;; esac',
      '  fi',
      '  printf "Device name: " > /dev/tty',
      '  IFS= read -r device_name < /dev/tty || { echo "Device name cancelled" >&2; exit 1; }',
      '  [ -n "$device_name" ] || { echo "Device name required" >&2; exit 1; }',
      '  if [ "$mode" = temporary ]; then',
      '    "$candidate" --temporary-local ' + endpoint + ' "$device_name" < /dev/tty > /dev/tty || { echo "Native temporary session failed; inspect local state." >&2; exit 1; }',
      '  else',
      '    "$candidate" --install-local ' + endpoint + ' "$device_name" "$tag" "$identity" < /dev/tty > /dev/tty || { echo "Native installation failed; inspect local state." >&2; exit 1; }',
      '  fi',
      '  exit 0',
      'fi',
    ] : []),
    "node=\"$stage/unpacked/bin/node\"",
    "[ -x \"$node\" ] && [ -f \"$node\" ] && [ ! -L \"$node\" ] || exit 1",
    "if ! identity=$(\"$node\" -e '" + IDENTITY_PROGRAM + "' \"$stage/unpacked/bundle.json\" \"$tag\" \"$target\"); then",
    "  echo 'Verified archive identity does not match this Mac or Release.' >&2",
    "  exit 1",
    "fi",
    'if [ "$mode" != upgrade ] && [ "$mode" != remote-upgrade ] && [ "$mode" != automatic-upgrade ]; then',
    "  printf 'Install mode: [1] Permanent (login LaunchAgent), [2] Temporary (24h foreground): ' > /dev/tty",
    "  IFS= read -r choice < /dev/tty || { echo 'Owner selection cancelled' >&2; exit 1; }",
    '  case "$choice" in 1) mode=install ;; 2) mode=temporary ;; *) echo "No mode selected" >&2; exit 1 ;; esac',
    "fi",
    ...(packaged ? [
      'if [ "$mode" = automatic-upgrade ]; then',
      '  entry="$stage/unpacked/apps/remote-control-agent/scripts/macos-remote-upgrade.mjs"',
      '  [ -f "$entry" ] && [ ! -L "$entry" ] || exit 1',
      '  "$node" "$entry" dispatch-automatic --bundle "$stage/unpacked" --source-sha "$identity" --endpoint "$endpoint" --expected-binding "$binding"',
      '  exit 0',
      'fi',
    ] : []),
    'if [ "$mode" = remote-upgrade ]; then',
    "  entry=\"$stage/unpacked/apps/remote-control-agent/scripts/macos-remote-upgrade.mjs\"",
    "  [ -f \"$entry\" ] && [ ! -L \"$entry\" ] || exit 1",
    "  if ! result=$(\"$node\" \"$entry\" dispatch --bundle \"$stage/unpacked\" --source-sha \"$identity\" --endpoint " + endpoint + "); then",
    "    echo 'macOS upgrade stopped; local recovery evidence retained.' >&2",
    "    exit 1",
    "  fi",
    "else",
    "  entry=\"$stage/unpacked/apps/remote-control-agent/scripts/macos-local.mjs\"",
    "  [ -f \"$entry\" ] && [ ! -L \"$entry\" ] || exit 1",
    // The verified attended manager owns confirmation, result reporting and
    // its exit status. Capturing stdout would remove the required owner TTY
    // and also break the foreground temporary Agent's terminal.
    "  if ! \"$node\" \"$entry\" \"$mode\" --bundle \"$stage/unpacked\" --source-sha \"$identity\" --endpoint " + endpoint + (packaged ? ' --expected-binding "$binding"' : "") + " < /dev/tty > /dev/tty; then",
    "    echo 'macOS upgrade stopped; local recovery evidence retained.' >&2",
    "    exit 1",
    "  fi",
    "  exit 0",
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
