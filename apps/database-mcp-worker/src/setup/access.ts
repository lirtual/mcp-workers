import type { Env } from '../types.js';
import { PublicError } from '../errors.js';
function fail(code: string): never {
  if (code === 'not_found') throw new PublicError('ACCESS_DENIED', 'Owner setup is unavailable on this host.');
  if (code === 'auth_misconfigured' || code === 'auth_unavailable')
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Owner authentication is unavailable.');
  if (code === 'csrf_rejected') throw new PublicError('ACCESS_DENIED', 'Invalid form origin or CSRF token.');
  throw new PublicError('AUTH_REQUIRED', 'Cloudflare Access authentication is required.');
}
function ownerHost(env: Env): string {
  const host = env.DATABASE_SETUP_HOST;
  if (!host || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || host.endsWith('.workers.dev')) fail('auth_misconfigured');
  return host;
}
type Identity = { sub: string; email: string };
type JwtHeader = { alg?: string; kid?: string };
type JwtPayload = { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; sub?: string; email?: string };
function decodeB64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('unauthorized');
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), s => s.charCodeAt(0));
  } catch { return fail('unauthorized'); }
}
function decodeJson<T>(value: string): T {
  try { return JSON.parse(new TextDecoder().decode(decodeB64(value))) as T; }
  catch { return fail('unauthorized'); }
}
export async function verifyAccess(request: Request, env: Env, requestFetch: typeof fetch = fetch): Promise<Identity> {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.hostname !== ownerHost(env) || url.port ||
      (request.headers.has('host') && request.headers.get('host') !== url.host)) fail('not_found');
  const team = env.ACCESS_TEAM_DOMAIN;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team ?? '') || !env.ACCESS_AUD || !env.OWNER_EMAIL) fail('auth_misconfigured');
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt || jwt.length > 10000) fail('unauthorized');
  const parts = jwt.split('.');
  if (parts.length !== 3) fail('unauthorized');
  const header = decodeJson<JwtHeader>(parts[0]!);
  const payload = decodeJson<JwtPayload>(parts[1]!);
  if (header.alg !== 'RS256' || !header.kid || typeof header.kid !== 'string') fail('unauthorized');
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== 'https://' + team ||
    !(Array.isArray(payload.aud) ? payload.aud.includes(env.ACCESS_AUD) : payload.aud === env.ACCESS_AUD) ||
    typeof payload.exp !== 'number' || payload.exp <= now ||
    (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now + 30)) ||
    !payload.sub || !payload.email || payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) fail('unauthorized');
  let certs: Response;
  try { certs = await requestFetch('https://' + team + '/cdn-cgi/access/certs', { redirect: 'error', signal: AbortSignal.timeout(5000) }); }
  catch { return fail('auth_unavailable'); }
  if (!certs.ok) fail('auth_unavailable');
  const body = await certs.json() as { keys?: (JsonWebKey & { kid?: string; alg?: string })[] };
  const jwk = body.keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256');
  if (!jwk) fail('unauthorized');
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, new Uint8Array(decodeB64(parts[2]!)).buffer, new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!valid) fail('unauthorized');
  } catch { fail('unauthorized'); }
  return { sub: payload.sub, email: payload.email };
}
const COOKIE = 'database_setup_csrf';
export function setupCsrf(request: Request): string | null {
  const cookies = request.headers.get('cookie') ?? '';
  return cookies.split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) ?? null;
}
export function validateCsrf(request: Request, env: Env, token: string): void {
  const origin = request.headers.get('origin');
  if (request.method !== 'POST' || origin !== 'https://' + ownerHost(env) ||
    !/^[A-Za-z0-9_-]{40,64}$/.test(token) || setupCsrf(request) !== token) fail('csrf_rejected');
}
export function csrfCookie(token: string): string {
  return COOKIE + '=' + token + '; Path=/setup; Max-Age=3600; Secure; HttpOnly; SameSite=Strict';
}
