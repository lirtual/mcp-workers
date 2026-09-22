import { describe, expect, it } from 'vitest';
import { authorizePinnedConnectionAttempt, readLiveConnectionControl, resolveRunConnectionPin, type PinnedConnectionAuthority } from '../src/connection-revocation.js';

const pinned: PinnedConnectionAuthority = {
  connectionId: 'raindrop',
  version: 1,
  endpoint: 'https://example.invalid/mcp',
  toolName: 'list_raindrops',
  effect: 'read'
};
const allowed = { connectionId: 'raindrop', disabled: false, allowedTools: { list_raindrops: ['read'] as const } };

describe('pinned Connection authorization', () => {
  it('rejects unavailable D1 controls and mismatched connection IDs', () => {
    expect(authorizePinnedConnectionAttempt(pinned, null)).toEqual({ allowed: false, reason: 'control_unavailable' });
    expect(authorizePinnedConnectionAttempt(pinned, { ...allowed, connectionId: 'other' })).toEqual({
      allowed: false, reason: 'connection_mismatch'
    });
  });

  it('honors revocation even for an older pinned version', () => {
    expect(authorizePinnedConnectionAttempt(pinned, { ...allowed, disabled: true })).toEqual({
      allowed: false, reason: 'revoked'
    });
  });

  it('rejects tightened tool/effect policy but preserves a pinned allowed attempt', () => {
    expect(authorizePinnedConnectionAttempt(pinned, { ...allowed, allowedTools: {} })).toEqual({
      allowed: false, reason: 'policy_tightened'
    });
    expect(authorizePinnedConnectionAttempt(pinned, allowed)).toEqual({ allowed: true });
  });
});

describe('D1 live Connection controls', () => {
  function db(row: unknown): D1Database {
    return {
      prepare: () => ({
        bind: () => ({ first: async () => row })
      })
    } as unknown as D1Database;
  }

  it('loads current controls for every new check', async () => {
    const read = await readLiveConnectionControl(db({
      connection_id: 'raindrop',
      disabled: 1,
      allowed_tools_json: '{"list_raindrops":["read"]}'
    }), 'raindrop');
    expect(authorizePinnedConnectionAttempt(pinned, read)).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('rejects missing or malformed controls without static fallback', async () => {
    expect(await readLiveConnectionControl(db(null), 'raindrop')).toBeNull();
    await expect(readLiveConnectionControl(db({
      connection_id: 'raindrop',
      disabled: 0,
      allowed_tools_json: '{"list_raindrops":["privileged"]}'
    }), 'raindrop')).rejects.toThrow('invalid');
  });
});

describe('Run-scoped Connection pin resolution', () => {
  function db(pin: string | null, config: string | null): D1Database {
    return {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes('workflow_runs')
            ? { connection_versions_json: pin }
            : config === null ? null : { config_json: config }
        })
      })
    } as unknown as D1Database;
  }

  it('preserves explicit legacy NULL compatibility', async () => {
    expect(await resolveRunConnectionPin(db(null, null), 'old-run', 'raindrop', 'list_raindrops', 'read'))
      .toBeUndefined();
  });

  it('resolves a pinned revision without silently retargeting', async () => {
    expect(await resolveRunConnectionPin(
      db('{"raindrop":2}', '{"endpoint":"https://example.invalid/mcp"}'),
      'new-run', 'raindrop', 'list_raindrops', 'read'
    )).toEqual({
      connectionId: 'raindrop', version: 2, endpoint: 'https://example.invalid/mcp',
      toolName: 'list_raindrops', effect: 'read'
    });
  });

  it('fails closed on missing revision and malformed pin map', async () => {
    await expect(resolveRunConnectionPin(db('{}', null), 'new-run', 'raindrop', 'list_raindrops', 'read'))
      .rejects.toThrow('unavailable');
    await expect(resolveRunConnectionPin(db('[]', null), 'new-run', 'raindrop', 'list_raindrops', 'read'))
      .rejects.toThrow('invalid');
  });
});
