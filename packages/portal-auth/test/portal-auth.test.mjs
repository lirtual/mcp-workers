import assert from "node:assert/strict";
import test from "node:test";
import { authenticatePortalRequest } from "../src/index.ts";

function request(headers = {}, body = undefined) {
  return new Request("https://worker.example/mcp", {
    method: body === undefined ? "GET" : "POST",
    headers,
    body,
  });
}

test("fails closed when the expected token is missing", async () => {
  const result = await authenticatePortalRequest(request(), {});
  assert.deepEqual(result, { ok: false, reason: "misconfigured" });
});

test("rejects missing and incorrect bearer credentials", async () => {
  const missing = await authenticatePortalRequest(request(), {
    expectedToken: "expected",
  });
  assert.deepEqual(missing, { ok: false, reason: "unauthorized" });

  const wrong = await authenticatePortalRequest(
    request({ Authorization: "Bearer wrong" }),
    { expectedToken: "expected" },
  );
  assert.deepEqual(wrong, { ok: false, reason: "unauthorized" });
});

test("allows server-to-server requests without Origin", async () => {
  const result = await authenticatePortalRequest(
    request({ Authorization: "Bearer expected" }),
    { expectedToken: "expected", allowedOrigins: [] },
  );
  assert.equal(result.ok, true);
});

test("rejects an Origin not present in the explicit allowlist", async () => {
  const result = await authenticatePortalRequest(
    request({
      Authorization: "Bearer expected",
      Origin: "https://untrusted.example",
    }),
    {
      expectedToken: "expected",
      allowedOrigins: ["https://trusted.example"],
    },
  );
  assert.deepEqual(result, { ok: false, reason: "invalid_origin" });
});

test("accepts a normalized explicitly allowed Origin", async () => {
  const result = await authenticatePortalRequest(
    request({
      Authorization: "Bearer expected",
      Origin: "https://trusted.example",
    }),
    {
      expectedToken: "expected",
      allowedOrigins: ["https://trusted.example/ignored/path"],
    },
  );
  assert.equal(result.ok, true);
});

test("strips Authorization while preserving protocol headers and request body", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const result = await authenticatePortalRequest(
    request(
      {
        Authorization: "Bearer expected",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        "MCP-Session-Id": "session-test",
      },
      body,
    ),
    { expectedToken: "expected" },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.request.headers.has("authorization"), false);
  assert.equal(result.request.headers.get("content-type"), "application/json");
  assert.equal(result.request.headers.get("mcp-protocol-version"), "2025-11-25");
  assert.equal(result.request.headers.get("mcp-session-id"), "session-test");
  assert.equal(await result.request.text(), body);
});
