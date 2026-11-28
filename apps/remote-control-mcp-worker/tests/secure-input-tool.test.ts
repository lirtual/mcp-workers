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
async function secureInputPageFixture(
  target: Record<string, unknown> = { kind: "task_process", session_id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", name: "API_TOKEN" },
  auth: "signed-in" | "signed-out" | "missing" | "load-failed" | "rejected" = "signed-in",
  options: { production?: boolean; deviceName?: string; execution?: Record<string, unknown>; principal?: Record<string, unknown>; hiddenInputSupported?: boolean } = {},
) {
  target ??= { kind: "task_process", session_id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", name: "API_TOKEN" };
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
      hidden: id !== "signin-panel" && id !== "status", disabled: id !== "secret", checked: false, value: "", textContent: "",
      addEventListener(type, handler) { handlers.set(id + ":" + type, handler); },
    });
    return elements.get(id)!;
  };
  const event = { preventDefault() {} };
  const invoke = (id: string, type: string) => handlers.get(id + ":" + type)!(event);
  let tokens = 0, submissions = 0, cancelled = false;
  let resultState: { state: string; error_code?: string } | undefined;
  const actions: string[] = [];
  const bodies: unknown[] = [];
  const clerk = auth === "missing" ? undefined : {
    load: async () => { if (auth === "load-failed") throw Error("SDK initialization failure"); },
    isSignedIn: auth !== "signed-out",
    session: auth === "signed-out" ? null : { getToken: async () => "fixture-token-" + ++tokens },
  };
  const execution = options.execution ?? {
    device_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", grant_type: "permanent",
  };
  runInNewContext(source, {
    document: { getElementById: element }, location: { href: origin + "/secure-input/" + id + "?untrusted=1#fragment" },
    window: { Clerk: clerk },
    CSS: { supports: (property: string, value: string) =>
      property === "-webkit-text-security" && value === "disc" && options.hiddenInputSupported !== false },
    fetch: async (url: string, init: RequestInit) => {
      const action = url.split("/").at(-1)!;
      actions.push(action);
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-token-" + actions.length);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (body !== undefined) bodies.push(body);
      if (auth === "rejected") return Response.json({ error: "unauthorized" }, { status: 401 });
      if (action === "submit") {
        submissions++;
        throw new Error("synthetic lost response");
      }
      if (action === "cancel") {
        assert.equal(init.body, "{}");
        cancelled = true;
        return Response.json({ request_id: id, state: "cancelled" });
      }
      return Response.json({ ...(resultState ?? { state: cancelled ? "cancelled" : "pending" }), purpose: "Synthetic input",
        target, execution, is_production: options.production === true, expires_at: Date.now() + 300_000,
        ...(options.deviceName ? { device_name: options.deviceName } : {}),
        ...(options.principal ? { provider_principal: options.principal } : {}),
      });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { html, headers: page.headers, id, element, invoke, actions, bodies, setResult: (value: typeof resultState) => { resultState = value; }, counts: () => ({ tokens, submissions }) };
}

test("secure input provides a static canonical Owner sign-in link and visible status before SDK initialization", async () => {
  const { html, headers, id } = await secureInputPageFixture(undefined, "missing");
  const login = "https://accounts.lirtual.dpdns.org/sign-in?redirect_url=" +
    encodeURIComponent("https://rca.lirtual.dpdns.org/secure-input/" + id);
  assert.ok(html.includes('<a id="signin" href="' + login + '">'));
  assert.match(html, /<section id="signin-panel">/);
  assert.ok(html.indexOf('id="status"') < html.indexOf('id="details"'));
  assert.match(html, /<script[^>]+clerk-js@6\.46\.3[^>]+data-clerk-publishable-key="pk_live_/);
  assert.match(html, /<button id="submit" type="submit" disabled>Confirm &amp; submit<\/button>/);
  assert.match(html, /<button id="cancel" type="button">Cancel<\/button>/);
  assert.doesNotMatch(html, /target-confirmed/);
  assert.equal(headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.match(headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
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

test("secure input refuses web submission when the browser cannot mask the secret field", async () => {
  const marker = "synthetic-unsupported-browser-marker";
  const { element, invoke, actions, counts } = await secureInputPageFixture(undefined, "signed-in", {
    hiddenInputSupported: false,
  });
  assert.equal(element("secret").disabled, true);
  assert.equal(element("submit").disabled, true);
  assert.equal(element("cancel").disabled, false);
  assert.match(element("status").textContent, /cannot hide secure input/i);
  element("secret").value = marker;
  await invoke("secure-form", "submit");
  assert.equal(counts().submissions, 0);
  assert.deepEqual(actions, ["details"]);
});

test("secure input page obtains a current Owner token per action and never re-enables uncertain submission", async () => {
  const marker = "synthetic-marker";
  const { element, invoke, actions, bodies, counts } = await secureInputPageFixture(undefined, "signed-in", { deviceName: "RAY-WORKSPACE" });
  assert.equal(element("submit").disabled, false);
  assert.equal(element("execution").textContent, "RAY-WORKSPACE");
  assert.match(element("exact-target").textContent, /Device ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
  assert.match(element("exact-target").textContent, /Process session: bbbbbbbb-cccc-dddd-eeee-ffffffffffff/);
  assert.match(element("exact-target").textContent, /Input name: API_TOKEN/);
  assert.equal(element("production-authorization").hidden, true);
  assert.equal(element("target").textContent, "Process input · API_TOKEN");
  await invoke("refresh", "click");
  element("secret").value = marker;
  await invoke("secure-form", "submit");
  assert.equal(element("secret").value, "");
  assert.doesNotMatch(element("status").textContent, new RegExp(marker));
  assert.match(element("status").textContent, /unknown/);
  assert.deepEqual(bodies.at(-1), { secret: marker, target_confirmed: true, production_authorized: false });
  await invoke("refresh", "click");
  assert.equal(element("submit").disabled, true);
  await invoke("secure-form", "submit");
  assert.equal(counts().submissions, 1);
  assert.equal(element("cancel").disabled, false);
  await invoke("cancel", "click");
  assert.match(element("status").textContent, /can no longer accept input/);
  assert.equal(element("secure-form").hidden, true);
  assert.equal(element("refresh").hidden, true);
  assert.deepEqual(actions, ["details", "details", "submit", "details", "cancel"]);
  assert.equal(counts().tokens, actions.length);
});

test("secure input page keeps production authorization independent of target confirmation", async () => {
  const marker = "synthetic-production-marker";
  const { element, invoke, bodies, counts } = await secureInputPageFixture(undefined, "signed-in", { production: true });
  assert.equal(element("scope").textContent, "Production");
  assert.equal(element("production-authorization").hidden, false);
  element("secret").value = marker;
  await invoke("secure-form", "submit");
  assert.equal(counts().submissions, 0);
  assert.match(element("status").textContent, /Authorize the production operation/);
  assert.equal(element("secret").value, marker);
  element("production-authorized").checked = true;
  await invoke("secure-form", "submit");
  assert.equal(counts().submissions, 1);
  assert.equal(element("secret").value, "");
  assert.doesNotMatch(element("status").textContent, new RegExp(marker));
  assert.deepEqual(bodies.at(-1), { secret: marker, target_confirmed: true, production_authorized: true });
});

test("secure input page shows the safe status classification and clears it after recovery", async () => {
  const { element, invoke, setResult } = await secureInputPageFixture();
  setResult({ state: "unknown", error_code: "timed_out" });
  await invoke("refresh", "click");
  assert.equal(element("error-code").textContent, "timed_out");
  assert.equal(element("error-code").hidden, false);
  assert.equal(element("submit").disabled, true);
  assert.equal(element("secure-form").hidden, true);
  assert.match(element("status").textContent, /Do not submit again/);
  setResult({ state: "succeeded" });
  await invoke("refresh", "click");
  assert.equal(element("error-code").textContent, "");
  assert.equal(element("error-code").hidden, true);
  assert.equal(element("submit").disabled, true);
  assert.match(element("status").textContent, /confirmed completion/);
});

test("secure input page distinguishes GitHub Variable and Secret recovery", async () => {
  for (const scope of ["repository", "environment"] as const) {
    const target = scope === "repository"
      ? { repository: "lirtual/mcp-workers", name: "DEPLOY_TOKEN" }
      : { repository: "lirtual/mcp-workers", environment: "preview", name: "DEPLOY_TOKEN" };
    const variable = await secureInputPageFixture({ kind: "github_" + scope + "_variable", ...target });
    assert.match(variable.element("target").textContent, new RegExp("GitHub " + scope + " Variable · lirtual/mcp-workers"));
    assert.match(variable.element("target").textContent, /DEPLOY_TOKEN/);
    assert.match(variable.element("effect").textContent, /Restore its prior value or remove it/);
    assert.doesNotMatch(variable.element("effect").textContent, /cannot be read back/);
    assert.match(variable.element("exact-target").textContent, /Repository: lirtual\/mcp-workers/);
    if (scope === "environment") assert.match(variable.element("exact-target").textContent, /Environment: preview/);
    else assert.doesNotMatch(variable.element("exact-target").textContent, /Environment:/);
    const secret = await secureInputPageFixture({ kind: "github_" + scope + "_secret", ...target });
    assert.match(secret.element("target").textContent, new RegExp("GitHub " + scope + " Secret · lirtual/mcp-workers"));
    assert.match(secret.element("effect").textContent, /cannot be read back/);
    assert.match(secret.element("exact-target").textContent, /Name: DEPLOY_TOKEN/);
  }
});

test("secure input page distinguishes Cloudflare deploy and inactive version", async () => {
  const account = "a".repeat(32);
  const base = { kind: "cloudflare_worker_secret", account_id: account, worker_name: "remote-control-mcp-worker", environment: "production", name: "API_TOKEN" };
  const deploy = await secureInputPageFixture(
    { ...base, mode: "deploy" }, "signed-in",
    { principal: { provider: "cloudflare", identity: "ray@example.com", account_id: account, account_name: "lirtual" } },
  );
  assert.equal(deploy.element("target").textContent, "Cloudflare Secret · remote-control-mcp-worker · production · API_TOKEN · deploy now");
  assert.match(deploy.element("effect").textContent, /deploy immediately/);
  assert.match(deploy.element("exact-target").textContent, new RegExp("Cloudflare account ID: " + account));
  assert.match(deploy.element("exact-target").textContent, /Cloudflare mode: deploy/);
  assert.equal(deploy.element("principal").textContent, "ray@example.com · lirtual");
  assert.equal(deploy.element("principal-row").hidden, false);
  const version = await secureInputPageFixture({ ...base, mode: "version" });
  assert.match(version.element("target").textContent, /inactive version/);
  assert.doesNotMatch(version.element("target").textContent, /deploy now/);
  assert.match(version.element("effect").textContent, /Deployment requires a separate action/);
  assert.doesNotMatch(version.element("effect").textContent, /deploy immediately/);
  assert.match(version.element("exact-target").textContent, /Cloudflare mode: version/);
  const unsupported = await secureInputPageFixture({ ...base, mode: "surprise" });
  assert.match(unsupported.element("target").textContent, /unsupported mode/);
  assert.equal(unsupported.element("effect").textContent, "Unsupported target.");
});

test("secure input page shows the hosted session identity separately from the device name", async () => {
  const attempt = "cccccccc-dddd-eeee-ffff-000000000001";
  const { element } = await secureInputPageFixture(undefined, "signed-in", {
    deviceName: "session-ubuntu",
    execution: {
      device_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", grant_type: "session",
      session_workflow_name: "ubuntu", session_run_id: 123, session_run_attempt: 2,
      session_attempt_id: attempt,
    },
  });
  assert.equal(element("execution").textContent, "session-ubuntu · ubuntu · Run 123 · Attempt 2");
  assert.match(element("exact-target").textContent, /Workflow: ubuntu/);
  assert.match(element("exact-target").textContent, /Run: 123/);
  assert.match(element("exact-target").textContent, /Run attempt: 2/);
  assert.match(element("exact-target").textContent, new RegExp("Workflow attempt ID: " + attempt));
  assert.match(element("exact-target").textContent, /Grant: session/);
  assert.match(element("scope").textContent, /Marked non-production by requester/);
});
