import { fail } from './types.ts';

export function validateMailHost(host: string): string {
  const hostname = host.trim().toLowerCase();
  if (hostname.length < 4 || hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname))
    fail('invalid_mail_host');
  if (/(?:^|\.)(?:localhost|local|internal|invalid|example|test)$/.test(hostname) ||
    hostname.endsWith('.arpa') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname))
    fail('invalid_mail_host');
  return hostname;
}
export function publicIp(address: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    const n = address.split('.').map(Number);
    if (n.some(x => x > 255 || x < 0)) return false;
    const [a, b, c] = n;
    return a > 0 && a < 224 && a !== 10 && a !== 127 &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && b === 0 && (c === 0 || c === 2)) &&
      !(a === 192 && b === 88 && c === 99) &&
      !(a === 192 && b === 168) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
      !(a === 203 && b === 0 && c === 113);
  }
  if (address.includes(':')) {
    // Public-only native global unicast; deny mapped, private, test, 6to4, Teredo,
    // documentation and IPv6 forms we cannot confidently classify.
    if (!/^[0-9a-f:.]+$/i.test(address) || address.includes('.') || address.includes('%')) return false;
    const first = address.split(':')[0];
    if (!first || !/^[0-9a-f]{1,4}$/i.test(first)) return false;
    const head = parseInt(first, 16);
    if (head < 0x2000 || head > 0x3fff || head === 0x2002) return false;
    if (/^2001:0{0,3}(?:db8|0)(?::|$)/i.test(address)) return false;
    return true;
  }
  return false;
}
export async function resolvePublicMailEndpoint(host: string, requestFetch: typeof fetch = fetch):
  Promise<{ hostname: string; address: string }> {
  const safe = validateMailHost(host);
  const lookups = await Promise.all([1, 28].map(async type => {
    const endpoint = new URL('https://cloudflare-dns.com/dns-query');
    endpoint.search = new URLSearchParams({ name: safe, type: String(type) }).toString();
    const result = await requestFetch(endpoint.toString(), {
      headers: { accept: 'application/dns-json' }, redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) fail('dns_unavailable');
    const data = await result.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    if (data.Status !== 0 && data.Status !== 3) fail('dns_unavailable');
    return (data.Answer ?? []).filter(x => x.type === type).map(x => x.data);
  }));
  const addresses = lookups.flat();
  if (!addresses.length || addresses.length > 24 || addresses.some(ip => !publicIp(ip))) fail('unsafe_mail_host');
  return { hostname: safe, address: addresses[0]! };
}
export async function assertPublicMailEndpoint(host: string, requestFetch: typeof fetch = fetch): Promise<string> {
  return (await resolvePublicMailEndpoint(host, requestFetch)).hostname;
}
export function validateMailPorts(imapPort: number, smtpPort: number): void {
  if (imapPort !== 993 || (smtpPort !== 465 && smtpPort !== 587)) fail('unsupported_mail_port');
}
