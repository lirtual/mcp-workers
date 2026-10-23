import { publicMcpEndpoint } from './mcp-public-fetch.ts';

/** Prepare one registered fixture request. Does not attach credentials or follow redirects. */
export function prepareFixtureRequest(approvedEndpoint: string, body: string): Request {
  let approved: string;
  try { approved = publicMcpEndpoint(approvedEndpoint).href; }
  catch { throw new Error('http_target_invalid'); }
  if (approved !== approvedEndpoint) throw new Error('http_target_invalid');
  const incoming = new Request(approved, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'accept': 'application/json'},
    body,
  });
  if (incoming.url !== approved) throw new Error('http_target_not_authorized');
  if (incoming.headers.has('authorization') || incoming.headers.has('cf-access-client-id') ||
      incoming.headers.has('cf-access-client-secret'))
    throw new Error('http_credential_rejected');
  return new Request(incoming, {redirect: 'manual'});
}

export async function sendFixture(request: Request, outbound: typeof fetch = fetch): Promise<Response> {
  const result = await outbound(request);
  if (result.status >= 300 && result.status < 400) throw new Error('http_redirect_denied');
  return result;
}
