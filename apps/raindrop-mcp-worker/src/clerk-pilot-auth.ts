import { createClerkClient } from "@clerk/backend";

// This alternate MCP resource is opt-in and independent of Portal /mcp.
// It has no route to Raindrop write tools.
export const CLERK_PILOT_PATH = "/clerk/mcp";
export const CLERK_PILOT_PRM_PATH =
  "/.well-known/oauth-protected-resource/clerk/mcp";
const SCOPE = "raindrop:read";

export interface ClerkPilotBindings {
  CLERK_SECRET_KEY?: string;
  CLERK_PILOT_PUBLISHABLE_KEY?: string;
  CLERK_PILOT_OWNER_USER_ID?: string;
  CLERK_PILOT_ISSUER?: string;
  CLERK_PILOT_RESOURCE?: string;
}

type Config = {
  secretKey: string;
  publishableKey: string;
  owner: string;
  issuer: string;
  resource: string;
  metadataUrl: string;
};

function configFor(request: Request, env: ClerkPilotBindings): Config | null {
  const {
    CLERK_SECRET_KEY: secretKey,
    CLERK_PILOT_PUBLISHABLE_KEY: publishableKey,
    CLERK_PILOT_OWNER_USER_ID: owner,
    CLERK_PILOT_ISSUER: issuer,
    CLERK_PILOT_RESOURCE: resource,
  } = env;
  if (
    !secretKey ||
    !publishableKey ||
    !owner ||
    !issuer ||
    !resource ||
    !/^user_[a-zA-Z0-9]+$/.test(owner)
  )
    return null;
  try {
    const target = new URL(resource);
    const issuerUrl = new URL(issuer);
    const incoming = new URL(request.url);
    if (
      target.protocol !== "https:" ||
      target.pathname !== CLERK_PILOT_PATH ||
      target.search ||
      target.hash ||
      target.origin !== incoming.origin ||
      issuerUrl.protocol !== "https:" ||
      issuerUrl.pathname !== "/" ||
      issuerUrl.search ||
      issuerUrl.hash ||
      issuerUrl.origin !== issuer
    )
      return null;
    return {
      secretKey,
      publishableKey,
      owner,
      issuer,
      resource,
      metadataUrl: new URL(CLERK_PILOT_PRM_PATH, resource).href,
    };
  } catch {
    return null;
  }
}

function problem(status: number, error: string, challenge?: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(challenge ? { "www-authenticate": challenge } : {}),
      },
    },
  );
}

function issuerMatches(token: unknown, issuer: string): boolean {
  // Opaque tokens are verified online by this Clerk instance's SDK.
  if (typeof token !== "string" || !token.includes(".")) return true;
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1] || segments[1].length > 8192)
    return false;
  try {
    const payload = JSON.parse(
      atob(segments[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return payload?.iss === issuer;
  } catch {
    return false;
  }
}

export function clerkPilotMetadata(
  request: Request,
  env: ClerkPilotBindings,
): Response {
  const config = configFor(request, env);
  if (!config) return problem(404, "not_found");
  return Response.json(
    {
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export type ClerkPilotAuthResult =
  { ok: true; request: Request } | { ok: false; response: Response };

export async function authenticateClerkPilot(
  request: Request,
  env: ClerkPilotBindings,
): Promise<ClerkPilotAuthResult> {
  const config = configFor(request, env);
  if (!config)
    return { ok: false, response: problem(503, "clerk_pilot_not_configured") };
  const challenge = `Bearer resource_metadata="${config.metadataUrl}", scope="${SCOPE}"`;
  if (request.url !== config.resource)
    return { ok: false, response: problem(404, "not_found") };
  // The original Portal path also rejects browser-origin MCP calls.
  if (request.headers.has("origin"))
    return { ok: false, response: problem(403, "invalid_origin") };
  const bearer = request.headers.get("authorization");
  if (!bearer || !/^Bearer [^ ]+$/.test(bearer))
    return { ok: false, response: problem(401, "unauthorized", challenge) };
  try {
    const sdk = createClerkClient({
      secretKey: config.secretKey,
      publishableKey: config.publishableKey,
    });
    const state = await sdk.authenticateRequest(request, {
      acceptsToken: "oauth_token",
      audience: config.resource,
    });
    if (
      !state.isAuthenticated ||
      state.tokenType !== "oauth_token" ||
      !issuerMatches(state.token, config.issuer) ||
      state.toAuth()?.userId !== config.owner
    )
      return { ok: false, response: problem(401, "unauthorized", challenge) };
    if (!state.toAuth()?.scopes?.includes(SCOPE))
      return {
        ok: false,
        response: problem(
          403,
          "insufficient_scope",
          `Bearer error="insufficient_scope", scope="${SCOPE}", resource_metadata="${config.metadataUrl}"`,
        ),
      };
    if (request.method !== "POST")
      return { ok: false, response: problem(405, "method_not_allowed") };
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    return { ok: true, request: new Request(request, { headers }) };
  } catch {
    // Never expose the bearer, Clerk credential, user ID, or SDK error.
    return { ok: false, response: problem(401, "unauthorized", challenge) };
  }
}
