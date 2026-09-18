import { describe, expect, it } from "vitest";
import { handleRequest, type Env } from "../src/index.js";

const ctx = {} as ExecutionContext;

const env: Env = {
  MCP_ACCESS_TOKEN: "portal-secret",
  EMAIL_ACCOUNTS_CONFIG: JSON.stringify({
    default_account: "qq",
    accounts: {
      qq: {
        provider: "qq",
        address: "user@qq.com",
        auth: { type: "password", password: "test-only-secret" },
      },
    },
  }),
  EMAIL_ALLOW_MODIFY: "false",
  EMAIL_ALLOW_SEND: "false",
};

function parseMcpPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
  if (dataLines.length === 0) {
    throw new Error("No JSON-RPC payload found in MCP response");
  }
  return JSON.parse(dataLines[dataLines.length - 1]);
}

describe("Email MCP v0.1 public contract", () => {
  it("discovers exactly the seven provider-neutral v0.1 tools", async () => {
    const response = await handleRequest(
      new Request("https://email.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer portal-secret",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    const payload = parseMcpPayload(await response.text()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(payload.result?.tools?.map((tool) => tool.name).sort()).toEqual([
      "email_accounts",
      "email_folders",
      "email_get",
      "email_modify",
      "email_respond",
      "email_search",
      "email_send",
    ]);
  });

  it("keeps the health seam shallow", async () => {
    const response = await handleRequest(
      new Request("https://email.example/health"),
      { ...env, EMAIL_ACCOUNTS_CONFIG: "" },
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "email-mcp-worker",
    });
  });
});
