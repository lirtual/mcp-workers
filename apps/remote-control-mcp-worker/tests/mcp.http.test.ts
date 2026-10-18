import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startAgent, type RunningAgent } from "../../remote-control-agent/src/server.ts";
import worker from "../src/worker.ts";
import { DEVICE_CALL_URL } from "../src/device-target.ts";

const workerUrl = "https://remote-control-mcp-worker.example.test/mcp";
const portalToken = "portal-secret-for-tests";
const deviceToken = "device-credential-for-tests";
const FIXTURE_TEXT = "WORKER_FIXTURE_SENTINEL_remote_control_t01";

interface ObservedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal?: AbortSignal;
}

function fetcher(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Fetcher {
  return {
    fetch,
    connect(): never {
      throw new Error("VPC connect is not used");
    },
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    MCP_ACCESS_TOKEN: portalToken,
    REMOTE_CONTROL_DEVICE_TOKEN: deviceToken,
    REMOTE_CONTROL_DEVICE: fetcher(() => {
      throw new Error("device binding must not be called");
    }),
    ...overrides,
  };
}

function recordingBinding(
  calls: ObservedCall[],
  impl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Fetcher {
  return fetcher(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request ? request.url : input instanceof URL ? input.href : String(input);
      const headers = new Headers(init?.headers ?? request?.headers);
      const bodyValue = init?.body ?? (request ? await request.clone().text() : "");
      const body = typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue);
      calls.push({
        url,
        method: init?.method ?? request?.method ?? "GET",
        headers,
        body,
        ...(init?.signal ? { signal: init.signal } : {}),
      });
      if (!impl) throw new Error("device binding must not be called");
      return impl(input, init);
  });
}

async function postMcp(
  target: Env,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await worker.fetch(
    new Request(workerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal,
    }),
    target,
  );
  const text = await response.text();
  return { status: response.status, text, json: text ? (JSON.parse(text) as unknown) : null };
}

test("forwards a disconnected MCP request signal to the device binding", async () => {
  const calls: ObservedCall[] = [];
  let resolveCallStarted!: () => void;
  const callStarted = new Promise<void>((resolve) => {
    resolveCallStarted = resolve;
  });
  const binding = recordingBinding(calls, async (_input, init) => {
    resolveCallStarted();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  });
  const controller = new AbortController();
  const responsePromise = postMcp(
    env({ REMOTE_CONTROL_DEVICE: binding }),
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_files",
        arguments: { path: "/tmp/search-fixture", pattern: "match", search_type: "filename" },
      },
    },
    { authorization: `Bearer ${portalToken}` },
    controller.signal,
  );

  await callStarted;
  controller.abort();
  await responsePromise;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.signal?.aborted, true);
});

async function withConsole(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  return lines.join("\n");
}

test("portal authentication fails closed before any device call", async () => {
  const calls: ObservedCall[] = [];
  const binding = recordingBinding(calls);
  const read = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_file", arguments: { path: "/tmp/ignored.txt" } },
  };

  const missingConfig = await postMcp(env({ MCP_ACCESS_TOKEN: undefined, REMOTE_CONTROL_DEVICE: binding }), read, {
    authorization: `Bearer ${portalToken}`,
  });
  assert.equal(missingConfig.status, 503);
  assert.equal((missingConfig.json as { error: string }).error, "portal_auth_not_configured");

  const missingBearer = await postMcp(env({ REMOTE_CONTROL_DEVICE: binding }), read);
  assert.equal(missingBearer.status, 401);
  assert.equal((missingBearer.json as { error: string }).error, "unauthorized");

  const wrongBearer = await postMcp(env({ REMOTE_CONTROL_DEVICE: binding }), read, {
    authorization: "Bearer wrong-secret",
  });
  assert.equal(wrongBearer.status, 401);

  const badOrigin = await postMcp(env({ REMOTE_CONTROL_DEVICE: binding }), read, {
    authorization: `Bearer ${portalToken}`,
    origin: "https://client.example",
  });
  assert.equal(badOrigin.status, 403);
  assert.equal((badOrigin.json as { error: string }).error, "invalid_origin");
  assert.equal(badOrigin.text.includes(portalToken), false);

  const preflight = await worker.fetch(
    new Request(workerUrl, { method: "OPTIONS", headers: { origin: "https://client.example" } }),
    env({ REMOTE_CONTROL_DEVICE: binding }),
  );
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);

  assert.equal(calls.length, 0);
});

test("advertises all curated tools without Worker feature gates while keeping auth fail-closed", async () => {
  const calls: ObservedCall[] = [];
  const target = env({ REMOTE_CONTROL_DEVICE: recordingBinding(calls) });
  const auth = { authorization: `Bearer ${portalToken}` };
  const response = await postMcp(target, { jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
  const tools = (response.json as { result: { tools: Array<{ name: string }> } }).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), [
    "read_file", "read_files", "list_directory", "stat_file", "search_files",
    "search_next", "stop_search", "write_file", "create_directory",
    "replace_text", "move_file", "delete_file", "get_operation_status",
    "run_command", "list_sessions", "read_session_output", "send_input",
    "stop_session",
  ]);
  const initialize = await postMcp(target, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, auth);
  const instructions = (initialize.json as { result: { instructions: string } }).result.instructions;
  assert.equal(instructions.includes("deployment gates"), false);
  assert.equal(instructions.includes("separate deployment"), false);
  assert.equal(instructions.includes("Linux Agent account"), true);

  for (const [name, argumentsValue] of [
    ["write_file", {}],
    ["run_command", {}],
    ["start_process", { operation_id: "legacy", command: "true" }],
    ["shell", { operation_id: "unlisted", command: "true" }],
  ] as const) {
    const result = await postMcp(target, {
      jsonrpc: "2.0", id: name, method: "tools/call",
      params: { name, arguments: argumentsValue },
    }, auth);
    assert.equal((result.json as { result: { isError: boolean } }).result.isError, true);
  }
  assert.equal(calls.length, 0);
});

test("legacy private Agent tool names remain forbidden", async () => {
  const calls: ObservedCall[] = [];
  const target = env({ REMOTE_CONTROL_DEVICE: recordingBinding(calls) });
  const auth = { authorization: `Bearer ${portalToken}` };
  for (const name of [
    "read_multiple_files", "get_file_info", "start_search", "get_more_search_results",
    "edit_block", "start_process", "read_process_output", "interact_with_process", "force_terminate",
  ]) {
    const result = await postMcp(target, {
      jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: {} },
    }, auth);
    assert.equal((result.json as { result: { isError: boolean } }).result.isError, true);
  }
  assert.equal(calls.length, 0);
});

test("lists curated local tools and rejects calls that could retarget the device", async () => {
  const calls: ObservedCall[] = [];
  const target = env({
    REMOTE_CONTROL_DEVICE: recordingBinding(calls),
  });
  const headers = { authorization: `Bearer ${portalToken}` };

  const listed = await postMcp(
    target,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    headers,
  );
  assert.equal(listed.status, 200);
  const tools = (listed.json as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "read_file",
      "read_files",
      "list_directory",
      "stat_file",
      "search_files",
      "search_next",
      "stop_search",
      "write_file",
      "create_directory",
      "replace_text",
      "move_file",
      "delete_file",
      "get_operation_status",
      "run_command",
      "list_sessions",
      "read_session_output",
      "send_input",
      "stop_session",
    ],
  );
  const annotations = tools[0]?.annotations as {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
  assert.equal(annotations.openWorldHint, false);
  const schema = JSON.stringify(tools[0]?.inputSchema);
  assert.equal(schema.includes("\"path\""), true);
  assert.equal(schema.includes("isUrl"), false);
  assert.equal(schema.includes("host"), false);
  const processTool = tools.find((tool) => tool.name === "run_command");
  assert.equal((processTool?.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
  assert.equal(tools.some((tool) => ["send_input", "stop_session"].includes(String(tool.name))), true);

  const secretUrl = "http://203.0.113.9/private";
  const rejectedArguments = [
    { path: secretUrl, isUrl: true },
    { path: "file:///etc/hostname" },
    { path: "/tmp/fixture.txt", host: "203.0.113.9", port: 8443, scheme: "https", url: secretUrl },
  ];
  for (const argument of rejectedArguments) {
    const result = await postMcp(
      target,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: argument } },
      headers,
    );
    assert.equal(result.status, 200);
    const payload = result.json as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(payload.result.isError, true);
    assert.equal(result.text.includes(secretUrl), false);
    assert.equal(result.text.includes("203.0.113.9"), false);
    assert.equal(result.text.includes(portalToken), false);
  }

  for (const name of ["write_file", "node:local", "set_config_value", "get_config", "kill_process"]) {
    const result = await postMcp(
      target,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name, arguments: { command: "id", path: secretUrl } } },
      headers,
    );
    const payload = result.json as { result: { isError: boolean } };
    assert.equal(payload.result.isError, true);
    assert.equal(result.text.includes(secretUrl), false);
  }

  for (const argumentsValue of [
    { command: "id" },
    { operation_id: "shell-path", command: "id", shell: "/bin/bash" },
  ]) {
    const result = await postMcp(target, {
      jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_command", arguments: argumentsValue },
    }, headers);
    assert.equal((result.json as { result: { isError: boolean } }).result.isError, true);
  }

  for (const [name, argumentsValue] of [
    ["send_input", { session_id: "2b6ecbd9-a994-47dd-ae82-3a8c4cf1641e", input: "x" }],
    ["send_input", { operation_id: "stdin", session_id: "not-a-session", input: "x" }],
    ["stop_session", { operation_id: "stop", session_id: "2b6ecbd9-a994-47dd-ae82-3a8c4cf1641e", process_id: 1234 }],
  ]) {
    const result = await postMcp(target, {
      jsonrpc: "2.0", id: 6, method: "tools/call", params: { name, arguments: argumentsValue },
    }, headers);
    assert.equal((result.json as { result: { isError: boolean } }).result.isError, true);
  }

  assert.equal(calls.length, 0);
});

test("an offline device returns a safe unavailable error", async () => {
  const calls: ObservedCall[] = [];
  const lines = await withConsole(async () => {
    const result = await postMcp(
      env({
        REMOTE_CONTROL_DEVICE: recordingBinding(calls, async () => {
          throw new Error(`connect ECONNREFUSED ${portalToken} ${deviceToken} /tmp/secret-fixture ${FIXTURE_TEXT}\n    at Worker.fetch`);
        }),
      }),
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "/tmp/secret-fixture" } },
      },
      { authorization: `Bearer ${portalToken}`, "x-device-credential": "client-supplied-device-token" },
    );
    assert.equal(result.status, 200);
    const payload = result.json as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(payload.result.isError, true);
    assert.equal(payload.result.content[0]?.text, "The remote device is unavailable.");
    assert.equal(result.text.includes(portalToken), false);
    assert.equal(result.text.includes(deviceToken), false);
    assert.equal(result.text.includes("secret-fixture"), false);
    assert.equal(result.text.includes(FIXTURE_TEXT), false);
    assert.equal(result.text.includes("ECONNREFUSED"), false);
    assert.equal(result.text.includes("at Worker.fetch"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, DEVICE_CALL_URL);
  });
  assert.equal(lines.includes(portalToken), false);
  assert.equal(lines.includes(deviceToken), false);
  assert.equal(lines.includes(FIXTURE_TEXT), false);
  assert.equal(lines.includes("secret-fixture"), false);
  assert.equal(lines.includes("ECONNREFUSED"), false);
  assert.equal(lines.includes("at Worker.fetch"), false);
});

test("reads a fixed fixture through the worker and the native agent", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remote-control-worker-fixture-"));
  const fixturePath = path.join(fixtureDir, "fixture.txt");
  await writeFile(fixturePath, `${FIXTURE_TEXT}\n`, "utf8");
  const agentEvents: string[] = [];
  let agent: RunningAgent | undefined;
  const calls: ObservedCall[] = [];
  const originalFetch = globalThis.fetch;

  try {
    const vendorHistory = path.join(os.homedir(), ".claude-server-commander");
    const vendorHistoryBefore = existsSync(vendorHistory);
    agent = await startAgent({
      deviceToken: deviceToken,
      log: (event) => agentEvents.push(event),
    });
    const runningAgent = agent;
    globalThis.fetch = (async () => {
      throw new Error("worker must not call global fetch");
    }) as typeof fetch;

    const binding = recordingBinding(calls, async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      assert.equal(url, DEVICE_CALL_URL);
      const forwarded = new URL(url);
      const headers = new Headers(init?.headers);
      return originalFetch(`${runningAgent.baseUrl}${forwarded.pathname}`, {
        method: init?.method,
        headers,
        body: init?.body,
      });
    });

    const logs = await withConsole(async () => {
      const initialized = await postMcp(
        env({ REMOTE_CONTROL_DEVICE: binding }),
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "t01", version: "0" },
          },
        },
        {
          authorization: `Bearer ${portalToken}`,
          host: "remote-control-mcp-worker.example.test",
          "x-attacker": "203.0.113.9",
        },
      );
      assert.equal(initialized.status, 200);
      assert.equal(
        (initialized.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name,
        "remote-control-mcp-worker",
      );
      assert.equal(calls.length, 0);

      const result = await postMcp(
        env({ REMOTE_CONTROL_DEVICE: binding }),
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "read_file", arguments: { path: fixturePath, offset: 0, length: 5 } },
        },
        {
          authorization: `Bearer ${portalToken}`,
          host: "remote-control-mcp-worker.example.test",
          "x-device-credential": "client-supplied-device-token",
          "x-forwarded-host": "203.0.113.9",
        },
      );
      assert.equal(result.status, 200);
      const payload = result.json as { result: { isError: boolean; content: Array<{ text: string }> } };
      assert.equal(payload.result.isError, false);
      assert.equal(payload.result.content[0]?.text.includes(FIXTURE_TEXT), true);
      assert.equal(result.text.includes(portalToken), false);
      assert.equal(result.text.includes(deviceToken), false);
      assert.equal(result.text.includes(fixturePath), false);
      assert.equal(result.text.includes("203.0.113.9"), false);

      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.ok(call);
      assert.equal(call.url, DEVICE_CALL_URL);
      assert.equal(call.method, "POST");
      assert.equal(call.headers.get("authorization"), null);
      assert.equal(call.headers.get("x-device-credential"), deviceToken);
      assert.equal(call.headers.get("x-forwarded-host"), null);
      assert.equal(call.headers.get("x-attacker"), null);
      assert.equal(call.headers.get("host"), null);
      assert.equal(call.body.includes(portalToken), false);
      assert.equal(call.body.includes("203.0.113.9"), false);
      assert.equal(call.body.includes(fixturePath), true);
      assert.equal(call.body.includes("\"isUrl\""), false);
    });

    assert.equal(logs.includes(portalToken), false);
    assert.equal(logs.includes(deviceToken), false);
    assert.equal(logs.includes(FIXTURE_TEXT), false);
    assert.equal(logs.includes(fixturePath), false);
    assert.equal(agentEvents.join("\n").includes(FIXTURE_TEXT), false);
    assert.equal(agentEvents.join("\n").includes(fixturePath), false);
    assert.equal(existsSync(vendorHistory), vendorHistoryBefore);
  } finally {
    globalThis.fetch = originalFetch;
    await agent?.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("all 18 public tool names are unambiguous in receipts while Agent names remain compatible", async () => {
  const mapping: Array<[string, string]> = [
    ["read_file", "read_file"],
    ["read_files", "read_multiple_files"],
    ["list_directory", "list_directory"],
    ["stat_file", "get_file_info"],
    ["search_files", "start_search"],
    ["search_next", "get_more_search_results"],
    ["stop_search", "stop_search"],
    ["write_file", "write_file"],
    ["create_directory", "create_directory"],
    ["replace_text", "edit_block"],
    ["move_file", "move_file"],
    ["delete_file", "delete_file"],
    ["get_operation_status", "get_operation_status"],
    ["run_command", "start_process"],
    ["list_sessions", "list_sessions"],
    ["read_session_output", "read_process_output"],
    ["send_input", "interact_with_process"],
    ["stop_session", "force_terminate"],
  ];
  const calls: ObservedCall[] = [];
  let current: [string, string] = mapping[0]!;
  const binding = recordingBinding(calls, async () => new Response(
    JSON.stringify({ operation_id: "audit", tool_name: current[1], state: "completed" }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  const target = env({ REMOTE_CONTROL_DEVICE: binding });
  const auth = { authorization: `Bearer ${portalToken}` };
  const listed = await postMcp(target, { jsonrpc: "2.0", id: "list", method: "tools/list" }, auth);
  const names = (listed.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, mapping.map(([name]) => name));
  assert.equal(new Set(mapping.map(([, agentName]) => agentName)).size, mapping.length);
  for (const pair of mapping) {
    current = pair;
    const status = await postMcp(target, {
      jsonrpc: "2.0", id: pair[0], method: "tools/call",
      params: { name: "get_operation_status", arguments: { operation_id: "audit" } },
    }, auth);
    const response = status.json as { result: { content: Array<{ text: string }> } };
    const receipt = JSON.parse(response.result.content[0]!.text) as { tool_name: string; public_tool_name: string };
    assert.equal(receipt.tool_name, pair[1]);
    assert.equal(receipt.public_tool_name, pair[0]);
  }
});

test("write_file and get_operation_status preserve a stable receipt across a lost response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-worker-receipt-"));
  const receiptDirectory = path.join(root, "receipts");
  const fixture = path.join(root, "fixture.txt");
  await writeFile(fixture, "start", "utf8");
  const originalFetch = globalThis.fetch;
  const calls: ObservedCall[] = [];
  let agent: RunningAgent | undefined;
  let loseFirstWriteReply = true;
  try {
    agent = await startAgent({ deviceToken, receiptDirectory });
    const runningAgent = agent;
    const binding = recordingBinding(calls, async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const forwarded = new URL(url);
      const response = await originalFetch(`${runningAgent.baseUrl}${forwarded.pathname}`, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
      if (forwarded.pathname === "/internal/call" && loseFirstWriteReply) {
        loseFirstWriteReply = false;
        await response.text();
        throw new Error("synthetic reply loss after dispatch");
      }
      return response;
    });
    globalThis.fetch = (async () => { throw new Error("Worker must use the fixed device binding"); }) as typeof fetch;
    const target = env({
      REMOTE_CONTROL_DEVICE: binding,
    });
    const auth = { authorization: `Bearer ${portalToken}` };
    const invoke = (name: string, args: unknown, id: number) => postMcp(target, {
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    }, auth);

    const first = await invoke("write_file", {
      operation_id: "stable:write.17", path: fixture, content: "+once", mode: "append",
    }, 1);
    assert.equal((first.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
      JSON.stringify({ operation_id: "stable:write.17", status: "timeout_unknown" }));
    assert.equal(await readFile(fixture, "utf8"), "start+once");

    const status = await invoke("get_operation_status", { operation_id: "stable:write.17" }, 2);
    const statusText = (status.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.equal((JSON.parse(statusText) as { state: string }).state, "completed");
    assert.equal(statusText.includes("argument_digest"), false);

    const same = await invoke("write_file", {
      operation_id: "stable:write.17", path: fixture, content: "+once", mode: "append",
    }, 3);
    assert.equal((same.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text
      ? JSON.parse((same.json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).status
      : undefined, "completed");
    assert.equal(await readFile(fixture, "utf8"), "start+once");

    const conflict = await invoke("write_file", {
      operation_id: "stable:write.17", path: fixture, content: "+different", mode: "append",
    }, 4);
    const conflictText = (conflict.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.deepEqual(JSON.parse(conflictText), { operation_id: "stable:write.17", status: "conflict" });
    assert.equal(await readFile(fixture, "utf8"), "start+once");

    const failed = await invoke("write_file", {
      operation_id: "known-failure", path: path.join(root, "missing", "fixture.txt"), content: "x", mode: "rewrite",
    }, 5);
    const failedText = (failed.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    const failedResult = JSON.parse(failedText) as { operation_id: string; status: string; receipt: { state: string } };
    assert.equal(failedResult.operation_id, "known-failure");
    assert.equal(failedResult.status, "failed");
    assert.equal(failedResult.receipt.state, "failed");

    const badRequest = await invoke("write_file", {
      operation_id: "valid-but-invalid-args", path: fixture, content: "x", mode: "replace",
    }, 6);
    const badRequestText = (badRequest.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.deepEqual(JSON.parse(badRequestText), { operation_id: "valid-but-invalid-args", status: "bad_request" });

    const beforeInvalidId = calls.length;
    const invalidId = await invoke("get_operation_status", { operation_id: ".." }, 7);
    assert.equal((invalidId.json as { result: { isError: boolean } }).result.isError, true);
    assert.equal(calls.length, beforeInvalidId);

    const statusCall = calls.find((call) => call.method === "GET");
    assert.equal(statusCall?.url, "http://remote-control-device.invalid/internal/operations/stable%3Awrite.17");
    assert.equal(calls.every((call) => call.headers.get("x-device-credential") === deviceToken), true);
    assert.equal(calls.every((call) => call.headers.get("authorization") === null), true);
  } finally {
    globalThis.fetch = originalFetch;
    await agent?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T06 mutation tools validate at the Worker and reach the native Agent receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-control-worker-t06-"));
  const receiptDirectory = path.join(root, "receipts");
  const fixture = path.join(root, "before.txt");
  await writeFile(fixture, "one two one\n", "utf8");
  const calls: ObservedCall[] = [];
  const originalFetch = globalThis.fetch;
  let agent: RunningAgent | undefined;
  try {
    agent = await startAgent({ deviceToken, receiptDirectory });
    const runningAgent = agent;
    globalThis.fetch = (async () => { throw new Error("Worker must use the fixed device binding"); }) as typeof fetch;
    const binding = recordingBinding(calls, async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const forwarded = new URL(url);
      return originalFetch(`${runningAgent.baseUrl}${forwarded.pathname}`, { method: init?.method, headers: init?.headers, body: init?.body });
    });
    const target = env({
      REMOTE_CONTROL_DEVICE: binding,
    });
    const auth = { authorization: `Bearer ${portalToken}` };
    const invoke = async (name: string, args: unknown, id: number) => postMcp(target, {
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    }, auth);

    const directory = path.join(root, "new-dir");
    const created = await invoke("create_directory", { operation_id: "t06-mkdir", path: directory }, 1);
    assert.equal((created.json as { result: { isError: boolean } }).result.isError, false);
    const edited = await invoke("replace_text", {
      operation_id: "t06-edit", file_path: fixture, old_string: "one", new_string: "three", expected_replacements: 2,
    }, 2);
    assert.equal((edited.json as { result: { isError: boolean } }).result.isError, false);
    assert.equal(await readFile(fixture, "utf8"), "three two three\n");
    const failed = await invoke("replace_text", {
      operation_id: "t06-mismatch", file_path: fixture, old_string: "three", new_string: "four", expected_replacements: 1,
    }, 3);
    assert.equal((failed.json as { result: { isError: boolean } }).result.isError, false);
    const failedText = (failed.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    assert.equal((JSON.parse(failedText) as { status: string }).status, "failed");
    assert.equal(await readFile(fixture, "utf8"), "three two three\n");
    const movedTo = path.join(root, "after.txt");
    const moved = await invoke("move_file", { operation_id: "t06-move", source: fixture, destination: movedTo }, 4);
    assert.equal((moved.json as { result: { isError: boolean } }).result.isError, false);
    assert.equal(await readFile(movedTo, "utf8"), "three two three\n");
    const status = await invoke("get_operation_status", { operation_id: "t06-edit" }, 5);
    const statusText = (status.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    // Existing Agent receipt names remain stable across public MCP renames.
    assert.equal((JSON.parse(statusText) as { tool_name: string; state: string }).tool_name, "edit_block");
    assert.equal((JSON.parse(statusText) as { public_tool_name: string }).public_tool_name, "replace_text");
    assert.equal((JSON.parse(statusText) as { state: string }).state, "completed");

    const deleted = await invoke("delete_file", { operation_id: "t06-delete", path: movedTo }, 7);
    assert.equal((deleted.json as { result: { isError: boolean } }).result.isError, false);
    const deletedReceipt = await invoke("get_operation_status", { operation_id: "t06-delete" }, 8);
    assert.equal(JSON.parse((deletedReceipt.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}").state, "completed");
    assert.equal(existsSync(movedTo), false);
    const forwarded = calls.filter((entry) => entry.method === "POST").map((entry) => JSON.parse(entry.body) as { tool: string });
    assert.equal(forwarded.some((entry) => entry.tool === "edit_block"), true);
    assert.equal(forwarded.some((entry) => entry.tool === "replace_text"), false);

    const beforeInvalid = calls.length;
    const arbitraryOptions = await invoke("replace_text", {
      operation_id: "t06-options", file_path: movedTo, old_string: "x", new_string: "y", options: { regex: true },
    }, 6);
    assert.equal((arbitraryOptions.json as { result: { isError: boolean } }).result.isError, true);
    assert.equal(calls.length, beforeInvalid);
    assert.equal(calls.filter((call) => call.method === "POST").every((call) => call.url === DEVICE_CALL_URL), true);
    assert.equal(calls.every((call) => call.headers.get("authorization") === null), true);
    assert.equal(calls.every((call) => call.headers.get("x-device-credential") === deviceToken), true);
  } finally {
    globalThis.fetch = originalFetch;
    await agent?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("lists a disposable directory through the worker and the native agent", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remote-control-worker-list-"));
  await mkdir(path.join(fixtureDir, "child"));
  await writeFile(path.join(fixtureDir, "child", "note.txt"), "LIST_SENTINEL_remote_control_t03\n", "utf8");
  const calls: ObservedCall[] = [];
  const originalFetch = globalThis.fetch;
  let agent: RunningAgent | undefined;

  try {
    agent = await startAgent({ deviceToken, receiptDirectory: path.join(fixtureDir, "receipts") });
    const runningAgent = agent;
    globalThis.fetch = (async () => {
      throw new Error("worker must not call global fetch");
    }) as typeof fetch;
    const binding = recordingBinding(calls, async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const forwarded = new URL(url);
      return originalFetch(`${runningAgent.baseUrl}${forwarded.pathname}`, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
    });
    const result = await postMcp(
      env({ REMOTE_CONTROL_DEVICE: binding }),
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "list_directory", arguments: { path: fixtureDir, depth: 2 } },
      },
      { authorization: `Bearer ${portalToken}` },
    );
    assert.equal(result.status, 200);
    const payload = result.json as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(payload.result.isError, false);
    assert.equal(payload.result.content[0]?.text.includes("file child/note.txt"), true);
    assert.equal(payload.result.content[0]?.text.includes("LIST_SENTINEL_remote_control_t03"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, DEVICE_CALL_URL);
    assert.equal(calls[0]?.body.includes("\"tool\":\"list_directory\""), true);
    assert.equal(calls[0]?.headers.get("authorization"), null);
    assert.equal(calls[0]?.headers.get("x-device-credential"), deviceToken);
  } finally {
    globalThis.fetch = originalFetch;
    await agent?.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("lists and pages bounded filename and content searches through the worker and agent", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remote-control-worker-search-"));
  await writeFile(path.join(fixtureDir, "content-a.txt"), "SEARCH_FIXTURE_SENTINEL\n", "utf8");
  await writeFile(path.join(fixtureDir, "content-b.txt"), "SEARCH_FIXTURE_SENTINEL\n", "utf8");
  for (let index = 0; index < 25; index += 1) {
    await writeFile(path.join(fixtureDir, `worker-match-${String(index).padStart(2, "0")}.txt`), "safe\n", "utf8");
  }
  const calls: ObservedCall[] = [];
  const originalFetch = globalThis.fetch;
  let agent: RunningAgent | undefined;

  try {
    agent = await startAgent({ deviceToken, shellPath: "/bin/sh", receiptDirectory: path.join(fixtureDir, "receipts") });
    const runningAgent = agent;
    globalThis.fetch = (async () => {
      throw new Error("worker must not call global fetch");
    }) as typeof fetch;
    const binding = recordingBinding(calls, async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const forwarded = new URL(url);
      return originalFetch(`${runningAgent.baseUrl}${forwarded.pathname}`, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
    });
    const target = env({
      REMOTE_CONTROL_DEVICE: binding,
    });
    const auth = { authorization: `Bearer ${portalToken}` };
    const list = await postMcp(target, { jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
    const tools = (list.json as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["read_file", "read_files", "list_directory", "stat_file", "search_files", "search_next", "stop_search", "write_file", "create_directory", "replace_text", "move_file", "delete_file", "get_operation_status", "run_command", "list_sessions", "read_session_output", "send_input", "stop_session"],
    );
    for (const tool of tools.slice(4, 7).concat(tools.slice(11))) {
      const annotations = tool.annotations as { readOnlyHint: boolean; destructiveHint: boolean };
      assert.equal(annotations.readOnlyHint, !["write_file", "create_directory", "replace_text", "move_file", "delete_file", "run_command", "send_input", "stop_session"].includes(String(tool.name)));
      assert.equal(annotations.destructiveHint, ["write_file", "create_directory", "replace_text", "move_file", "delete_file", "run_command", "send_input", "stop_session"].includes(String(tool.name)));
    }
    const writeTool = tools[7];
    assert.equal(JSON.stringify(writeTool?.description).includes("new ID"), true);
    assert.equal((writeTool?.inputSchema as { required: string[] }).required.includes("operation_id"), true);

    const started = await postMcp(
      target,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "search_files",
          arguments: { path: fixtureDir, pattern: "worker-match-", search_type: "filename" },
        },
      },
      auth,
    );
    const firstText = (started.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    const first = JSON.parse(firstText) as { session_id: string; results: unknown[]; has_more: boolean };
    assert.equal(first.results.length, 20);
    assert.equal(first.has_more, true);

    const next = await postMcp(
      target,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_next", arguments: { session_id: first.session_id } },
      },
      auth,
    );
    const second = JSON.parse(
      (next.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}",
    ) as { results: unknown[]; has_more: boolean };
    assert.equal(second.results.length, 5);

    const processStarted = await postMcp(target, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "run_command", arguments: { operation_id: "worker-process-once", command: "printf '%s' 'worker-shell-fixture'", timeout_ms: 500 } },
    }, auth);
    const processInfo = JSON.parse((processStarted.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}") as { operation_id: string; status: string; session_id: string };
    assert.equal(processInfo.operation_id, "worker-process-once");
    assert.equal(processInfo.status, "completed");
    assert.ok(processInfo.session_id, JSON.stringify(processInfo));
    assert.match(processInfo.session_id, /^[0-9a-f-]{36}$/);
    const processOutput = await postMcp(target, {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "read_session_output", arguments: { session_id: processInfo.session_id, offset: 0, length: 64 } },
    }, auth);
    const outputPage = JSON.parse((processOutput.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}") as { output: string; eof: boolean };
    assert.equal(outputPage.output, "worker-shell-fixture");
    assert.equal(outputPage.eof, true);
    const listedSessions = await postMcp(target, {
      jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_sessions", arguments: {} },
    }, auth);
    assert.equal(JSON.parse((listedSessions.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "[]").length, 1);

    const waiting = await postMcp(target, {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "run_command", arguments: { operation_id: "worker-stdin-start", command: 'read value; printf "worker:%s" "$value"', timeout_ms: 0 } },
    }, auth);
    const waitingInfo = JSON.parse((waiting.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}") as { session_id: string; status: string };
    assert.equal(waitingInfo.status, "running");
    const inputArgs = { operation_id: "worker-stdin-once", session_id: waitingInfo.session_id, input: "input\n" };
    const inputSent = await postMcp(target, {
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "send_input", arguments: inputArgs },
    }, auth);
    assert.equal(JSON.parse((inputSent.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}").status, "completed");
    const inputDuplicate = await postMcp(target, {
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "send_input", arguments: inputArgs },
    }, auth);
    assert.equal(JSON.parse((inputDuplicate.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}").status, "completed");
    const inputOutput = await postMcp(target, {
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "read_session_output", arguments: { session_id: waitingInfo.session_id } },
    }, auth);
    assert.equal(JSON.parse((inputOutput.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}").output, "worker:input");

    const stoppable = await postMcp(target, {
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "run_command", arguments: { operation_id: "worker-stop-start", command: "sleep 30", timeout_ms: 0 } },
    }, auth);
    const stoppableInfo = JSON.parse((stoppable.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}") as { session_id: string; status: string };
    assert.equal(stoppableInfo.status, "running");
    const terminated = await postMcp(target, {
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: { name: "stop_session", arguments: { operation_id: "worker-stop-once", session_id: stoppableInfo.session_id } },
    }, auth);
    assert.equal(JSON.parse((terminated.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}").status, "completed");
    assert.equal(second.has_more, false);

    const content = await postMcp(
      target,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "search_files",
          arguments: { path: fixtureDir, pattern: "SEARCH_FIXTURE_SENTINEL", search_type: "content" },
        },
      },
      auth,
    );
    const contentText = (content.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";
    const contentPage = JSON.parse(contentText) as { results: unknown[]; has_more: boolean };
    assert.equal(contentPage.results.length, 2);
    assert.equal(contentPage.has_more, false);

    const stoppedStart = await postMcp(
      target,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "search_files",
          arguments: { path: fixtureDir, pattern: "worker-match-", search_type: "filename" },
        },
      },
      auth,
    );
    const stoppedPage = JSON.parse(
      (stoppedStart.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}",
    ) as { session_id: string };
    const stopped = await postMcp(
      target,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "stop_search", arguments: { session_id: stoppedPage.session_id } },
      },
      auth,
    );
    assert.equal(JSON.parse((stopped.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}").status, "stopped");

    const beforeRejected = calls.length;
    const rejected = await postMcp(
      target,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "search_files",
          arguments: { path: fixtureDir, pattern: "secret", search_type: "filename", host: "203.0.113.9" },
        },
      },
      auth,
    );
    assert.equal((rejected.json as { result: { isError: boolean } }).result.isError, true);
    assert.equal(calls.length, beforeRejected);
    assert.equal(calls.every((call) => call.url === DEVICE_CALL_URL), true);
    assert.equal(calls.every((call) => call.headers.get("authorization") === null), true);
    assert.equal(calls.every((call) => call.headers.get("x-device-credential") === deviceToken), true);
  } finally {
    globalThis.fetch = originalFetch;
    await agent?.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
