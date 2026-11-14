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
  assert.match(response.headers.get("www-authenticate") ?? "", /scope="openid offline_access"/);
  const metadata = await gatewayFetch(new Request(origin + "/.well-known/oauth-protected-resource/mcp/sentry"), env);
  assert.equal(metadata.status, 200);
  const body = await metadata.json();
  assert.deepEqual(body.scopes_supported, ["openid", "offline_access"]);
  assert.equal(JSON.stringify(body).includes("public_metadata"), false);
  assert.equal(JSON.stringify(body).includes("private_metadata"), false);
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

test("tools/call checks the live Portal tool list before performing a side effect", async () => {
  const calls = [];
  const resp = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list", arguments: {} })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      const req = JSON.parse(init.body);
      calls.push(req.method);
      assert.equal(init.redirect, "manual");
      if (req.method === "tools/list") return toolList();
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    },
  });
  assert.equal(resp.status, 200);
  assert.deepEqual(calls, ["tools/list", "tools/call"]);
});

test("tools/call rejects a Portal-disabled or inaccessible tool before execution", async () => {
  let forwardedExecution = false;
  const resp = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_update", arguments: {} })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      if (JSON.parse(init.body).method === "tools/call") forwardedExecution = true;
      return toolList();
    },
  });
  assert.equal(resp.status, 403);
  assert.equal(forwardedExecution, false);
});

test("tools/call fails closed when live Portal tool discovery is unavailable", async () => {
  let executed = false;
  const resp = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      if (JSON.parse(init.body).method === "tools/call") executed = true;
      return new Response(null, { status: 302, headers: { location: "https://evil.example.test" } });
    },
  });
  assert.equal(resp.status, 502);
  assert.equal(executed, false);
});

test("tools/call follows live Portal tool pagination without a second tool catalog", async () => {
  const calls = [];
  const response = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      const req = JSON.parse(init.body);
      calls.push(req.method);
      if (req.method === "tools/call") return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [] } });
      if (!req.params?.cursor) return jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "raindrop_collection_list" }], nextCursor: "next" } });
      assert.equal(req.params.cursor, "next");
      return toolList();
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["tools/list", "tools/list", "tools/call"]);
});

test("tools/call checks the live Portal list when Portal uses SSE", async () => {
  let executed = false;
  const response = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      const req = JSON.parse(init.body);
      if (req.method === "tools/call") {
        executed = true;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [] } });
      }
      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "sentry_issue_list" }] } });
      return new Response(`event: message\ndata: ${data}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(executed, true);
});

test("tools/call fails closed on a cyclic Portal pagination cursor", async () => {
  let calls = 0;
  const response = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).method, "tools/list");
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [], nextCursor: "same" } });
    },
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 2);
});

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': {name:'ChatGPT',version:'1'},
};
const modernRequest = (server, method, params = {}, name) =>
  request(server,'POST',message(method,{...params,_meta:modernMeta}),{
    'Mcp-Protocol-Version':'2026-07-28','Mcp-Method':method,
    ...(name ? {'Mcp-Name':name}:{}),
  });
test('modern server/discover returns tools-only capabilities without Portal forwarding',async()=>{
  let sent=false;
  const response=await gatewayFetch(modernRequest('raindrop','server/discover'),env,{
    verifyOAuth:async()=>true,sendPortal:async()=>{sent=true;return toolList()}
  });
  assert.equal(response.status,200);
  assert.equal(sent,false);
  const json=await response.json();
  assert.deepEqual(json.result.supportedVersions,['2026-07-28']);
  assert.deepEqual(json.result.capabilities,{tools:{}});
  assert.equal(json.result.resultType,'complete');
  assert.equal(json.result.cacheScope,'private');
  assert.equal(json.result.ttlMs,0);
});
test('modern tools/list sends matching headers and retains required list result fields',async()=>{
  let forwarded=false;
  const response=await gatewayFetch(modernRequest('raindrop','tools/list'),env,{
    verifyOAuth:async()=>true,
    sendPortal:async(_,init)=>{
      forwarded=true;
      assert.equal(init.headers.get('Mcp-Protocol-Version'),'2026-07-28');
      assert.equal(init.headers.get('Mcp-Method'),'tools/list');
      assert.equal(init.headers.has('Mcp-Name'),false);
      const msg=JSON.parse(init.body);
      assert.equal(msg.params._meta['io.modelcontextprotocol/protocolVersion'],'2026-07-28');
      return jsonResponse({jsonrpc:'2.0',id:1,result:{resultType:'complete',
        tools:[{name:'raindrop_collection_list',inputSchema:{type:'object',properties:{}}},
          {name:'sentry_issue_list'},{name:'portal_toggle_single_server'}],
        ttlMs:300000,cacheScope:'public'}});
    },
  });
  assert.equal(response.status,200);
  assert.equal(forwarded,true);
  const parsed=await response.json();
  assert.deepEqual(parsed.result.tools.map(t=>t.name),['raindrop_collection_list']);
  assert.equal(parsed.result.resultType,'complete');
  assert.equal(parsed.result.ttlMs,0);
  assert.equal(parsed.result.cacheScope,'private');
});
test('modern tool call validates live catalog with correct per-request headers and metadata',async()=>{
  const calls=[];
  const name='raindrop_collection_list';
  const response=await gatewayFetch(modernRequest('raindrop','tools/call',{name,arguments:{}},name),env,{
    verifyOAuth:async()=>true,
    sendPortal:async(_,init)=>{
      const msg=JSON.parse(init.body);
      calls.push(msg.method);
      assert.equal(init.headers.get('Mcp-Protocol-Version'),'2026-07-28');
      assert.equal(init.headers.get('Mcp-Method'),msg.method);
      assert.equal(init.headers.get('Mcp-Name'),msg.method==='tools/call'?name:null);
      assert.equal(msg.params._meta['io.modelcontextprotocol/protocolVersion'],'2026-07-28');
      assert.deepEqual(msg.params._meta['io.modelcontextprotocol/clientCapabilities'],{});
      return msg.method==='tools/list'
        ? jsonResponse({jsonrpc:'2.0',id:1,result:{resultType:'complete',tools:[{name}]}})
        : jsonResponse({jsonrpc:'2.0',id:1,result:{resultType:'complete',content:[]}});
    }
  });
  assert.equal(response.status,200);
  assert.deepEqual(calls,['tools/list','tools/call']);
});
test('modern header/body mismatches fail closed before Portal requests',async()=>{
  let forwarded=false;
  const req=modernRequest('raindrop','tools/list');
  req.headers.delete('Mcp-Method');
  const response=await gatewayFetch(req,env,{verifyOAuth:async()=>true,sendPortal:async()=>{forwarded=true;return toolList()}});
  assert.equal(response.status,400);
  assert.equal(forwarded,false);
});

test('modern SSE tool-list response remains usable and scoped', async () => {
  const response = await gatewayFetch(modernRequest('raindrop','tools/list'),env,{
    verifyOAuth: async () => true,
    sendPortal: async () => {
      const result = JSON.stringify({jsonrpc:'2.0',id:1,result:{resultType:'complete',tools:[
        {name:'raindrop_collection_list'},{name:'sentry_issue_list'}],ttlMs:120000,cacheScope:'public'}});
      return new Response('event: message\ndata: '+result+'\n\n',
        {headers:{'content-type':'text/event-stream'}});
    },
  });
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')??'',/text\/event-stream/);
  const text=await response.text();
  const result=JSON.parse(text.slice(text.indexOf('data: ')+6).trim());
  assert.deepEqual(result.result.tools.map(t=>t.name),['raindrop_collection_list']);
  assert.equal(result.result.resultType,'complete');
  assert.equal(result.result.cacheScope,'private');
});
test('modern discovery rejects invalid OAuth before revealing capabilities',async()=>{
  let forwarded=false;
  const response=await gatewayFetch(modernRequest('raindrop','server/discover'),env,{
    verifyOAuth:async()=>false,sendPortal:async()=>{forwarded=true;return toolList();}
  });
  assert.equal(response.status,401);
  assert.equal(forwarded,false);
});
