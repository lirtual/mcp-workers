/**
 * Linux v2 user-service installer, from a trusted checkout. No curl|sh,
 * sudo, Portal Bearer, Cloudflare token, or changes to deployed v1 services.
 *
 * node apps/remote-control-agent/scripts/install-v2.mjs --endpoint https://EXAMPLE/ [--name HOST]
 * node apps/remote-control-agent/scripts/install-v2.mjs --resume --endpoint https://EXAMPLE/
 * node apps/remote-control-agent/scripts/install-v2.mjs --upgrade --endpoint https://EXAMPLE/
 * node apps/remote-control-agent/scripts/install-v2.mjs --uninstall
 * node apps/remote-control-agent/scripts/install-v2.mjs --foreground --endpoint https://EXAMPLE/ --name TEST
 * node apps/remote-control-agent/scripts/install-v2.mjs --foreground --resume --endpoint https://EXAMPLE/
 */
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beginDeviceEnrollment } from "../src/pair-device.ts";
import { confirmDeviceLocally } from "../src/confirm-device.ts";

/** WSL2 runs the same Linux Agent; Windows is never an authentication peer. */
export function classifyLinuxKernel(release) {
  if (typeof release !== "string" || !release.trim()) {
    throw new Error("Unable to identify the Linux kernel.");
  }
  if (!/microsoft/i.test(release)) return "linux";
  // WSL1 cannot satisfy the Linux pidfd supervisor contract.
  return /wsl2/i.test(release) ? "wsl2" : "wsl1";
}

export const UNIT = "remote-control-v2-agent.service";
export const MARKER = "# Managed by mcp-workers v2 Linux installer; NOT the v1 Agent.";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(packageRoot, "src", "v2-main.ts");
const compilerScript = path.join(packageRoot, "scripts", "build-session-supervisor.mjs");
const IDENTITY_REL = path.join(".local", "share", "mcp-workers", "remote-control", "v2-identity.pem");
const UINT = /^[a-zA-Z0-9._/+-]+$/;

export function parseInstallArgs(argv) {
  const result = { action: "install", endpoint: undefined, name: undefined, foreground: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--foreground") {
      if (result.foreground) throw new Error("Duplicate foreground option.");
      result.foreground = true;
    } else if (arg === "--upgrade" || arg === "--uninstall" || arg === "--resume") {
      if (result.action !== "install") throw new Error("Choose one installer action.");
      result.action = arg.slice(2);
    } else if (arg === "--endpoint" || arg === "--name") {
      if (!argv[i + 1]) throw new Error("Missing required argument value.");
      result[arg.slice(2)] = argv[++i];
    } else {
      throw new Error("Unknown installer option.");
    }
  }
  if (result.foreground && (result.action === "uninstall" || result.action === "upgrade")) {
    throw new Error("Foreground supports first pairing or --resume only.");
  }
  if (result.action !== "uninstall" && !result.endpoint) {
    throw new Error("Provide --endpoint (a trusted HTTPS origin).");
  }
  if (result.action === "uninstall" && (result.endpoint || result.name)) {
    throw new Error("Uninstall accepts no endpoint or device label.");
  }
  if (result.name && (result.name.length > 64 || /[\x00-\x1f]/.test(result.name))) {
    throw new Error("Invalid device label.");
  }
  return result;
}

export function trustedEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/" ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) || url.hostname.startsWith(".") ||
      !Number.isInteger(Number(url.port || "443"))) {
    throw new Error("The device must use a clean, trusted HTTPS origin.");
  }
  return url.origin + "/";
}

function systemdLiteral(value) {
  // Reject systemd expansion, injection, and ambiguous paths. No secrets.
  if (!UINT.test(value) || value.includes("..") || value.includes("%") ||
      value.includes("\\") || value.includes("\n")) {
    throw new Error("The checkout and user paths must contain no spaces or systemd escapes.");
  }
  return value;
}

export function renderV2Service({ node, home, repoRoot, endpoint, keyPath }) {
  const nodePath = systemdLiteral(node);
  const project = systemdLiteral(repoRoot);
  const identity = systemdLiteral(keyPath);
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(project) ||
      !path.isAbsolute(identity) || !path.isAbsolute(home)) {
    throw new Error("Absolute installation paths are required.");
  }
  return [
    MARKER,
    "[Unit]",
    "Description=Remote Control v2 Agent (outbound WSS, independent of v1)",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=" + project + "/apps/remote-control-agent",
    "Environment=REMOTE_CONTROL_V2_ENDPOINT=" + trustedEndpoint(endpoint),
    "Environment=REMOTE_CONTROL_V2_KEY_PATH=" + identity,
    "UMask=0077",
    "ExecStartPre=/usr/bin/test -r " + identity,
    "ExecStartPre=/usr/bin/test -r " + identity + ".device-id",
    "ExecStartPre=/usr/bin/test -x " + project + "/apps/remote-control-agent/.build/session-supervisor",
    "ExecStart=" + nodePath + " --experimental-strip-types " + project + "/apps/remote-control-agent/src/v2-main.ts",
    "Restart=on-failure",
    "RestartSec=15s",
    "TimeoutStopSec=15s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) {
    if (binary === "cc") throw new Error("Missing or unusable cc compiler.");
    if (binary === "systemctl") throw new Error("The systemd user manager or requested user service action is unavailable.");
    if (binary === "systemd-analyze") throw new Error("Missing or unusable systemd-analyze.");
    if (binary === process.execPath) throw new Error("Could not compile the existing C session supervisor.");
    throw new Error("A local prerequisite is unavailable.");
  }
}

async function exists(target) {
  try { return await lstat(target); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function ownerOnly(file, expectedMode) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== expectedMode) {
    throw new Error("The existing private identity has unsafe ownership or permissions.");
  }
}

async function preflight(action, foreground) {
  if (process.platform !== "linux" || process.getuid?.() === 0 ||
      Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Install as a non-root Linux user with Node.js 24.");
  }
  systemdLiteral(process.execPath);
  systemdLiteral(packageRoot);
  const release = await readFile("/proc/sys/kernel/osrelease", "utf8");
  const host = classifyLinuxKernel(release);
  // Uninstall still works on a host that no longer supports the original
  // C pidfd helper; do not strand the independent v2 user-service unit.
  if (host === "wsl1" && action !== "uninstall") {
    throw new Error("WSL1 is not supported; use WSL2 with systemd.");
  }
  // Foreground testing is deliberately supervisor-free: same Node24/C
  // helper and identity constraints, no user bus, unit or daemon required.
  if (!foreground) run("systemctl", ["--user", "show-environment"]);
  if (action === "uninstall") return host; // No compiler required for removal.
  if (!foreground) run("systemd-analyze", ["--user", "--version"]);
  run("cc", ["--version"]);
  run(process.execPath, [compilerScript]);
  return host;
}

async function readOwnedUnit(file) {
  const meta = await exists(file);
  if (!meta) return null;
  if (!meta.isFile() || meta.isSymbolicLink() || meta.uid !== process.getuid()) {
    throw new Error("Refusing to replace a non-owned or linked systemd unit.");
  }
  const text = await readFile(file, "utf8");
  if (!text.startsWith(MARKER + "\n")) {
    throw new Error("An unrelated systemd service already occupies the v2 service name.");
  }
  return text;
}

async function atomicUnitWrite(unitPath, content) {
  const temporary = unitPath + "." + process.pid + ".tmp.service";
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally { await file.close(); }
  try {
    run("systemd-analyze", ["--user", "verify", temporary]);
    await rename(temporary, unitPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function installUnit(unitPath, content, previous) {
  await atomicUnitWrite(unitPath, content);
  try {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", previous ? "restart" : "enable", ...(previous ? [] : ["--now"]), UNIT]);
    run("systemctl", ["--user", "is-active", "--quiet", UNIT]);
  } catch {
    // Never leave an installed half-started v2 service on first installation.
    if (!previous) {
      try { run("systemctl", ["--user", "disable", "--now", UNIT]); } catch { /* unavailable */ }
      await rm(unitPath, { force: true });
    } else {
      await atomicUnitWrite(unitPath, previous);
      try {
        run("systemctl", ["--user", "daemon-reload"]);
        run("systemctl", ["--user", "restart", UNIT]);
      } catch { /* Preserve the old unit even if local service is unhealthy. */ }
    }
    try { run("systemctl", ["--user", "daemon-reload"]); } catch { /* unavailable */ }
    throw new Error("The v2 user service could not be activated; original v1 services were not touched.");
  }
}

async function launchForeground({ endpoint, keyPath }) {
  // Reuse the exact same signed-WSS Agent entrypoint as the systemd unit.
  // Import keeps SIGINT/SIGTERM handling in v2-main and no extra process,
  // job runner, local port or unattended supervisor is installed.
  process.env.REMOTE_CONTROL_V2_ENDPOINT = endpoint;
  process.env.REMOTE_CONTROL_V2_KEY_PATH = keyPath;
  await import("../src/v2-main.ts");
}

export async function runInstaller(args, {
  home = os.homedir(), stdin = process.stdin, stdout = process.stdout,
  startForeground = launchForeground,
} = {}) {
  const options = parseInstallArgs(args);
  const unitPath = path.join(home, ".config", "systemd", "user", UNIT);
  const keyPath = path.join(home, IDENTITY_REL);
  systemdLiteral(home);
  const host = await preflight(options.action, options.foreground);
  if (options.action !== "uninstall") trustedEndpoint(options.endpoint);
  if (host === "wsl2" && !options.foreground && options.action !== "uninstall") {
    stdout.write("WSL2 detected. This systemd user service cannot wake a stopped WSL distribution. " +
      "After Windows restart, open the distribution and verify the v2 service; " +
      "while WSL is stopped, the device is unavailable. See docs/remote-control/WSL2-V2-LIFECYCLE.md.\n");
  }
  const previous = await readOwnedUnit(unitPath);
  if (options.foreground && previous) {
    throw new Error("Foreground refuses to compete with an existing v2 systemd unit.");
  }

  if (options.action === "uninstall") {
    if (!previous) throw new Error("The dedicated v2 service is not installed.");
    run("systemctl", ["--user", "disable", "--now", UNIT]);
    await rm(unitPath);
    run("systemctl", ["--user", "daemon-reload"]);
    stdout.write("Removed the v2 user service. Local keys retained; revoke the device from MCP separately.\n");
    return;
  }
  if (((options.action === "install" || options.action === "resume") && previous) || (options.action === "upgrade" && !previous)) {
    throw new Error("Existing v2 service requires --upgrade; an absent service requires a first install.");
  }
  await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const privateDirectory = await lstat(path.dirname(keyPath));
  if (!privateDirectory.isDirectory() || privateDirectory.isSymbolicLink() ||
      privateDirectory.uid !== process.getuid() || (privateDirectory.mode & 0o077) !== 0) {
    throw new Error("The private identity directory must be owner-only.");
  }

  if (options.action === "resume") {
    if (!(await exists(keyPath)) || !(await exists(keyPath + ".device-id"))) {
      throw new Error("Resume requires a completed local confirmation and an absent v2 service.");
    }
  }

  if (options.action === "install") {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("First pairing needs the device's interactive terminal.");
    if (await exists(keyPath) || await exists(keyPath + ".device-id")) {
      throw new Error("An identity already exists; never overwrite or silently re-pair it.");
    }
    const enrollment = await beginDeviceEnrollment(options.name ?? os.hostname(), options.endpoint, keyPath);
    const terminal = createInterface({ input: stdin, output: stdout, terminal: true });
    try {
      stdout.write("Pending 10-minute pairing code: " + enrollment.code + "\n");
      stdout.write("Local public key fingerprint: " + enrollment.fingerprint + "\n");
      stdout.write("In authenticated MCP: pairing_lookup; compare its fingerprint with the one above, then pairing_prepare. Enter only the returned challenge here.\n");
      // The installer already holds the original code in memory. Prompt only
      // for the independently prepared challenge; never ask the user to type
      // a second lookalike code or persist the pairing code to disk.
      let challenge;
      for (let attempt = 0; attempt < 3; attempt++) {
        const typed = (await terminal.question("12-character MCP confirmation challenge: ")).trim().toUpperCase();
        if (/^[A-Z2-7]{12}$/.test(typed)) {
          challenge = typed;
          break;
        }
        if (attempt < 2) stdout.write("Challenge must be 12 characters (A-Z, 2-7). Try again.\n");
      }
      if (!challenge) throw new Error("Invalid local challenge format.");
      // The verifier and Ed25519 transcript remain bound to the exact code
      // generated for this identity; owner-reviewed server challenge is required.
      await confirmDeviceLocally(enrollment.code, challenge, options.endpoint, keyPath);
    } finally { terminal.close(); }
  }
  await ownerOnly(keyPath, 0o600);
  await ownerOnly(keyPath + ".device-id", 0o600);
  if (options.foreground) {
    stdout.write("v2 identity ready. Starting foreground Agent; closing this terminal or suspending the container disconnects it. No systemd service is created.\n");
    await startForeground({ endpoint: trustedEndpoint(options.endpoint), keyPath });
    return;
  }
  await mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 });
  const rendered = renderV2Service({
    node: process.execPath, home, repoRoot: path.resolve(packageRoot, "..", ".."),
    endpoint: options.endpoint, keyPath,
  });
  await installUnit(unitPath, rendered, previous);
  stdout.write("v2 user service active. Use list_devices and an approved nonsensitive read fixture to verify connectivity.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInstaller(process.argv.slice(2)).catch(error => {
    // Only print fixed, hard-coded classifications; never echo external
    // exception messages, endpoint query strings or private credential data.
    const safeErrors = [
      "Install as a non-root Linux user with Node.js 24.",
      "Missing or unusable cc compiler.",
      "The systemd user manager or requested user service action is unavailable.",
      "Missing or unusable systemd-analyze.",
      "Could not compile the existing C session supervisor.",
      "WSL1 is not supported; use WSL2 with systemd.",
      "Foreground supports first pairing or --resume only.",
    ];
    const reason = error instanceof Error && safeErrors.includes(error.message)
      ? error.message + " " : "";
    process.stderr.write(reason +
      "v2 installation/upgrade/removal failed; no v1 service was changed.\n");
    process.exitCode = 1;
  });
}
