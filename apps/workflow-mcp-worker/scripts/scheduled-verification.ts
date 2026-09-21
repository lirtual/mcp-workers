export const SNAPSHOT_WORKFLOW_ID = 'raindrop-daily-snapshot';
export const SNAPSHOT_SCHEDULE_KEY = 'raindrop-daily-snapshot:daily-nine';

export interface ScheduledDbRow {
  run_id: string;
  workflow_id: string;
  state: string;
  definition_digest: string;
  engine_version: string | null;
  trigger_type: string;
  scheduled_time: number;
  source_type: string;
  source_key: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface SchedulerDbState {
  schedule_key: string;
  last_evaluated_at: number;
  last_admitted_scheduled_time: number | null;
}

export function parseExpectedNineAmUtc(input: string, nowMs: number): number {
  if (!/^\d{4}-\d{2}-\d{2}T01:00:00(?:\.000)?Z$/.test(input)) {
    throw new Error('Expected UTC occurrence must be 01:00:00Z (09:00 Asia/Shanghai).');
  }
  const expectedMs = Date.parse(input);
  if (!Number.isFinite(expectedMs) || new Date(expectedMs).toISOString().slice(0, 19) !== input.slice(0, 19)) {
    throw new Error('Expected scheduled occurrence date is invalid.');
  }
  if (nowMs < expectedMs + 60_000) throw new Error('The actual 09:00 occurrence has not yet elapsed.');
  if (nowMs > expectedMs + 48 * 60 * 60_000) {
    throw new Error('Expected occurrence is older than the bounded 48-hour acceptance window.');
  }
  return expectedMs;
}

export function verifyScheduledD1(
  state: SchedulerDbState[],
  rows: ScheduledDbRow[],
  expectedMs: number,
  scheduleKey: string = SNAPSHOT_SCHEDULE_KEY
): ScheduledDbRow {
  if (state.length !== 1 || state[0]?.schedule_key !== scheduleKey) {
    throw new Error('D1 scheduler_state does not contain exactly one expected schedule key.');
  }
  const item = state[0];
  if (item.last_evaluated_at < expectedMs ||
      item.last_admitted_scheduled_time !== expectedMs) {
    throw new Error('D1 scheduler_state does not confirm this scheduled occurrence was admitted.');
  }
  if (rows.length !== 1) {
    throw new Error('D1 scheduled occurrence must have exactly one admission and Run.');
  }
  const row = rows[0]!;
  if (row.workflow_id !== SNAPSHOT_WORKFLOW_ID ||
      row.trigger_type !== 'schedule' ||
      row.source_type !== 'schedule' ||
      row.source_key !== String(expectedMs) ||
      row.scheduled_time !== expectedMs ||
      !/^run_[0-9a-f]{40}$/.test(row.run_id) ||
      !/^[0-9a-f]{64}$/.test(row.definition_digest) ||
      Date.parse(row.created_at) < expectedMs) {
    throw new Error('D1 scheduled Run has inconsistent occurrence or provenance.');
  }
  return row;
}

export function verifyCompletedDeploy(
  run: Record<string, unknown>,
  expectedMs: number,
  expectedId: number
): { commitSha: string; completedAt: string } {
  if (run.id !== expectedId || run.name !== 'Workflow MCP Deploy' ||
      run.event !== 'workflow_dispatch' && run.event !== 'push' ||
      run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Referenced production deploy did not complete successfully.');
  }
  const completedAt = run.updated_at;
  const commitSha = run.head_sha;
  if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt)) ||
      Date.parse(completedAt) >= expectedMs ||
      typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error('Production deployment provenance is missing or not before the scheduled occurrence.');
  }
  return { commitSha, completedAt };
}
