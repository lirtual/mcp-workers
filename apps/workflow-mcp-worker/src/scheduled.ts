import { cronEventId, CRON_CONTRACT, PLATFORM_CRON, scheduledMinute } from './cron.ts';
import { cleanError, WorkflowService } from './store.ts';
import type { Env } from './store.ts';

export type ScheduledTick = {
  cron: string;
  scheduledTime: number;
  noRetry?: () => void;
};
const facts = {
  platform_cron: PLATFORM_CRON,
  timezone: CRON_CONTRACT.timezone,
  dst: CRON_CONTRACT.dst,
  minimum_interval_seconds: CRON_CONTRACT.minimum_interval_seconds,
  exactly_once: CRON_CONTRACT.exactly_once,
  gap: CRON_CONTRACT.gap,
};

// Cloudflare calls this once per platform minute. Plans in D1 decide which
// published workflows match that minute, so a user schedule does not redeploy.
export async function handleScheduled(controller: ScheduledTick, env: Env) {
  const empty = {...facts, scheduled_time: null as string | null, scan_truncated: false, admissions: [] as Array<Record<string, unknown>>};
  if (controller.cron !== PLATFORM_CRON || !Number.isFinite(controller.scheduledTime) || controller.scheduledTime < 0 || controller.scheduledTime > Number.MAX_SAFE_INTEGER) {
    controller.noRetry?.();
    return {...empty, ignored: 'unsupported_platform_cron' as const};
  }
  const minute = scheduledMinute(controller.scheduledTime);
  const scheduledTime = new Date(minute).toISOString();
  if (!env.DB || !env.WORKFLOW) return {...empty, scheduled_time: scheduledTime, error: 'workflow_bindings_missing'};
  try {
    const service = new WorkflowService(env);
    const tick = await service.cronTickTargets(minute);
    const admissions = [];
    for (const target of tick.targets) {
      if (target.state !== 'active' && target.state !== 'paused') {
        admissions.push({workflow_id: target.workflow_id, error: 'invalid_cron', exactly_once: false as const});
        continue;
      }
      try {
        const admitted = await service.admitEvent(target.workflow_id, {
          kind: 'cron',
          event: 'cron',
          event_id: cronEventId(minute),
          source: 'worker-scheduled',
          payload: {scheduled_time: scheduledTime},
        });
        admissions.push({workflow_id: target.workflow_id, ...admitted, exactly_once: false as const});
      } catch (error) {
        admissions.push({workflow_id: target.workflow_id, error: cleanError(error), exactly_once: false as const});
      }
    }
    return {...facts, scheduled_time: scheduledTime, scan_truncated: tick.truncated, admissions};
  } catch {
    return {...empty, scheduled_time: scheduledTime, error: 'unavailable'};
  }
}
