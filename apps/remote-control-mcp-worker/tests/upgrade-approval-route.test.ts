import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.ts";

const URL = "https://rca.lirtual.dpdns.org/upgrade-approve/op-123/" + "a".repeat(64);
function fixture() {
  let forwarded = 0;
  const stub = { fetch: async () => {
    forwarded++;
    throw Error("An unverified Access request must never reach the owner DO.");
  } };
  const env = {
    MCP_ACCESS_TOKEN: "configured-portal-bearer",
    DEVICE_COORDINATOR: {
      idFromName: () => "single-owner-v2",
      get: () => stub,
    },
  } as unknown as Env;
  return { env, count: () => forwarded };
}
test("upgrade confirmation URLs fail closed when a separate Access app isn't configured", async () => {
  const f = fixture();
  for (const method of ["GET", "POST"] as const) {
    const response = await worker.fetch(new Request(URL, {
      method, headers: { origin: "https://rca.lirtual.dpdns.org" },
    }), f.env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(f.count(), 0, "neither GET nor POST can bypass Access");
});
test("forged owner JWT, arbitrary target and wrong route cannot approve", async () => {
  const f = fixture();
  const env = Object.assign(f.env as Record<string,unknown>, {
    REMOTE_CONTROL_UPGRADE_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    REMOTE_CONTROL_UPGRADE_ACCESS_AUD: "1".repeat(64),
    REMOTE_CONTROL_UPGRADE_OWNER_EMAIL: "owner@example.test",
  }) as Env;
  const badPaths = [
    "https://evil.example/upgrade-approve/op-123/" + "a".repeat(64),
    "https://rca.lirtual.dpdns.org/upgrade-approve/op-123/" + "a".repeat(64) + "?extra=true",
    "https://rca.lirtual.dpdns.org/upgrade-approve/op-123/../../../",
    "https://rca.lirtual.dpdns.org/upgrade-approve/op-123/invalid",
  ];
  for (const url of badPaths) {
    const response = await worker.fetch(new Request(url, {
      headers: { "cf-access-jwt-assertion": "forged.jwt.signature" },
    }), env);
    assert.ok([403,404].includes(response.status), "unverified origin/path refused");
  }
  const response = await worker.fetch(new Request(URL, {
    headers: { "cf-access-jwt-assertion": "forged.jwt.signature" },
  }), env);
  assert.equal(response.status, 403);
  assert.equal(f.count(), 0);
});
