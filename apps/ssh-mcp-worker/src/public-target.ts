import { HostError } from './hosts.ts';
import { isIpLiteral, isPublicAddress, normalizeDnsName } from './target-security.ts';

interface DnsAnswer { type: number; data: string }

/** Resolve once and reject the whole answer set when any candidate is not public. */
export async function resolvePublicAddress(host: string, signal?: AbortSignal): Promise<string> {
  const candidates = isIpLiteral(host)
    ? [host.replace(/^\[|\]$/g, '')]
    : await resolveDns(normalizeDnsName(host) ?? (() => { throw new HostError('invalid_target'); })(), signal);
  if (candidates.length === 0 || candidates.length > 16 || candidates.some(address => !isPublicAddress(address))) {
    throw new HostError('invalid_target');
  }
  return candidates[0]!;
}

async function resolveDns(host: string, signal?: AbortSignal): Promise<string[]> {
  const addresses: string[] = [];
  for (const type of [1, 28]) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new HostError('invalid_target');
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('Answer' in body)) continue;
    const answers = (body as { Answer?: DnsAnswer[] }).Answer;
    for (const answer of answers ?? []) {
      if (answer.type === type && typeof answer.data === 'string') addresses.push(answer.data);
      if (addresses.length > 16) throw new HostError('invalid_target');
    }
  }
  return [...new Set(addresses)];
}
