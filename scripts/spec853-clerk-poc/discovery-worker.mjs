/**
 * Spec #853 T3, isolated public discovery-only MCP OAuth test.
 *
 * Public routes: RFC 9728 metadata; every /mcp request returns 401.
 * No credentials, upstream tool execution, database, client sessions, or logs.
 * THIS IS NOT AN AUTHENTICATED MCP SERVER. Do not attach production tools.
 */
const RESOURCE = "https://spec853-clerk-oauth-lab.aiyaya.workers.dev/mcp";
const ISSUER = "https://warm-tadpole-1093.clerk.accounts.dev";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const METADATA_URL = new URL(METADATA_PATH, RESOURCE).href;
const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const resourceMetadata = JSON.stringify({
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  bearer_methods_supported: ["header"],
});
const unauthorized = () => new Response(JSON.stringify({ error: "unauthorized" }), {
  status: 401,
  headers: {
    ...jsonHeaders,
    "www-authenticate": 'Bearer resource_metadata="' + METADATA_URL + '"',
  },
});
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Host-bound: prevent Host-header aliases from advertising the wrong audience.
    if (url.origin !== new URL(RESOURCE).origin) {
      return new Response("not-found", { status: 404, headers: jsonHeaders });
    }
    // Exact RFC 9728 path; root metadata alias for clients without suffix support.
    if (request.method === "GET" &&
        (url.pathname === METADATA_PATH ||
         url.pathname === "/.well-known/oauth-protected-resource")) {
      return new Response(resourceMetadata, { status: 200, headers: jsonHeaders });
    }
    if (url.pathname === "/mcp") {
      return unauthorized(); // Even syntactically valid Bearer tokens are DENIED.
    }
    return new Response("not-found", { status: 404, headers: jsonHeaders });
  },
};
