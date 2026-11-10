import windowsInstallerSource from "../agent/install.ps1";
import { renderClientReleaseManifestShell } from "./release-manifest-shell.ts";
import { renderInstallHome } from "./install-home.ts";
/**
 * Public onboarding page and the nested Windows installer text. Linux and
 * macOS latest shells are rendered by their own routes. Historical old-repository
 * pins are not consulted here.
 */
/** Serve the nested Windows installer. It resolves latest itself; no raw source pin. */
export function renderAgentInstallPowerShell(origin: string): string {
  if (!validInstallerOrigin(origin)) {
    throw Error("Unapproved Windows installer pin or origin");
  }
  return windowsInstallerSource.endsWith("\n") ? windowsInstallerSource : `${windowsInstallerSource}\n`;
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

const INSTALLER_PATHS = ["/", "/install.sh", "/install.ps1", "/install-macos.sh"];

/** Shared origin guard for every public installer route, including Linux latest. */
export function rejectUntrustedInstallerRequest(request: Request, trustedOrigin?: string): Response | null {
  const u = new URL(request.url);
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (!INSTALLER_PATHS.includes(u.pathname)) return new Response("Not found.\n", { status:404, headers });
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
  return null;
}

/** Static first-install shell: the owner device resolves one immutable snapshot. */
export function renderLinuxLatestInstallShell(origin: string): string {
  if (!validInstallerOrigin(origin)) throw new Error("Unapproved latest Agent release");
  return [
    "#!/bin/sh",
    "# Worker-origin Agent installer: one immutable GitHub Release snapshot",
    "set -eu",
    "umask 077",
    'case "$#" in',
    "  0) ;;",
    '  1) [ "$1" = "--upgrade" ] || { echo "Unsupported installer action" >&2; exit 1; } ;;',
    '  *) echo "Unsupported installer action" >&2; exit 1 ;;',
    "esac",
    "if [ \"$(id -u)\" -eq 0 ] || [ ! -r /dev/tty ] || [ ! -t 1 ]; then",
    "  echo 'Requires an ordinary interactive Linux user' >&2; exit 1",
    "fi",
    "for tool in curl sha256sum tar mktemp uname id chmod flock rm readlink dirname wc awk; do",
    "  command -v \"$tool\" >/dev/null 2>&1 || { echo 'Missing Linux installer tool' >&2; exit 1; }",
    "done",
    "[ \"$(uname -s)\" = Linux ] || { echo 'Linux only' >&2; exit 1; }",
    "case \"$(uname -m)\" in",
    " x86_64) target=linux-x64-glibc ;;",
    " aarch64) target=linux-arm64-glibc ;;",
    " *) echo 'Unsupported Linux CPU' >&2; exit 1 ;;",
    "esac",
    "echo '==> [1/5] Linux host and CPU checks passed'",
    "stage=$(mktemp -d /tmp/rca-stage.XXXXXXXX)",
    "trap 'rm -rf -- \"$stage\"' EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    ...renderClientReleaseManifestShell(),
    "archive=\"$stage/agent.tar.gz\"",
    "echo '==> [2/5] Downloading Remote Control Agent '\"$tag\"'...'",
    "effective=$(curl -fL --progress-bar --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --max-time 180 --max-filesize 180000000 -w '%{url_effective}' \"$download\" -o \"$archive\")",
    "# Curl writes its real download progress to stderr; stdout retains only the final verified URL.",
    "# GitHub may redirect this one immutable asset to its own CDN, never an arbitrary host.",
    "case \"$effective\" in",
    "  \"$download\"|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) ;;",
    "  *) echo 'Unexpected GitHub Release asset redirect' >&2; exit 1 ;;",
    "esac",
    "echo '==> [3/5] Verifying GitHub asset URL, size and SHA-256...'",
    "[ \"$(wc -c < \"$archive\")\" -eq \"$expected_size\" ] || { echo 'Verified asset size mismatch' >&2; exit 1; }",
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
    "\"$stage/node\" \"$stage/bootstrap-node.mjs\" --archive \"$archive\" --tag \"$tag\" --sha256 \"$expected\" --endpoint \"" +
      origin + "/\" \"$@\" < /dev/tty",
    "",
  ].join("\n");
}

export function handleAgentInstallerRequest(request: Request, trustedOrigin?: string): Response {
  const rejected = rejectUntrustedInstallerRequest(request, trustedOrigin);
  if (rejected) return rejected;
  const u = new URL(request.url);
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (u.pathname === "/") {
    return new Response(renderInstallHome({linux:true, windows:true, macos:true}), {status:200, headers:{...headers,
      "content-type":"text/html; charset=utf-8", "x-frame-options":"DENY",
      "referrer-policy":"no-referrer", "content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
  }
  if (u.pathname === "/install-macos.sh") {
    return new Response("Reviewed macOS Agent release is resolved per install attempt.\n",{status:503,headers});
  }
  if (u.pathname === "/install.ps1") {
    return new Response(renderAgentInstallPowerShell(u.origin), {
      status:200, headers:{...headers,"content-type":"text/plain; charset=utf-8",
        "x-frame-options":"DENY"},
    });
  }
  // Public /install.sh is the Worker latest route, not a pinned old-repository shell.
  return new Response("No reviewed Python-free Agent release is published yet.\n", { status:503, headers });
}
