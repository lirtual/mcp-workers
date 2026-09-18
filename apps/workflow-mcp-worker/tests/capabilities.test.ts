import { describe, expect, it } from 'vitest';
import { getAutomaticAttemptLimit, getCapabilityDescriptor } from '../src/capabilities.js';

describe('capability retry policy', () => {
  it('keeps automatic retries explicit and bounded for reads', () => {
    expect(getAutomaticAttemptLimit('http.read', undefined)).toBe(1);
    expect(getAutomaticAttemptLimit('http.read', 3)).toBe(3);
    expect(() => getAutomaticAttemptLimit('http.read', 4)).toThrow(/at most 3/);
  });

  it('keeps static unsafe capabilities bounded while mcp.call delegates safety to per-tool policy', () => {
    expect(getCapabilityDescriptor('mcp.call')).toMatchObject({
      effect: 'unknown',
      maxAutomaticAttempts: 3
    });

    expect(getCapabilityDescriptor('github.archive_markdown')?.effect).toBe('unsafe_write');
    expect(() => getAutomaticAttemptLimit('github.archive_markdown', 2)).toThrow(/at most 1/);
  });
});
