import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayFetch } from "../src/worker.ts";

const origin = "https://gateway.example.test";
const portal = "https://portal.example.test/mcp";
const env = {
  CLERK_SECRET_KEY: "sk_test_example",
  CLERK_PUBLISHABLE_KEY: "pk_test_example",
  CLERK_OWNER_USER_ID: "user_Test123",
  CLERK_ISSUER: "https://issuer.example.test",
  GATEWAY_ORIGIN: origin,
  PORTAL_MCP_URL: portal,
  CF_ACCESS_CLIENT_ID: "gateway-machine-id",
  CF_ACCESS_CLIENT_SECRET: "gateway-machine-secret",
};
const message = (method, params = undefined) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
const request = (server, method = "POST", body = message("tools/list"), headers = {}) =>
  new Request(origin + "/mcp/" + server, {
    method,
    headers: { authorization: "Bearer test-oauth", ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers },
    ...(method === "POST" ? { body } : {}),
  });
const jsonResponse = (payload) => Response.json(payload, { headers: { "content-type": "application/json" } });
const toolList = () => jsonResponse({
  jsonrpc: "2.0", id: 1, result: { tools: [
    { name: "sentry_issue_list" },
    { name: "raindrop_collection_list" },
    { name: "portal_toggle_single_server" },
  ] },
});

test("unauthenticated MCP GET exposes a resource-specific 401 challenge for Clerk discovery", async () => {
  const response = await gatewayFetch(new Request(origin + "/mcp/sentry"), env);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp\/sentry/);
});

test("authenticated tool discovery projects the current server and strips caller credentials", async () => {
  let forwarded = 0;
  const response = await gatewayFetch(request("sentry"), env, {
    verifyOAuth: async (_, resource) => resource === origin + "/mcp/sentry",
    sendPortal: async (url, init) => {
      forwarded++;
      assert.equal(url, portal);
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.get("CF-Access-Client-Id"), "gateway-machine-id");
      assert.equal(init.headers.get("CF-Access-Client-Secret"), "gateway-machine-secret");
      assert.equal(init.headers.has("authorization"), false);
      assert.equal(init.headers.has("cookie"), false);
      return toolList();
    },
  });
  assert.equal(forwarded, 1);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.tools.map((t) => t.name), ["sentry_issue_list"]);
  assert.equal(response.headers.has("CF-Access-Client-Secret"), false);
});

test("direct cross-server and Portal management calls never reach the shared machine identity", async () => {
  for (const name of ["raindrop_collection_list", "portal_toggle_single_server", "portal_codemode_execute"]) {
    let forwarded = false;
    const response = await gatewayFetch(request("sentry", "POST", message("tools/call", { name })), env, {
      verifyOAuth: async () => true,
      sendPortal: async () => { forwarded = true; return jsonResponse({}); },
    });
    assert.equal(response.status, 403, name);
    assert.equal(forwarded, false, name);
  }
});

test("wrong Audience/Owner or invalid OAuth is rejected before Portal access", async () => {
  let forwarded = false;
  const response = await gatewayFetch(request("sentry"), env, {
    verifyOAuth: async () => false,
    sendPortal: async () => { forwarded = true; return toolList(); },
  });
  assert.equal(response.status, 401);
  assert.equal(forwarded, false);
});

test("Portal 3xx is rejected without following a machine credential redirect", async () => {
  const response = await gatewayFetch(request("sentry"), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://evil.example.test" } });
    },
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.has("location"), false);
});

test("invalid or unknown MCP methods fail closed before upstream requests", async () => {
  let forwarded = false;
  const response = await gatewayFetch(request("sentry", "POST", message("resources/read", { uri: "file://sentry" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async () => { forwarded = true; return toolList(); },
  });
  assert.equal(response.status, 403);
  assert.equal(forwarded, false);
});

test("missing runtime configuration blocks upstream calls", async () => {
  const response = await gatewayFetch(request("sentry"), { ...env, CF_ACCESS_CLIENT_SECRET: "" });
  assert.equal(response.status, 503);
});
