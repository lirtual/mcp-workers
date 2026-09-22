// THROWAWAY #173 CI adapter: only the pre-approved list_directory tool is used.
// This host-side adapter sends no remote path/tool names into Docker. The isolated
// Desktop Commander process has no network, shell exposure, or host home mount.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const scratch = resolve(dirname(fileURLToPath(import.meta.url)));
const image = "node:24-bookworm-slim"; // disposable CI proof, not a deployed agent
const maxBytes = 8192;

export async function readViaIsolatedDesktopCommander(fixedRoot) {
  // The caller supplies a startup-configured root, never a value from MCP.
  const root = await realpath(fixedRoot);
  let output;
  try {
    const result = await run("docker", [
      "run", "--rm", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "128", "--memory", "1g", "--cpus", "1",
      "--user", "1000:1000", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
      "--env", "UPSTREAM_FIXED_READ_ROOT=/allowed",
      "--volume", `${scratch}:/prototype:ro`,
      "--volume", `${root}:/allowed:ro`,
      "--workdir", "/prototype", image,
      "node", "test/upstream-stdio-proof.mjs",
    ], { timeout: 20000, maxBuffer: maxBytes, windowsHide: true });
    output = result.stdout.trim();
  } catch {
    // No stderr, absolute paths, arguments, or upstream metadata are returned.
    throw new Error("isolated_upstream_unavailable");
  }
  let result;
  try { result = JSON.parse(output); } catch { throw new Error("isolated_upstream_invalid_result"); }
  if (result?.source !== "desktop-commander-0.2.51" ||
      typeof result.text !== "string" || Buffer.byteLength(result.text) > 4096) {
    throw new Error("isolated_upstream_invalid_result");
  }
  return { source: result.source, text: result.text };
}
