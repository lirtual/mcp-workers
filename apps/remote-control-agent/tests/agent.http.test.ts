import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startAgent, type RunningAgent } from "../src/server.ts";

const require = createRequire(import.meta.url);
const DEVICE_TOKEN = "device-credential-for-tests";
const PUBLISHED_INTEGRITY =
  "sha512-VNeKfaBR6TN/8MlP/ziTpjNEeHrGOFmmzQjrwzr52kQalBJoNNISWwaSQElPFc6+I17NOOM354KbSdS/aDrqGA==";
const FIXTURE_TEXT = "FIXTURE_SENTINEL_remote_control_t01";

function childRunning(home: string): boolean {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return false;
  }

  for (const pid of pids) {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`).toString("utf8");
      const environ = readFileSync(`/proc/${pid}/environ`).toString("utf8");
      if (!command.includes(`${path.sep}dist${path.sep}index.js`)) continue;
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

test("pins Desktop Commander 0.2.52 to the published integrity", async () => {
  const installed = require("@wonderwhy-er/desktop-commander/package.json") as { version: string };
  assert.equal(installed.version, "0.2.52");

  const lockfile = await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.match(lockfile, /@wonderwhy-er\/desktop-commander@0\.2\.52/);
  assert.ok(lockfile.includes(PUBLISHED_INTEGRITY));
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

test("device routes reject an invalid credential before any stdio tool runs", async () => {
  const home = await temporaryHome();
  const events: string[] = [];
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    childHome: home,
    log: (event) => events.push(event),
  });

  try {
    assert.equal(agent.hostname, "127.0.0.1");
    const secretPath = path.join(home, "secret-path.txt");
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
    }

    const health = await fetch(`${agent.baseUrl}/internal/healthz`, {
      headers: { "x-device-credential": "wrong-device-token", authorization: "Bearer portal-token" },
    });
    assert.equal(health.status, 401);

    const status = await fetch(`${agent.baseUrl}/internal/operations/op-1`, {
      headers: { "x-device-credential": "nope" },
    });
    assert.equal(status.status, 401);

    assert.equal(childRunning(home), false);
    await assert.rejects(readFile(path.join(home, ".claude-server-commander", "claude_tool_call.log"), "utf8"));
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

    assert.equal(childRunning(home), false);
    assert.deepEqual(events, ["health", "status", "rejected"]);
  } finally {
    await agent.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects URL reads, admin tools, and write or shell calls before stdio", async () => {
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

    assert.equal(childRunning(home), false);
  } finally {
    await agent.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("reads a fixed fixture through the pinned stdio child without leaking into agent logs", { timeout: 90_000 }, async () => {
  const home = await temporaryHome();
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remote-control-fixture-"));
  const fixturePath = path.join(fixtureDir, "fixture.txt");
  const missingPath = path.join(fixtureDir, "missing-SENTINEL.txt");
  await writeFile(fixturePath, `${FIXTURE_TEXT}\n`, "utf8");
  const events: string[] = [];
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
        arguments: { path: fixturePath, offset: 0, length: 5 },
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    const body = JSON.parse(text) as {
      status: string;
      result: { content: Array<{ type: string; text: string }> };
    };
    assert.equal(body.status, "completed");
    assert.equal(body.result.content[0]?.type, "text");
    assert.equal(body.result.content[0]?.text.includes(FIXTURE_TEXT), true);
    assert.equal(text.includes(portalToken), false);
    assert.equal(text.includes(DEVICE_TOKEN), false);
    assert.equal(childRunning(home), true);

    const config = JSON.parse(
      await readFile(path.join(home, ".claude-server-commander", "config.json"), "utf8"),
    ) as { telemetryEnabled?: boolean };
    assert.equal(config.telemetryEnabled, false);

    const toolLog = await readFile(
      path.join(home, ".claude-server-commander", "claude_tool_call.log"),
      "utf8",
    );
    // Upstream stores the raw arguments. This is not an agent log and is not redacted.
    assert.equal(toolLog.includes(fixturePath), true);
    assert.equal(toolLog.includes("read_file"), true);

    const historyPath = path.join(home, ".claude-server-commander", "tool-history.jsonl");
    let history = "";
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      try {
        history = await readFile(historyPath, "utf8");
        if (history.includes(FIXTURE_TEXT) && history.includes(fixturePath)) break;
      } catch {
        // The upstream history flushes asynchronously.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(history.includes(fixturePath), true);
    assert.equal(history.includes(FIXTURE_TEXT), true);

    const failed = await call(agent, { tool: "read_file", arguments: { path: missingPath } });
    assert.equal(failed.status, 200);
    assert.equal((failed.json as { status: string }).status, "failed");
    assert.equal(failed.text.includes(missingPath), false);
    assert.equal(failed.text.includes("missing-SENTINEL"), false);
    assert.equal(failed.text.includes(FIXTURE_TEXT), false);
    assert.equal(failed.text.includes("Error:"), false);

    const logText = events.join("\n");
    assert.equal(logText.includes(FIXTURE_TEXT), false);
    assert.equal(logText.includes(fixturePath), false);
    assert.equal(logText.includes(DEVICE_TOKEN), false);
    assert.equal(logText.includes(portalToken), false);
    assert.equal(events.includes("read_completed"), true);
    assert.equal(events.includes("read_failed"), true);

    const childPid = childPidWithHome(home);
    assert.ok(childPid);
    const environ = readFileSync(`/proc/${childPid}/environ`).toString("utf8");
    assert.equal(environ.includes(DEVICE_TOKEN), false);
    assert.equal(environ.includes(portalToken), false);
    assert.equal(environ.includes(`HOME=${home}`), true);
    assert.equal(environ.includes("DESKTOP_COMMANDER_DISABLE_TELEMETRY=1"), true);
    assert.equal(environ.includes(`HOME=${os.homedir()}`), false);
  } finally {
    await agent.close();
    await rm(home, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

function childPidWithHome(home: string): string | null {
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`).toString("utf8");
      const environ = readFileSync(`/proc/${pid}/environ`).toString("utf8");
      if (!command.includes(`${path.sep}dist${path.sep}index.js`)) continue;
      if (environ.includes(`HOME=${home}\0`) || environ.endsWith(`HOME=${home}`)) return pid;
    } catch {
      // Process exited while scanning.
    }
  }
  return null;
}
