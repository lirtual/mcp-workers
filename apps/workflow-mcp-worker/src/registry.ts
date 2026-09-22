import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
import type { Env } from './types.js';
import { workflowRegistry } from './generated/workflow-registry.js';
import type { WorkflowRegistryEntry } from './types.js';

const entries = workflowRegistry as unknown as readonly WorkflowRegistryEntry[];
const byId = new Map(entries.map(entry => [entry.metadata.id, entry] as const));

export function getWorkflowRegistry(): readonly WorkflowRegistryEntry[] {
  return entries;
}

export function findWorkflow(workflowId: string): WorkflowRegistryEntry | undefined {
  return byId.get(workflowId);
}

/**
 * T05 read-only projection. The generated v0.1 registry remains the default.
 * After an explicitly authorized cutover, absence of D1 or invalid source
 * fails closed; never revert to static entries on a D1 fault.
 */
export async function listVisibleWorkflows(env?: Env): Promise<readonly WorkflowRegistryEntry[]> {
  if (env?.DYNAMIC_WORKFLOW_REGISTRY_ENABLED !== 'true') return getWorkflowRegistry();
  if (!env.DB) throw new Error('Dynamic workflow registry storage is unavailable.');
  const page = await env.DB.prepare(
    `SELECT a.workflow_id, a.active_digest, d.normalized_plan_json, d.source_path
     FROM workflow_active_definitions a
     LEFT JOIN workflow_definition_versions d
       ON d.definition_digest = a.active_digest AND d.workflow_id = a.workflow_id
     WHERE a.state = 'enabled' AND a.active_digest IS NOT NULL
     ORDER BY a.workflow_id LIMIT 65`
  ).all<{
    workflow_id: string; active_digest: string; normalized_plan_json: string | null; source_path: string | null
  }>();
  if (page.results.length > 64) throw new Error('Active workflow population exceeds supported bound.');
  let scheduleCount = 0;
  const visible = page.results.map(row => {
    // A dangling active pointer must fail the entire dynamic view. An INNER
    // JOIN would silently omit a previously visible workflow at cutover.
    if (row.normalized_plan_json === null || row.source_path === null) {
      throw new Error('Active workflow is missing its pinned definition.');
    }
    const plan = validateVersionedWorkflowPlan(JSON.parse(row.normalized_plan_json));
    if (plan.id !== row.workflow_id || !/^[0-9a-f]{64}$/.test(row.active_digest)) {
      throw new Error('Active workflow definition is inconsistent.');
    }
    scheduleCount += plan.triggers.filter(trigger => trigger.type === 'schedule').length;
    const metadata: WorkflowRegistryEntry['metadata'] = {
      id: plan.id,
      name: plan.name,
      ...(plan.description ? { description: plan.description } : {}),
      definitionDigest: row.active_digest,
      triggerTypes: plan.triggers.map(trigger => String(trigger.type)),
      inputs: plan.inputs,
      stepCapabilities: [...new Set(Object.values(plan.steps).map(step => step.uses))]
    };
    return {
      sourcePath: row.source_path,
      definitionDigest: row.active_digest,
      metadata,
      plan
    } satisfies WorkflowRegistryEntry;
  });
  if (scheduleCount > 50) throw new Error('Active schedules exceed supported bound.');
  return visible;
}

export async function findVisibleWorkflow(
  workflowId: string,
  env?: Env
): Promise<WorkflowRegistryEntry | undefined> {
  if (env?.DYNAMIC_WORKFLOW_REGISTRY_ENABLED !== 'true') return findWorkflow(workflowId);
  const visible = await listVisibleWorkflows(env);
  return visible.find(entry => entry.metadata.id === workflowId);
}
