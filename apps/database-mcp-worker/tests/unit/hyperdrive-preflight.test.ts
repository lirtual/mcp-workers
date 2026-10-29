import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';
import { handleHyperdrivePreflight } from '../../src/hyperdrive-preflight.js';
import { getRegistryConnection } from '../../src/registry/store.js';
import { resolveHyperdriveConnection } from '../../src/db/hyperdrive.js';
import { healthCheck } from '../../src/db/index.js';
import type { Env } from '../../src/types.js';

vi.mock('../../src/registry/store.js', () => ({ getRegistryConnection: vi.fn() }));
vi.mock('../../src/db/hyperdrive.js', () => ({ resolveHyperdriveConnection: vi.fn(() => ({ id: 'test' })) }));
vi.mock('../../src/db/index.js', () => ({ healthCheck: vi.fn(async () => ({ ok: true, latencyMs: 1 })) }));

const secret = Buffer.alloc(32, 11).toString('base64');
const fencedWrites: string[] = [];
const env = { DATABASE_ENCRYPTION_KEY: secret, DB: {
  prepare(sql: string) {return {
    bind(..._args: unknown[]) { return {
      async run() { fencedWrites.push(sql); return {meta:{changes:1}}; }
    }; }
  }; }
} } as unknown as Env;
const row = { id: 'test_pg', dialect: 'postgres', transport: 'hyperdrive',
  status: 'disabled', revision: 3, config_id: 'test-config', binding_name: 'HYPERDRIVE_TEST' };

function request(overrides: { id?: string; revision?: number; timestamp?: number;
  key?: string; tamper?: boolean; signature?: string } = {}): Request {
  const body = JSON.stringify({ id: overrides.id ?? 'test_pg',
    revision: overrides.revision ?? 3, timestamp: overrides.timestamp ?? Date.now() });
  const raw = Buffer.from(overrides.key ?? secret, 'base64');
  const hkdf = Buffer.from(hkdfSync('sha256', raw, 'database-mcp:preflight:salt:v1',
    'database-mcp:hyperdrive-health:v1', 32));
  const signature = overrides.signature ?? createHmac('sha256', hkdf)
    .update(body).digest('base64url');
  return new Request('https://database-mcp-worker.aiyaya.workers.dev/internal/hyperdrive-health', {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-database-hyperdrive-proof': signature },
    body: overrides.tamper ? body.replace('test_pg', 'other_pg') : body
  });
}

describe('protected disabled Hyperdrive preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();fencedWrites.length=0;
    vi.mocked(getRegistryConnection).mockResolvedValue(row as never);
    vi.mocked(healthCheck).mockResolvedValue({ ok: true, latencyMs: 1 });
  });
  it('probes while connection is still disabled without changing registry state', async () => {
    const response = await handleHyperdrivePreflight(request(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, connection: 'test_pg',
      dialect: 'postgres', transport: 'hyperdrive', revision: 3 });
    expect(fencedWrites).toHaveLength(2);
    expect(fencedWrites[0]).toContain('in_flight_count=in_flight_count+1');
    expect(fencedWrites[1]).toContain('in_flight_count=in_flight_count-1');
    expect(resolveHyperdriveConnection).toHaveBeenCalledOnce();
    expect(healthCheck).toHaveBeenCalledOnce();
    expect(getRegistryConnection).toHaveBeenCalledWith(env.DB, 'test_pg');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects missing, forged, mismatched and expired signatures before D1 read', async () => {
    for (const bad of [request({ signature: '0'.repeat(43) }), request({ tamper: true }),
      request({ key: Buffer.alloc(32, 13).toString('base64') }),
      request({ timestamp: Date.now() - 120000 })]) {
      expect((await handleHyperdrivePreflight(bad, env)).status).toBe(403);
    }
    expect(getRegistryConnection).not.toHaveBeenCalled();
  });
  it('never probes an active or stale-revision connection', async () => {
    vi.mocked(getRegistryConnection).mockResolvedValue({ ...row, status: 'active' } as never);
    expect((await handleHyperdrivePreflight(request(), env)).status).toBe(403);
    vi.mocked(getRegistryConnection).mockResolvedValue({ ...row, revision: 4 } as never);
    expect((await handleHyperdrivePreflight(request(), env)).status).toBe(403);
    expect(healthCheck).not.toHaveBeenCalled();
  });
  it('fails closed on missing key or failed real health', async () => {
    expect((await handleHyperdrivePreflight(request(),
      { DB: env.DB } as Env)).status).toBe(403);
    vi.mocked(healthCheck).mockResolvedValue({ ok: false, latencyMs: 1 });
    expect((await handleHyperdrivePreflight(request(), env)).status).toBe(403);
  });
  it('rejects wrong method, content type and oversized body', async () => {
    const good = request();
    const badMethod = new Request(good.url, { method: 'GET' });
    const badType = new Request(good.url, { method: 'POST', body: '{}' });
    const oversized = new Request(good.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(257)
    });
    for (const bad of [badMethod, badType, oversized]) {
      expect((await handleHyperdrivePreflight(bad, env)).status).toBe(403);
    }
    expect(getRegistryConnection).not.toHaveBeenCalled();
  });
});
