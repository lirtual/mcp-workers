import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_SCHEDULE_KEY,
  SNAPSHOT_WORKFLOW_ID,
  parseExpectedNineAmUtc,
  verifyCompletedDeploy,
  verifyScheduledD1,
  type ScheduledDbRow
} from '../scripts/scheduled-verification.js';

const expected = Date.parse('2026-09-22T01:00:00Z');
const state = [{
  schedule_key: SNAPSHOT_SCHEDULE_KEY,
  last_evaluated_at: expected + 60_000,
  last_admitted_scheduled_time: expected
}];
const row: ScheduledDbRow = {
  run_id: 'run_' + 'a'.repeat(40),
  workflow_id: SNAPSHOT_WORKFLOW_ID,
  state: 'succeeded',
  definition_digest: 'b'.repeat(64),
  engine_version: 'worker-version',
  trigger_type: 'schedule',
  scheduled_time: expected,
  source_type: 'schedule',
  source_key: String(expected),
  created_at: '2026-09-22T01:00:02Z',
  started_at: '2026-09-22T01:00:03Z',
  ended_at: '2026-09-22T01:00:05Z'
};

describe('T17 bounded post-deployment verification', () => {
  it('accepts the true 09:00 Asia/Shanghai UTC occurrence only after it elapsed', () => {
    expect(parseExpectedNineAmUtc('2026-09-22T01:00:00.000Z', expected + 60_000))
      .toBe(expected);
    expect(() => parseExpectedNineAmUtc('2026-09-22T09:00:00Z', expected + 60_000))
      .toThrow(/01:00:00Z/);
    expect(() => parseExpectedNineAmUtc('2026-09-22T01:00:00Z', expected))
      .toThrow(/not yet elapsed/);
    expect(() => parseExpectedNineAmUtc('2026-09-22T01:00:00Z', expected + 49 * 3600_000))
      .toThrow(/48-hour/);
  });

  it('requires the exact unique scheduled admission and durable scheduler state', () => {
    expect(verifyScheduledD1(state, [row], expected)).toEqual(row);
    expect(() => verifyScheduledD1(state, [], expected)).toThrow(/exactly one/);
    expect(() => verifyScheduledD1(state, [row, row], expected)).toThrow(/exactly one/);
    expect(() => verifyScheduledD1(
      [{ ...state[0]!, last_admitted_scheduled_time: null }], [row], expected
    )).toThrow(/does not confirm/);
    expect(() => verifyScheduledD1(state, [{ ...row, trigger_type: 'manual' }], expected))
      .toThrow(/inconsistent/);
    expect(() => verifyScheduledD1(state, [{ ...row, source_key: 'another' }], expected))
      .toThrow(/inconsistent/);
  });

  it('requires successful deployment completion before the real occurrence', () => {
    const deploy = {
      id: 35579720076,
      name: 'Workflow MCP Deploy',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      updated_at: '2026-09-21T08:49:00Z',
      head_sha: 'c'.repeat(40)
    };
    expect(verifyCompletedDeploy(deploy, expected, 35579720076))
      .toMatchObject({ commitSha: 'c'.repeat(40) });
    expect(() => verifyCompletedDeploy({ ...deploy, status: 'in_progress' }, expected, 35579720076))
      .toThrow(/did not complete/);
    expect(() => verifyCompletedDeploy(
      { ...deploy, updated_at: '2026-09-22T01:01:00Z' }, expected, 35579720076
    )).toThrow(/not before/);
    expect(() => verifyCompletedDeploy(deploy, expected, 123)).toThrow(/did not complete/);
  });
});
