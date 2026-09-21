import { describe, expect, it } from 'vitest';
import { verifyRaindropOutput } from '../scripts/raindrop-verification.js';

describe('Raindrop production evidence contract', () => {
  it.each([0, 4, 19, 20])('accepts %i returned records while preserving upstream total count', size => {
    const bookmarks = Array.from({ length: size }, (_, i) => ({
      id: i + 1, title: 'Bookmark ' + i, url: 'https://example.com/' + i
    }));
    const evidence = verifyRaindropOutput({ bookmarks, count: 120 });
    expect(evidence).toMatchObject({ returnedCount: size, totalCount: 120 });
    expect(evidence.recordsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain('https://example.com/');
  });

  it('accepts genuinely empty bookmarks without mistaking the total for page length', () => {
    expect(verifyRaindropOutput({ bookmarks: [], count: 0 }).returnedCount).toBe(0);
  });

  it.each([
    undefined,
    {},
    { count: 0 },
    { bookmarks: null, count: 0 },
    { bookmarks: [{ id: 1 }], count: 0 },
    { bookmarks: [{}], count: -1 },
    { bookmarks: [{}], count: '1' },
    { bookmarks: [{}], count: Number.NaN },
    { bookmarks: [null], count: 1 },
    { bookmarks: Array.from({ length: 21 }, () => ({})), count: 21 }
  ])('rejects invalid result contract without fabricating empty success', outputs => {
    expect(() => verifyRaindropOutput(outputs)).toThrow();
  });
});
