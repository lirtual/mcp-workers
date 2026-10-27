import { isIP } from 'node:net';
import { parseDirectDatabaseUrl } from '../config.js';
import { PublicError } from '../errors.js';

function invalid(): never { throw new PublicError('INVALID_INPUT', 'The database endpoint must be a public, eligible address.'); }
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
  // Only global unicast 2000::/3; exclude documented/special-purpose prefixes.
  const value = ip.toLowerCase();
  if (!/^[23][0-9a-f]{0,3}:/.test(value)) return false;
  return !value.startsWith('2001:db8:') && !value.startsWith('2001:0:') &&
    !value.startsWith('2001:10:') && !value.startsWith('2001:20:');
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
    if (!publicAddress(ip) || parsed.dialect === 'mysql') invalid();
    return parsed;
  }
  if (!allowedHostname(host)) invalid();
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
        if (typeof record.data !== 'string' || !publicAddress(record.data)) invalid();
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
