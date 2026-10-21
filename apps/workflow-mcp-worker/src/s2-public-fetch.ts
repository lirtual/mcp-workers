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

/** Only use with an endpoint already checked against an owner operation grant. */
export function scopedPublicMcpFetch(
  approvedEndpoint: string | URL,
  outbound: typeof fetch = fetch,
): typeof fetch {
  const approved = publicMcpEndpoint(approvedEndpoint).href;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Merge both Request and RequestInit first so neither can override redirect.
    const incoming = new Request(input, init);
    if (incoming.url !== approved) throw new Error('mcp_target_not_authorized');
    const request = new Request(incoming, { redirect: 'manual' });
    const result = await outbound(request);
    if (result.status >= 300 && result.status < 400) throw new Error('mcp_redirect_denied');
    return result;
  }) as typeof fetch;
}
