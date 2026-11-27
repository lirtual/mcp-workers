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
async function secureInputPageFixture(target = { kind: "task_process" }, auth: "signed-in" | "signed-out" | "missing" | "load-failed" | "rejected" = "signed-in") {
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
  const html = await page.text();
  const source = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(source);
  type Handler = (event: { preventDefault(): void }) => Promise<void>;
  type Element = { hidden: boolean; disabled: boolean; checked: boolean; value: string;
    textContent: string; addEventListener(type: string, handler: Handler): void };
  const handlers = new Map<string, Handler>(), elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: id !== "signin-panel" && id !== "status", disabled: true, checked: false, value: "", textContent: "",
      addEventListener(type, handler) { handlers.set(id + ":" + type, handler); },
    });
    return elements.get(id)!;
  };
  const event = { preventDefault() {} };
  const invoke = (id: string, type: string) => handlers.get(id + ":" + type)!(event);
  let tokens = 0, submissions = 0, cancelled = false;
  let resultState: { state: string; error_code?: string } | undefined;
  const actions: string[] = [];
  const clerk = auth === "missing" ? undefined : {
    load: async () => { if (auth === "load-failed") throw Error("SDK initialization failure"); },
    isSignedIn: auth !== "signed-out",
    session: auth === "signed-out" ? null : { getToken: async () => "fixture-token-" + ++tokens },
  };
  runInNewContext(source, {
    document: { getElementById: element }, location: { href: origin + "/secure-input/" + id + "?untrusted=1#fragment" },
    window: { Clerk: clerk },
    fetch: async (url: string, init: RequestInit) => {
      const action = url.split("/").at(-1)!;
      actions.push(action);
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-token-" + actions.length);
      if (auth === "rejected") return Response.json({ error: "unauthorized" }, { status: 401 });
      if (action === "submit") { submissions++; throw new Error("synthetic lost response"); }
      if (action === "cancel") {
        assert.equal(init.body, "{}");
        cancelled = true;
        return Response.json({ request_id: id, state: "cancelled" });
      }
      return Response.json({ ...(resultState ?? { state: cancelled ? "cancelled" : "pending" }), purpose: "Synthetic input",
        target, execution: {}, is_production: false, expires_at: Date.now() + 300_000 });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { html, id, element, invoke, actions, setResult: (value: typeof resultState) => { resultState = value; }, counts: () => ({ tokens, submissions }) };
}

test("secure input provides a static canonical Owner sign-in link and visible status before SDK initialization", async () => {
  const { html, id } = await secureInputPageFixture(undefined, "missing");
  const login = "https://accounts.lirtual.dpdns.org/sign-in?redirect_url=" +
    encodeURIComponent("https://rca.lirtual.dpdns.org/secure-input/" + id);
  assert.ok(html.includes('<a id="signin" href="' + login + '">'));
  assert.match(html, /<section id="signin-panel">/);
  assert.ok(html.indexOf('id="status"') < html.indexOf('id="details"'));
  assert.match(html, /<script[^>]+clerk-js@6\.46\.3[^>]+data-clerk-publishable-key="pk_live_/);
});

test("secure input leaves sign-in and failure status visible until Owner verification succeeds", async () => {
  for (const auth of ["signed-out", "missing", "load-failed", "rejected"] as const) {
    const { element, actions } = await secureInputPageFixture(undefined, auth);
    assert.equal(element("signin-panel").hidden, false, auth);
    assert.equal(element("details").hidden, true, auth);
    assert.match(element("status").textContent, /sign in|unavailable|failed|not authorized/i, auth);
    assert.deepEqual(actions, auth === "rejected" ? ["details"] : []);
  }
  const signedIn = await secureInputPageFixture();
  assert.equal(signedIn.element("signin-panel").hidden, true);
  assert.equal(signedIn.element("details").hidden, false);
  assert.deepEqual(signedIn.actions, ["details"]);
});

test("secure input page obtains a current Owner token per action and never re-enables uncertain submission", async () => {
  const { element, invoke, actions, counts } = await secureInputPageFixture();
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
  assert.equal(counts().submissions, 1);
  assert.equal(element("cancel").disabled, false);
  await invoke("cancel", "click");
  assert.equal(element("state").textContent, "cancelled");
  assert.equal(element("secure-form").hidden, true);
  assert.deepEqual(actions, ["details", "details", "submit", "details", "cancel"]);
  assert.equal(counts().tokens, actions.length);
});

test("secure input page shows the safe status classification and clears it after recovery", async () => {
  const { element, invoke, setResult } = await secureInputPageFixture();
  setResult({ state: "unknown", error_code: "timed_out" });
  await invoke("refresh", "click");
  assert.equal(element("error-code").textContent, "timed_out");
  assert.equal(element("submit").disabled, true);
  assert.match(element("status").textContent, /Do not submit again/);
  setResult({ state: "succeeded" });
  await invoke("refresh", "click");
  assert.equal(element("error-code").textContent, "—");
  assert.equal(element("submit").disabled, true);
});

test("secure input page distinguishes GitHub Variable and Secret recovery", async () => {
  for (const scope of ["repository", "environment"]) {
    const variable = await secureInputPageFixture({ kind: "github_" + scope + "_variable" });
    assert.match(variable.element("effect").textContent, /GitHub Variable/);
    assert.match(variable.element("recovery").textContent, /restoring the prior Variable value/);
    assert.doesNotMatch(variable.element("recovery").textContent, /cannot be read back/);
    const secret = await secureInputPageFixture({ kind: "github_" + scope + "_secret" });
    assert.match(secret.element("effect").textContent, /GitHub Secret/);
    assert.match(secret.element("recovery").textContent, /previous Secret value cannot be read back/);
  }
});
