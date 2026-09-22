import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleAdminRoute } from '../src/admin-routes.js';
import { GITHUB_EXECUTOR_CONFIG } from '../src/platform-config.js';
import { getWorkflowRegistry } from '../src/registry.js';
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
  MCP_ACCESS_TOKEN: 'ordinary-mcp-secret',
  DB: {
    prepare: () => ({
      first: async () => ({ revision: 1 }),
      all: async () => ({ results: [] })
    })
  } as unknown as D1Database
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
    expect((await invoke('Bearer ' + await token(), { ...env, DB: undefined } as unknown as Env)).status).toBe(503);
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
        expect(statements).toHaveLength(3);
        return [{ meta: { changes } }, { meta: { changes } }, { meta: { changes } }];
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
        expect(statements).toHaveLength(4);
        return [{ meta: { changes: 1 } }, { meta: { changes } }, { meta: { changes } }, { meta: { changes } }];
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

describe('D1-backed approved Connection snapshot', () => {
  it('reflects current version and global revision without credential or endpoint exposure', async () => {
    const db = {
      prepare: (sql: string) => ({
        first: async () => sql.includes('connection_policy_revision') ? { revision: 7 } : null,
        all: async () => ({
          results: [{ connection_id: 'raindrop', current_version: 3, disabled: 1,
            allowed_tools_json: '{"list_raindrops":["read"]}' }]
        })
      })
    } as unknown as D1Database;
    const response = await invoke('Bearer ' + await token(), { ...env, DB: db });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as { revision: number;
      connections: Record<string, { version: number; enabled: boolean }> };
    expect(snapshot.revision).toBe(7);
    expect(snapshot.connections.raindrop).toMatchObject({ version: 3, enabled: false });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('ordinary-mcp-secret');
    expect(serialized).not.toContain('MCP_ACCESS_TOKEN');
    expect(serialized).not.toContain('https://');
  });

  it('rejects a torn snapshot when policy changes between reads', async () => {
    let revisionRead = 0;
    const db = {
      prepare: () => ({
        first: async () => ({ revision: ++revisionRead }),
        all: async () => ({ results: [] })
      })
    } as unknown as D1Database;
    const response = await invoke('Bearer ' + await token(), { ...env, DB: db });
    expect(response.status).toBe(503);
  });

  it('fails closed if the policy store cannot provide an authoritative revision', async () => {
    const db = { prepare: () => ({ first: async () => null }) } as unknown as D1Database;
    const response = await invoke('Bearer ' + await token(), { ...env, DB: db });
    expect(response.status).toBe(503);
  });
});

describe('concurrent admin action replay reconciliation', () => {
  it('returns the authoritative registration result after a losing unique-ID race', async () => {
    let actionReads = 0;
    let awaitDigest = '';
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({ first: async () =>
          sql.includes('connection_admin_actions') && ++actionReads === 2 ? {
            connection_id: 'raindrop', action_kind: 'register',
            request_digest: awaitDigest, resulting_revision: 1
          } : null
        })
      }),
      batch: async () => { throw new Error('UNIQUE constraint failed'); }
    } as unknown as D1Database;
    const requestBody = {
      actionId: 'race-register', connectionId: 'raindrop', expectedRevision: 0, tools: ['list_raindrops']
    };
    // The digest is bound to the approved static configuration, never to credential bytes.
    // Obtain it from the exact registered action calculation via the shared registry.
    const { getConnection } = await import('../src/connections.js');
    const connection = getConnection('raindrop')!;
    const config = JSON.stringify({
      endpoint: connection.endpoint, transport: connection.transport,
      protocolVersion: connection.protocolVersion, authSecret: connection.auth.secret,
      trustAnnotations: false, tools: { list_raindrops: connection.tools.list_raindrops }
    });
    const hash = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(['raindrop', 0, config])));
    awaitDigest = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    const request = new Request('https://example.test/admin/connections/register', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + await token() },
      body: JSON.stringify(requestBody)
    });
    const response = (await handleAdminRoute(request, { ...env, DB: db }, options))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, revision: 1 });
  });
});

describe('authenticated immutable definition staging', () => {
  const definition = getWorkflowRegistry().find(item => item.metadata.id === 'local-http-smoke')!;
  const envelope = () => ({
    publicationId: 'http-staging-001',
    workflowId: definition.metadata.id,
    definitionDigest: definition.definitionDigest,
    plan: definition.plan,
    metadata: definition.metadata,
    policyRevision: 1,
    manifestVersion: 1,
    sourcePath: definition.sourcePath,
    sourceSha: 'a'.repeat(40)
  });
  function database(): D1Database {
    const statement = (sql: string) => ({
      bind: (..._values: unknown[]) => statement(sql),
      first: async () => sql.includes('connection_policy_revision') ? { revision: 1 } : null
    });
    return {
      prepare: statement,
      batch: async (queries: unknown[]) => {
        expect(queries).toHaveLength(2);
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
      }
    } as unknown as D1Database;
  }
  async function invokeStage(payload: unknown, jwt?: string): Promise<Response> {
    const request = new Request('https://example.test/admin/definitions/stage', {
      method: 'POST',
      headers: { authorization: jwt ?? 'Bearer ' + await token() },
      body: JSON.stringify(payload)
    });
    return (await handleAdminRoute(request, { ...env, DB: database() }, options))!;
  }

  it('rejects ordinary MCP credentials, forged publisher identity and a corrupted digest', async () => {
    expect((await invokeStage(envelope(), 'Bearer ordinary-mcp-secret')).status).toBe(401);
    expect((await invokeStage(envelope(), 'Bearer ' + await token({ repository_id: '999' }))).status).toBe(403);
    const forged = { ...envelope(), definitionDigest: 'f'.repeat(64) };
    expect((await invokeStage(forged)).status).toBe(422);
    expect((await invokeStage({ ...envelope(), metadata: { ...definition.metadata, name: 'altered' } })).status).toBe(422);
  });

  it('stages a bounded, signed, unactivated definition with no secret data in reply', async () => {
    const response = await invokeStage(envelope());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workflowId: definition.metadata.id,
      definitionDigest: definition.definitionDigest,
      publicationId: 'http-staging-001',
      staged: true
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects an unknown body field and malformed or oversized requests', async () => {
    expect((await invokeStage({ ...envelope(), secret: 'arbitrary' })).status).toBe(400);
    expect((await invokeStage({ ...envelope(), sourceSha: 'not-a-sha' })).status).toBe(400);
    expect((await invokeStage({ ...envelope(), publicationId: 'x'.repeat(400_000) })).status).toBe(413);
  });
});
