import { latestDueOccurrence } from './cron.js';
import { admitScheduledWorkflow } from './admission.js';
import { D1WorkflowStore } from './storage.js';
import type { Env } from './types.js';

/**
 * TEMPORARY T17 production canary. This uses the existing minute Cron and the
 * normal scheduled admission/Cloudflare Workflow route, NOT workflow_run.
 * The hard deadline makes it inert even if cleanup is delayed. Remove this
 * module and its scheduler call immediately after evidence collection.
 *
 * 2026-09-21 17:20 Asia/Shanghai = 2026-09-21T09:20:00Z.
 */
export const T17_CANARY_OCCURRENCE = Date.parse('2026-09-21T09:20:00.000Z');
export const T17_CANARY_EXPIRES = Date.parse('2026-09-21T09:35:00.000Z');
export const T17_CANARY_KEY = 'raindrop-daily-snapshot:t17-canary-20260921';

export async function runT17CanaryTick(env: Env, scheduledTime: number): Promise<boolean> {
  const minute = Math.floor(scheduledTime / 60_000) * 60_000;
  if (minute < T17_CANARY_OCCURRENCE || minute >= T17_CANARY_EXPIRES) {
    return false;
  }

  const due = latestDueOccurrence({
    cron: '20 17 21 9 *',
    timezone: 'Asia/Shanghai',
    // Bounded one-off catch-up for slow deployment, never previous days.
    fromExclusive: T17_CANARY_OCCURRENCE - 60_000,
    toInclusive: minute
  });
  if (due !== T17_CANARY_OCCURRENCE) return false;

  const store = new D1WorkflowStore(env.DB);
  const current = await store.getSchedulerState(T17_CANARY_KEY);
  if (current?.lastAdmittedScheduledTime === due) return false;

  await admitScheduledWorkflow(
    env,
    'raindrop-daily-snapshot',
    't17-canary-20260921',
    due
  );
  await store.saveSchedulerState({
    scheduleKey: T17_CANARY_KEY,
    lastEvaluatedAt: minute,
    lastAdmittedScheduledTime: due
  });
  return true;
}
