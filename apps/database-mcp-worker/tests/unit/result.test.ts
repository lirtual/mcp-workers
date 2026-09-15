import { describe, expect, it } from 'vitest';
import { assertJsonWithinBytes, boundQueryResult, clampRequestedLimit, jsonSafe } from '../../src/result.js';

describe('result bounding', () => {
  it('truncates by row count and reports it', () => {
    const result = boundQueryResult([{ name: 'id' }], [[1], [2], [3]], 2, 10000);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe('row_limit');
  });

  it('truncates by serialized result size', () => {
    const result = boundQueryResult([{ name: 'value' }], [['x'.repeat(1000)]], 10, 100);
    expect(result.rows).toHaveLength(0);
    expect(result.truncationReason).toBe('result_size');
  });

  it('converts BigInt to JSON-safe strings', () => {
    expect(jsonSafe(123n)).toBe('123');
  });

  it('clamps client limits', () => {
    expect(clampRequestedLimit(1000, 500)).toBe(500);
  });

  it('rejects oversized schema output', () => {
    expect(() => assertJsonWithinBytes({ x: 'a'.repeat(1000) }, 100)).toThrow();
  });
});
