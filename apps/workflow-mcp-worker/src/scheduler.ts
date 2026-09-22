import { admitScheduledWorkflow } from './admission.js';
import { latestDueOccurrence } from './cron.js';
import { runMaintenanceBatch } from './maintenance.js';
import { getWorkflowRegistry } from './registry.js';
import { asRuntimePlan } from './runtime-plan.js';
import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
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

  // The new path is enabled only when both existing v0.2 gates are explicitly
  // enabled. Legacy production Cron and maintenance continue unchanged.
  const dynamic = env.DYNAMIC_WORKFLOW_REGISTRY_ENABLED === 'true' &&
    env.DYNAMIC_WORKFLOW_ADMISSION_ENABLED === 'true';
  const entries: Array<{
    plan: ReturnType<typeof asRuntimePlan>;
    selected?: { definitionDigest: string; registryRevision: number };
  }> = [];
  if (dynamic) {
    // Never silently truncate active schedules or fall back to bundled YAML
    // after a D1 failure: this would restart an obsolete version.
    const rows = await env.DB.prepare(
      `SELECT a.active_digest, a.registry_revision, d.normalized_plan_json
       FROM workflow_active_definitions a
       JOIN workflow_definition_versions d ON d.definition_digest = a.active_digest
       WHERE a.state = 'enabled' AND a.active_digest IS NOT NULL
         AND d.workflow_id = a.workflow_id
       ORDER BY a.workflow_id`
    ).all<{
      active_digest: string; registry_revision: number; normalized_plan_json: string
    }>();
    for (const row of rows.results) {
      if (!/^[0-9a-f]{64}$/.test(row.active_digest) ||
          !Number.isSafeInteger(row.registry_revision) || row.registry_revision < 1) {
        throw new Error('Invalid active schedule version.');
      }
      const plan = asRuntimePlan(validateVersionedWorkflowPlan(JSON.parse(row.normalized_plan_json)));
      entries.push({ plan, selected: {
        definitionDigest: row.active_digest, registryRevision: row.registry_revision
      } });
    }
  } else {
    for (const entry of getWorkflowRegistry()) entries.push({ plan: asRuntimePlan(entry.plan) });
  }

  for (const { plan, selected } of entries) {
    for (const candidate of plan.triggers) {
      if (!isScheduleTrigger(candidate)) continue;
      if (evaluatedSchedules >= maxSchedules) {
        if (dynamic) throw new Error('Active schedule limit exceeded.');
        break;
      }

      evaluatedSchedules += 1;
      const scheduleKey = `${plan.id}:${candidate.id}`;
      try {
        const state = await store.getSchedulerState(scheduleKey);
        // Missing dynamic cutover is a broken registry invariant. Never
        // backfill from an arbitrary previous minute in that situation.
        if (selected && !state) throw new Error('Schedule cutover cursor is missing.');
        const previousEvaluation = state?.lastEvaluatedAt ?? currentMinute - 60_000;
        const due = latestDueOccurrence({
          cron: candidate.cron,
          timezone: candidate.timezone ?? 'UTC',
          fromExclusive: previousEvaluation,
          toInclusive: currentMinute
        });

        let lastAdmitted = state?.lastAdmittedScheduledTime;
        if (due !== null && (lastAdmitted === undefined || due > lastAdmitted)) {
          const result = await admitScheduledWorkflow(env, plan.id, candidate.id, due, selected);
          lastAdmitted = due;
          if (!result.alreadyAdmitted) admittedRuns += 1;
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
    if (!dynamic && evaluatedSchedules >= maxSchedules) break;
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
