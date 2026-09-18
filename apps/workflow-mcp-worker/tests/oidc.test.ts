import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyGitHubOidcToken } from '../src/oidc.js';

const issuer = 'https://token.actions.example.test';
const audience = 'workflow-mcp-worker';
const jwksUrl = 'https://token.actions.example.test/.well-known/jwks';
let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
});

describe('GitHub OIDC verifier', () => {
  it('verifies a cryptographically signed GitHub job identity', async () => {
    const now = 1_800_000_000;
    const token = await signJwt({
      iss: issuer,
      aud: audience,
      iat: now - 10,
      nbf: now - 10,
      exp: now + 300,
      repository_id: '12345',
      workflow_ref: 'lirtual/mcp-workers/.github/workflows/workflow-executor.yml@refs/heads/main',
      ref: 'refs/heads/main',
      workflow_sha: 'abc123',
      run_id: '9001',
      run_attempt: '2'
    });
    const fetchImpl = jwksFetch();

    await expect(
      verifyGitHubOidcToken(
        token,
        { issuer, audience, jwksUrl },
        fetchImpl as typeof fetch,
        now
      )
    ).resolves.toEqual({
      repositoryId: '12345',
      workflowRef: 'lirtual/mcp-workers/.github/workflows/workflow-executor.yml@refs/heads/main',
      ref: 'refs/heads/main',
      workflowSha: 'abc123',
      runId: '9001',
      runAttempt: 2
    });
  });

  it('rejects issuer, audience, and expiry mismatches after signature verification', async () => {
    const now = 1_800_000_000;
    const base = {
      iss: issuer,
      aud: audience,
      iat: now - 10,
      nbf: now - 10,
      exp: now + 300,
      repository_id: '12345',
      workflow_ref: 'wf',
      ref: 'refs/heads/main',
      workflow_sha: 'abc',
      run_id: '1',
      run_attempt: '1'
    };

    await expect(
      verifyGitHubOidcToken(
        await signJwt({ ...base, iss: 'https://evil.example' }),
        { issuer, audience, jwksUrl },
        jwksFetch() as typeof fetch,
        now
      )
    ).rejects.toThrow(/issuer/i);

    await expect(
      verifyGitHubOidcToken(
        await signJwt({ ...base, aud: 'wrong-audience' }),
        { issuer, audience, jwksUrl },
        jwksFetch() as typeof fetch,
        now
      )
    ).rejects.toThrow(/audience/i);

    await expect(
      verifyGitHubOidcToken(
        await signJwt({ ...base, exp: now - 100 }),
        { issuer, audience, jwksUrl, clockSkewSeconds: 0 },
        jwksFetch() as typeof fetch,
        now
      )
    ).rejects.toThrow(/expired/i);
  });

  it('rejects a token signed by an untrusted key', async () => {
    const other = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;

    const now = 1_800_000_000;
    const token = await signJwt(
      {
        iss: issuer,
        aud: audience,
        exp: now + 300,
        repository_id: '123',
        workflow_ref: 'wf',
        ref: 'refs/heads/main',
        workflow_sha: 'abc',
        run_id: '1',
        run_attempt: '1'
      },
      other.privateKey
    );

    await expect(
      verifyGitHubOidcToken(
        token,
        { issuer, audience, jwksUrl },
        jwksFetch() as typeof fetch,
        now
      )
    ).rejects.toThrow(/signature/i);
  });
});

function jwksFetch() {
  return vi.fn(async () =>
    Response.json({
      keys: [publicJwk]
    })
  );
}

async function signJwt(
  claims: Record<string, unknown>,
  key: CryptoKey = privateKey
): Promise<string> {
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
  const payload = base64UrlJson(claims);
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
