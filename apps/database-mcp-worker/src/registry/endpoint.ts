import { isIP } from 'node:net';
import { parseDirectDatabaseUrl } from '../config.js';
import { PublicError } from '../errors.js';

type InvalidEndpointReason = 'nonpublic_address' | 'invalid_hostname';
function invalid(reason: InvalidEndpointReason): never {
  const messages: Record<InvalidEndpointReason, string> = {
    nonpublic_address: 'The database endpoint resolves to a nonpublic or reserved address.',
    invalid_hostname: 'The database endpoint hostname is not an eligible public DNS name.'
  };
  throw new PublicError('INVALID_INPUT', messages[reason]);
}
function unavailable(): never { throw new PublicError('CONNECTION_UNAVAILABLE', 'Database hostname validation is unavailable.'); }

/** Check IPv4 special-use ranges. Reject anything not known to be globally routable. */
function publicIPv4(ip: string): boolean {
  const v = ip.split('.').map(Number);
  if (v.length !== 4 || v.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = v as [number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
function publicIPv6(ip: string): boolean {
  // DNS JSON returns textual addresses, not necessarily canonical IPv6.
  // Normalize before checking reserved prefixes (e.g. 2001:0db8::/32).
  let value: string;
  try { value = new URL(`http://[${ip}]/`).hostname.slice(1, -1); }
  catch { return false; }
  // 2000::/3 is global-unicast space, but includes IANA special-use ranges.
  if (!/^[23][0-9a-f]{0,3}:/.test(value)) return false;
  const parts = value.split(':');
  const first = Number.parseInt(parts[0]!, 16);
  const second = Number.parseInt(parts[1] || '0', 16);
  const third = Number.parseInt(parts[2] || '0', 16);
  // 3fff::/20 is documentation-only; 2002::/16 is 6to4, not a
  // demonstrably globally reachable direct database endpoint.
  if ((first === 0x3fff && second < 0x1000) || first === 0x2002) return false;
  if (first === 0x2001 && (
    second === 0 || // IETF/Teredo; do not accept special-purpose 2001:0::/32
    (second === 2 && third === 0) || // 2001:2::/48 benchmarking
    (second >= 0x10 && second <= 0x2f) || // legacy ORCHID and ORCHIDv2 ranges
    second === 0xdb8 // 2001:db8::/32 documentation
  )) return false;
  return true;
}
function publicAddress(ip: string): boolean {
  return isIP(ip) === 4 ? publicIPv4(ip) : isIP(ip) === 6 ? publicIPv6(ip) : false;
}
function allowedHostname(host: string): boolean {
  if (host.length > 253 || !host.includes('.') || host.endsWith('.')) return false;
  if (host === 'localhost' || /\.(?:localhost|local|internal|test|invalid|example|arpa)$/i.test(host)) return false;
  return host.split('.').every(part => part.length >= 1 && part.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part));
}
interface DnsReply { Status?: unknown; Answer?: Array<{ type?: unknown; data?: unknown }> }

export async function validatePublicEndpoint(raw: string, id: string, requestFetch: typeof fetch = fetch) {
  const parsed = parseDirectDatabaseUrl(raw, id);
  const host = parsed.host.toLowerCase();
  const ip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(ip)) {
    if (!publicAddress(ip)) invalid('nonpublic_address');
    return parsed;
  }
  if (!allowedHostname(host)) invalid('invalid_hostname');
  let addresses = 0;
  try {
    const answers = await Promise.all(['A', 'AAAA'].map(async type => {
      const response = await requestFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(3500)
      });
      if (!response.ok) unavailable();
      return await response.json() as DnsReply;
    }));
    for (const answer of answers) {
      if (answer.Status !== 0) unavailable();
      for (const record of answer.Answer ?? []) {
        if (record.type !== 1 && record.type !== 28) continue;
        if (typeof record.data !== 'string' || !publicAddress(record.data)) invalid('nonpublic_address');
        addresses++;
      }
    }
  } catch (error) {
    if (error instanceof PublicError) throw error;
    return unavailable();
  }
  if (addresses === 0) unavailable();
  // DNS-to-connect binding cannot be guaranteed by mysql2/pg; residual rebinding
  // and TOCTOU risks are documented. Workers outbound restrictions are additive.
  return parsed;
}
