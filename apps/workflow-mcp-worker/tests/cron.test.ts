import { describe, expect, it } from 'vitest';
import { latestDueOccurrence, parseCronExpression, validateTimeZone } from '../src/cron.js';

describe('workflow scheduler cron subset', () => {
  it('supports wildcard, ranges, lists, and stepped numeric fields', () => {
    expect(parseCronExpression('*/5 9-17 * * 1-5')).toMatchObject({
      minute: { values: expect.arrayContaining([0, 5, 55]) },
      hour: { values: expect.arrayContaining([9, 17]) },
      dayOfWeek: { values: [1, 2, 3, 4, 5] }
    });
    expect(parseCronExpression('0 0 1,15 * 0,7').dayOfWeek.values).toEqual([0]);
  });

  it('rejects unsupported or invalid cron syntax', () => {
    expect(() => parseCronExpression('0 0 L * *')).toThrow(/Invalid cron field/);
    expect(() => parseCronExpression('0 0 * *')).toThrow(/five fields/);
    expect(() => parseCronExpression('61 * * * *')).toThrow(/Invalid cron field/);
  });

  it('returns only the latest missed occurrence', () => {
    const from = Date.parse('2026-09-18T00:01:00Z');
    const to = Date.parse('2026-09-18T00:17:00Z');
    expect(
      latestDueOccurrence({
        cron: '*/5 * * * *',
        timezone: 'UTC',
        fromExclusive: from,
        toInclusive: to
      })
    ).toBe(Date.parse('2026-09-18T00:15:00Z'));
  });

  it('evaluates wall-clock cron fields in the configured timezone', () => {
    const due = latestDueOccurrence({
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      fromExclusive: Date.parse('2025-12-31T02:00:00Z'),
      toInclusive: Date.parse('2026-01-01T02:00:00Z')
    });

    expect(due).toBe(Date.parse('2026-01-01T01:00:00Z'));
  });

  it('maps each Shanghai 09:00 boundary to 01:00 UTC without admitting other minutes', () => {
    for (const day of ['2026-09-20', '2026-09-21']) {
      const start = Date.parse(day + 'T00:59:00Z');
      const due = Date.parse(day + 'T01:00:00Z');
      expect(latestDueOccurrence({
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        fromExclusive: start,
        toInclusive: due - 1
      })).toBeNull();
      expect(latestDueOccurrence({
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        fromExclusive: start,
        toInclusive: due
      })).toBe(due);
      expect(latestDueOccurrence({
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        fromExclusive: due,
        toInclusive: due + 60_000
      })).toBeNull();
    }
  });

  it('keeps only the newest Shanghai daily occurrence after several missed days', () => {
    expect(latestDueOccurrence({
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      fromExclusive: Date.parse('2026-09-18T01:00:00Z'),
      toInclusive: Date.parse('2026-09-21T01:01:00Z')
    })).toBe(Date.parse('2026-09-21T01:00:00Z'));
  });

  it('validates IANA timezones', () => {
    expect(() => validateTimeZone('Asia/Shanghai')).not.toThrow();
    expect(() => validateTimeZone('Not/AZone')).toThrow(/Invalid schedule timezone/);
  });
});
