import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("listens on loopback only and refuses the login home", async () => {
  const home = await temporaryHome();
  try {
    await assert.rejects(
      () => startAgent({ deviceToken: DEVICE_TOKEN, childHome: home, host: "0.0.0.0" }),
      /loopback/,
    );
    await assert.rejects(
      () => startAgent({ deviceToken: "", childHome: home }),
      /not configured/,
    );
    await assert.rejects(
      () => startAgent({ deviceToken: DEVICE_TOKEN, childHome: os.homedir() }),
      /login home/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("device routes reject an invalid credential before any file read", async () => {
  const home = await temporaryHome();
  const events: string[] = [];
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    childHome: home,
    log: (event) => events.push(event),
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

test("health and operation status do not execute work or expose host details", async () => {
  const home = await temporaryHome();
  const events: string[] = [];
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    childHome: home,
    log: (event) => events.push(event),
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
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, childHome: home });
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
    childHome: home,
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
