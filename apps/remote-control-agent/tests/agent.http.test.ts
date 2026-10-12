import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_RESULT_CHARS, MAX_SCAN_BYTES } from "../src/read-file.ts";
import { startAgent, type RunningAgent } from "../src/server.ts";

const DEVICE_TOKEN = "device-credential-for-tests";
const FIXTURE_TEXT = "FIXTURE_SENTINEL_remote_control_t01";
const VENDOR_DIR = ".claude-server-commander";

function processUsesHome(home: string): boolean {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return false;
  }

  for (const pid of pids) {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`).toString("utf8");
      if (environ.includes(`HOME=${home}\0`) || environ.endsWith(`HOME=${home}`)) return true;
    } catch {
      // The process exited or is not readable.
    }
  }
  return false;
}

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remote-control-agent-"));
}

async function call(
  agent: RunningAgent,
  body: unknown,
  token: string | null = DEVICE_TOKEN,
): Promise<{ status: number; text: string; json: unknown }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("x-device-credential", token);
  const response = await fetch(`${agent.baseUrl}/internal/call`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? (JSON.parse(text) as unknown) : null };
}

function completedText(json: unknown): string {
  const body = json as { status: string; result: { content: Array<{ type: string; text: string }> } };
  assert.equal(body.status, "completed");
  assert.equal(body.result.content[0]?.type, "text");
  return body.result.content[0]?.text ?? "";
}

test("agent package does not depend on Desktop Commander or an MCP client", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = packageJson.dependencies ?? {};
  assert.equal(dependencies["@wonderwhy-er/desktop-commander"], undefined);
  assert.equal(dependencies["@modelcontextprotocol/client"], undefined);

  const lockfile = await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.equal(lockfile.includes("@wonderwhy-er/desktop-commander"), false);
  const marker = "\n  apps/remote-control-agent:\n";
  const start = lockfile.indexOf(marker);
  assert.notEqual(start, -1);
  const rest = lockfile.slice(start + 1);
  const next = rest.indexOf("\n  apps/", 1);
  const agentSection = next === -1 ? rest : rest.slice(0, next);
  assert.equal(agentSection.includes("@modelcontextprotocol/client"), false);
  assert.equal(agentSection.includes("desktop-commander"), false);
});

test("listens on loopback only and requires a device credential", async () => {
  await assert.rejects(
    () => startAgent({ deviceToken: DEVICE_TOKEN, host: "0.0.0.0" }),
    /loopback/,
  );
  await assert.rejects(() => startAgent({ deviceToken: "" }), /not configured/);
});

test("device routes reject an invalid credential before any file read", async () => {
  const home = await temporaryHome();
  const events: string[] = [];
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    log: (event) => events.push(event),
    receiptDirectory: path.join(home, "receipts"),
  });
  const vendorHistory = path.join(os.homedir(), VENDOR_DIR);
  const vendorHistoryBefore = existsSync(vendorHistory);

  try {
    assert.equal(agent.hostname, "127.0.0.1");
    const secretPath = path.join(home, "secret-path.txt");
    await writeFile(secretPath, "AUTH_SENTINEL_must_not_be_read\n", "utf8");
    const results = [
      await call(agent, { tool: "read_file", arguments: { path: secretPath } }, "wrong-device-token"),
      await call(agent, { tool: "read_file", arguments: { path: secretPath } }, null),
    ];
    for (const result of results) {
      assert.equal(result.status, 401);
      assert.equal((result.json as { error: string }).error, "unauthorized");
      assert.equal(result.text.includes(DEVICE_TOKEN), false);
      assert.equal(result.text.includes(secretPath), false);
      assert.equal(result.text.includes("secret-path"), false);
      assert.equal(result.text.includes("AUTH_SENTINEL_must_not_be_read"), false);
    }

    const health = await fetch(`${agent.baseUrl}/internal/healthz`, {
      headers: { "x-device-credential": "wrong-device-token", authorization: "Bearer portal-token" },
    });
    assert.equal(health.status, 401);

    const status = await fetch(`${agent.baseUrl}/internal/operations/op-1`, {
      headers: { "x-device-credential": "nope" },
    });
    assert.equal(status.status, 401);

    assert.equal(processUsesHome(home), false);
    assert.equal(existsSync(path.join(home, VENDOR_DIR)), false);
    assert.equal(existsSync(vendorHistory), vendorHistoryBefore);
    assert.deepEqual(events, ["unauthorized", "unauthorized", "unauthorized", "unauthorized"]);
  } finally {
    await agent.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("write_file persists an operation receipt that can be queried after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-receipt-"));
  const receiptDirectory = path.join(root, "receipts");
  const fixture = path.join(root, "fixture.txt");
  await writeFile(fixture, "before", "utf8");
  let agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });

  try {
    const written = await call(agent, {
      tool: "write_file",
      operation_id: "fixture-write-1",
      arguments: { path: fixture, content: "after", mode: "rewrite" },
    });
    assert.equal(written.status, 200);
    assert.equal((written.json as { status: string }).status, "completed");
    assert.equal((written.json as { operation_id: string }).operation_id, "fixture-write-1");
    assert.equal(await readFile(fixture, "utf8"), "after");

    const status = await fetch(`${agent.baseUrl}/internal/operations/fixture-write-1`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    const statusJson = (await status.json()) as Record<string, unknown>;
    assert.equal(statusJson.operation_id, "fixture-write-1");
    assert.equal(statusJson.tool_name, "write_file");
    assert.equal(statusJson.state, "completed");
    assert.equal(typeof statusJson.created_at, "string");
    assert.equal(typeof statusJson.updated_at, "string");
    assert.equal("argument_digest" in statusJson, true);
    assert.equal(JSON.stringify(statusJson).includes("after"), false);

    await agent.close();
    agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });
    const afterRestart = await fetch(`${agent.baseUrl}/internal/operations/fixture-write-1`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    assert.equal((await afterRestart.json() as { state: string }).state, "completed");
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("write_file appends once for concurrent duplicate IDs and rejects changed parameters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-write-idempotency-"));
  const receiptDirectory = path.join(root, "receipts");
  const fixture = path.join(root, "fixture.txt");
  await writeFile(fixture, "start", "utf8");
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });
  try {
    const request = {
      tool: "write_file",
      operation_id: "append-once",
      arguments: { path: fixture, content: "+one", mode: "append" },
    };
    const repeated = await Promise.all(Array.from({ length: 5 }, () => call(agent, request)));
    assert.ok(repeated.every((item) => item.status === 200));
    assert.equal(await readFile(fixture, "utf8"), "start+one");

    const conflict = await call(agent, {
      ...request,
      arguments: { path: fixture, content: "+two", mode: "append" },
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.json as { error: string }).error, "conflict");
    assert.equal((conflict.json as { operation_id: string }).operation_id, "append-once");
    assert.equal(await readFile(fixture, "utf8"), "start+one");

    const missingId = await call(agent, {
      tool: "write_file",
      arguments: { path: fixture, content: "+bad", mode: "append" },
    });
    assert.equal(missingId.status, 400);
    assert.equal(await readFile(fixture, "utf8"), "start+one");

    const receiptFile = path.join(receiptDirectory, "operation-receipts.json");
    const persisted = await readFile(receiptFile, "utf8");
    assert.equal(persisted.includes("+one"), false);
    assert.equal(persisted.includes(fixture), false);
    assert.equal((await (await import("node:fs/promises")).stat(receiptFile)).mode & 0o777, 0o600);
    assert.equal((await (await import("node:fs/promises")).stat(receiptDirectory)).mode & 0o777, 0o700);
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an admitted receipt found after restart is unknown and is never replayed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-write-recovery-"));
  const receiptDirectory = path.join(root, "receipts");
  const fixture = path.join(root, "fixture.txt");
  await mkdir(receiptDirectory, { mode: 0o700 });
  await writeFile(fixture, "before", "utf8");
  const operationId = "crash-window";
  const digest = (await import("../src/operations.ts")).operationDigest("write_file", {
    path: fixture,
    content: "after",
    mode: "rewrite",
  });
  const now = new Date().toISOString();
  await writeFile(path.join(receiptDirectory, "operation-receipts.json"), JSON.stringify({
    version: 1,
    receipts: [{ operation_id: operationId, tool_name: "write_file", argument_digest: digest, state: "running", created_at: now, updated_at: now }],
  }), { mode: 0o600 });
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });
  try {
    const status = await fetch(`${agent.baseUrl}/internal/operations/${operationId}`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    assert.equal((await status.json() as { state: string }).state, "unknown");
    const duplicate = await call(agent, {
      tool: "write_file",
      operation_id: operationId,
      arguments: { path: fixture, content: "after", mode: "rewrite" },
    });
    assert.equal((duplicate.json as { status: string }).status, "unknown");
    assert.equal(await readFile(fixture, "utf8"), "before");
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a known filesystem permission failure retains its operation ID without leaking the path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-write-failure-"));
  const receiptDirectory = path.join(root, "receipts");
  const blockedDirectory = path.join(root, "blocked");
  await mkdir(blockedDirectory);
  await chmod(blockedDirectory, 0o500);
  const privatePath = path.join(blockedDirectory, "fixture.txt");
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });
  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("root bypasses directory write permissions");
      return;
    }
    const failed = await call(agent, {
      tool: "write_file",
      operation_id: "known-write-failure",
      arguments: { path: privatePath, content: "secret-content", mode: "rewrite" },
    });
    assert.equal((failed.json as { status: string }).status, "failed");
    assert.equal((failed.json as { operation_id: string }).operation_id, "known-write-failure");
    assert.equal(failed.text.includes(privatePath), false);
    assert.equal(failed.text.includes("secret-content"), false);
    const status = await fetch(`${agent.baseUrl}/internal/operations/known-write-failure`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    const receipt = await status.text();
    assert.equal((JSON.parse(receipt) as { state: string }).state, "failed");
    assert.equal(receipt.includes(privatePath), false);
    assert.equal(receipt.includes("secret-content"), false);
  } finally {
    await agent.close();
    await chmod(blockedDirectory, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("expired uncertain receipts become not_found based on admission time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-receipt-expiry-"));
  const receiptDirectory = path.join(root, "receipts");
  await mkdir(receiptDirectory, { mode: 0o700 });
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();
  await writeFile(path.join(receiptDirectory, "operation-receipts.json"), JSON.stringify({
    version: 1,
    receipts: [{ operation_id: "expired-unknown", tool_name: "write_file", argument_digest: "a".repeat(64), state: "unknown", created_at: old, updated_at: recent }],
  }), { mode: 0o600 });
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });
  try {
    const status = await fetch(`${agent.baseUrl}/internal/operations/expired-unknown`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    assert.equal(status.status, 404);
    assert.equal((await status.json() as { error: string }).error, "not_found");
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt capacity preserves uncertain records and rejects new dispatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-receipt-capacity-"));
  const receiptDirectory = path.join(root, "receipts");
  await mkdir(receiptDirectory, { mode: 0o700 });
  const now = new Date().toISOString();
  const receipts = Array.from({ length: 1000 }, (_, index) => ({
    operation_id: `unknown-${index}`,
    tool_name: "write_file",
    argument_digest: "b".repeat(64),
    state: "unknown",
    created_at: now,
    updated_at: now,
  }));
  await writeFile(path.join(receiptDirectory, "operation-receipts.json"), JSON.stringify({ version: 1, receipts }), { mode: 0o600 });
  const fixture = path.join(root, "must-not-be-created.txt");
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });
  try {
    const result = await call(agent, {
      tool: "write_file",
      operation_id: "capacity-rejected",
      arguments: { path: fixture, content: "no side effect", mode: "rewrite" },
    });
    assert.equal(result.status, 503);
    assert.equal((result.json as { operation_id: string }).operation_id, "capacity-rejected");
    assert.equal((result.json as { status: string }).status, "unavailable");
    assert.equal(existsSync(fixture), false);
    const retained = await fetch(`${agent.baseUrl}/internal/operations/unknown-0`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    assert.equal((await retained.json() as { state: string }).state, "unknown");
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("health and operation status do not execute work or expose host details", async () => {
  const home = await temporaryHome();
  const events: string[] = [];
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    log: (event) => events.push(event),
    receiptDirectory: path.join(home, "receipts"),
  });

  try {
    const healthResponse = await fetch(`${agent.baseUrl}/internal/healthz`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    const healthText = await healthResponse.text();
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(JSON.parse(healthText), { status: "ok" });
    assert.equal(healthText.includes(os.userInfo().username), false);
    assert.equal(healthText.includes(os.homedir()), false);
    assert.equal(healthText.includes(home), false);
    assert.equal(healthText.includes(DEVICE_TOKEN), false);

    const statusResponse = await fetch(`${agent.baseUrl}/internal/operations/op-does-not-exist`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    const statusText = await statusResponse.text();
    assert.equal(statusResponse.status, 404);
    assert.equal((JSON.parse(statusText) as { error: string }).error, "not_found");
    assert.equal(statusText.includes("op-does-not-exist"), false);

    const rejectedId = await fetch(`${agent.baseUrl}/internal/operations/not%20an%20id`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    const rejectedText = await rejectedId.text();
    assert.equal(rejectedId.status, 400);
    assert.equal(rejectedText.includes(DEVICE_TOKEN), false);
    assert.equal(rejectedText.includes("not an id"), false);

    assert.equal(processUsesHome(home), false);
    assert.equal(existsSync(path.join(home, VENDOR_DIR)), false);
    assert.deepEqual(events, ["health", "status", "rejected"]);
  } finally {
    await agent.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects URL reads, admin tools, and write or shell calls before opening a file", async () => {
  const home = await temporaryHome();
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN });
  const secretUrl = "http://203.0.113.9/secret-file";

  try {
    const calls: Array<{ body: unknown; label: string }> = [
      { label: "url flag", body: { tool: "read_file", arguments: { path: secretUrl, isUrl: true } } },
      { label: "url path", body: { tool: "read_file", arguments: { path: "file:///etc/hostname" } } },
      { label: "host argument", body: { tool: "read_file", arguments: { path: "fixture.txt", host: "203.0.113.9" } } },
      { label: "port argument", body: { tool: "read_file", arguments: { path: "fixture.txt", port: 9 } } },
      { label: "scheme argument", body: { tool: "read_file", arguments: { path: "fixture.txt", scheme: "https" } } },
      { label: "url argument", body: { tool: "read_file", arguments: { path: "fixture.txt", url: secretUrl } } },
      { label: "write", body: { tool: "write_file", arguments: { path: "fixture.txt", content: "nope" } } },
      { label: "shell", body: { tool: "start_process", arguments: { command: "id" } } },
      { label: "config", body: { tool: "set_config_value", arguments: { key: "telemetryEnabled", value: true } } },
      { label: "get config", body: { tool: "get_config", arguments: {} } },
      { label: "processes", body: { tool: "list_processes", arguments: {} } },
      { label: "kill", body: { tool: "kill_process", arguments: { pid: 1 } } },
    ];

    for (const entry of calls) {
      const result = await call(agent, entry.body);
      assert.equal(result.status, 400, entry.label);
      assert.equal(result.text.includes(secretUrl), false, entry.label);
      assert.equal(result.text.includes("203.0.113.9"), false, entry.label);
      assert.equal(result.text.includes(DEVICE_TOKEN), false, entry.label);
      assert.equal(result.text.includes("at "), false, entry.label);
    }

    assert.equal(processUsesHome(home), false);
    assert.equal(existsSync(path.join(home, VENDOR_DIR)), false);
  } finally {
    await agent.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("reads a disposable fixture through node:fs without vendor history or secret logs", async () => {
  const home = await temporaryHome();
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remote-control-fixture-"));
  const fixturePath = path.join(fixtureDir, "fixture.txt");
  const missingPath = path.join(fixtureDir, "missing-SENTINEL.txt");
  const blockedPath = path.join(fixtureDir, "blocked-SENTINEL.txt");
  const oversizedPath = path.join(fixtureDir, "oversized.txt");
  const scanPath = path.join(fixtureDir, "scan-bound.txt");
  const lines = ["alpha", "beta", "GAMMA_SECRET_LINE", "delta"];
  await writeFile(fixturePath, `${lines.join("\n")}\n${FIXTURE_TEXT}\n`, "utf8");
  await writeFile(blockedPath, "ACCESS_SENTINEL_must_not_leak\n", "utf8");
  await chmod(blockedPath, 0o000);
  const oversizedSentinel = "OVERSIZE_SENTINEL_must_not_leak";
  await writeFile(oversizedPath, `${oversizedSentinel}${"A".repeat(MAX_RESULT_CHARS)}`, "utf8");
  const scanSentinel = "SCAN_SENTINEL_must_not_leak";
  const scanLine = "y\n";
  const scanCount = Math.ceil((MAX_SCAN_BYTES + 64) / scanLine.length);
  await writeFile(scanPath, `${scanSentinel}\n${scanLine.repeat(scanCount)}`, "utf8");
  const events: string[] = [];
  const vendorHistory = path.join(os.homedir(), VENDOR_DIR);
  const vendorHistoryBefore = existsSync(vendorHistory);
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    log: (event) => events.push(event),
  });

  try {
    const portalToken = "portal-bearer-must-not-matter";
    const response = await fetch(`${agent.baseUrl}/internal/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${portalToken}`,
        host: "attacker.example",
        "x-device-credential": DEVICE_TOKEN,
        "x-forwarded-host": "203.0.113.9",
      },
      body: JSON.stringify({
        tool: "read_file",
        arguments: { path: fixturePath, offset: 0, length: 2 },
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(completedText(JSON.parse(text)), "alpha\nbeta");
    assert.equal(text.includes("GAMMA_SECRET_LINE"), false);
    assert.equal(text.includes(FIXTURE_TEXT), false);
    assert.equal(text.includes(portalToken), false);
    assert.equal(text.includes(DEVICE_TOKEN), false);
    assert.equal(text.includes(fixturePath), false);

    const tail = await call(agent, { tool: "read_file", arguments: { path: fixturePath, offset: -1, length: 1 } });
    assert.equal(tail.status, 200);
    assert.equal(completedText(tail.json), FIXTURE_TEXT);
    assert.equal(tail.text.includes(fixturePath), false);
    assert.equal(tail.text.includes("GAMMA_SECRET_LINE"), false);

    const fullWindow = await call(agent, {
      tool: "read_file",
      arguments: { path: fixturePath, offset: 0, length: 5 },
    });
    assert.equal(fullWindow.status, 200);
    assert.equal(completedText(fullWindow.json).includes(FIXTURE_TEXT), true);

    const failed = await call(agent, { tool: "read_file", arguments: { path: missingPath } });
    assert.equal(failed.status, 200);
    assert.equal((failed.json as { status: string }).status, "failed");
    assert.equal((failed.json as { error: { message: string } }).error.message, "The file read failed.");
    assert.equal(failed.text.includes(missingPath), false);
    assert.equal(failed.text.includes("missing-SENTINEL"), false);
    assert.equal(failed.text.includes(FIXTURE_TEXT), false);
    assert.equal(failed.text.includes("Error:"), false);

    const blocked = await call(agent, { tool: "read_file", arguments: { path: blockedPath } });
    assert.equal(blocked.status, 200);
    assert.equal((blocked.json as { status: string }).status, "failed");
    assert.equal(blocked.text.includes(blockedPath), false);
    assert.equal(blocked.text.includes("blocked-SENTINEL"), false);
    assert.equal(blocked.text.includes("ACCESS_SENTINEL_must_not_leak"), false);
    assert.equal(blocked.text.includes("EACCES"), false);

    const directory = await call(agent, { tool: "read_file", arguments: { path: fixtureDir } });
    assert.equal(directory.status, 200);
    assert.equal((directory.json as { status: string }).status, "failed");
    assert.equal(directory.text.includes(fixtureDir), false);

    const oversized = await call(agent, {
      tool: "read_file",
      arguments: { path: oversizedPath, offset: 0, length: 1 },
    });
    assert.equal(oversized.status, 200);
    assert.equal((oversized.json as { status: string }).status, "failed");
    assert.equal(oversized.text.includes(oversizedSentinel), false);
    assert.equal(oversized.text.includes("A".repeat(64)), false);
    assert.equal(oversized.text.includes(oversizedPath), false);

    const scanBound = await call(agent, {
      tool: "read_file",
      arguments: { path: scanPath, offset: 1_000_000, length: 1 },
    });
    assert.equal(scanBound.status, 200);
    assert.equal((scanBound.json as { status: string }).status, "failed");
    assert.equal(scanBound.text.includes(scanSentinel), false);
    assert.equal(scanBound.text.includes(scanPath), false);

    const firstOfLarge = await call(agent, {
      tool: "read_file",
      arguments: { path: scanPath, offset: 0, length: 1 },
    });
    assert.equal(firstOfLarge.status, 200);
    assert.equal(completedText(firstOfLarge.json), scanSentinel);

    assert.equal(processUsesHome(home), false);
    assert.equal(existsSync(path.join(home, VENDOR_DIR)), false);
    assert.equal(existsSync(vendorHistory), vendorHistoryBefore);

    const logText = events.join("\n");
    assert.equal(logText.includes(FIXTURE_TEXT), false);
    assert.equal(logText.includes(fixturePath), false);
    assert.equal(logText.includes("GAMMA_SECRET_LINE"), false);
    assert.equal(logText.includes("ACCESS_SENTINEL_must_not_leak"), false);
    assert.equal(logText.includes(oversizedSentinel), false);
    assert.equal(logText.includes(scanSentinel), false);
    assert.equal(logText.includes(DEVICE_TOKEN), false);
    assert.equal(logText.includes(portalToken), false);
    assert.equal(events.includes("read_completed"), true);
    assert.equal(events.includes("read_failed"), true);
  } finally {
    await chmod(blockedPath, 0o600).catch(() => undefined);
    await agent.close();
    await rm(home, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("lists, describes, and batch-reads a disposable directory within fixed bounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-browse-"));
  const nested = path.join(root, "keep", "nested");
  await mkdir(nested, { recursive: true });
  const visible = "VISIBLE_FIXTURE_LINE";
  const hidden = "HIDDEN_SYMLINK_TARGET_SENTINEL";
  await writeFile(path.join(root, "keep", "note.txt"), `${visible}\n`, "utf8");
  await writeFile(path.join(nested, "deep.txt"), "deep\n", "utf8");
  const secretDir = await mkdtemp(path.join(os.tmpdir(), "remote-control-secret-dir-"));
  await writeFile(path.join(secretDir, "secret.txt"), `${hidden}\n`, "utf8");
  await symlink(secretDir, path.join(root, "linked"));
  const blocked = path.join(root, "blocked.txt");
  await writeFile(blocked, "ACCESS_SENTINEL_must_not_leak\n", "utf8");
  await chmod(blocked, 0o000);
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN });

  try {
    const shallow = await call(agent, { tool: "list_directory", arguments: { path: root, depth: 1 } });
    assert.equal(shallow.status, 200);
    const shallowText = (shallow.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.equal(shallowText.includes("directory keep"), true);
    assert.equal(shallowText.includes("symlink linked"), true);
    assert.equal(shallowText.includes("file blocked.txt"), true);
    assert.equal(shallowText.includes("deep.txt"), false);
    assert.equal(shallowText.includes(hidden), false);
    assert.equal(shallowText.includes("truncated: false"), true);

    const deeper = await call(agent, { tool: "list_directory", arguments: { path: root, depth: 3 } });
    const deeperText = (deeper.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.equal(deeperText.includes("file keep/nested/deep.txt"), true);
    assert.equal(deeperText.includes("secret.txt"), false);

    const info = await call(agent, { tool: "get_file_info", arguments: { path: path.join(root, "keep", "note.txt") } });
    const infoText = (info.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.equal(infoText.includes("type: file"), true);
    assert.equal(infoText.includes(`size: ${visible.length + 1}`), true);
    assert.equal(infoText.includes(visible), false);

    const batch = await call(agent, {
      tool: "read_multiple_files",
      arguments: { paths: [path.join(root, "keep", "note.txt"), blocked, path.join(root, "missing.txt")] },
    });
    const batchText = (batch.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.equal(batchText.includes(visible), true);
    assert.equal(batchText.includes("ACCESS_SENTINEL_must_not_leak"), false);
    assert.equal(batchText.includes("The file read failed."), true);
    assert.equal(batchText.includes("truncated: false"), true);

    const tooMany = await call(agent, {
      tool: "read_multiple_files",
      arguments: { paths: Array.from({ length: 9 }, () => path.join(root, "keep", "note.txt")) },
    });
    assert.equal(tooMany.status, 400);

    const many = path.join(root, "many");
    await mkdir(many);
    for (let index = 0; index < 101; index += 1) {
      await writeFile(path.join(many, `f${String(index).padStart(3, "0")}.txt`), "x\n", "utf8");
    }
    const capped = await call(agent, { tool: "list_directory", arguments: { path: many, depth: 1 } });
    const cappedText = (capped.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.equal(cappedText.includes("truncated: true"), true);
    assert.equal(cappedText.includes("f100.txt"), false);
    assert.equal(cappedText.split("\n").filter((line) => line.startsWith("file ")).length, 100);

    const denied = await call(agent, { tool: "list_directory", arguments: { path: path.join(root, "no-such") } });
    assert.equal(denied.status, 200);
    assert.equal(JSON.stringify(denied.json).includes("The directory list failed."), true);
    assert.equal(JSON.stringify(denied.json).includes(hidden), false);
  } finally {
    await chmod(blocked, 0o600).catch(() => undefined);
    await agent.close();
    await rm(root, { recursive: true, force: true });
    await rm(secretDir, { recursive: true, force: true });
  }
});

test("searches fixture names and contents in pages, stops sessions, and rejects stale ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-search-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remote-control-search-link-"));
  await writeFile(path.join(root, "content-a.txt"), "first\nNEEDLE_CONTENT_SENTINEL here\nlast\n", "utf8");
  await writeFile(path.join(root, "content-b.txt"), "NEEDLE_CONTENT_SENTINEL again\n", "utf8");
  for (let index = 0; index < 25; index += 1) {
    await writeFile(path.join(root, `name-match-${String(index).padStart(2, "0")}.txt`), "other\n", "utf8");
  }
  await writeFile(path.join(outside, "linked-secret.txt"), "NEEDLE_CONTENT_SENTINEL linked\n", "utf8");
  await symlink(outside, path.join(root, "linked-outside"));
  await symlink(root, path.join(root, "self-cycle"));
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN });

  try {
    const started = await call(agent, {
      tool: "start_search",
      arguments: { path: root, pattern: "name-match-", search_type: "filename" },
    });
    assert.equal(started.status, 200);
    const first = JSON.parse(completedText(started.json)) as {
      session_id: string;
      results: Array<{ path: string }>;
      has_more: boolean;
    };
    assert.equal(first.results.length, 20);
    assert.equal(first.has_more, true);
    assert.equal(typeof first.session_id, "string");

    const next = await call(agent, {
      tool: "get_more_search_results",
      arguments: { session_id: first.session_id },
    });
    const second = JSON.parse(completedText(next.json)) as {
      results: Array<{ path: string }>;
      has_more: boolean;
    };
    assert.equal(second.results.length, 5);
    assert.equal(second.has_more, false);
    assert.equal(second.results.some((result) => result.path.includes("linked-outside")), false);

    const content = await call(agent, {
      tool: "start_search",
      arguments: { path: root, pattern: "NEEDLE_CONTENT_SENTINEL", search_type: "content" },
    });
    const contentPage = JSON.parse(completedText(content.json)) as {
      results: Array<{ path: string; line: number; text: string }>;
      has_more: boolean;
    };
    assert.equal(contentPage.results.length, 2);
    assert.equal(contentPage.results.every((result) => result.line === 2 || result.line === 1), true);
    assert.equal(contentPage.has_more, false);
    assert.equal(JSON.stringify(contentPage).includes("linked-secret"), false);

    await writeFile(path.join(root, "long-line.txt"), `LONG_LINE_SENTINEL${"x".repeat(400)}\n`, "utf8");
    const longLine = await call(agent, {
      tool: "start_search",
      arguments: { path: root, pattern: "LONG_LINE_SENTINEL", search_type: "content" },
    });
    const longLinePage = JSON.parse(completedText(longLine.json)) as {
      results: Array<{ text: string }>;
    };
    assert.equal(longLinePage.results[0]?.text.length, 240);

    const missingDirectory = await call(agent, {
      tool: "start_search",
      arguments: { path: path.join(root, "missing-directory-SENTINEL"), pattern: "secret", search_type: "filename" },
    });
    assert.equal((missingDirectory.json as { status: string }).status, "failed");
    assert.equal(missingDirectory.text.includes("missing-directory-SENTINEL"), false);

    const stoppable = await call(agent, {
      tool: "start_search",
      arguments: { path: root, pattern: "name-match-", search_type: "filename" },
    });
    const stoppablePage = JSON.parse(completedText(stoppable.json)) as { session_id: string; has_more: boolean };
    assert.equal(stoppablePage.has_more, true);
    const stopped = await call(agent, {
      tool: "stop_search",
      arguments: { session_id: stoppablePage.session_id },
    });
    assert.equal(JSON.parse(completedText(stopped.json)).status, "stopped");
    const afterStop = await call(agent, {
      tool: "get_more_search_results",
      arguments: { session_id: stoppablePage.session_id },
    });
    assert.equal((afterStop.json as { status: string }).status, "failed");
    assert.equal(afterStop.text.includes(stoppablePage.session_id), false);

    for (const arguments_ of [
      { path: root, pattern: "x", search_type: "content", session_id: "forged" },
      { path: root, pattern: "", search_type: "filename" },
      { path: root, pattern: "x", search_type: "process" },
      { session_id: "process-session-id" },
      { session_id: "../etc/passwd" },
    ]) {
      const tool = "path" in arguments_ ? "start_search" : "get_more_search_results";
      const rejected = await call(agent, { tool, arguments: arguments_ });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.text.includes(root), false);
      assert.equal(rejected.text.includes("/etc/passwd"), false);
    }

    const forgedButWellFormed = await call(agent, {
      tool: "get_more_search_results",
      arguments: { session_id: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal((forgedButWellFormed.json as { status: string; error: { code: string } }).error.code, "not_found");

    const capacitySessions: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const active = await call(agent, {
        tool: "start_search",
        arguments: { path: root, pattern: "name-match-", search_type: "filename" },
      });
      capacitySessions.push((JSON.parse(completedText(active.json)) as { session_id: string }).session_id);
    }
    const overCapacity = await call(agent, {
      tool: "start_search",
      arguments: { path: root, pattern: "name-match-", search_type: "filename" },
    });
    assert.equal((overCapacity.json as { status: string; error: { code: string } }).error.code, "conflict");
    for (const session_id of capacitySessions) {
      await call(agent, { tool: "stop_search", arguments: { session_id } });
    }

    const expiringAgent = await startAgent({ deviceToken: DEVICE_TOKEN, searchSessionTtlMs: 20 });
    try {
      const expiringStart = await call(expiringAgent, {
        tool: "start_search",
        arguments: { path: root, pattern: "name-match-", search_type: "filename" },
      });
      const expiringSession = JSON.parse(completedText(expiringStart.json)) as { session_id: string };
      await new Promise((resolve) => setTimeout(resolve, 40));
      const expired = await call(expiringAgent, {
        tool: "get_more_search_results",
        arguments: { session_id: expiringSession.session_id },
      });
      assert.equal((expired.json as { status: string; error: { code: string } }).error.code, "not_found");
      assert.equal(expired.text.includes(expiringSession.session_id), false);
    } finally {
      await expiringAgent.close();
    }

    const preRestartAgent = await startAgent({ deviceToken: DEVICE_TOKEN });
    const beforeRestart = await call(preRestartAgent, {
      tool: "start_search",
      arguments: { path: root, pattern: "name-match-", search_type: "filename" },
    });
    const preRestartSession = JSON.parse(completedText(beforeRestart.json)) as { session_id: string };
    await preRestartAgent.close();
    const postRestartAgent = await startAgent({ deviceToken: DEVICE_TOKEN });
    try {
      const stale = await call(postRestartAgent, {
        tool: "get_more_search_results",
        arguments: { session_id: preRestartSession.session_id },
      });
      assert.equal((stale.json as { status: string; error: { code: string } }).error.code, "not_found");
    } finally {
      await postRestartAgent.close();
    }
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("search permission failures return a safe error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-search-permission-"));
  const blocked = path.join(root, "blocked");
  await mkdir(blocked);
  await writeFile(path.join(blocked, "permission-SENTINEL.txt"), "PRIVATE_SEARCH_SENTINEL\n", "utf8");
  await chmod(blocked, 0o000);
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN });

  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("root bypasses fixture directory permissions");
    }
    const result = await call(agent, {
      tool: "start_search",
      arguments: { path: root, pattern: "PRIVATE_SEARCH_SENTINEL", search_type: "content" },
    });
    assert.equal((result.json as { status: string }).status, "failed");
    assert.equal(result.text.includes("permission-SENTINEL"), false);
    assert.equal(result.text.includes("PRIVATE_SEARCH_SENTINEL"), false);
    assert.equal(result.text.includes("EACCES"), false);
  } finally {
    await chmod(blocked, 0o700).catch(() => undefined);
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a disconnected search releases its active session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-search-disconnect-"));
  const matchPrefix = Buffer.from("DISCONNECT_SEARCH_SENTINEL\n");
  const largeFile = Buffer.concat([
    matchPrefix,
    Buffer.alloc(2 * 1024 * 1024 - matchPrefix.length, 0x78),
  ]);
  for (let index = 0; index < 16; index += 1) {
    await writeFile(path.join(root, `content-${String(index).padStart(2, "0")}.txt`), largeFile);
  }
  for (let index = 0; index < 25; index += 1) {
    await writeFile(path.join(root, `session-match-${String(index).padStart(2, "0")}.txt`), "x\n", "utf8");
  }
  const events: string[] = [];
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, log: (event) => events.push(event) });

  try {
    const controller = new AbortController();
    const request = fetch(`${agent.baseUrl}/internal/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-credential": DEVICE_TOKEN },
      body: JSON.stringify({
        tool: "start_search",
        arguments: { path: root, pattern: "DISCONNECT_SEARCH_SENTINEL", search_type: "content" },
      }),
      signal: controller.signal,
    });
    const deadline = Date.now() + 5000;
    while (!events.includes("search_started") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(events.includes("search_started"), true);
    controller.abort();
    await assert.rejects(request, /abort/i);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sessions: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = await call(agent, {
        tool: "start_search",
        arguments: { path: root, pattern: "session-match-", search_type: "filename" },
      });
      sessions.push((JSON.parse(completedText(result.json)) as { session_id: string }).session_id);
    }
    const overCapacity = await call(agent, {
      tool: "start_search",
      arguments: { path: root, pattern: "session-match-", search_type: "filename" },
    });
    assert.equal((overCapacity.json as { status: string }).status, "failed");

    for (const session_id of sessions) {
      await call(agent, { tool: "stop_search", arguments: { session_id } });
    }
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});
