/**
 * Spec #853 — test-only. Before bundling, the test replaces synthetic placeholders
 * with an ephemeral test public key. Never deploy this fixture.
 */
import { createClerkClient } from "@clerk/backend";

const resource = "https://sentry.example.invalid/mcp";
const publishableKey = "__SPEC853_FAKE_PUBLISHABLE_KEY__";
const jwtKey = "__SPEC853_FAKE_JWT_PEM__";
const expectedIssuer = "https://gentle-lynx-71.clerk.accounts.dev";

// SDK machine-token verification does not enforce issuer even if the option is
// supplied. Check iss only AFTER SDK cryptographic verification. Test JWTs only.
function verifiedJwtIssuer(token) {
  if (typeof token !== "string" || token.length > 8192) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.iss === expectedIssuer;
  } catch {
    return false;
  }
}

export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("not-found", { status: 404 });
    }
    try {
      const clerk = createClerkClient({
        secretKey: "sk_test_synthetic_fixture_only",
        publishableKey,
        jwtKey,
      });
      const state = await clerk.authenticateRequest(request, {
        acceptsToken: "oauth_token",
        audience: resource,
        jwtKey,
      });
      const auth = state.isAuthenticated ? state.toAuth() : null;
      const allowed = state.isAuthenticated &&
        state.tokenType === "oauth_token" &&
        verifiedJwtIssuer(state.token) &&
        auth?.userId === "user_synthetic_owner" &&
        auth?.scopes?.includes("sentry:read");
      return Response.json({ allowed: !!allowed }, { status: allowed ? 200 : 401 });
    } catch {
      return Response.json({ allowed: false }, { status: 401 });
    }
  },
};
