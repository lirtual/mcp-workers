import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import worker from "../src/worker.ts";

test("request_secure_input forwards explicit production classification and rejects invalid values", async () => {
  const requestId = randomUUID();
  const forwarded: unknown[] = [];
  const owner = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      forwarded.push(await request.json());
      return Response.json({ request_id: requestId, expires_at: Date.now() + 300_000, state: "pending" });
    },
  };
  const env = {
    MCP_ACCESS_TOKEN: "portal-owner-token",
    CLERK_PUBLISHABLE_KEY: "pk_live_" + Buffer.from("clerk.lirtual.dpdns.org$").toString("base64"),
    CLERK_OWNER_USER_ID: "user_testowner1",
    DEVICE_COORDINATOR: { idFromName: () => "owner", get: () => owner },
  } as never;
  const call = (isProduction: unknown) => worker.fetch(new Request("https://rca.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer portal-owner-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "request_secure_input",
      arguments: {
        purpose: "One-time test credential", is_production: isProduction,
        execution: { device_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
        target: { kind: "task_process", session_id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", name: "API_TOKEN" },
      },
    } }),
  }), env);

  const response = await call(false);
  assert.equal(response.status, 200);
  assert.equal((forwarded[0] as { request: { is_production: boolean } }).request.is_production, false);
  assert.match(await response.text(), new RegExp(requestId));

  const bad = await call("false");
  assert.equal(bad.status, 200);
  assert.match(await bad.text(), /Invalid secure input request/);
  assert.equal(forwarded.length, 1);
});
