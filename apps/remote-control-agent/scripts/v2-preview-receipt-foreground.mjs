#!/usr/bin/env node
/** Explicit, time-limited test of Receipt/Shell through the EXISTING v2 Preview.
 *  No new Worker, plugin or systemd unit. Not for normal/production v2 Agents.
 *  Run only as rcagent inside the disposable WSL distro.
 */
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maintainAuthenticatedDeviceSession } from "../src/v2-connection-lifecycle.ts";
import { dropOneCompletedWriteReply } from "./v2-preview-receipt-fault.mjs";

const ENDPOINT = "https://remote-control-v2-preview.aiyaya.workers.dev/";
const MAX_RUNTIME_MS = 12 * 60_000;
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--drop-reply-once" ||
    !/^receipt-fault-[a-z0-9-]{10,90}$/.test(args[1] ?? ""))) {
  throw new Error("Use --drop-reply-once receipt-fault-<unique-safe-id>, or no arguments.");
}
const faultId = args.length === 2 ? args[1] : null;
const faultState = { used: false };

if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME !== "rc-v2-receipt-lab" ||
    os.userInfo().username !== "rcagent" || process.getuid?.() === 0 ||
    process.versions.node.split(".")[0] !== "24" || os.homedir() !== "/home/rcagent") {
  throw new Error("The Receipt test is only allowed for rcagent in the disposable WSL2 distro.");
}
const mounts = await readFile("/proc/mounts", "utf8");
if (mounts.split("\n").some(line => /\bdrvfs\b/.test(line) || /\s\/mnt\/c\s/.test(line))) {
  throw new Error("The Receipt test refuses a mounted Windows filesystem.");
}
const home = os.homedir();
try {
  await lstat(path.join(home, ".config/systemd/user/remote-control-v2-agent.service"));
  throw new Error("Refusing to compete with an installed v2 systemd Agent.");
} catch (error) { if (error?.code !== "ENOENT") throw error; }
const key = path.join(home, ".local/share/mcp-workers/remote-control/v2-identity.pem");
for (const f of [key, key + ".device-id"]) {
  const st = await lstat(f);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() ||
      (st.mode & 0o777) !== 0o600) {
    throw new Error("The paired Preview test identity is not owner-only.");
  }
}
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), MAX_RUNTIME_MS);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
process.umask(0o077);
process.stderr.write("Preview test: opt-in file write and Shell for at most 12 minutes (Ctrl+C to stop).\n");
try {
  await maintainAuthenticatedDeviceSession(ENDPOINT, key, controller.signal, {
    readOnly: true,
    writeFile: true,
    shell: true,
    ...(faultId ? {
      makeSocket: (url, protocols) => dropOneCompletedWriteReply(
        new WebSocket(url, protocols), faultId, faultState,
        () => process.stderr.write("preview-receipt-test: discarded one committed write reply; reconnecting\\n"),
      ),
    } : {}),
    onState: state => process.stderr.write(`preview-receipt-test: ${state}\n`),
  });
} finally {
  clearTimeout(deadline);
  process.stderr.write("Preview test stopped; existing services are unchanged.\n");
}
