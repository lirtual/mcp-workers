export interface GitHubOidcVerificationConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  clockSkewSeconds?: number;
}

export interface GitHubJobIdentity {
  repositoryId: string;
  workflowRef: string;
  ref: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  repository_id?: string;
  workflow_ref?: string;
  ref?: string;
  workflow_sha?: string;
  run_id?: string | number;
  run_attempt?: string | number;
}

export async function verifyGitHubOidcToken(
  token: string,
  config: GitHubOidcVerificationConfig,
  fetchImpl: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<GitHubJobIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('OIDC token is not a compact JWT.');

  const header = parseJsonPart<JwtHeader>(parts[0]!);
  const claims = parseJsonPart<JwtClaims>(parts[1]!);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('OIDC token uses an unsupported signing algorithm.');

  const jwksResponse = await fetchImpl(config.jwksUrl, {
    headers: { Accept: 'application/json' }
  });
  if (!jwksResponse.ok) throw new Error(`OIDC JWKS request failed with status ${jwksResponse.status}.`);
  const jwks = (await jwksResponse.json()) as { keys?: JsonWebKey[] };
  const jwk = jwks.keys?.find(key => key.kid === header.kid);
  if (!jwk) throw new Error('OIDC signing key was not found in JWKS.');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const verified = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64UrlDecode(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!verified) throw new Error('OIDC token signature is invalid.');

  const skew = config.clockSkewSeconds ?? 30;
  if (claims.iss !== config.issuer) throw new Error('OIDC issuer is not trusted.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(config.audience)) throw new Error('OIDC audience is not trusted.');
  if (typeof claims.exp !== 'number' || claims.exp + skew < nowSeconds) throw new Error('OIDC token is expired.');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > nowSeconds) throw new Error('OIDC token is not active yet.');
  if (typeof claims.iat === 'number' && claims.iat - skew > nowSeconds) throw new Error('OIDC token issued-at time is in the future.');

  const repositoryId = requiredString(claims.repository_id, 'repository_id');
  const workflowRef = requiredString(claims.workflow_ref, 'workflow_ref');
  const ref = requiredString(claims.ref, 'ref');
  const workflowSha = requiredString(claims.workflow_sha, 'workflow_sha');
  const runId = requiredScalarString(claims.run_id, 'run_id');
  const runAttempt = requiredPositiveInteger(claims.run_attempt, 'run_attempt');

  return { repositoryId, workflowRef, ref, workflowSha, runId, runAttempt };
}

function parseJsonPart<T>(part: string): T {
  const bytes = base64UrlDecode(part);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`OIDC claim "${name}" is missing.`);
  return value;
}

function requiredScalarString(value: unknown, name: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) {
    throw new Error(`OIDC claim "${name}" is missing.`);
  }
  return String(value);
}

function requiredPositiveInteger(value: unknown, name: string): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    throw new Error(`OIDC claim "${name}" is invalid.`);
  }
  return number;
}
