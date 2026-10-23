import type { Plan } from './plan.ts';

export const COMPENSATION_ROW = 'saga:compensation';
export const SAGA_BOUNDARY = 'not_an_acid_rollback';

export type CompensationStepReport = {
  step_id: string;
  status: 'succeeded' | 'failed' | 'indeterminate' | 'uncleared';
  error_code?: string;
};
export type CompensationReport = {
  acid_rollback: false;
  trigger: 'failure' | 'cancel' | null;
  steps: CompensationStepReport[];
};

export function compensationEffectId(stepId: string): string {
  return stepId + ':compensate';
}

export function publishedSaga(plan: Plan) {
  if (!plan.saga) return undefined;
  const compensations = [];
  for (const step of plan.steps) {
    const action = step.compensate;
    if (!action) continue;
    compensations.push({
      step_id: step.id,
      triggers: [...plan.saga.on],
      connection: {
        endpoint: String(action.with.endpoint),
        tool: String(action.with.tool),
        scope: 'write' as const,
      },
      schema_digest: String(action.with.schema_digest),
    });
  }
  return {on: [...plan.saga.on], boundary: SAGA_BOUNDARY, compensations};
}

export function publicCompensation(raw: string | null | undefined): CompensationReport | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {trigger?: unknown; steps?: unknown};
    const trigger = parsed.trigger === 'failure' || parsed.trigger === 'cancel' ? parsed.trigger : null;
    const steps = Array.isArray(parsed.steps) ? parsed.steps.filter(step => step && typeof step === 'object') as CompensationStepReport[] : [];
    return {acid_rollback: false, trigger, steps};
  } catch {
    return {acid_rollback: false, trigger: null, steps: []};
  }
}
