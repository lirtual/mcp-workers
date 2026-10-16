#!/usr/bin/env node
/**
 * Disposable, time-limited T07 Receipt Lab ONLY. This file is never installed
 * into systemd, never enabled in v2-main, and does not acquire Portal credentials.
 *
 *   sudo -u rcagent -H node apps/remote-control-agent/scripts/v2-receipt-lab-foreground.mjs
 */
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maintainAuthenticatedDeviceSession } from "../src/v2-connection-lifecycle.ts";

const LAB_DISTRO = "rc-v2-receipt-lab";
const LAB_ENDPOINT = "https://remote-control-v2-receipt-lab.aiyaya.workers.dev/";
const LAB_USER = "rcagent";
const MAX_RUNTIME_MS = 12 * 60_000;

if (process.platform !== "linux" ||
    process.env.WSL_DISTRO_NAME !== LAB_DISTRO ||
    os.userInfo().username !== LAB_USER ||
    process.getuid?.() === 0 ||
    process.versions.node.split(".")[0] !== "24") {
  throw new Error("Lab agent denied: wrong WSL distro, Linux user, or Node version.");
}
const mounts = await readFile("/proc/mounts", "utf8");
if (mounts.split("\n").some(line => /\bdrvfs\b/.test(line) || /\s\/mnt\/c\s/.test(line))) {
  throw new Error("Lab agent denied: a Windows filesystem is mounted.");
}
const home = os.homedir();
if (home !== "/home/rcagent") throw new Error("Lab agent denied: unexpected home.");
const unit = path.join(home, ".config/systemd/user/remote-control-v2-agent.service");
try {
  await lstat(unit);
  throw new Error("Lab agent denied: an existing v2 systemd service was found.");
} catch (e) {
  if (e?.code !== "ENOENT") throw e;
}
const keyPath = path.join(home, ".local/share/mcp-workers/remote-control/v2-identity.pem");
for (const file of [keyPath, keyPath + ".device-id"]) {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() ||
      (st.mode & 0o777) !== 0o600) {
    throw new Error("Lab agent denied: private identity ownership/mode mismatch.");
  }
}
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), MAX_RUNTIME_MS);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => controller.abort());
}
process.umask(0o077);
process.stderr.write("Receipt Lab foreground Agent: explicit write/Shell test enabled for at most 12 minutes. Ctrl+C stops it.\n");
try {
  await maintainAuthenticatedDeviceSession(LAB_ENDPOINT, keyPath, controller.signal, {
    readOnly: true,
    writeFile: true,
    shell: true,
    onState: state => process.stderr.write(`receipt-lab-agent: ${state}\n`),
  });
} finally {
  clearTimeout(timeout);
  process.stderr.write("Receipt Lab foreground Agent stopped. No systemd service changed.\n");
}
