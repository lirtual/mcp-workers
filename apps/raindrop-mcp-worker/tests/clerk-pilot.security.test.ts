import { beforeEach, describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const sdk = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createClerkClient: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: (...args: unknown[]) => {
    sdk.createClerkClient(...args);
    return { authenticateRequest: sdk.authenticateRequest };
  },
}));

import worker from "../src/worker.js";
import { authenticateClerkPilot } from "../src/clerk-pilot-auth.js";

const origin = "https://raindrop.example.test";
const resource = origin + "/clerk/mcp";
const issuer = "https://clerk.example.test";
const portalSecret = "synthetic-portal-secret";
const env = {
  MCP_ACCESS_TOKEN: portalSecret,
  RAINDROP_ACCESS_TOKEN: "synthetic-raindrop-secret",
  CLERK_SECRET_KEY: "synthetic-clerk-secret",
  CLERK_PILOT_PUBLISHABLE_KEY: "synthetic-public-dev-key",
  CLERK_PILOT_OWNER_USER_ID: "user_owner",
  CLERK_PILOT_ISSUER: issuer,
  CLERK_PILOT_RESOURCE: resource,
};

const request = (
  path: string,
  bearer?: string,
  method = "POST",
  body?: object,
  additionalHeaders: Record<string, string> = {},
) =>
  new Request(origin + path, {
    method,
    headers: {
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...additionalHeaders,
    },
    ...(method === "POST"
      ? {
          body: JSON.stringify(
            body ?? {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
              params: {},
            },
          ),
        }
      : {}),
  });

function clerkState(token: string) {
  const scopes = token === "no-scope" ? [] : ["raindrop:read"];
  const owner = token === "wrong-owner" ? "user_unapproved" : "user_owner";
  return {
    isAuthenticated: token !== "invalid" && token !== portalSecret,
    tokenType: token === "wrong-type" ? "session_token" : "oauth_token",
    token: token.startsWith("eyJ") ? token : "opaque-synthetic",
    toAuth: () => ({ userId: owner, scopes }),
  };
}

beforeEach(() => {
  sdk.authenticateRequest.mockReset();
  sdk.createClerkClient.mockReset();
  sdk.authenticateRequest.mockImplementation(async (req: Request) => {
    const token =
      req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (token === "provider-down") throw new Error("synthetic upstream outage");
    return clerkState(token);
  });
});

describe("opt-in Clerk Raindrop pilot", () => {
  it("keeps unconfigured ingress closed without a dependency on Portal", async () => {
    const fullyDisabled = await worker.fetch(request("/clerk/mcp", "valid"), {
      MCP_ACCESS_TOKEN: portalSecret,
      RAINDROP_ACCESS_TOKEN: "synthetic-raindrop-secret",
    } as never);
    expect(fullyDisabled.status).toBe(404);
    const unavailable = { ...env, CLERK_PILOT_OWNER_USER_ID: "" };
    expect(
      (await worker.fetch(request("/clerk/mcp", "valid"), unavailable)).status,
    ).toBe(503);
    expect(sdk.authenticateRequest).not.toHaveBeenCalled();
    const existing = await worker.fetch(request("/mcp"), unavailable);
    expect(existing.status).toBe(401);
    const portal = await worker.fetch(
      request("/mcp", portalSecret, "POST", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "pilot", version: "1" },
        },
      }),
      unavailable,
    );
    expect(portal.status).toBe(200);
  });

  it("serves Resource Metadata for only the exact pinned resource", async () => {
    const r = await worker.fetch(
      request(
        "/.well-known/oauth-protected-resource/clerk/mcp",
        undefined,
        "GET",
      ),
      env,
    );
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toEqual({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["raindrop:read"],
      bearer_methods_supported: ["header"],
    });
    const absent = await worker.fetch(
      request(
        "/.well-known/oauth-protected-resource/clerk/mcp",
        undefined,
        "GET",
      ),
      { ...env, CLERK_SECRET_KEY: "" },
    );
    expect(absent.status).toBe(404);
  });

  it("rejects missing, wrong, or Portal credentials, without calling Raindrop", async () => {
    const missing = await worker.fetch(request("/clerk/mcp"), env);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("raindrop:read");
    for (const bearer of [
      "invalid",
      portalSecret,
      "wrong-type",
      "wrong-owner",
    ]) {
      const res = await worker.fetch(request("/clerk/mcp", bearer), env);
      expect(res.status).toBe(401);
    }
    expect(sdk.createClerkClient).toHaveBeenCalled();
  });

  it("rejects missing scope and OAuth verification outage", async () => {
    expect(
      (await worker.fetch(request("/clerk/mcp", "no-scope"), env)).status,
    ).toBe(403);
    expect(
      (await worker.fetch(request("/clerk/mcp", "provider-down"), env)).status,
    ).toBe(401);
  });

  it("rejects wrong audience, query, unsafe origins and arbitrary path", async () => {
    expect(
      (
        await worker.fetch(request("/clerk/mcp", "valid"), {
          ...env,
          CLERK_PILOT_RESOURCE: "https://other.example.test/clerk/mcp",
        })
      ).status,
    ).toBe(503);
    expect(
      (await worker.fetch(request("/clerk/mcp?target=other", "valid"), env))
        .status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          request("/clerk/mcp", "valid", "POST", undefined, {
            Origin: "https://attacker.example",
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect((await worker.fetch(request("/other", "valid"), env)).status).toBe(
      404,
    );
  });

  it("rejects signed-looking token from the wrong issuer, even if SDK accepts it", async () => {
    const jwt = [
      Buffer.from('{"typ":"at+jwt"}').toString("base64url"),
      Buffer.from('{"iss":"https://evil.example.test"}').toString("base64url"),
      "signature",
    ].join(".");
    expect((await worker.fetch(request("/clerk/mcp", jwt), env)).status).toBe(
      401,
    );
  });

  it("pins SDK token type and Audience and strips Authorization before MCP dispatch", async () => {
    const auth = await authenticateClerkPilot(
      request("/clerk/mcp", "valid"),
      env,
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.request.headers.get("authorization")).toBeNull();
    expect(sdk.authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      acceptsToken: "oauth_token",
      audience: resource,
    });
  });

  it("exposes exactly collection_list and no write tools or MCP resources", async () => {
    const handler = new RaindropMCPService(
      { accessToken: "synthetic" },
      { readonlyCollectionPilot: true },
    );
    const tools = await handler.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["collection_list"]);
    expect(
      ((await handler.getManifest()) as { resources: unknown[] }).resources,
    ).toEqual([]);
    await expect(handler.callTool("collection_create", {})).rejects.toThrow(
      "not found",
    );
    await expect(handler.readResource("mcp://raindrop/1")).rejects.toThrow(
      "not exposed",
    );
    const r = await worker.fetch(request("/clerk/mcp", "valid"), env);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("collection_list");
    expect(body).not.toContain("collection_create");
    expect(body).not.toContain("bookmark_delete");
    expect(body).not.toContain("highlight_create");
  });

  it("never dispatches a write tool from the actual MCP ingress", async () => {
    const outbound = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no upstream call may be attempted"));
    try {
      const result = await worker.fetch(
        request("/clerk/mcp", "valid", "POST", {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "collection_create", arguments: { title: "NEVER" } },
        }),
        env,
      );
      expect(result.status).toBe(200);
      // The MCP SDK may return either JSON or SSE for a JSON-RPC error.
      const raw = await result.text();
      const data = raw.startsWith("event:")
        ? raw
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
        : raw;
      const payload = JSON.parse(data ?? "") as {
        error?: { code: number };
        result?: unknown;
      };
      expect(payload.error).toBeDefined();
      expect(payload.result).toBeUndefined();
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      outbound.mockRestore();
    }
  });

  it("rejects unsupported methods after valid authentication", async () => {
    const r = await worker.fetch(request("/clerk/mcp", "valid", "GET"), env);
    expect(r.status).toBe(405);
  });
});
