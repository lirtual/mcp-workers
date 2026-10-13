import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { operationDigest } from "../src/operations.ts";
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

test("directory creation, text edits, and moves share operation receipts without leaking arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-t06-"));
  const receiptDirectory = path.join(root, "receipts");
  const fixture = path.join(root, "notes.txt");
  await writeFile(fixture, "alpha beta alpha\n", "utf8");
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });
  const mutate = (tool: string, operationId: string, args: unknown) => call(agent, { tool, operation_id: operationId, arguments: args });
  const status = async (id: string) => fetch(`${agent.baseUrl}/internal/operations/${id}`, { headers: { "x-device-credential": DEVICE_TOKEN } });
  try {
    const directory = path.join(root, "created");
    const created = await mutate("create_directory", "mkdir-once", { path: directory });
    assert.equal((created.json as { status: string }).status, "completed");
    assert.equal((await status("mkdir-once")).status, 200);
    const repeated = await mutate("create_directory", "mkdir-once", { path: directory });
    assert.equal((repeated.json as { status: string }).status, "completed");
    assert.equal((await status("mkdir-once")).status, 200);

    const edited = await mutate("edit_block", "edit-once", {
      file_path: fixture, old_string: "alpha", new_string: "omega", expected_replacements: 2,
    });
    assert.equal((edited.json as { status: string }).status, "completed");
    assert.equal(await readFile(fixture, "utf8"), "omega beta omega\n");
    const editReceipt = await (await status("edit-once")).text();
    assert.equal(editReceipt.includes("omega"), false);
    assert.equal(editReceipt.includes(fixture), false);

    const mismatch = await mutate("edit_block", "edit-mismatch", {
      file_path: fixture, old_string: "omega", new_string: "secret-replacement", expected_replacements: 1,
    });
    assert.equal((mismatch.json as { status: string }).status, "failed");
    assert.equal(await readFile(fixture, "utf8"), "omega beta omega\n");
    const missing = await mutate("edit_block", "edit-no-match", {
      file_path: fixture, old_string: "absent", new_string: "replacement",
    });
    assert.equal((missing.json as { status: string }).status, "failed");
    assert.equal(await readFile(fixture, "utf8"), "omega beta omega\n");

    const occupiedDestination = path.join(root, "occupied.txt");
    await writeFile(occupiedDestination, "keep this file", "utf8");
    const rejectedMove = await mutate("move_file", "move-occupied", { source: fixture, destination: occupiedDestination });
    assert.equal((rejectedMove.json as { status: string }).status, "failed");
    assert.equal(await readFile(fixture, "utf8"), "omega beta omega\n");
    assert.equal(await readFile(occupiedDestination, "utf8"), "keep this file");

    const movedTo = path.join(root, "renamed.txt");
    const moved = await mutate("move_file", "move-once", { source: fixture, destination: movedTo });
    assert.equal((moved.json as { status: string }).status, "completed");
    assert.equal(await readFile(movedTo, "utf8"), "omega beta omega\n");
    assert.equal((await status("move-once")).status, 200);
    const changedIdReuse = await mutate("move_file", "move-once", { source: movedTo, destination: fixture });
    assert.equal(changedIdReuse.status, 409);
    assert.equal(existsSync(fixture), false);

    const permissions = path.join(root, "locked");
    await mkdir(permissions);
    await chmod(permissions, 0o500);
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const denied = await mutate("create_directory", "mkdir-denied", { path: path.join(permissions, "denied") });
      assert.equal((denied.json as { status: string }).status, "failed");
      assert.equal(existsSync(path.join(permissions, "denied")), false);
    }
    const rawReceipts = await readFile(path.join(receiptDirectory, "operation-receipts.json"), "utf8");
    assert.equal(rawReceipts.includes("secret-replacement"), false);
    assert.equal(rawReceipts.includes(fixture), false);
  } finally {
    await agent.close();
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("delete_file deletes only regular files and persists its receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-agent-delete-"));
  const receiptDirectory = path.join(root, "receipts");
  const fixture = path.join(root, "delete-me.txt");
  const directory = path.join(root, "keep-dir");
  const linked = path.join(root, "link");
  await writeFile(fixture, "fixture");
  await mkdir(directory);
  await symlink(fixture, linked);
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory });
  try {
    const remove = (id: string, path: string) => call(agent, { tool: "delete_file", operation_id: id, arguments: { path } });
    const deniedDirectory = await remove("delete-directory", directory);
    assert.equal((deniedDirectory.json as { status: string }).status, "failed");
    const deniedLink = await remove("delete-symlink", linked);
    assert.equal((deniedLink.json as { status: string }).status, "failed");
    assert.equal(await readFile(fixture, "utf8"), "fixture");
    const deleted = await remove("delete-fixture", fixture);
    assert.equal((deleted.json as { status: string }).status, "completed");
    const duplicate = await remove("delete-fixture", fixture);
    assert.equal((duplicate.json as { status: string }).status, "completed");
    const missing = await remove("delete-missing", fixture);
    assert.equal((missing.json as { status: string }).status, "failed");
    const receipt = await fetch(`${agent.baseUrl}/internal/operations/delete-fixture`, {
      headers: { "x-device-credential": DEVICE_TOKEN },
    });
    assert.equal((await receipt.json() as { state: string }).state, "completed");
    assert.equal(await readFile(linked, "utf8").then(() => true, () => false), false);
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

test("start_process uses receipts once and managed sessions expose bounded output after the request ends", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-t08-"));
  const events: string[] = [];
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    receiptDirectory: path.join(root, "receipts"),
    shellPath: "/bin/sh",
    log: (event) => events.push(event),
  });
  const callTool = (tool: string, args: unknown, operationId?: string) => call(agent, {
    tool,
    ...(operationId ? { operation_id: operationId } : {}),
    arguments: args,
  });
  const output = async (sessionId: string, offset = 0, length = 16) => callTool("read_process_output", {
    session_id: sessionId, offset, length,
  });

  try {
    const crossToolPath = path.join(root, "cross-tool.txt");
    const fileOperation = await callTool("write_file", { path: crossToolPath, content: "fixture", mode: "rewrite" }, "cross-tool-id");
    assert.equal((fileOperation.json as { status: string }).status, "completed");
    const crossToolCommand = `printf x >> ${path.join(root, "must-not-run.txt")}`;
    const crossToolReuse = await callTool("start_process", { command: crossToolCommand }, "cross-tool-id");
    assert.equal(crossToolReuse.status, 409);
    assert.equal(existsSync(path.join(root, "must-not-run.txt")), false);

    const short = await callTool("start_process", { command: "printf 'short-output'", timeout_ms: 500 }, "short-once");
    const shortBody = short.json as { status: string; session_id: string };
    assert.equal(shortBody.status, "completed");
    assert.match(shortBody.session_id, /^[0-9a-f-]{36}$/);
    const firstPage = JSON.parse(completedText((await output(shortBody.session_id, 0, 5)).json)) as { output: string; next_offset: number; eof: boolean };
    assert.equal(firstPage.output, "short");
    assert.equal(firstPage.next_offset, 5);
    assert.equal(firstPage.eof, false);
    const finalPage = JSON.parse(completedText((await output(shortBody.session_id, 5, 20)).json)) as { output: string; eof: boolean };
    assert.equal(finalPage.output, "-output");
    assert.equal(finalPage.eof, true);

    const countFile = path.join(root, "count.txt");
    const longCommand = `printf x >> ${countFile}; sleep 0.2; printf '%s' '-done'`;
    const long = await callTool("start_process", { command: longCommand, timeout_ms: 5 }, "long-once");
    const longBody = long.json as { status: string; session_id: string };
    assert.equal(longBody.status, "running");
    assert.deepEqual((JSON.parse(completedText((await callTool("list_sessions", {})).json)) as Array<{ session_id: string }>).map((item) => item.session_id).sort(), [longBody.session_id, shortBody.session_id].sort());

    const duplicate = await callTool("start_process", { command: longCommand, timeout_ms: 5 }, "long-once");
    assert.equal((duplicate.json as { session_id: string }).session_id, longBody.session_id);
    const conflict = await callTool("start_process", { command: "printf different", timeout_ms: 5 }, "long-once");
    assert.equal(conflict.status, 409);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await readFile(countFile, "utf8"), "x");

    const longOutput = JSON.parse(completedText((await output(longBody.session_id)).json)) as { output: string; state: string; eof: boolean };
    assert.equal(longOutput.output, "-done");
    assert.equal(longOutput.state, "completed");
    assert.equal(longOutput.eof, true);

    const receipt = await fetch(`${agent.baseUrl}/internal/operations/long-once`, { headers: { "x-device-credential": DEVICE_TOKEN } });
    assert.equal((await receipt.json() as { state: string }).state, "completed");

    const bounded = await callTool("start_process", { command: "printf '%300000s' x", timeout_ms: 1000 }, "bounded-output");
    const boundedSessionId = (bounded.json as { session_id: string }).session_id;
    const boundedPage = JSON.parse(completedText((await output(boundedSessionId, 0, 65_536)).json)) as { output: string; next_offset: number; truncated: boolean; eof: boolean };
    assert.equal(boundedPage.output.length, 65_536);
    assert.equal(boundedPage.next_offset, 65_536);
    assert.equal(boundedPage.truncated, true);
    assert.equal(boundedPage.eof, false);
    const boundedLastPage = JSON.parse(completedText((await output(boundedSessionId, 196_608, 65_536)).json)) as { output: string; next_offset: number; truncated: boolean; eof: boolean };
    assert.equal(boundedLastPage.output.length, 65_536);
    assert.equal(boundedLastPage.next_offset, 262_144);
    assert.equal(boundedLastPage.truncated, true);
    assert.equal(boundedLastPage.eof, true);

    const arbitraryShell = await callTool("start_process", { command: "true", shell: "/bin/bash" }, "shell-select");
    assert.equal(arbitraryShell.status, 400);
    const virtualCode = await callTool("node:local", { code: "process.exit(1)" });
    assert.equal(virtualCode.status, 400);
    const invalidSession = await output("00000000-0000-4000-8000-000000000000");
    assert.equal(invalidSession.status, 404);
    assert.equal(events.includes("process_started"), true);
    assert.equal(events.includes("process_output_read"), true);
    assert.equal(events.join(" ").includes("short-output"), false);
    assert.equal(events.join(" ").includes(longCommand), false);
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a process receipt never replays after Agent restart and stale session IDs are not restored", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-t08-restart-"));
  const receiptDirectory = path.join(root, "receipts");
  const countFile = path.join(root, "count.txt");
  const request = { tool: "start_process", operation_id: "restart-no-replay", arguments: { command: `printf x >> ${countFile}; sleep 0.05`, timeout_ms: 1000 } };
  let agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory, shellPath: "/bin/sh" });
  try {
    const started = await call(agent, request);
    const originalSession = (started.json as { session_id: string }).session_id;
    assert.match(originalSession, /^[0-9a-f-]{36}$/);
    assert.equal(await readFile(countFile, "utf8"), "x");
    await agent.close();

    agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory, shellPath: "/bin/sh" });
    const duplicate = await call(agent, request);
    const duplicateBody = duplicate.json as Record<string, unknown>;
    assert.equal(duplicateBody.status, "completed");
    assert.equal("session_id" in duplicateBody, false);
    assert.equal(await readFile(countFile, "utf8"), "x");
    const stale = await call(agent, { tool: "read_process_output", arguments: { session_id: originalSession } });
    assert.equal(stale.status, 404);
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed sessions accept idempotent stdin and terminate only verified owned sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-t09-session-actions-"));
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    receiptDirectory: path.join(root, "receipts"),
    shellPath: "/bin/sh",
  });
  const action = (tool: string, operationId: string, argumentsValue: unknown) => call(agent, {
    tool,
    operation_id: operationId,
    arguments: argumentsValue,
  });
  try {
    const started = await call(agent, {
      tool: "start_process",
      operation_id: "stdin-reader",
      arguments: { command: 'read first; read second; printf "%s:%s" "$first" "$second"', timeout_ms: 0 },
    });
    const sessionId = (started.json as { session_id: string }).session_id;
    assert.equal((started.json as { status: string }).status, "running");

    const firstInput = { session_id: sessionId, input: "alpha\n" };
    const sent = await action("interact_with_process", "stdin-first", firstInput);
    assert.equal((sent.json as { status: string }).status, "completed");
    const duplicate = await action("interact_with_process", "stdin-first", firstInput);
    assert.equal((duplicate.json as { status: string }).status, "completed");
    const changed = await action("interact_with_process", "stdin-first", { session_id: sessionId, input: "different\n" });
    assert.equal(changed.status, 409);
    const crossActionReuse = await action("force_terminate", "stdin-first", { session_id: sessionId });
    assert.equal(crossActionReuse.status, 409);

    const second = await action("interact_with_process", "stdin-second", { session_id: sessionId, input: "omega\n" });
    assert.equal((second.json as { status: string }).status, "completed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = await call(agent, { tool: "read_process_output", arguments: { session_id: sessionId } });
    const page = JSON.parse(completedText(output.json)) as { output: string; state: string };
    assert.equal(page.output, "alpha:omega");
    assert.equal(page.state, "completed");

    const long = await call(agent, {
      tool: "start_process",
      operation_id: "terminate-fixture",
      arguments: { command: "sleep 30", timeout_ms: 0 },
    });
    const longSession = (long.json as { session_id: string }).session_id;
    const barePid = await action("force_terminate", "terminate-bare-pid", { session_id: longSession, pid: process.pid });
    assert.equal(barePid.status, 400);
    const unrelated = await call(agent, {
      tool: "start_process",
      operation_id: "unrelated-fixture",
      arguments: { command: "sleep 0.3; printf unrelated-survived", timeout_ms: 0 },
    });
    const unrelatedSession = (unrelated.json as { session_id: string }).session_id;
    const stopped = await action("force_terminate", "terminate-once", { session_id: longSession });
    assert.equal((stopped.json as { status: string }).status, "completed");
    const stopDuplicate = await action("force_terminate", "terminate-once", { session_id: longSession });
    assert.equal((stopDuplicate.json as { status: string }).status, "completed");
    const stale = await action("force_terminate", "terminate-stale", { session_id: "00000000-0000-4000-8000-000000000000" });
    assert.equal(stale.status, 404);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const unrelatedOutput = await call(agent, { tool: "read_process_output", arguments: { session_id: unrelatedSession } });
    const unrelatedPage = JSON.parse(completedText(unrelatedOutput.json)) as { output: string };
    assert.equal(unrelatedPage.output, "unrelated-survived");

    const stubborn = await call(agent, {
      tool: "start_process",
      operation_id: "terminate-escalation-fixture",
      arguments: { command: "trap '' TERM; sleep 30", timeout_ms: 0 },
    });
    const stubbornSession = (stubborn.json as { session_id: string }).session_id;
    const startedAt = Date.now();
    const escalated = await action("force_terminate", "terminate-escalation-once", { session_id: stubbornSession });
    assert.equal((escalated.json as { status: string }).status, "completed");
    assert.ok(Date.now() - startedAt < 1800);
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("force_terminate does not target an unrelated process when a numeric process-group target is reused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-t09-pgid-reuse-"));
  const agent = await startAgent({
    deviceToken: DEVICE_TOKEN,
    receiptDirectory: path.join(root, "receipts"),
    shellPath: "/bin/sh",
  });
  const targetGroupFile = path.join(root, "target-pgid");
  const unrelatedGroupFile = path.join(root, "unrelated-pgid");
  const action = (tool: string, operationId: string, argumentsValue: unknown) => call(agent, {
    tool,
    operation_id: operationId,
    arguments: argumentsValue,
  });
  let originalKill: typeof process.kill | undefined;
  try {
    const target = await call(agent, {
      tool: "start_process",
      operation_id: "pgid-reuse-target",
      arguments: {
        command: `ps -o pgid= -p "$$" > '${targetGroupFile}'; trap '' TERM; while :; do sleep 0.05; done`,
        timeout_ms: 0,
      },
    });
    assert.equal((target.json as { status: string }).status, "running");
    const targetSession = (target.json as { session_id: string }).session_id;

    const unrelated = await call(agent, {
      tool: "start_process",
      operation_id: "pgid-reuse-unrelated",
      arguments: {
        command: `ps -o pgid= -p "$$" > '${unrelatedGroupFile}'; trap 'printf unrelated-was-signaled; exit 0' TERM; while :; do sleep 0.05; done`,
        timeout_ms: 0,
      },
    });
    assert.equal((unrelated.json as { status: string }).status, "running");
    const unrelatedSession = (unrelated.json as { session_id: string }).session_id;

    const readGroupId = async (file: string): Promise<number> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const value = Number((await readFile(file, "utf8")).trim());
          if (Number.isSafeInteger(value) && value > 1) return value;
        } catch { /* Wait for the disposable shell fixture to start. */ }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("The process-group fixture did not start.");
    };
    const targetGroupId = await readGroupId(targetGroupFile);
    const unrelatedGroupId = await readGroupId(unrelatedGroupFile);
    assert.notEqual(targetGroupId, unrelatedGroupId);

    // Simulate the kernel resolving the already-checked numeric PGID to a
    // different live group by the time kill(2) runs. The new pidfd path must
    // never issue this numeric group signal.
    originalKill = process.kill;
    Object.defineProperty(process, "kill", {
      configurable: true,
      value: (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -targetGroupId) return originalKill?.(-unrelatedGroupId, signal);
        return originalKill?.(pid, signal);
      },
    });
    const stopped = await action("force_terminate", "pgid-reuse-stop", { session_id: targetSession });
    Object.defineProperty(process, "kill", { configurable: true, value: originalKill });
    originalKill = undefined;

    const unrelatedOutput = await call(agent, { tool: "read_process_output", arguments: { session_id: unrelatedSession } });
    const unrelatedPage = JSON.parse(completedText(unrelatedOutput.json)) as { output: string; state: string };
    assert.equal(unrelatedPage.output.includes("unrelated-was-signaled"), false);
    assert.equal(unrelatedPage.state, "running");
    assert.equal((stopped.json as { status: string }).status, "completed");
    const targetOutput = await call(agent, { tool: "read_process_output", arguments: { session_id: targetSession } });
    const targetPage = JSON.parse(completedText(targetOutput.json)) as { state: string };
    assert.equal(targetPage.state, "completed");
  } finally {
    if (originalKill) Object.defineProperty(process, "kill", { configurable: true, value: originalKill });
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("uncertain stdin receipts become unknown after restart and stale session input is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-t09-restart-"));
  const receiptDirectory = path.join(root, "receipts");
  await mkdir(receiptDirectory);
  const sessionId = "2b6ecbd9-a994-47dd-ae82-3a8c4cf1641e";
  const inputArgs = { session_id: sessionId, input: "must-not-replay\n" };
  const now = new Date().toISOString();
  await writeFile(path.join(receiptDirectory, "operation-receipts.json"), JSON.stringify({
    version: 1,
    receipts: [{
      operation_id: "uncertain-stdin",
      tool_name: "interact_with_process",
      argument_digest: operationDigest("interact_with_process", inputArgs),
      state: "running",
      created_at: now,
      updated_at: now,
      session_id: sessionId,
    }],
  }), "utf8");
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory, shellPath: "/bin/sh" });
  try {
    const retry = await call(agent, { tool: "interact_with_process", operation_id: "uncertain-stdin", arguments: inputArgs });
    assert.equal((retry.json as { status: string }).status, "unknown");
    const receipt = await fetch(agent.baseUrl + "/internal/operations/uncertain-stdin", { headers: { "x-device-credential": DEVICE_TOKEN } });
    const value = await receipt.json() as { state: string; session_id?: string };
    assert.equal(value.state, "unknown");
    assert.equal("session_id" in value, false);

    const stale = await call(agent, {
      tool: "interact_with_process",
      operation_id: "new-stale-input",
      arguments: inputArgs,
    });
    assert.equal(stale.status, 404);
    const staleStop = await call(agent, {
      tool: "force_terminate",
      operation_id: "new-stale-stop",
      arguments: { session_id: sessionId },
    });
    assert.equal(staleStop.status, 404);
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent shutdown terminates only its owned process group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-t08-shutdown-"));
  const sentinel = path.join(root, "survived.txt");
  const agent = await startAgent({ deviceToken: DEVICE_TOKEN, receiptDirectory: path.join(root, "receipts"), shellPath: "/bin/sh" });
  let closed = false;
  try {
    const result = await call(agent, {
      tool: "start_process",
      operation_id: "shutdown-owned-group",
      arguments: { command: `(sleep 0.5; printf x > ${sentinel}) & wait`, timeout_ms: 0 },
    });
    assert.equal((result.json as { status: string }).status, "running");
    const startedAt = Date.now();
    await agent.close();
    closed = true;
    assert.ok(Date.now() - startedAt < 1500);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(existsSync(sentinel), false);
  } finally {
    if (!closed) await agent.close();
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
