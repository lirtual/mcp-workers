import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index.js';
import { authenticateDatabasePortal } from '../../src/portal-auth.js';
import { handleHyperdrivePreflight } from '../../src/hyperdrive-preflight.js';
import type { Env } from '../../src/types.js';

vi.mock('../../src/portal-auth.js', () => ({
  authenticateDatabasePortal: vi.fn()
}));
vi.mock('../../src/hyperdrive-preflight.js', () => ({
  handleHyperdrivePreflight: vi.fn(async () => Response.json({ ok: true }))
}));
const url = 'https://database-mcp-worker.aiyaya.workers.dev/internal/hyperdrive-health';
const env = { DB: {} } as Env;
const ctx = {} as ExecutionContext;

describe('private Hyperdrive route authentication', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects a request without valid MCP bearer auth before invoking private health', async () => {
    vi.mocked(authenticateDatabasePortal).mockResolvedValue({ ok: false, reason: 'unauthorized' });
    const req = new Request(url, { method: 'POST' });
    const response = await worker.fetch(req, env, ctx);
    expect(response.status).toBe(401);
    expect(handleHyperdrivePreflight).not.toHaveBeenCalled();
  });
  it('runs private preflight only after existing Portal bearer validation', async () => {
    const req = new Request(url, { method: 'POST' });
    vi.mocked(authenticateDatabasePortal).mockResolvedValue({
      ok: true, request: req, authInfo: { clientId: 'test', scopes: [] }
    } as never);
    const response = await worker.fetch(req, env, ctx);
    expect(response.status).toBe(200);
    expect(handleHyperdrivePreflight).toHaveBeenCalledWith(req, env);
  });
  it('does not expose the private preflight on a similar path', async () => {
    const response = await worker.fetch(new Request(url + '/other'), env, ctx);
    expect(response.status).toBe(404);
    expect(authenticateDatabasePortal).not.toHaveBeenCalled();
  });
});
