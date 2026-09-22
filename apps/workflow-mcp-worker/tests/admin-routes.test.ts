import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleAdminRoute } from '../src/admin-routes.js';
import { GITHUB_EXECUTOR_CONFIG } from '../src/platform-config.js';
import type { Env } from '../src/types.js';

const now = 1_800_000_000;
const issuer = GITHUB_EXECUTOR_CONFIG.oidc.issuer;
const workflowRef = 'lirtual/mcp-workers/.github/workflows/workflow-mcp-publisher.yml@refs/heads/main';
let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid?: string };

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  }, true, ['sign', 'verify'])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & { kid?: string };
  publicJwk.kid = 'test-key';
});

const env = {
  ADMIN_PUBLISHER_REPOSITORY_ID: '1371085786',
  ADMIN_PUBLISHER_WORKFLOW_REF: workflowRef,
  ADMIN_PUBLISHER_REF: 'refs/heads/main',
  ADMIN_PUBLISHER_WORKFLOW_SHA: 'trusted-sha',
  MCP_ACCESS_TOKEN: 'ordinary-mcp-secret'
} as Env;

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function token(claims: Record<string, unknown> = {}): Promise<string> {
  const first = encoded({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const second = encoded({
    iss: issuer, aud: 'workflow-mcp-publisher', exp: now + 300, nbf: now - 10, iat: now - 10,
    repository_id: '1371085786', workflow_ref: workflowRef, ref: 'refs/heads/main',
    workflow_sha: 'trusted-sha', run_id: '12345', run_attempt: '1',
    ...claims
  });
  const input = `${first}.${second}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
}

const options = {
  nowSeconds: now,
  fetchImpl: vi.fn(async () => Response.json({ keys: [publicJwk] })) as unknown as typeof fetch
};

async function invoke(authorization?: string, settings: Env = env, method = 'GET'): Promise<Response> {
  const request = new Request('https://example.test/admin/connections/snapshot', {
    method,
    ...(authorization ? { headers: { authorization } } : {})
  });
  return (await handleAdminRoute(request, settings, options))!;
}

describe('protected publisher admin boundary', () => {
  it('returns bounded redacted policy for the exact signed publisher identity', async () => {
    const response = await invoke('Bearer ' + await token());
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.revision).toBe(1);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('workflow-self');
    expect(serialized).not.toContain('ordinary-mcp-secret');
    expect(serialized).not.toContain('MCP_ACCESS_TOKEN');
    expect(serialized).not.toContain('https://');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('fails closed on absent trust config, missing bearer or shared MCP token', async () => {
    expect((await invoke()).status).toBe(401);
    expect((await invoke('Bearer ordinary-mcp-secret')).status).toBe(401);
    expect((await invoke('Bearer ' + await token(), {} as Env)).status).toBe(503);
  });

  it('rejects wrong repo, ref, workflow, revision SHA, executor audience and expired token', async () => {
    for (const bad of [
      { repository_id: '999' }, { ref: 'refs/heads/evil' }, { workflow_ref: 'executor' },
      { workflow_sha: 'untrusted' }, { aud: 'workflow-mcp-worker' }, { exp: now - 100 }
    ]) {
      expect((await invoke('Bearer ' + await token(bad))).status).toBeGreaterThanOrEqual(401);
      expect((await invoke('Bearer ' + await token(bad))).status).toBeLessThanOrEqual(403);
    }
  });

  it('exposes no admin mutation or MCP fallthrough', async () => {
    expect((await invoke('Bearer ' + await token(), env, 'POST')).status).toBe(405);
    expect(await handleAdminRoute(new Request('https://example.test/mcp'), env, options)).toBeNull();
  });
});

describe('protected Connection disable CAS', () => {
  function db(changes: number): D1Database {
    const prepare = (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => null,
        run: async () => ({ meta: { changes: 1 } }),
        sql
      })
    });
    return {
      prepare,
      batch: async (statements: unknown[]) => {
        expect(statements).toHaveLength(2);
        return [{ meta: { changes } }, { meta: { changes } }];
      }
    } as unknown as D1Database;
  }
  async function disable(database: D1Database, body: unknown, bearer?: string): Promise<Response> {
    const request = new Request('https://example.test/admin/connections/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: bearer ?? 'Bearer ' + await token() },
      body: JSON.stringify(body)
    });
    return (await handleAdminRoute(request, { ...env, DB: database }, options))!;
  }

  it('requires valid publisher identity and strict action shape', async () => {
    const body = { actionId: 'disable-1', connectionId: 'raindrop', expectedRevision: 1 };
    expect((await disable(db(1), body, 'Bearer ordinary-mcp-secret')).status).toBe(401);
    expect((await disable(db(1), { ...body, credential: 'must-not-persist' })).status).toBe(400);
    expect((await disable(db(1), { ...body, expectedRevision: -1 })).status).toBe(400);
  });

  it('atomically claims CAS or rejects stale revision without leaking credentials', async () => {
    const body = { actionId: 'disable-1', connectionId: 'raindrop', expectedRevision: 1 };
    const accepted = await disable(db(1), body);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ connectionId: 'raindrop', revision: 2, disabled: true });
    const stale = await disable(db(0), body);
    expect(stale.status).toBe(409);
    expect(await stale.text()).not.toContain('ordinary-mcp-secret');
  });
});

describe('protected bounded Connection registration', () => {
  const approved = { actionId: 'register-raindrop-1', connectionId: 'raindrop',
    expectedRevision: 0, tools: ['list_raindrops'] };
  function database(changes: number): D1Database {
    return {
      prepare: () => ({
        bind: () => ({ first: async () => null })
      }),
      batch: async (statements: unknown[]) => {
        expect(statements).toHaveLength(3);
        return [{ meta: { changes: 1 } }, { meta: { changes } }, { meta: { changes } }];
      }
    } as unknown as D1Database;
  }
  async function register(body: unknown, db: D1Database, authorization?: string): Promise<Response> {
    const request = new Request('https://example.test/admin/connections/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        authorization: authorization ?? 'Bearer ' + await token() },
      body: JSON.stringify(body)
    });
    return (await handleAdminRoute(request, { ...env, DB: db }, options))!;
  }

  it('requires the signed publisher and refuses unknown tools or credentials', async () => {
    expect((await register(approved, database(1), 'Bearer ordinary-mcp-secret')).status).toBe(401);
    expect((await register({ ...approved, tools: ['unknown_tool'] }, database(1))).status).toBe(403);
    expect((await register({ ...approved, secret: 'MCP_ACCESS_TOKEN' }, database(1))).status).toBe(400);
    expect((await register({ ...approved, endpoint: 'https://attacker.invalid/mcp' }, database(1))).status).toBe(400);
  });

  it('accepts a bounded approved tracer through the HTTP and D1 boundary', async () => {
    const response = await register(approved, database(1));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connectionId: 'raindrop', version: 1, revision: 1 });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await register(approved, database(0))).status).toBe(409);
  });
});
