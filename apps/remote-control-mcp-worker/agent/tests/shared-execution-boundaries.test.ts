import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgentExecutionEngine, defaultAgentShellPath } from "../src/execution.ts";

test("retired Windows Node execution refuses its shell selection", () => {
  assert.throws(() => defaultAgentShellPath("win32"), /native Rust Agent/);
});

test("revocation synchronously denies reads and effects while cleanup races", {skip: process.platform === "win32"}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-revocation-gate-"));
  const filePath = path.join(root, "retained.txt");
  const engine = createAgentExecutionEngine({ receiptDirectory: path.join(root, "receipts") });
  const controller = new AbortController();
  try {
    await writeFile(filePath, "retained", "utf8");
    const before = await engine.executeTool({ tool: "list_sessions", arguments: {} }, controller.signal);
    assert.equal(before?.status, 200, "reads must work before revocation");

    // The tombstone must be set before cleanup awaits. These requests compete
    // with revocation and must not leak reads or admit new side effects.
    const revoking = engine.stopOwnedForRevocation();
    const requests = [
      { tool: "list_sessions", arguments: {} },
      { tool: "read_file", arguments: { path: filePath } },
      { tool: "read_process_output", arguments: { session_id: "unknown", offset: 0, length: 100 } },
      { tool: "write_file", arguments: { path: filePath, content: "MUST_NOT_WRITE", mode: "rewrite" } },
      { tool: "start_process", arguments: { command: "echo MUST_NOT_RUN", timeout_ms: 1000 } },
      { tool: "browser_status", arguments: {} },
      { tool: "browser_start", arguments: {} },
      { tool: "browser_navigate", arguments: { url: "https://example.com" } },
    ];
    const call = (request: typeof requests[number]) =>
      engine.executeTool({ ...request, operation_id: "revoked-" + randomUUID() }, controller.signal);
    const repliesDuring = await Promise.all(requests.map(call));
    for (const reply of repliesDuring) {
      assert.deepEqual(reply, { status: 200, body: { status: "failed" } });
    }
    assert.equal(await engine.stopOwnedForRevocation(), "confirmed");
    await revoking;
    const repliesAfter = await Promise.all(requests.map(call));
    for (const reply of repliesAfter) {
      assert.deepEqual(reply, { status: 200, body: { status: "failed" } });
    }
    assert.equal(await readFile(filePath, "utf8"), "retained");
  } finally {
    controller.abort();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("retired GUI effects cannot be admitted or replayed through the paired engine", {skip: process.platform === "win32"}, async () => {
  const engine = createAgentExecutionEngine();
  try {
    for (const tool of [
      "browser_start", "browser_status", "browser_tabs", "browser_click",
      "computer_status", "computer_observe", "computer_stop",
    ]) {
      const result = await engine.executeTool({
        tool, arguments: {}, operation_id: "retired-" + randomUUID(),
      }, new AbortController().signal);
      assert.ok(result === undefined || result.status !== 200, tool);
    }
  } finally {
    await engine.close();
  }
});
