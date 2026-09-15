import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/index.ts";
import type { Env } from "../../src/types.ts";

const ctx = {} as ExecutionContext;

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    MCP_ACCESS_TOKEN: "origin-secret",
    CLIENT_ID: "client-id",
    API_KEY: "api-key",
    R2_BUCKET: {} as R2Bucket,
    ...overrides,
  } as Env;
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("/health reports single-user liveness without OAuth mode", async () => {
  const response = await worker.fetch(new Request("https://worker.example/health"), baseEnv(), ctx);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "single-user");
  assert.equal("auth_mode" in body, false);
});

test("/ready succeeds with required single-user secrets and R2 binding", async () => {
  const response = await worker.fetch(new Request("https://worker.example/ready"), baseEnv(), ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ready: true });
});

test("/ready reports missing capabilities without secret values", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/ready"),
    baseEnv({ MCP_ACCESS_TOKEN: undefined, CLIENT_ID: undefined, API_KEY: undefined, R2_BUCKET: undefined }),
    ctx,
  );
  assert.equal(response.status, 503);
  const body = await json(response);
  assert.equal(body.ready, false);
  assert.deepEqual(body.missing, ["MCP_ACCESS_TOKEN", "CLIENT_ID", "API_KEY", "R2_BUCKET"]);
  assert.equal(JSON.stringify(body).includes("origin-secret"), false);
  assert.equal(JSON.stringify(body).includes("client-id"), false);
  assert.equal(JSON.stringify(body).includes("api-key"), false);
});

test("/mcp fails closed when MCP_ACCESS_TOKEN is not configured", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/mcp", { method: "POST" }),
    baseEnv({ MCP_ACCESS_TOKEN: undefined }),
    ctx,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await json(response), {
    error: "server_misconfigured",
    missing: ["MCP_ACCESS_TOKEN"],
  });
});

test("/mcp rejects missing or incorrect origin bearer", async () => {
  for (const authorization of [undefined, "Bearer wrong-token"]) {
    const headers = new Headers();
    if (authorization) headers.set("authorization", authorization);
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", { method: "POST", headers }),
      baseEnv(),
      ctx,
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
});

test("retired IMA secret names do not satisfy the runtime contract", async () => {
  const env = {
    MCP_ACCESS_TOKEN: "origin-secret",
    IMA_OPENAPI_CLIENTID: "legacy-client",
    IMA_OPENAPI_APIKEY: "legacy-key",
    R2_BUCKET: {} as R2Bucket,
  } as unknown as Env;
  const response = await worker.fetch(
    new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { authorization: "Bearer origin-secret" },
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await json(response), {
    error: "server_misconfigured",
    missing: ["CLIENT_ID", "API_KEY"],
  });
});

test("retired Worker-owned OAuth routes return normal not-found behavior", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/revoke",
    "/oauth/disconnect",
  ]) {
    const response = await worker.fetch(new Request(`https://worker.example${path}`), baseEnv(), ctx);
    assert.equal(response.status, 404, path);
  }
});
