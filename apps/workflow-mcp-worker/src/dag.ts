import type { ExpressionAst, RuntimePlan, RuntimeStep } from './runtime-plan.js';
import { evaluateRuntimeExpression } from './runtime-plan.js';

export type StepTerminalState =
  | 'succeeded'
  | 'failed'
  | 'skipped_condition'
  | 'skipped_dependency'
  | 'cancelled'
  | 'timed_out'
  | 'indeterminate';

export type StepState = 'pending' | 'running' | StepTerminalState;

export interface StepDecision {
  action: 'run' | 'skip';
  skipState?: 'skipped_condition' | 'skipped_dependency';
}

const terminal = new Set<StepState>([
  'succeeded',
  'failed',
  'skipped_condition',
  'skipped_dependency',
  'cancelled',
  'timed_out',
  'indeterminate'
]);

export function isTerminalStepState(state: StepState | undefined): state is StepTerminalState {
  return state !== undefined && terminal.has(state);
}

export function readyStepIds(
  plan: RuntimePlan,
  states: Readonly<Record<string, StepState>>
): string[] {
  return Object.entries(plan.steps)
    .filter(([stepId, step]) => {
      if (states[stepId] !== undefined) return false;
      return step.needs.every(dependency => isTerminalStepState(states[dependency]));
    })
    .map(([stepId]) => stepId);
}

export function decideStep(
  step: RuntimeStep,
  dependencyStates: Readonly<Record<string, StepTerminalState>>,
  context: {
    input: Readonly<Record<string, unknown>>;
    stepOutputs: Readonly<Record<string, unknown>>;
  }
): StepDecision {
  if (!step.if) {
    const allSucceeded = step.needs.every(dependency => dependencyStates[dependency] === 'succeeded');
    return allSucceeded ? { action: 'run' } : { action: 'skip', skipState: 'skipped_dependency' };
  }

  const condition = evaluateRuntimeExpression(step.if, {
    input: context.input,
    stepOutputs: context.stepOutputs,
    dependencyStates
  });
  return condition
    ? { action: 'run' }
    : { action: 'skip', skipState: 'skipped_condition' };
}

export function deriveRunTerminalState(
  states: Readonly<Record<string, StepState>>
): 'succeeded' | 'failed' | 'timed_out' | 'indeterminate' {
  const values = Object.values(states);
  if (values.some(state => state === 'indeterminate')) return 'indeterminate';
  if (values.some(state => state === 'failed')) return 'failed';
  if (values.some(state => state === 'timed_out')) return 'timed_out';
  return 'succeeded';
}

export function hasFailureLikeDependency(
  dependencyStates: Readonly<Record<string, StepTerminalState>>
): boolean {
  return Object.values(dependencyStates).some(
    state => state === 'failed' || state === 'timed_out' || state === 'indeterminate'
  );
}

export function statusCallValue(
  expression: Extract<ExpressionAst, { kind: 'call' }>,
  dependencyStates: Readonly<Record<string, StepTerminalState>>
): boolean {
  if (expression.name === 'always') return true;
  if (expression.name === 'failure') return hasFailureLikeDependency(dependencyStates);
  return Object.values(dependencyStates).every(state => state === 'succeeded');
}
