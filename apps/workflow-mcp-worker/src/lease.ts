export type LeasePermission = 'manifest:read' | 'artifact:allocate' | 'callback:write';

export interface ExecutorLeaseClaims {
  issuer: 'workflow-mcp-worker';
  attemptId: string;
  runId: string;
  stepRunId: string;
  githubRunId: string;
  githubRunAttempt: number;
  permissions: LeasePermission[];
  issuedAt: number;
  expiresAt: number;
}

export async function issueExecutorLease(
  secret: string,
  claims: Omit<ExecutorLeaseClaims, 'issuer' | 'issuedAt' | 'expiresAt'>,
  options: { ttlSeconds?: number; nowSeconds?: number } = {}
): Promise<string> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? 300;
  if (ttl < 30 || ttl > 900) throw new Error('Executor lease TTL must be between 30 and 900 seconds.');

  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({
    issuer: 'workflow-mcp-worker',
    ...claims,
    issuedAt: now,
    expiresAt: now + ttl
  } satisfies ExecutorLeaseClaims);
  const signature = await sign(secret, `${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

export async function verifyExecutorLease(
  token: string,
  secret: string,
  requiredPermission: LeasePermission,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<ExecutorLeaseClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Executor lease is malformed.');
  const expected = await sign(secret, `${parts[0]}.${parts[1]}`);
  if (!constantTimeEqual(expected, parts[2]!)) throw new Error('Executor lease signature is invalid.');

  const claims = decodeJson<ExecutorLeaseClaims>(parts[1]!);
  if (claims.issuer !== 'workflow-mcp-worker') throw new Error('Executor lease issuer is invalid.');
  if (!Number.isInteger(claims.expiresAt) || claims.expiresAt < nowSeconds) throw new Error('Executor lease has expired.');
  if (!Array.isArray(claims.permissions) || !claims.permissions.includes(requiredPermission)) {
    throw new Error('Executor lease does not grant the required permission.');
  }
  if (
    typeof claims.attemptId !== 'string' ||
    typeof claims.runId !== 'string' ||
    typeof claims.stepRunId !== 'string' ||
    typeof claims.githubRunId !== 'string' ||
    !Number.isInteger(claims.githubRunAttempt)
  ) {
    throw new Error('Executor lease claims are incomplete.');
  }
  return claims;
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson<T>(value: string): T {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), char => char.charCodeAt(0)))) as T;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
