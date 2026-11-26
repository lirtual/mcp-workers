import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
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

// Execute the served page script with synthetic DOM/Clerk/HTTP boundaries.
// No browser account, live endpoint or secret is involved in this regression.
test("secure input page obtains a current Owner token per action and never re-enables uncertain submission", async () => {
  const id = randomUUID();
  const origin = "https://rca.lirtual.dpdns.org";
  const env = {
    MCP_ACCESS_TOKEN: "owner-test-credential",
    CLERK_PUBLISHABLE_KEY: "pk_live_" + Buffer.from("clerk.lirtual.dpdns.org$").toString("base64"),
    CLERK_OWNER_USER_ID: "user_fixture",
    DEVICE_COORDINATOR: { idFromName: () => "owner", get: () => ({}) },
  } as never;
  const page = await worker.fetch(new Request(origin + "/secure-input/" + id), env);
  assert.equal(page.status, 200);
  const source = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(await page.text())?.[1];
  assert.ok(source);
  type Handler = (event: { preventDefault(): void }) => Promise<void>;
  type Element = { hidden: boolean; disabled: boolean; checked: boolean; value: string;
    textContent: string; addEventListener(type: string, handler: Handler): void };
  const handlers = new Map<string, Handler>(), elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, disabled: true, checked: false, value: "", textContent: "",
      addEventListener(type, handler) { handlers.set(id + ":" + type, handler); },
    });
    return elements.get(id)!;
  };
  const event = { preventDefault() {} };
  const invoke = (id: string, type: string) => handlers.get(id + ":" + type)!(event);
  let tokens = 0, submissions = 0, cancelled = false;
  const actions: string[] = [];
  runInNewContext(source, {
    document: { getElementById: element }, location: { href: origin + "/secure-input/" + id },
    window: { Clerk: { load: async () => {}, session: { getToken: async () => "fixture-token-" + ++tokens } } },
    fetch: async (url: string, init: RequestInit) => {
      const action = url.split("/").at(-1)!;
      actions.push(action);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-token-" + actions.length);
      if (action === "submit") { submissions++; throw new Error("synthetic lost response"); }
      if (action === "cancel") {
        assert.equal(init.body, "{}");
        cancelled = true;
        return Response.json({ request_id: id, state: "cancelled" });
      }
      return Response.json({ state: cancelled ? "cancelled" : "pending", purpose: "Synthetic input",
        target: { kind: "task_process" }, execution: {}, is_production: false, expires_at: Date.now() + 300_000 });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("submit").disabled, false);
  await invoke("refresh", "click");
  element("secret").value = "synthetic-marker";
  element("target-confirmed").checked = true;
  await invoke("secure-form", "submit");
  assert.equal(element("secret").value, "");
  assert.match(element("status").textContent, /unknown/);
  await invoke("refresh", "click");
  assert.equal(element("submit").disabled, true);
  await invoke("secure-form", "submit");
  assert.equal(submissions, 1);
  assert.equal(element("cancel").disabled, false);
  await invoke("cancel", "click");
  assert.equal(element("state").textContent, "cancelled");
  assert.equal(element("secure-form").hidden, true);
  assert.deepEqual(actions, ["details", "details", "submit", "details", "cancel"]);
  assert.equal(tokens, actions.length);
});
