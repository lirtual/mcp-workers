import { describe, expect, it } from "vitest";
import { handleRequest, type Env } from "../src/index.js";

const ctx = {} as ExecutionContext;

const validConfig = JSON.stringify({
  default_account: "qq",
  accounts: {
    qq: {
      provider: "qq",
      address: "user@qq.com",
      auth: { type: "password", password: "secret-auth-code" },
    },
  },
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    MCP_ACCESS_TOKEN: "portal-secret",
    EMAIL_ACCOUNTS_CONFIG: validConfig,
    EMAIL_ALLOW_MODIFY: "false",
    EMAIL_ALLOW_SEND: "false",
    ...overrides,
  };
}

describe("Email MCP HTTP entrypoint", () => {
  it("exposes shallow public health without configuration details", async () => {
    const response = await handleRequest(
      new Request("https://email.example/health"),
      env({ EMAIL_ACCOUNTS_CONFIG: "" }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "email-mcp-worker",
    });
  });

  it("fails closed when Portal authentication is not configured", async () => {
    const response = await handleRequest(
      new Request("https://email.example/mcp"),
      env({ MCP_ACCESS_TOKEN: "" }),
      ctx,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "portal_auth_not_configured" });
  });

  it("rejects bad bearer credentials and browser origins", async () => {
    const unauthorized = await handleRequest(
      new Request("https://email.example/mcp", {
        headers: { Authorization: "Bearer wrong" },
      }),
      env(),
      ctx,
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const forbidden = await handleRequest(
      new Request("https://email.example/mcp", {
        headers: {
          Authorization: "Bearer portal-secret",
          Origin: "https://browser.example",
        },
      }),
      env(),
      ctx,
    );
    expect(forbidden.status).toBe(403);
  });

  it("distinguishes missing and invalid account configuration", async () => {
    const missing = await handleRequest(
      new Request("https://email.example/mcp", {
        headers: { Authorization: "Bearer portal-secret" },
      }),
      env({ EMAIL_ACCOUNTS_CONFIG: "" }),
      ctx,
    );
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: "email_config_not_configured" });

    const invalid = await handleRequest(
      new Request("https://email.example/mcp", {
        headers: { Authorization: "Bearer portal-secret" },
      }),
      env({ EMAIL_ACCOUNTS_CONFIG: "{\"default_account\":\"missing\",\"accounts\":{}}" }),
      ctx,
    );
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toMatchObject({ error: "email_config_invalid" });
  });

  it("returns 404 for unknown routes", async () => {
    const response = await handleRequest(
      new Request("https://email.example/other"),
      env(),
      ctx,
    );
    expect(response.status).toBe(404);
  });
});
