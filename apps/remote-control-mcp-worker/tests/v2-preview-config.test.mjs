import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

test("dedicated v2 preview cannot inherit the v1 VPC binding, token or DO namespace", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const preview = JSON.parse(await readFile(path.join(root, "wrangler.v2-preview.jsonc"), "utf8"));
  const production = await readFile(path.join(root, "wrangler.jsonc"), "utf8");
  assert.equal(preview.name, "remote-control-v2-preview");
  assert.equal(preview.main, "src/worker.ts");
  assert.equal(preview.vars?.REMOTE_CONTROL_V2_PREVIEW_ONLY, "true");
  assert.equal(preview.durable_objects.bindings.length, 1);
  assert.deepEqual(preview.durable_objects.bindings[0], {
    name: "V2_OWNER", class_name: "V2OwnerCoordinator",
  });
  assert.deepEqual(preview.exports.V2OwnerCoordinator, { type: "durable-object", storage: "sqlite" });
  assert.deepEqual(preview.secrets.required, ["MCP_ACCESS_TOKEN"]);
  assert.deepEqual(preview.compatibility_flags, ["nodejs_compat"]);
  assert.equal(preview.observability.logs.invocation_logs, false);
  assert.equal(preview.preview_urls, false);
  assert.equal(preview.keep_vars, false);
  assert.ok(!("vpc_services" in preview));
  assert.ok(!("migrations" in preview));
  assert.ok(!("routes" in preview));
  assert.ok(!("triggers" in preview));
  assert.equal(JSON.stringify(preview).includes("REMOTE_CONTROL_DEVICE_TOKEN"), false);
  assert.equal(JSON.stringify(preview).includes("REMOTE_CONTROL_DEVICE"), false);
  const bootstrap = JSON.parse(await readFile(path.join(root, "wrangler.v2-preview-bootstrap.jsonc"), "utf8"));
  const { secrets: _requiredPreviewSecret, ...releaseSettings } = preview;
  assert.deepEqual(bootstrap, releaseSettings, "bootstrap differs only by omission of the required secret declaration");
  assert.equal("secrets" in bootstrap, false);
  assert.ok(production.includes('"name": "remote-control-mcp-worker"'), "production configuration must remain independent");
});


test("preview MCP blocks direct mutation, shell and receipt calls even with a valid device ID", async () => {
  // The tool-list boundary is not sufficient: a client can handcraft any MCP
  // tools/call RPC. Refuse risky calls before routing to owner DO or legacy VPC.
  const { default: worker } = await import("../src/worker.ts");
  const { randomUUID } = await import("node:crypto");
  let ownerCalls = 0, legacyCalls = 0;
  const env = {
    MCP_ACCESS_TOKEN: "isolated-preview-test-token",
    REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    V2_OWNER: {
      idFromName() { ownerCalls++; throw Error("Preview must not route mutation to DO"); },
      get() { ownerCalls++; throw Error("Preview must not route mutation to DO"); },
    },
    REMOTE_CONTROL_DEVICE: {
      fetch() { legacyCalls++; throw Error("Preview must not route mutation to v1"); },
    },
  };
  async function rpc(method, params, token = "isolated-preview-test-token") {
    const response = await worker.fetch(new Request("https://preview.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 51, method, params }),
    }), env);
    return { status: response.status, body: await response.json() };
  }
  const listed = await rpc("tools/list", {});
  const names = listed.body.result.tools.map(tool => tool.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("list_devices"));
  for (const denied of [
    "write_file", "create_directory", "replace_text", "move_file",
    "delete_file", "get_operation_status", "run_command",
    "send_input", "stop_session", "list_sessions", "read_session_output",
  ]) assert.ok(!names.includes(denied), "preview must not advertise " + denied);

  const device_id = randomUUID(), operation_id = "preview-blocked-" + randomUUID();
  const cases = [
    ["write_file", { device_id, operation_id, path: "/tmp/preview-denied", content: "NO", mode: "append" }],
    ["run_command", { device_id, operation_id, command: "echo NO", timeout_ms: 100 }],
    ["get_operation_status", { device_id, operation_id }],
    ["send_input", { device_id, operation_id, session_id: randomUUID(), input: "NO" }],
    ["delete_file", { device_id, operation_id, path: "/tmp/preview-denied" }],
    ["read_file", { path: "/etc/os-release" }], // explicit device is mandatory in preview
  ];
  for (const [name, args] of cases) {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.equal(result.body.result?.isError, true, "preview must deny " + name);
    assert.match(result.body.result?.content?.[0]?.text ?? "",
      /preview permits only explicit-device read-only calls and owner pairing/i);
  }
  const unauthorized = await rpc("tools/call", { name: "write_file",
    arguments: { device_id, operation_id, path: "/tmp/preview-denied", content: "NO", mode: "append" },
  }, "wrong-token");
  assert.equal(unauthorized.status, 401);
  assert.equal(ownerCalls, 0, "disallowed preview tools must not reach the owner DO");
  assert.equal(legacyCalls, 0, "disallowed preview tools must not fall back to v1");
});


test("Preview Receipt tools require one explicitly granted device, without widening other device access", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const { randomUUID } = await import("node:crypto");
  const permittedId = randomUUID(), otherId = randomUUID();
  const operation_id = "preview-test-" + randomUUID();
  let doCalls = 0, v1Calls = 0;
  const env = {
    MCP_ACCESS_TOKEN: "preview-test-token",
    REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    REMOTE_CONTROL_V2_RECEIPT_TEST_DEVICE_ID: permittedId,
    V2_OWNER: {
      idFromName: () => "single-owner-v2",
      get: () => ({
        fetch: async request => {
          doCalls++;
          assert.match(String(request.url || request), /\/operation$/);
          return Response.json({ operation_id, status: "not_found" });
        },
      }),
    },
    REMOTE_CONTROL_DEVICE: { fetch: () => { v1Calls++; throw Error("v1 forbidden"); } },
  };
  const rpc = async (method, params, token = "preview-test-token") => {
    const res = await worker.fetch(new Request("https://preview.test/mcp", {
      method: "POST", headers: {
        "content-type": "application/json", authorization: "Bearer " + token,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 21, method, params }),
    }), env);
    return { status: res.status, body: await res.json() };
  };
  const names = (await rpc("tools/list", {})).body.result.tools.map(t => t.name);
  for (const name of ["write_file", "run_command", "get_operation_status",
    "list_sessions", "read_session_output"]) {
    assert.ok(names.includes(name), "missing opt-in tool: " + name);
  }
  for (const name of ["delete_file", "move_file", "create_directory", "replace_text",
    "send_input", "stop_session"]) {
    assert.ok(!names.includes(name), "unrelated mutation listed: " + name);
  }

  const mutation = { operation_id, path: "/tmp/denied", content: "NO", mode: "append" };
  for (const [name, args] of [
    ["write_file", { device_id: otherId, ...mutation }],
    ["write_file", { ...mutation }],
    ["run_command", { device_id: otherId, operation_id, command: "printf 'NO'" }],
    ["get_operation_status", { device_id: otherId, operation_id }],
    ["list_sessions", { device_id: otherId }],
    ["read_session_output", { device_id: otherId, session_id: randomUUID() }],
    ["write_file", { device_id: permittedId, operation_id, path: "/tmp/denied", content: "BAD", mode: "append" }],
    ["run_command", { device_id: permittedId, operation_id, command: "id" }],
    ["delete_file", { device_id: permittedId, operation_id, path: "/tmp/denied" }],
    ["send_input", { device_id: permittedId, operation_id, session_id: randomUUID(), input: "NO" }],
  ]) {
    const r = await rpc("tools/call", { name, arguments: args });
    assert.equal(r.body.result?.isError, true, name + " should be denied");
  }
  assert.equal(doCalls, 0);
  assert.equal(v1Calls, 0);

  const fixture = "/home/rcagent/receipt-v2-preview-test-" + randomUUID() + ".txt";
  const boundedWrite = await rpc("tools/call", {
    name: "write_file", arguments: {
      device_id: permittedId, operation_id, path: fixture,
      content: "RC_V2_RECEIPT_ONCE\\n", mode: "append",
    },
  });
  assert.notEqual(boundedWrite.body.result?.isError, true);
  assert.equal(JSON.parse(boundedWrite.body.result.content[0].text).status, "not_found");
  const boundedCommand = await rpc("tools/call", {
    name: "run_command", arguments: {
      device_id: permittedId, operation_id, command: "printf 'RC_V2_RECEIPT_TEST_OK\\n'",
    },
  });
  assert.notEqual(boundedCommand.body.result?.isError, true);
  assert.equal(doCalls, 2, "only allowed test tools reached DO");
  assert.equal(v1Calls, 0);
  doCalls = 0;

  const unauthorized = await rpc("tools/call", {
    name: "get_operation_status", arguments: { device_id: permittedId, operation_id },
  }, "wrong-token");
  assert.equal(unauthorized.status, 401);
  const allowed = await rpc("tools/call", {
    name: "get_operation_status", arguments: { device_id: permittedId, operation_id },
  });
  assert.notEqual(allowed.body.result?.isError, true);
  assert.equal(JSON.parse(allowed.body.result.content[0].text).status, "not_found");
  assert.equal(doCalls, 1);
  assert.equal(v1Calls, 0);
});

test("malformed device grant fails closed and does not advertise mutation tools", async () => {
  const { default: worker } = await import("../src/worker.ts");
  for (const invalid of ["", "all", "*", "not-a-uuid", "00000000-0000-0000-0000-000000000000 extra"]) {
    const result = await worker.fetch(new Request("https://preview.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 22, method: "tools/list", params: {} }),
    }), {
      MCP_ACCESS_TOKEN: "token",
      REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
      REMOTE_CONTROL_V2_RECEIPT_TEST_DEVICE_ID: invalid,
    });
    const names = (await result.json()).result.tools.map(x => x.name);
    assert.ok(!names.includes("write_file") && !names.includes("run_command") &&
      !names.includes("get_operation_status"));
  }
});
