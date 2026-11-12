/** Real local workerd/Miniflare integration. Does NOT talk to Clerk/ChatGPT/production. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createSign } from "node:crypto";

const entry = process.env.SPEC853_MINIFLARE_ENTRY;
const issuer = "https://clerk.example.invalid";
const url = "https://sentry.example.invalid/mcp";
const other = "https://workflow.example.invalid/mcp";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "probe-key", use: "sig", alg: "RS256" };
const now = Math.floor(Date.now() / 1000);
const claims = { iss: issuer, sub: "owner123", aud: url, scope: "sentry:read", iat: now - 5, exp: now + 3600 };
const b64 = input => Buffer.from(JSON.stringify(input)).toString("base64url");
function signJwt(extra = {}) {
  const input = b64({ alg: "RS256", kid: "probe-key" }) + "." + b64({ ...claims, ...extra });
  const signature = createSign("RSA-SHA256").update(input).end().sign(privateKey).toString("base64url");
  return input + "." + signature;
}
function toolRequest(resource, value, tool = "sentry_find_organizations") {
  return new Request(resource, { method: "POST", headers: value ? { authorization: "Bearer " + value } : {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool } }) });
}
const source = await readFile(fileURLToPath(new URL("./probe.mjs", import.meta.url)), "utf8");
const worker = `
import {createSyntheticMcpProbe,verifySyntheticJwt} from "./probe.mjs";
const issuer = ${JSON.stringify(issuer)};
const jwks = ${JSON.stringify({keys:[publicJwk]})};
const resources=[
 {id:"sentry",url:${JSON.stringify(url)},scope:"sentry:read",ownerSub:"owner123",allowedTools:["sentry_find_organizations"]},
 {id:"workflow",url:${JSON.stringify(other)},scope:"workflow:read",ownerSub:"owner123",allowedTools:["workflow_get"]}
];
const app=createSyntheticMcpProbe({issuer,resources,
 verify:token=>verifySyntheticJwt(token,{issuer,jwks}),
 dispatch:async({principal,resourceId,toolName})=>({content:[{type:"text",text:resourceId+":"+toolName+":"+principal}]})
});
export default { fetch: request => app.fetch(request) };
`;

test("Cloudflare workerd native Web APIs: synthetic OAuth resource isolation (actual local runtime)", { skip: !entry && "Set SPEC853_MINIFLARE_ENTRY to an installed Miniflare module" }, async () => {
  const { Miniflare } = await import(entry);
  const mf = new Miniflare({
    workers: [{
      config: {
        name: "spec853-poc",
        compatibilityDate: "2026-10-19",
        manifest: {
          mainModule: "worker.mjs",
          modulesRoot: "/",
          modules: {
            "worker.mjs": { type: "esm", contents: worker },
            "probe.mjs": { type: "esm", contents: source },
          },
        },
      },
    }],
  });
  const send = async (req) => mf.dispatchFetch(req.url, {
    method: req.method, headers: Object.fromEntries(req.headers), body: await req.text(),
  });
  try {
    const meta = await mf.dispatchFetch("https://sentry.example.invalid/.well-known/oauth-protected-resource/mcp");
    assert.equal(meta.status, 200);
    assert.equal((await meta.json()).resource, url);
    const anon = await mf.dispatchFetch(url, { method: "POST", body: "{}" });
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get("www-authenticate"), /oauth-protected-resource/);
    const valid = await send(toolRequest(url, signJwt()));
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).result.content[0].text, "sentry:sentry_find_organizations:owner123");
    const badAudience = await send(toolRequest(other, signJwt(), "workflow_get"));
    assert.equal(badAudience.status, 403);
    const badScope = await send(toolRequest(url, signJwt({ scope: "workflow:read" })));
    assert.equal(badScope.status, 403);
    const badOwner = await send(toolRequest(url, signJwt({ sub: "attacker" })));
    assert.equal(badOwner.status, 403);
    const badIssuer = await send(toolRequest(url, signJwt({iss:"https://evil.example.invalid"})));
    assert.equal(badIssuer.status, 401);
    const badSignature = await send(toolRequest(url, signJwt().slice(0,-3)+"xyz"));
    assert.equal(badSignature.status, 401);
    const oldStatic = await send(toolRequest(url, "MCP_ACCESS_TOKEN_EXAMPLE"));
    assert.equal(oldStatic.status, 401);
  } finally {
    await mf.dispose();
  }
});
