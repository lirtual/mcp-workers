import { admitScheduledWorkflow } from './admission.js';
import { latestDueOccurrence } from './cron.js';
import { runMaintenanceBatch } from './maintenance.js';
import { runT17CanaryTick } from './t17-canary.js';
import { getWorkflowRegistry } from './registry.js';
import { asRuntimePlan } from './runtime-plan.js';
import { D1WorkflowStore } from './storage.js';
import type { Env } from './types.js';

interface ScheduleTrigger {
  type: 'schedule';
  id: string;
  cron: string;
  timezone?: string;
  misfire?: 'latest';
}

export interface SchedulerTickResult {
  evaluatedSchedules: number;
  admittedRuns: number;
  maintenanceProcessed: number;
  errors: number;
}

export async function runSchedulerTick(
  env: Env,
  scheduledTime: number,
  options: { maxSchedules?: number; maintenanceLimit?: number } = {}
): Promise<SchedulerTickResult> {
  const store = new D1WorkflowStore(env.DB);
  const currentMinute = Math.floor(scheduledTime / 60_000) * 60_000;
  const maxSchedules = options.maxSchedules ?? 50;
  const maintenanceLimit = options.maintenanceLimit ?? 20;
  let evaluatedSchedules = 0;
  let admittedRuns = 0;
  let errors = 0;

  for (const entry of getWorkflowRegistry()) {
    const plan = asRuntimePlan(entry.plan);
    for (const candidate of plan.triggers) {
      if (!isScheduleTrigger(candidate)) continue;
      if (evaluatedSchedules >= maxSchedules) break;

      evaluatedSchedules += 1;
      const scheduleKey = `${plan.id}:${candidate.id}`;
      try {
        const state = await store.getSchedulerState(scheduleKey);
        const previousEvaluation = state?.lastEvaluatedAt ?? currentMinute - 60_000;
        const due = latestDueOccurrence({
          cron: candidate.cron,
          timezone: candidate.timezone ?? 'UTC',
          fromExclusive: previousEvaluation,
          toInclusive: currentMinute
        });

        let lastAdmitted = state?.lastAdmittedScheduledTime;
        if (due !== null && (lastAdmitted === undefined || due > lastAdmitted)) {
          await admitScheduledWorkflow(env, plan.id, candidate.id, due);
          lastAdmitted = due;
          admittedRuns += 1;
        }

        await store.saveSchedulerState({
          scheduleKey,
          lastEvaluatedAt: currentMinute,
          ...(lastAdmitted === undefined ? {} : { lastAdmittedScheduledTime: lastAdmitted })
        });
      } catch {
        errors += 1;
      }
    }
    if (evaluatedSchedules >= maxSchedules) break;
  }

  // TEMPORARY T17 self-expiring canary, using the existing real Cloudflare minute tick.
  // It cannot fire outside the 2026-09-21 09:20–09:35 UTC acceptance window.
  try {
    if (await runT17CanaryTick(env, scheduledTime)) admittedRuns += 1;
  } catch {
    errors += 1;
  }

  const maintenanceProcessed = await runMaintenanceBatch(env, maintenanceLimit);
  return { evaluatedSchedules, admittedRuns, maintenanceProcessed, errors };
}

function isScheduleTrigger(value: Readonly<Record<string, unknown>>): value is Readonly<ScheduleTrigger> {
  return (
    value.type === 'schedule' &&
    typeof value.id === 'string' &&
    typeof value.cron === 'string' &&
    (value.timezone === undefined || typeof value.timezone === 'string')
  );
}
