import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/worker.ts";

const origin = "https://rca.lirtual.dpdns.org";
const issuer = "https://clerk.lirtual.dpdns.org";
const path = "/__spec1018_probe";
const owner = "user_fixture";
const portal = "portal-fixture";
function fixture() {
  let calls = 0;
  const env = {
    MCP_ACCESS_TOKEN: portal,
    CLERK_PUBLISHABLE_KEY: "pk_live_" + Buffer.from("clerk.lirtual.dpdns.org$").toString("base64"),
    CLERK_OWNER_USER_ID: owner,
    RCA_CLERK_PROBE_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + 600),
    DEVICE_COORDINATOR: {
      idFromName: () => "single-owner-v2",
      get: () => ({ fetch: async () => { calls++; throw new Error("probe must not access DeviceCoordinator"); } }),
    },
  } as unknown as Env;
  return {env, calls: () => calls};
}

test("Gate 0: no-effect probe is off by default, canonical-origin only, expires and cannot touch device state", async () => {
  const f = fixture();
  const get = (url: string, env = f.env) => worker.fetch(new Request(url), env);
  const page = await get(origin + path);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /No device will be paired/);
  assert.match(html, /accounts\.lirtual\.dpdns\.org/);
  assert.doesNotMatch(html, /user_fixture|portal-fixture/);
  assert.equal((await get("https://remote-control-mcp-worker.example.workers.dev" + path)).status, 404);
  for (const query of ["?utm_source=chatgpt.com", "?redirect=https://example.com"]) {
    const withQuery = await get(origin + path + query);
    assert.equal(withQuery.status, 200);
    const page = await withQuery.text();
    assert.doesNotMatch(page, /utm_source|example\.com/);
    assert.match(page, /location.hash\|\|location.search/);
    assert.match(page, /accounts\.lirtual\.dpdns\.org\/sign-in\?redirect_url=/);
  }
  assert.equal((await get(origin + path, {...f.env, RCA_CLERK_PROBE_EXPIRES_AT: undefined} as Env)).status, 404);
  assert.equal((await get(origin + path, {...f.env, RCA_CLERK_PROBE_EXPIRES_AT: "1"} as Env)).status, 404);
  assert.equal((await get(origin + path + "/check")).status, 405);
  const denied = await worker.fetch(new Request(origin + path + "/check", {
    method: "POST", headers: {origin, cookie:"__session=not-a-bearer"},
  }), f.env);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), {verified:false});
  assert.equal(f.calls(), 0);
});

test("Gate 0: probe verifies a bounded signed Owner session; denies alternate token profiles without dispatch", async t => {
  const f = fixture();
  const {publicKey, privateKey} = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = {...await exportJWK(publicKey), kid: "probe-fixture-key", alg:"RS256", use:"sig"};
  let keyRequests = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), issuer + "/.well-known/jwks.json");
    assert.equal(init?.redirect, "manual");
    keyRequests++;
    return Response.json({keys:[jwk]});
  });
  const now = Math.floor(Date.now() / 1000);
  const base = {iss: issuer, sub: owner, azp: origin, sid:"sess_fixture", v:2, jti:"jwt_fixture", iat:now, nbf:now-5, exp:now+60};
  async function mint(overrides: Record<string, unknown> = {}, key = privateKey, typ = "JWT") {
    return new SignJWT({...base,...overrides}).setProtectedHeader({alg:"RS256",typ,kid:jwk.kid}).sign(key);
  }
  const post = (token: string, requestOrigin: string | null = origin, url = origin + path + "/check") => {
    const headers = new Headers({authorization:"Bearer " + token});
    if (requestOrigin !== null) headers.set("origin", requestOrigin);
    return worker.fetch(new Request(url, {method:"POST",headers}), f.env);
  };
  const token = await mint();
  const good = await post(token);
  assert.equal(good.status, 200);
  const result = await good.json();
  assert.deepEqual(result, {verified:true,lifetime_seconds:60});
  assert.equal(good.headers.get("cache-control"), "no-store");
  assert.equal(keyRequests, 1);
  for (const overrides of [
    {sub:"user_other"},{azp:"https://other.example"},{azp:undefined},
    {sid:undefined,v:undefined},{v:1},{sts:"pending"},{act:{sub:"user_other"}},
    {aud:"client_other",scope:"openid",client_id:"client_other",exp:now+86400},
    {sub:"mch_fixture",sid:undefined},{exp:now+61},{iat:now+30},{iss:"https://other.example"},
    {exp:now-10},{jti:undefined},
  ]) assert.notEqual((await post(await mint(overrides))).status, 200);
  const signatureDenied = await post(await mint({},other.privateKey));
  assert.equal(signatureDenied.status, 401);
  assert.deepEqual(await signatureDenied.json(), {verified:false});
  const otherOwner = await post(await mint({sub:"user_other",v:1,azp:undefined}));
  assert.equal(otherOwner.status,403);
  assert.deepEqual(await otherOwner.json(), {verified:false});
  const diagnostic = await post(await mint({v:1,azp:undefined,jti:undefined,exp:now+61}));
  assert.equal(diagnostic.status,403);
  assert.deepEqual(await diagnostic.json(), {
    verified:false,checks:["azp_missing","session_version","token_id","freshness"],
  });
  const wrongOrigin = await post(await mint({azp:"https://other.example"}));
  assert.deepEqual(await wrongOrigin.json(), {verified:false,checks:["azp_mismatch"]});
  const crossOrigin = await post(token,"https://other.example");
  assert.equal(crossOrigin.status,403);
  assert.deepEqual(await crossOrigin.json(),{verified:false});
  const queryPost = await post(token,origin,origin+path+"/check?utm_source=chatgpt.com");
  assert.equal(queryPost.status,404);
  assert.deepEqual(await queryPost.json(),{verified:false});
  assert.notEqual((await post(await mint({},privateKey,"at+jwt"))).status,200);
  assert.notEqual((await post(token, null)).status,200);
  assert.notEqual((await post(token, "https://other.example")).status,200);
  assert.notEqual((await post(token,origin,"https://other.example"+path+"/check")).status,200);
  const mcp = await post(token, null, origin + "/mcp");
  assert.equal(mcp.status,401);
  assert.equal(f.calls(),0);
});
