import { describe, expect, it } from 'vitest';
import { authorizePinnedConnectionAttempt, type PinnedConnectionAuthority } from '../src/connection-revocation.js';

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
