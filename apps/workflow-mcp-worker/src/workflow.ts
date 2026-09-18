import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getCapabilityDescriptor } from './capabilities.js';
import {
  decideStep,
  deriveRunTerminalState,
  isTerminalStepState,
  readyStepIds,
  type StepState,
  type StepTerminalState
} from './dag.js';
import {
  executeCloudflareCapability,
  prepareCloudflareCapability,
  type CapabilityExecutionResult
} from './execute-capability.js';
import type { EffectiveOperationPolicy } from './effective-policy.js';
import { makeAttemptId, makeStepIdentity } from './identities.js';
import { asRuntimePlan, resolveRuntimeValue, type RuntimePlan, type RuntimeStep } from './runtime-plan.js';
import { D1WorkflowStore, type StepSummary } from './storage.js';
import type { Env, WorkflowRunParams } from './types.js';

interface ExecutionOutcome {
  ok: boolean;
  runId: string;
  errorCode?: string;
}

type AttemptResult =
  | CapabilityExecutionResult
  | { state: 'timed_out'; errorCode: string; errorSummary: string };

export class WorkflowRuntime extends WorkflowEntrypoint<Env, WorkflowRunParams> {
  override async run(event: WorkflowEvent<WorkflowRunParams>, step: WorkflowStep): Promise<ExecutionOutcome> {
    return executeDagRun(this.env, event.payload.runId, step);
  }
}

export async function executeDagRun(
  env: Env,
  runId: string,
  durableStep: WorkflowStep
): Promise<ExecutionOutcome> {
  const store = new D1WorkflowStore(env.DB);
  const run = await store.getRun(runId);
  if (!run) return { ok: false, runId, errorCode: 'RUN_NOT_FOUND' };

  const definition = await store.getDefinition(run.definitionDigest);
  if (!definition) return { ok: false, runId, errorCode: 'PINNED_DEFINITION_NOT_FOUND' };

  const plan = asRuntimePlan(definition.plan);
  await store.markRunRunning(runId);

  const existing = await store.listStepSummaries(runId);
  const states: Record<string, StepState> = {};
  const stepOutputs: Record<string, unknown> = {};
  seedTerminalState(existing, states, stepOutputs);

  while (Object.keys(states).length < Object.keys(plan.steps).length) {
    const ready = readyStepIds(plan, states);
    if (ready.length === 0) {
      await store.finishRun({
        runId,
        state: 'failed',
        output: {},
        errorCode: 'DAG_STALLED',
        errorSummary: 'Workflow DAG could not make forward progress.'
      });
      return { ok: false, runId, errorCode: 'DAG_STALLED' };
    }

    const completed = await Promise.all(
      ready.map(stepId =>
        executeReadyStep({
          env,
          store,
          durableStep,
          runId,
          plan,
          stepId,
          input: run.input,
          stepOutputs,
          states
        })
      )
    );

    for (const item of completed) {
      states[item.stepId] = item.state;
      if (item.output) stepOutputs[item.stepId] = item.output;
    }
  }

  const terminalState = deriveRunTerminalState(states);
  const workflowOutput = Object.fromEntries(
    Object.entries(plan.outputs).flatMap(([name, value]) => {
      const resolved = resolveRuntimeValue(value, { input: run.input, stepOutputs });
      return resolved === undefined ? [] : [[name, resolved]];
    })
  );

  const error =
    terminalState === 'indeterminate'
      ? {
          errorCode: 'WORKFLOW_INDETERMINATE',
          errorSummary: 'At least one workflow step has an indeterminate external outcome.'
        }
      : terminalState === 'timed_out'
        ? {
            errorCode: 'WORKFLOW_TIMED_OUT',
            errorSummary: 'At least one workflow step timed out.'
          }
        : terminalState === 'failed'
          ? {
              errorCode: 'WORKFLOW_STEP_FAILED',
              errorSummary: 'At least one workflow step failed.'
            }
          : {};

  await store.finishRun({
    runId,
    state: terminalState,
    output: workflowOutput,
    ...error
  });

  return {
    ok: terminalState === 'succeeded',
    runId,
    ...(terminalState === 'succeeded' ? {} : { errorCode: error.errorCode })
  };
}

async function executeReadyStep(input: {
  env: Env;
  store: D1WorkflowStore;
  durableStep: WorkflowStep;
  runId: string;
  plan: RuntimePlan;
  stepId: string;
  input: Readonly<Record<string, unknown>>;
  stepOutputs: Readonly<Record<string, unknown>>;
  states: Readonly<Record<string, StepState>>;
}): Promise<{ stepId: string; state: StepTerminalState; output?: Record<string, unknown> }> {
  const definition = input.plan.steps[input.stepId];
  if (!definition) {
    return {
      stepId: input.stepId,
      state: 'failed'
    };
  }

  const identity = await makeStepIdentity(input.runId, input.stepId);
  const descriptor = getCapabilityDescriptor(definition.uses);
  const dependencyStates = Object.fromEntries(
    definition.needs.map(dependency => [dependency, input.states[dependency] as StepTerminalState])
  );
  const decision = decideStep(definition, dependencyStates, {
    input: input.input,
    stepOutputs: input.stepOutputs
  });

  if (decision.action === 'skip') {
    const state = decision.skipState ?? 'skipped_condition';
    await input.store.ensureStepRun({
      runId: input.runId,
      stepId: input.stepId,
      stepRunId: identity.stepRunId,
      operationId: identity.operationId,
      effectivePolicy: {
        effect: descriptor?.effect ?? 'unknown',
        source: 'capability',
        maxAutomaticAttempts: descriptor?.maxAutomaticAttempts ?? 1,
        defaultAutomaticAttempts: descriptor?.defaultAutomaticAttempts ?? 1
      }
    });
    await input.store.markStepSkipped({
      runId: input.runId,
      stepRunId: identity.stepRunId,
      stepId: input.stepId,
      state
    });
    return { stepId: input.stepId, state };
  }

  if (definition.executor !== 'cloudflare') {
    await input.store.ensureStepRun({
      runId: input.runId,
      stepId: input.stepId,
      stepRunId: identity.stepRunId,
      operationId: identity.operationId,
      effectivePolicy: {
        effect: descriptor?.effect ?? 'unknown',
        source: 'capability',
        maxAutomaticAttempts: descriptor?.maxAutomaticAttempts ?? 1,
        defaultAutomaticAttempts: descriptor?.defaultAutomaticAttempts ?? 1
      }
    });
    await input.store.finishStep({
      runId: input.runId,
      stepRunId: identity.stepRunId,
      stepId: input.stepId,
      state: 'failed',
      errorCode: 'EXECUTOR_NOT_IMPLEMENTED',
      errorSummary: `Executor "${definition.executor}" is not implemented yet.`
    });
    return { stepId: input.stepId, state: 'failed' };
  }

  const resolved = resolveRuntimeValue(definition.with, {
    input: input.input,
    stepOutputs: input.stepOutputs,
    dependencyStates
  });
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    await input.store.ensureStepRun({
      runId: input.runId,
      stepId: input.stepId,
      stepRunId: identity.stepRunId,
      operationId: identity.operationId,
      effectivePolicy: {
        effect: descriptor?.effect ?? 'unknown',
        source: 'capability',
        maxAutomaticAttempts: 1,
        defaultAutomaticAttempts: 1
      }
    });
    await input.store.finishStep({
      runId: input.runId,
      stepRunId: identity.stepRunId,
      stepId: input.stepId,
      state: 'failed',
      errorCode: 'INVALID_CAPABILITY_INPUT',
      errorSummary: 'Resolved capability input must be an object.'
    });
    return { stepId: input.stepId, state: 'failed' };
  }

  let prepared;
  try {
    prepared = await prepareCloudflareCapability(
      input.env,
      definition.uses,
      resolved as Record<string, unknown>,
      definition.retryMaxAttempts
    );
  } catch (error) {
    await input.store.ensureStepRun({
      runId: input.runId,
      stepId: input.stepId,
      stepRunId: identity.stepRunId,
      operationId: identity.operationId,
      effectivePolicy: {
        effect: descriptor?.effect ?? 'unknown',
        source: 'capability',
        maxAutomaticAttempts: 1,
        defaultAutomaticAttempts: 1
      }
    });
    await input.store.finishStep({
      runId: input.runId,
      stepRunId: identity.stepRunId,
      stepId: input.stepId,
      state: 'failed',
      errorCode: 'CAPABILITY_PREPARATION_FAILED',
      errorSummary: safeErrorMessage(error)
    });
    return { stepId: input.stepId, state: 'failed' };
  }

  await input.store.ensureStepRun({
    runId: input.runId,
    stepId: input.stepId,
    stepRunId: identity.stepRunId,
    operationId: identity.operationId,
    effectivePolicy: prepared.policy as unknown as Record<string, unknown>
  });

  return runAttempts({
    env: input.env,
    store: input.store,
    durableStep: input.durableStep,
    runId: input.runId,
    stepId: input.stepId,
    definition,
    stepRunId: identity.stepRunId,
    operationId: identity.operationId,
    maxAttempts: prepared.maxAttempts,
    effectivePolicy: prepared.policy,
    ...(prepared.dependencySnapshot ? { dependencySnapshot: prepared.dependencySnapshot } : {}),
    capabilityInput: resolved as Record<string, unknown>
  });
}

async function runAttempts(input: {
  env: Env;
  store: D1WorkflowStore;
  durableStep: WorkflowStep;
  runId: string;
  stepId: string;
  definition: RuntimeStep;
  stepRunId: string;
  operationId: string;
  maxAttempts: number;
  effectivePolicy: EffectiveOperationPolicy;
  dependencySnapshot?: Record<string, unknown>;
  capabilityInput: Readonly<Record<string, unknown>>;
}): Promise<{ stepId: string; state: StepTerminalState; output?: Record<string, unknown> }> {
  for (let attemptNumber = 1; attemptNumber <= input.maxAttempts; attemptNumber += 1) {
    const attemptId = await makeAttemptId(input.stepRunId, attemptNumber);
    await input.store.ensureAttempt({
      runId: input.runId,
      stepRunId: input.stepRunId,
      stepId: input.stepId,
      attemptId,
      attemptNumber,
      executorType: input.definition.executor
    });
    if (input.dependencySnapshot) {
      await input.store.recordAttemptDependencySnapshot(attemptId, input.dependencySnapshot);
    }

    const result = await executeDurableAttempt(
      input.env,
      input.durableStep,
      input.stepId,
      attemptNumber,
      input.definition,
      input.capabilityInput,
      input.operationId,
      input.effectivePolicy
    );
    if (result.dependencySnapshot) {
      await input.store.recordAttemptDependencySnapshot(attemptId, result.dependencySnapshot);
    }

    await input.store.recordAttemptResult({
      runId: input.runId,
      stepRunId: input.stepRunId,
      stepId: input.stepId,
      attemptId,
      state: result.state,
      ...(result.state === 'succeeded' ? { output: result.output } : {}),
      ...(result.state === 'succeeded'
        ? {}
        : { errorCode: result.errorCode, errorSummary: result.errorSummary })
    });

    if (result.state === 'succeeded') {
      await input.store.finishStep({
        runId: input.runId,
        stepRunId: input.stepRunId,
        stepId: input.stepId,
        state: 'succeeded',
        output: result.output
      });
      return { stepId: input.stepId, state: 'succeeded', output: result.output };
    }

    if (result.state === 'indeterminate') {
      await input.store.finishStep({
        runId: input.runId,
        stepRunId: input.stepRunId,
        stepId: input.stepId,
        state: 'indeterminate',
        errorCode: result.errorCode,
        errorSummary: result.errorSummary
      });
      return { stepId: input.stepId, state: 'indeterminate' };
    }

    const hasNextAttempt = attemptNumber < input.maxAttempts;
    if (hasNextAttempt) continue;

    await input.store.finishStep({
      runId: input.runId,
      stepRunId: input.stepRunId,
      stepId: input.stepId,
      state: result.state,
      errorCode: result.errorCode,
      errorSummary: result.errorSummary
    });
    return { stepId: input.stepId, state: result.state };
  }

  throw new Error('Attempt loop exhausted without a terminal result.');
}

async function executeDurableAttempt(
  env: Env,
  durableStep: WorkflowStep,
  stepId: string,
  attemptNumber: number,
  definition: RuntimeStep,
  capabilityInput: Readonly<Record<string, unknown>>,
  operationId: string,
  effectivePolicy: EffectiveOperationPolicy
): Promise<AttemptResult> {
  try {
    const serialized = await durableStep.do(
      `step:${stepId}:attempt:${attemptNumber}`,
      {
        retries: { limit: 0, delay: '1 second', backoff: 'constant' },
        timeout: definition.timeoutMs ?? 300_000
      },
      async () =>
        JSON.stringify(
          await executeCloudflareCapability(definition.uses, capabilityInput, {
            env,
            operationId,
            effectivePolicy,
            ...(definition.timeoutMs ? { timeoutMs: definition.timeoutMs } : {})
          })
        )
    );
    if (typeof serialized !== 'string') {
      throw new Error('Durable step returned a non-serializable attempt result.');
    }
    return JSON.parse(serialized) as AttemptResult;
  } catch (error) {
    const summary = safeErrorMessage(error);
    if (/time(?:d)?\s*out|timeout/i.test(summary)) {
      return {
        state: 'timed_out',
        errorCode: 'STEP_TIMED_OUT',
        errorSummary: summary
      };
    }
    return {
      state: 'failed',
      errorCode: 'DURABLE_STEP_FAILED',
      errorSummary: summary
    };
  }
}

function seedTerminalState(
  summaries: readonly StepSummary[],
  states: Record<string, StepState>,
  outputs: Record<string, unknown>
): void {
  for (const summary of summaries) {
    if (!isTerminalStepState(summary.state)) continue;
    states[summary.stepId] = summary.state;
    if (summary.output) outputs[summary.stepId] = summary.output;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown durable step error.';
  return message.slice(0, 500);
}
