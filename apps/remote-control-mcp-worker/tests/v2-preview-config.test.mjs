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
