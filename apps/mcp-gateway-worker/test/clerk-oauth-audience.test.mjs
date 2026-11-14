import assert from "node:assert/strict";
import { test } from "node:test";
import { createClerkClient } from "@clerk/backend";

// Exercise the pinned SDK's actual opaque-OAuth audience check without
// issuing a token, contacting Clerk, or installing a second OAuth server.
test("Clerk SDK accepts only an OAuth token verified for the requested Resource", async () => {
  const resource = "https://gateway.example.test/mcp/raindrop";
  const otherResource = "https://gateway.example.test/mcp/sentry";
  const api = "https://clerk-test.invalid";
  const originalFetch = globalThis.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  let audienceFromBackend = resource;
  let verifies = 0;

  try {
    process.env.NODE_ENV = "test";
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), api + "/oauth_applications/access_tokens/verify");
      assert.equal(init.method, "POST");
      assert.equal(JSON.parse(init.body).access_token, "oat_synthetic_test_only");
      verifies++;
      return Response.json({
        object: "clerk_idp_oauth_access_token",
        aud: audienceFromBackend,
        sub: "user_Synthetic",
      });
    };

    const client = createClerkClient({
      secretKey: "sk_test_Synthetic",
      publishableKey: "pk_test_Synthetic",
      apiUrl: api,
    });

    const accepted = await client.idPOAuthAccessToken.verify(
      "oat_synthetic_test_only",
      { audience: resource },
    );
    assert.equal(accepted.aud, resource);

    await assert.rejects(
      client.idPOAuthAccessToken.verify("oat_synthetic_test_only", {
        audience: otherResource,
      }),
      /OAuth audience mismatch/,
    );

    audienceFromBackend = undefined;
    await assert.rejects(
      client.idPOAuthAccessToken.verify("oat_synthetic_test_only", {
        audience: resource,
      }),
      /Invalid OAuth audience claim/,
    );

    assert.equal(verifies, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
