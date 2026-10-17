/**
 * Planned Worker-local convenience bootstrap. Fail closed until a reviewed
 * immutable zero-Python Release is published and its pins are supplied.
 */
export type InstallReleasePin = Readonly<{
  tag: string; commit: string; x64Sha256: string; arm64Sha256: string;
}>;

// Intentionally disabled until separate Release and deployment approval.
const VERIFIED_PYTHON_FREE_RELEASE: InstallReleasePin | null = null;
const APPROVED_ORIGINS = new Set(["https://remote-control-v2-preview.aiyaya.workers.dev"]);

function validPin(p: InstallReleasePin): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(p.tag)
    && /^[a-f0-9]{40}$/.test(p.commit)
    && /^[a-f0-9]{64}$/.test(p.x64Sha256)
    && /^[a-f0-9]{64}$/.test(p.arm64Sha256);
}

export function renderAgentInstallShell(origin: string, p: InstallReleasePin): string {
  if (!APPROVED_ORIGINS.has(origin) || !validPin(p))
    throw new Error("Unapproved immutable Agent release or install origin");
  // All interpolation is restricted to validated ASCII pins and origin.
  return [
    "#!/bin/sh",
    "# Worker-origin Agent installer: published immutable GitHub archive only",
    "set -eu",
    "umask 077",
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
    "stage=$(mktemp -d /tmp/rca-stage.XXXXXXXX)",
    "trap 'rm -rf -- \"$stage\"' EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    "archive=\"$stage/agent.tar.gz\"",
    "download=\"https://github.com/lirtual/remote-control-agent/releases/download/" + p.tag + "/remote-control-agent-" + p.tag + "-$target.tar.gz\"",
    "curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --max-time 180 --max-filesize 180000000 \"$download\" -o \"$archive\"",
    "printf '%s  %s\\n' \"$expected\" \"$archive\" | sha256sum -c - >/dev/null || { echo 'Verified asset checksum mismatch' >&2; exit 1; }",
    "# The COMPLETE archive has been verified before any bundled byte executes.",
    "tar -xOzf \"$archive\" bin/node > \"$stage/node\"",
    "tar -xOzf \"$archive\" apps/remote-control-agent/scripts/bootstrap-node.mjs > \"$stage/bootstrap-node.mjs\"",
    "chmod 700 \"$stage/node\"",
    "chmod 600 \"$stage/bootstrap-node.mjs\"",
    "unset NODE_OPTIONS NODE_PATH",
    "\"$stage/node\" \"$stage/bootstrap-node.mjs\" --archive \"$archive\" --tag \"" + p.tag +
      "\" --commit \"" + p.commit + "\" --sha256 \"$expected\" --endpoint \"" + origin + "/\" < /dev/tty",
    "",
  ].join("\n");
}

export function handleAgentInstallerRequest(
  request: Request,
  release: InstallReleasePin | null = VERIFIED_PYTHON_FREE_RELEASE,
): Response {
  const u = new URL(request.url);
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (u.pathname !== "/install.sh") return new Response("Not found.\n", { status:404, headers });
  if (request.method !== "GET" || u.search || u.hash || request.headers.has("origin"))
    return new Response("Invalid installation request.\n", { status:405, headers });
  if (u.protocol !== "https:" || !APPROVED_ORIGINS.has(u.origin) ||
      request.headers.has("forwarded") || request.headers.has("x-forwarded-host"))
    return new Response("Unapproved Worker origin.\n", { status:403, headers });
  if (!release || !validPin(release))
    return new Response("No reviewed Python-free Agent release is published yet.\n", { status:503, headers });
  return new Response(renderAgentInstallShell(u.origin,release), {
    status:200, headers: { ...headers, "content-type":"text/x-shellscript; charset=utf-8" },
  });
}
