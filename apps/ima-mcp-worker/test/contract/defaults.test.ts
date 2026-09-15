import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, DEFAULT_IMA_BASE_URL } from "../../src/ima.ts";
import { originAllowed } from "../../src/index.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";

const minimalEnv = {} as Env;

const creds: ImaCredentials = {
  clientId: "test_cid",
  apiKey: "test_key",
};

test("Zero-config defaults: DEFAULT_IMA_BASE_URL is https://ima.qq.com", async () => {
  assert.equal(DEFAULT_IMA_BASE_URL, "https://ima.qq.com");

  let requestedUrl = "";
  const { restore } = setupMockFetch((req) => {
    requestedUrl = req.url;
    return new Response(JSON.stringify({ code: 0, data: {} }));
  });

  try {
    const client = new ImaClient(minimalEnv, creds);
    await client.post("test_endpoint", {});
    assert.equal(requestedUrl, "https://ima.qq.com/test_endpoint");
  } finally {
    restore();
  }
});

test("Zero-config defaults: ImaClient respects explicit IMA_BASE_URL override if present", async () => {
  let requestedUrl = "";
  const { restore } = setupMockFetch((req) => {
    requestedUrl = req.url;
    return new Response(JSON.stringify({ code: 0, data: {} }));
  });

  try {
    const customEnv: Env = { ...minimalEnv, IMA_BASE_URL: "https://custom-proxy.example.com" };
    const client = new ImaClient(customEnv, creds);
    await client.post("test_endpoint", {});
    assert.equal(requestedUrl, "https://custom-proxy.example.com/test_endpoint");
  } finally {
    restore();
  }
});

test("Zero-config defaults: originAllowed is unrestricted by default", () => {
  const nativeReq = new Request("https://worker.dev/mcp", { method: "POST" });
  assert.equal(originAllowed(nativeReq, minimalEnv), true);

  const chatgptReq = new Request("https://worker.dev/mcp", {
    method: "POST",
    headers: { origin: "https://chatgpt.com" },
  });
  assert.equal(originAllowed(chatgptReq, minimalEnv), true);

  const claudeReq = new Request("https://worker.dev/mcp", {
    method: "POST",
    headers: { origin: "https://claude.ai" },
  });
  assert.equal(originAllowed(claudeReq, minimalEnv), true);

  const customReq = new Request("https://worker.dev/mcp", {
    method: "POST",
    headers: { origin: "https://my-domain.example.org" },
  });
  assert.equal(originAllowed(customReq, minimalEnv), true);

  const restrictedEnv: Env = {
    ...minimalEnv,
    MCP_ALLOWED_ORIGIN_HOSTNAMES: "chatgpt.com, mycompany.com",
  };
  assert.equal(originAllowed(chatgptReq, restrictedEnv), true);
  assert.equal(originAllowed(customReq, restrictedEnv), false);

  const wildcardEnv: Env = { ...minimalEnv, MCP_ALLOWED_ORIGIN_HOSTNAMES: "*" };
  assert.equal(originAllowed(customReq, wildcardEnv), true);
});
