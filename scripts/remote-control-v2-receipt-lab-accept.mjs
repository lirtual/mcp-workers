#!/usr/bin/env node
/**
 * One-time T07 live lab acceptance. Run ONLY in rc-v2-receipt-lab as the ray
 * administrative user; never copy the MCP bearer into rcagent's home.
 *
 *   LAB_DEVICE_ID="$(sudo -u rcagent -H cat /home/rcagent/.local/share/mcp-workers/remote-control/v2-identity.pem.device-id)" \
 *     node scripts/remote-control-v2-receipt-lab-accept.mjs probe
 *   LAB_DEVICE_ID="..." node scripts/remote-control-v2-receipt-lab-accept.mjs receipt
 *
 * Both phases fail closed and never retry a mutation after uncertain delivery.
 * This is not a simulated WSS lost-response / hibernation soak test.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ENDPOINT = "https://remote-control-v2-receipt-lab.aiyaya.workers.dev/mcp";
const USER = "rcagent";
const NAME = "rc-v2-receipt-lab";
const VALID_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DEVICE_ID = process.env.LAB_DEVICE_ID?.trim();
const phase = process.argv[2];
if (!["probe", "receipt"].includes(phase) || process.argv.length !== 3)
  throw new Error("Usage: node scripts/remote-control-v2-receipt-lab-accept.mjs probe|receipt");
if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME !== NAME)
  throw new Error("Refusing to run outside the disposable Receipt Lab WSL2 distro.");
if (!VALID_ID.test(DEVICE_ID ?? ""))
  throw new Error("LAB_DEVICE_ID must be read from the rcagent identity sidecar.");
if (os.userInfo().username === USER || process.getuid?.() === 0)
  throw new Error("Run as unprivileged lab administrator, NOT rcagent or root.");
const mounts = readFileSync("/proc/mounts", "utf8");
if (mounts.split("\n").some(line => /\bdrvfs\b/.test(line) || /\s\/mnt\/c\s/.test(line)))
  throw new Error("Windows mount detected: lab safety prerequisite not satisfied.");

const secretPath = path.join(os.homedir(), ".config/mcp-workers-receipt-lab/mcp-access-token");
const secretStat = statSync(secretPath);
if (!secretStat.isFile() || secretStat.uid !== process.getuid() || (secretStat.mode & 0o077))
  throw new Error("Lab bearer file must be owned by the administrator with mode 0600.");
const bearer = readFileSync(secretPath, "utf8").trim();
if (bearer.length < 32) throw new Error("Lab bearer appears invalid.");

async function rpc(name, args, token = bearer) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  return {
    http: response.status,
    isError: result.result?.isError === true || !!result.error,
    text: result.result?.content?.[0]?.text,
  };
}
async function data(name, args) {
  const r = await rpc(name, args);
  if (r.http !== 200 || r.isError || typeof r.text !== "string")
    throw new Error(`Lab ${name} failed (HTTP ${r.http}); no write retry performed.`);
  try { return JSON.parse(r.text); } catch { throw new Error(`Invalid ${name} response; no retry.`); }
}
async function status(operation_id) {
  const result = await data("get_operation_status", { device_id: DEVICE_ID, operation_id });
  if (result.operation_id !== operation_id) throw new Error("Receipt operation ID mismatch");
  return result;
}
function expectStatus(result, expected, label) {
  if (result.status !== expected) throw new Error(`${label}: status=${result.status}; stop rather than replay.`);
  console.log(`PASS: ${label} (${expected})`);
}
function checkResult(r, expected, label) {
  if (r !== expected) throw new Error(`${label}: unexpected response; stop.`);
  console.log(`PASS: ${label}`);
}

const entries = await data("list_devices", {});
assert.ok(Array.isArray(entries));
const approved = entries.filter(x => x.name === NAME && x.status !== "revoked");
assert.equal(approved.length, 1, "Expected exactly one non-revoked receipt lab device");
assert.equal(approved[0].device_id, DEVICE_ID, "Requested device differs from own guest's sidecar");
assert.equal(approved[0].status, "online", "Lab device must be online");
console.log("PASS: exactly one expected lab device online");

const identity = await rpc("read_file", { device_id: DEVICE_ID, path: "/etc/os-release" });
assert.equal(identity.http, 200);
assert.equal(identity.isError, false);
assert.match(identity.text ?? "", /Debian GNU\/Linux/);
console.log("PASS: explicit-device signed WSS read");

if (phase === "probe") {
  console.log("PROBE PASS: Agent remains read-only; no mutation attempted.");
  process.exit(0);
}

// Only after operator has deliberately stopped the read-only foreground Agent
// and started the separate, short-lived mutation-enabled foreground process.
const unauthorized = await rpc("write_file", { device_id: DEVICE_ID, operation_id: "blocked-" + randomUUID(),
  path: "/home/rcagent/no-auth-lab-fixture", mode: "append", content: "DENIED" }, "invalid-lab-token");
checkResult(unauthorized.http, 401, "unauthorized file write rejected");

const noId = await rpc("write_file", { device_id: DEVICE_ID, path: "/home/rcagent/no-id-lab-fixture",
  mode: "append", content: "DENIED" });
checkResult(noId.isError, true, "missing operation_id rejected");

const operation_id = "lab-append-" + randomUUID();
const fixture = `/home/${USER}/receipt-lab-fixture-${randomUUID()}.txt`;
const content = "RC_V2_APPEND_ONCE\n";
const request = { device_id: DEVICE_ID, operation_id, path: fixture, content, mode: "append" };
const first = await data("write_file", request);
expectStatus(first, "completed", "first append");
expectStatus(await status(operation_id), "completed", "persisted write receipt");
expectStatus(await data("write_file", request), "completed", "identical append replay");
const file = await rpc("read_file", { device_id: DEVICE_ID, path: fixture });
assert.equal(file.http, 200);
assert.equal(file.isError, false);
assert.equal(file.text, content, "Duplicate operation ID must not append twice");
console.log("PASS: fixture contains exactly one append");

expectStatus(await data("write_file", { ...request, content: "CHANGED\n" }), "conflict", "same ID, different payload");
const afterConflict = await rpc("read_file", { device_id: DEVICE_ID, path: fixture });
assert.equal(afterConflict.text, content, "Conflict must not modify fixture");
console.log("PASS: conflict has no file effect");

const unknown = await status("lab-unknown-" + randomUUID());
expectStatus(unknown, "not_found", "unknown receipt lookup");

const commandId = "lab-command-" + randomUUID();
const command = "printf 'RC_V2_RECEIPT_LAB_OK\\n'";
const cmdArgs = { device_id: DEVICE_ID, operation_id: commandId, command, timeout_ms: 1000 };
const launched = await data("run_command", cmdArgs);
if (!["running", "completed"].includes(launched.status) || !VALID_ID.test(launched.session_id ?? ""))
  throw new Error(`Unexpected command start result: ${launched.status}; do not retry.`);
console.log("PASS: benign printf launched with an owned session");
const duplicate = await data("run_command", cmdArgs);
assert.equal(duplicate.session_id, launched.session_id, "Duplicate must reuse original session");
console.log("PASS: same command ID did not create a second session");
expectStatus(await data("run_command", { ...cmdArgs, command: "printf 'CHANGED\\n'" }),
  "conflict", "same command ID, different command");
const commandReceipt = await status(commandId);
assert.equal(commandReceipt.receipt?.session_id, launched.session_id, "Session receipt mismatch");
console.log("PASS: command session receipt persisted");
const page = await data("read_session_output", {
  device_id: DEVICE_ID, session_id: launched.session_id, offset: 0, length: 2048,
});
assert.match(page.output ?? "", /RC_V2_RECEIPT_LAB_OK/);
console.log("PASS: bounded command output read");

console.log("LIVE RECEIPT PASS: cloud Worker→DO→WSS→Agent. Fixture:", fixture);
console.log("NOT TESTED: deliberate lost response, second device, 72-hour hibernation.");
