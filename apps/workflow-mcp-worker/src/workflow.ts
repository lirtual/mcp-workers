import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
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
  type CapabilityExecutionResult
} from './execute-capability.js';
import type { EffectiveOperationPolicy } from './effective-policy.js';
import {
  dispatchGitHubExecutor,
  getGitHubRunFact,
  githubExecutorTrust,
  type GitHubDispatchResult
} from './github-executor.js';
import { makeAttemptId, makeStepIdentity } from './identities.js';
import {
  prepareRemoteAttempt,
  type PreparedRemoteAttempt
} from './executor-protocol.js';
import { parseRemoteExecutorResult } from './remote-result.js';
import { asRuntimePlan, resolveRuntimeValue, type RuntimePlan, type RuntimeStep } from './runtime-plan.js';
import { resolveStepExecutionPolicy } from './step-policy.js';
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
    return { stepId: input.stepId, state: 'failed' };
  }

  const identity = await makeStepIdentity(input.runId, input.stepId);
  const dependencyStates = Object.fromEntries(
    definition.needs.map(dependency => [dependency, input.states[dependency] as StepTerminalState])
  );
  const decision = decideStep(definition, dependencyStates, {
    input: input.input,
    stepOutputs: input.stepOutputs
  });

  if (decision.action === 'skip') {
    await input.store.ensureStepRun({
      runId: input.runId,
      stepId: input.stepId,
      stepRunId: identity.stepRunId,
      operationId: identity.operationId,
      effectivePolicy: {
        effect: 'unknown',
        source: 'conservative_default',
        maxAutomaticAttempts: 1,
        defaultAutomaticAttempts: 1
      }
    });
    const state = decision.skipState ?? 'skipped_condition';
    await input.store.markStepSkipped({
      runId: input.runId,
      stepRunId: identity.stepRunId,
      stepId: input.stepId,
      state
    });
    return { stepId: input.stepId, state };
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
        effect: 'unknown',
        source: 'conservative_default',
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

  const capabilityInput = resolved as Record<string, unknown>;
  const policyResolution = await resolveStepExecutionPolicy({
    env: input.env,
    store: input.store,
    stepRunId: identity.stepRunId,
    definition,
    capabilityInput
  });

  await input.store.ensureStepRun({
    runId: input.runId,
    stepId: input.stepId,
    stepRunId: identity.stepRunId,
    operationId: identity.operationId,
    effectivePolicy: policyResolution.policy as unknown as Record<string, unknown>
  });

  if (!policyResolution.ok) {
    await input.store.finishStep({
      runId: input.runId,
      stepRunId: identity.stepRunId,
      stepId: input.stepId,
      state: 'failed',
      errorCode: policyResolution.errorCode,
      errorSummary: policyResolution.errorSummary
    });
    return { stepId: input.stepId, state: 'failed' };
  }

  if (definition.executor === 'github') {
    return runRemoteAttempt({
      env: input.env,
      store: input.store,
      durableStep: input.durableStep,
      runId: input.runId,
      stepId: input.stepId,
      definition,
      stepRunId: identity.stepRunId,
      operationId: identity.operationId,
      maxAttempts: policyResolution.maxAttempts,
      effectivePolicy: policyResolution.policy,
      capabilityInput
    });
  }

  if (definition.executor !== 'cloudflare') {
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

  return runAttempts({
    env: input.env,
    store: input.store,
    durableStep: input.durableStep,
    runId: input.runId,
    stepId: input.stepId,
    definition,
    stepRunId: identity.stepRunId,
    operationId: identity.operationId,
    maxAttempts: policyResolution.maxAttempts,
    effectivePolicy: policyResolution.policy,
    ...(policyResolution.dependencySnapshot
      ? { dependencySnapshot: policyResolution.dependencySnapshot }
      : {}),
    capabilityInput
  });
}

async function runRemoteAttempt(input: {
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
  capabilityInput: Readonly<Record<string, unknown>>;
}): Promise<{ stepId: string; state: StepTerminalState; output?: Record<string, unknown> }> {
  if (input.maxAttempts !== 1) {
    return finishRemoteFailure(input, 'failed', 'REMOTE_RETRY_NOT_IMPLEMENTED',
      'v0.1 GitHub executor currently requires one automatic Attempt.');
  }

  const attemptNumber = 1;
  const attemptId = await makeAttemptId(input.stepRunId, attemptNumber);
  let prepared: PreparedRemoteAttempt;

  try {
    const serialized = await input.durableStep.do(
      `remote:${input.stepId}:attempt:${attemptNumber}:prepare`,
      { retries: { limit: 0, delay: '1 second', backoff: 'constant' }, timeout: '1 minute' },
      async () =>
        JSON.stringify(
          await prepareRemoteAttempt(input.store, {
            runId: input.runId,
            stepRunId: input.stepRunId,
            stepId: input.stepId,
            attemptId,
            attemptNumber,
            trust: githubExecutorTrust(input.env),
            manifest: {
              version: 1,
              runId: input.runId,
              stepRunId: input.stepRunId,
              attemptId,
              operationId: input.operationId,
              capability: input.definition.uses,
              input: { ...input.capabilityInput },
              ...(input.definition.timeoutMs ? { timeoutMs: input.definition.timeoutMs } : {})
            }
          })
        )
    );
    if (typeof serialized !== 'string') throw new Error('Remote Attempt preparation was not serializable.');
    prepared = JSON.parse(serialized) as PreparedRemoteAttempt;
  } catch (error) {
    return finishRemoteFailure(
      input,
      'failed',
      'REMOTE_ATTEMPT_PREPARE_FAILED',
      safeErrorMessage(error)
    );
  }

  const dispatches: GitHubDispatchResult[] = [];
  for (let generation = 1; generation <= 2; generation += 1) {
    const serialized = await input.durableStep.do(
      `remote:${input.stepId}:attempt:${attemptNumber}:dispatch:${generation}`,
      { retries: { limit: 0, delay: '1 second', backoff: 'constant' }, timeout: '1 minute' },
      async () =>
        JSON.stringify(
          await dispatchGitHubExecutor(
            input.env,
            prepared.attemptId,
            prepared.claimNonce,
            { generation }
          )
        )
    );
    if (typeof serialized !== 'string') {
      return finishRemoteFailure(
        input,
        'indeterminate',
        'GITHUB_DISPATCH_UNKNOWN',
        'GitHub dispatch result was not serializable.'
      );
    }

    const dispatch = JSON.parse(serialized) as GitHubDispatchResult;
    dispatches.push(dispatch);
    await input.store.recordExecutorDispatch({
      attemptId: prepared.attemptId,
      generation: dispatch.generation,
      outcome: dispatch.outcome,
      ...(dispatch.workflowRunId ? { returnedGitHubRunId: dispatch.workflowRunId } : {}),
      ...(dispatch.errorSummary ? { errorSummary: dispatch.errorSummary } : {})
    });

    if (dispatch.outcome === 'accepted') break;
    if (dispatch.outcome === 'failed' && !dispatches.some(item => item.outcome === 'unknown')) {
      return finishRemoteAttemptResult(input, attemptId, {
        state: 'failed',
        errorCode: 'GITHUB_DISPATCH_FAILED',
        errorSummary: dispatch.errorSummary ?? 'GitHub executor dispatch was explicitly rejected.'
      });
    }
    if (dispatch.outcome === 'unknown' && generation < 2) continue;
    break;
  }

  const possibleCandidate = dispatches.some(
    dispatch => dispatch.outcome === 'accepted' || dispatch.outcome === 'unknown'
  );
  if (!possibleCandidate) {
    return finishRemoteAttemptResult(input, attemptId, {
      state: 'failed',
      errorCode: 'GITHUB_EXECUTOR_NOT_STARTED',
      errorSummary: 'No GitHub Candidate Job could have started for this Attempt.'
    });
  }

  let callbackId: string | undefined;
  try {
    const wake = await input.durableStep.waitForEvent<{
      kind: string;
      callbackId: string;
    }>(
      `remote:${input.stepId}:attempt:${attemptNumber}:wait`,
      {
        type: prepared.eventType,
        timeout: input.definition.timeoutMs ?? 30 * 60 * 1000
      }
    );
    if (wake.payload.kind === 'result' && wake.payload.callbackId) {
      callbackId = wake.payload.callbackId;
    }
  } catch {
    // wait timeout is only a reconciliation trigger; D1/GitHub facts decide the outcome below.
  }

  const result = await reconcileRemoteAttempt(input, attemptId, callbackId);
  return finishRemoteAttemptResult(input, attemptId, result);
}

async function reconcileRemoteAttempt(
  input: {
    env: Env;
    store: D1WorkflowStore;
    runId: string;
    stepRunId: string;
    stepId: string;
    definition: RuntimeStep;
  },
  attemptId: string,
  callbackId?: string
): Promise<CapabilityExecutionResult> {
  const callback = callbackId
    ? await input.store.getCallbackInbox(callbackId)
    : await input.store.getLatestCallbackForAttempt(attemptId);

  if (
    callback &&
    callback.attemptId === attemptId &&
    callback.callbackKind === 'result' &&
    !callback.ignoredReason
  ) {
    return parseRemoteExecutorResult(input.definition.uses, callback.result);
  }

  const attempt = await input.store.getRemoteAttempt(attemptId);
  if (!attempt) {
    return {
      state: 'failed',
      errorCode: 'REMOTE_ATTEMPT_MISSING',
      errorSummary: 'Remote Attempt disappeared during reconciliation.'
    };
  }

  const dispatchFacts = await input.store.listExecutorDispatches(attemptId);
  const acceptedRunId =
    attempt.githubRunId ??
    [...dispatchFacts]
      .reverse()
      .find(fact => fact.outcome === 'accepted' && fact.returnedGitHubRunId)
      ?.returnedGitHubRunId;

  if (!acceptedRunId) {
    if (dispatchFacts.some(fact => fact.outcome === 'unknown')) {
      return {
        state: 'indeterminate',
        errorCode: 'GITHUB_DISPATCH_UNRESOLVED',
        errorSummary:
          'At least one GitHub dispatch response was ambiguous and no claimed physical run could be reconciled.'
      };
    }
    return {
      state: 'failed',
      errorCode: 'GITHUB_EXECUTOR_NOT_STARTED',
      errorSummary: 'No accepted or claimed GitHub run exists for this Attempt.'
    };
  }

  try {
    const fact = await getGitHubRunFact(input.env, acceptedRunId);
    if (fact.status === 'queued') {
      return {
        state: 'failed',
        errorCode: 'GITHUB_EXECUTOR_UNAVAILABLE',
        errorSummary: 'GitHub Candidate Job remained queued until the Workflow wait deadline.'
      };
    }
    if (fact.status === 'in_progress') {
      return {
        state: 'indeterminate',
        errorCode: 'GITHUB_EXECUTOR_STILL_RUNNING',
        errorSummary: 'GitHub executor is still running after the Workflow wait deadline.'
      };
    }
    if (fact.status === 'completed') {
      if (fact.conclusion === 'success') {
        return {
          state: 'indeterminate',
          errorCode: 'REMOTE_CALLBACK_MISSING',
          errorSummary:
            'Claimed GitHub Job completed successfully but no authoritative result callback is available.'
        };
      }
      return {
        state: 'failed',
        errorCode:
          fact.conclusion === 'cancelled'
            ? 'GITHUB_EXECUTOR_CANCELLED'
            : 'GITHUB_EXECUTOR_FAILED',
        errorSummary: `GitHub executor completed with conclusion "${fact.conclusion ?? 'unknown'}".`
      };
    }
    return {
      state: 'indeterminate',
      errorCode: 'GITHUB_EXECUTOR_STATUS_UNKNOWN',
      errorSummary: 'GitHub executor status could not be classified.'
    };
  } catch (error) {
    return {
      state: 'indeterminate',
      errorCode: 'GITHUB_RECONCILIATION_FAILED',
      errorSummary: safeErrorMessage(error)
    };
  }
}

async function finishRemoteAttemptResult(
  input: {
    store: D1WorkflowStore;
    runId: string;
    stepRunId: string;
    stepId: string;
  },
  attemptId: string,
  result: CapabilityExecutionResult
): Promise<{ stepId: string; state: StepTerminalState; output?: Record<string, unknown> }> {
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

async function finishRemoteFailure(
  input: {
    store: D1WorkflowStore;
    runId: string;
    stepRunId: string;
    stepId: string;
  },
  state: 'failed' | 'indeterminate',
  errorCode: string,
  errorSummary: string
): Promise<{ stepId: string; state: StepTerminalState }> {
  await input.store.finishStep({
    runId: input.runId,
    stepRunId: input.stepRunId,
    stepId: input.stepId,
    state,
    errorCode,
    errorSummary
  });
  return { stepId: input.stepId, state };
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

    const result = await executeDurableAttempt(
      input.env,
      input.durableStep,
      input.stepId,
      attemptNumber,
      input.definition,
      input.operationId,
      input.effectivePolicy,
      input.dependencySnapshot,
      input.capabilityInput
    );

    await input.store.recordAttemptResult({
      runId: input.runId,
      stepRunId: input.stepRunId,
      stepId: input.stepId,
      attemptId,
      state: result.state,
      ...(result.state === 'succeeded' ? { output: result.output } : {}),
      ...(result.state === 'succeeded'
        ? {}
        : { errorCode: result.errorCode, errorSummary: result.errorSummary }),
      ...('dependencySnapshot' in result && result.dependencySnapshot
        ? { dependencySnapshot: result.dependencySnapshot }
        : input.dependencySnapshot
          ? { dependencySnapshot: input.dependencySnapshot }
          : {})
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

    if (attemptNumber < input.maxAttempts) continue;

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
  operationId: string,
  effectivePolicy: EffectiveOperationPolicy,
  dependencySnapshot: Record<string, unknown> | undefined,
  capabilityInput: Readonly<Record<string, unknown>>
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
            ...(dependencySnapshot ? { dependencySnapshot } : {}),
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
