/**
 * Candidate S2 public MCP transport, guarded by the disabled-by-default
 * S2_READONLY_ENABLED flag in the runner. URL shape checks and manual redirects
 * do NOT establish DNS/IP or SSRF isolation. The owner selected personal
 * trusted-target scope (B), explicitly accepting residual risks; the original
 * P0-3/AC-08 isolation gate remains unproven. Production enablement is separate.
 *
 * The caller MUST supply a trusted, authorized concrete endpoint. Passing
 * an endpoint derived only from a Draft or Run input is not authorization.
 */
export function publicMcpEndpoint(input: string | URL): URL {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443')) throw new Error('mcp_target_invalid');
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ||
      host.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error('mcp_target_invalid');
  }
  if (/^\d+(?:\.\d+)*$/.test(host) ||
      /\.(?:localhost|local|internal|invalid|test)$/.test(host)) {
    throw new Error('mcp_target_invalid');
  }
  return url;
}

// S2 may authenticate only to the owner's explicitly chosen Portal.
// Never send this credential to an arbitrary endpoint from a Draft.
export const TRUSTED_PORTAL_ENDPOINT = 'https://test-mcp.lirtual.dpdns.org/mcp';
export type PortalServiceToken = {clientId:string;clientSecret:string};

/** Only use with an endpoint already checked against an owner operation grant. */
export function scopedPublicMcpFetch(
  approvedEndpoint: string | URL,
  outbound: typeof fetch = fetch,
  portalToken?: PortalServiceToken,
): typeof fetch {
  const approved = publicMcpEndpoint(approvedEndpoint).href;
  if (portalToken && approved !== TRUSTED_PORTAL_ENDPOINT)
    throw new Error('portal_auth_wrong_target');
  if (portalToken && (!portalToken.clientId || !portalToken.clientSecret))
    throw new Error('portal_auth_not_configured');
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Merge both Request and RequestInit first so neither can override redirect.
    const incoming = new Request(input, init);
    if (incoming.url !== approved) throw new Error('mcp_target_not_authorized');
    if (incoming.headers.has('cf-access-client-id') ||
        incoming.headers.has('cf-access-client-secret'))
      throw new Error('portal_auth_header_override_denied');
    const request = new Request(incoming, { redirect: 'manual' });
    if (portalToken) {
      request.headers.set('CF-Access-Client-Id', portalToken.clientId);
      request.headers.set('CF-Access-Client-Secret', portalToken.clientSecret);
    }
    const result = await outbound(request);
    if (result.status >= 300 && result.status < 400) throw new Error('mcp_redirect_denied');
    return result;
  }) as typeof fetch;
}
