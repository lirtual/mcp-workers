import { describe, expect, it } from 'vitest';
import { latestDueOccurrence } from '../src/cron.js';
import {
  T17_CANARY_OCCURRENCE, T17_CANARY_EXPIRES, T17_CANARY_KEY
} from '../src/t17-canary.js';
import {
  parseExpectedT17CanaryUtc, T17_CANARY_EXPECTED_UTC,
  T17_CANARY_SCHEDULE_KEY, verifyScheduledD1
} from '../scripts/scheduled-verification.js';

describe('one-off production Raindrop canary safety', () => {
  it('has the exact approved timestamp and only a 15-minute admission window', () => {
    expect(new Date(T17_CANARY_OCCURRENCE).toISOString()).toBe(T17_CANARY_EXPECTED_UTC);
    expect(T17_CANARY_EXPIRES - T17_CANARY_OCCURRENCE).toBe(15 * 60_000);
    expect(T17_CANARY_KEY).toBe(T17_CANARY_SCHEDULE_KEY);
    expect(latestDueOccurrence({
      cron: '20 17 21 9 *', timezone: 'Asia/Shanghai',
      fromExclusive: T17_CANARY_OCCURRENCE - 60_000, toInclusive: T17_CANARY_OCCURRENCE
    })).toBe(T17_CANARY_OCCURRENCE);
    expect(latestDueOccurrence({
      cron: '20 17 21 9 *', timezone: 'Asia/Shanghai',
      fromExclusive: T17_CANARY_OCCURRENCE - 60_000, toInclusive: T17_CANARY_OCCURRENCE - 60_000
    })).toBeNull();
  });

  it('cannot pass verification before the real clock or with the permanent business occurrence', () => {
    expect(() => parseExpectedT17CanaryUtc(T17_CANARY_EXPECTED_UTC, T17_CANARY_OCCURRENCE))
      .toThrow(/not yet elapsed/);
    expect(() => parseExpectedT17CanaryUtc('2026-09-22T01:00:00.000Z', T17_CANARY_OCCURRENCE + 60_000))
      .toThrow(/fixed authorized/);
    expect(parseExpectedT17CanaryUtc(T17_CANARY_EXPECTED_UTC, T17_CANARY_OCCURRENCE + 61_000))
      .toBe(T17_CANARY_OCCURRENCE);
    expect(() => parseExpectedT17CanaryUtc(T17_CANARY_EXPECTED_UTC, T17_CANARY_EXPIRES))
      .toThrow(/15-minute window/);
  });

  it('correlates only the canary schedule key and single D1 admission', () => {
    const state = [{
      schedule_key: T17_CANARY_SCHEDULE_KEY,
      last_evaluated_at: T17_CANARY_OCCURRENCE,
      last_admitted_scheduled_time: T17_CANARY_OCCURRENCE
    }];
    const row = {
      run_id: 'run_' + 'a'.repeat(40),
      workflow_id: 'raindrop-daily-snapshot',
      state: 'succeeded',
      definition_digest: 'b'.repeat(64),
      engine_version: 'test',
      trigger_type: 'schedule',
      scheduled_time: T17_CANARY_OCCURRENCE,
      source_type: 'schedule',
      source_key: String(T17_CANARY_OCCURRENCE),
      created_at: '2026-09-21T09:20:01Z',
      started_at: '2026-09-21T09:20:02Z',
      ended_at: '2026-09-21T09:20:03Z'
    };
    expect(verifyScheduledD1(state, [row], T17_CANARY_OCCURRENCE, T17_CANARY_SCHEDULE_KEY))
      .toMatchObject({ trigger_type: 'schedule' });
    expect(() => verifyScheduledD1(state, [row], T17_CANARY_OCCURRENCE))
      .toThrow(/schedule key/);
  });
});
