import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startAgent, type RunningAgent } from "../../remote-control-agent/src/server.ts";
import worker, { DEVICE_CALL_URL } from "../src/worker.ts";

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
        name: "start_search",
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

test("lists only the local read tool and rejects anything that could retarget the device", async () => {
  const calls: ObservedCall[] = [];
  const target = env({ REMOTE_CONTROL_DEVICE: recordingBinding(calls) });
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
      "read_multiple_files",
      "list_directory",
      "get_file_info",
      "start_search",
      "get_more_search_results",
      "stop_search",
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

  for (const name of ["write_file", "start_process", "set_config_value", "get_config", "kill_process"]) {
    const result = await postMcp(
      target,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name, arguments: { command: "id", path: secretUrl } } },
      headers,
    );
    const payload = result.json as { result: { isError: boolean } };
    assert.equal(payload.result.isError, true);
    assert.equal(result.text.includes(secretUrl), false);
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

test("lists a disposable directory through the worker and the native agent", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remote-control-worker-list-"));
  await mkdir(path.join(fixtureDir, "child"));
  await writeFile(path.join(fixtureDir, "child", "note.txt"), "LIST_SENTINEL_remote_control_t03\n", "utf8");
  const calls: ObservedCall[] = [];
  const originalFetch = globalThis.fetch;
  let agent: RunningAgent | undefined;

  try {
    agent = await startAgent({ deviceToken });
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
    agent = await startAgent({ deviceToken });
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
    const target = env({ REMOTE_CONTROL_DEVICE: binding });
    const auth = { authorization: `Bearer ${portalToken}` };
    const list = await postMcp(target, { jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
    const tools = (list.json as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["read_file", "read_multiple_files", "list_directory", "get_file_info", "start_search", "get_more_search_results", "stop_search"],
    );
    for (const tool of tools.slice(-3)) {
      const annotations = tool.annotations as { readOnlyHint: boolean; destructiveHint: boolean };
      assert.equal(annotations.readOnlyHint, true);
      assert.equal(annotations.destructiveHint, false);
    }

    const started = await postMcp(
      target,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "start_search",
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
        params: { name: "get_more_search_results", arguments: { session_id: first.session_id } },
      },
      auth,
    );
    const second = JSON.parse(
      (next.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "{}",
    ) as { results: unknown[]; has_more: boolean };
    assert.equal(second.results.length, 5);
    assert.equal(second.has_more, false);

    const content = await postMcp(
      target,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "start_search",
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
          name: "start_search",
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
          name: "start_search",
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
