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
    await service.expireCronDue();
    const tick = await service.cronTickTargets(minute);
    const due = await service.dueCronTargets();
    const cancellations = await service.overdueCancellationTargets();
    const admissions: Array<Record<string, unknown>> = [];
    const cancellationReconciliations: Array<Record<string, unknown>> = [];
    for (const item of cancellations) {
      try {
        const result = await service.reconcileCancellation(item.id);
        cancellationReconciliations.push({run_id:item.id,cancellation:result});
      } catch (error) {
        cancellationReconciliations.push({run_id:item.id,error:cleanError(error)});
      }
    }
    const seen = new Set<string>();
    const admit = async (workflowId: string, state: string, scheduledMs: number) => {
      const eventId = cronEventId(scheduledMs);
      const key = workflowId + '\0' + eventId;
      if (seen.has(key)) return;
      seen.add(key);
      if (state !== 'active' && state !== 'paused') {
        admissions.push({workflow_id: workflowId, error: 'invalid_cron', exactly_once: false as const});
        try { await service.clearCronDue(workflowId, eventId); } catch { /* Keep the admission error. */ }
        return;
      }
      try {
        const admitted = await service.admitEvent(workflowId, {
          kind: 'cron',
          event: 'cron',
          event_id: eventId,
          source: 'worker-scheduled',
          payload: {scheduled_time: new Date(scheduledMs).toISOString()},
        });
        await service.clearCronDue(workflowId, eventId);
        admissions.push({workflow_id: workflowId, ...admitted, exactly_once: false as const});
      } catch (error) {
        const code = cleanError(error);
        try {
          if (code === 'run_capacity_exceeded') await service.rememberCronDue(workflowId, scheduledMs, eventId);
          else await service.clearCronDue(workflowId, eventId);
        } catch (persistError) {
          admissions.push({workflow_id: workflowId, error: code, due_persistence_error:cleanError(persistError), exactly_once: false as const});
          return;
        }
        admissions.push({workflow_id: workflowId, error: code, exactly_once: false as const});
      }
    };
    for (const item of due) await admit(item.workflow_id, item.state, item.scheduled_ms);
    for (const target of tick.targets) await admit(target.workflow_id, target.state, minute);
    return {...facts, scheduled_time: scheduledTime, scan_truncated: tick.truncated, admissions, cancellation_reconciliations:cancellationReconciliations};
  } catch {
    return {...empty, scheduled_time: scheduledTime, error: 'unavailable'};
  }
}
