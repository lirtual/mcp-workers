import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { httpRead } from './http-read.js';
import { asRuntimePlan, resolveRuntimeValue } from './runtime-plan.js';
import { D1WorkflowStore } from './storage.js';
import type { Env, WorkflowRunParams } from './types.js';

interface ExecutionOutcome {
  ok: boolean;
  runId: string;
  errorCode?: string;
}

export class WorkflowRuntime extends WorkflowEntrypoint<Env, WorkflowRunParams> {
  override async run(event: WorkflowEvent<WorkflowRunParams>, step: WorkflowStep): Promise<ExecutionOutcome> {
    return step.do(
      'execute-local-workflow',
      {
        retries: { limit: 1, delay: '1 second', backoff: 'constant' },
        timeout: '5 minutes'
      },
      async () => executeSingleLocalRun(this.env, event.payload.runId)
    );
  }
}

export async function executeSingleLocalRun(env: Env, runId: string): Promise<ExecutionOutcome> {
  const store = new D1WorkflowStore(env.DB);
  const run = await store.getRun(runId);
  if (!run) return { ok: false, runId, errorCode: 'RUN_NOT_FOUND' };

  const definition = await store.getDefinition(run.definitionDigest);
  if (!definition) return { ok: false, runId, errorCode: 'PINNED_DEFINITION_NOT_FOUND' };

  const plan = asRuntimePlan(definition.plan);
  const stepEntries = Object.entries(plan.steps);
  const onlyStep = stepEntries[0];

  if (stepEntries.length !== 1 || !onlyStep || onlyStep[1].uses !== 'http.read') {
    return failBeforeStep(store, runId, 'UNSUPPORTED_PLAN', 'T02 runtime accepts one local http.read step.');
  }

  const [stepId, stepDefinition] = onlyStep;
  const stepRunId = `step_${runId}_${stepId}`;
  const operationId = `op_${runId}_${stepId}`;
  const attemptId = `attempt_${runId}_${stepId}_1`;

  await store.markRunRunning(runId);
  await store.startLocalStep({
    runId,
    stepId,
    stepRunId,
    operationId,
    attemptId,
    executorType: 'cloudflare'
  });

  try {
    const resolved = resolveRuntimeValue(stepDefinition.with, { input: run.input, stepOutputs: {} });
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
      throw new Error('Resolved http.read input must be an object.');
    }
    const url = (resolved as Record<string, unknown>).url;
    if (typeof url !== 'string') throw new Error('Resolved http.read URL must be a string.');

    const httpOutput = await httpRead(url);
    const output: Record<string, unknown> = {
      url: httpOutput.url,
      status: httpOutput.status,
      contentType: httpOutput.contentType,
      body: httpOutput.body
    };
    const stepOutputs = { [stepId]: output };
    const workflowOutput = Object.fromEntries(
      Object.entries(plan.outputs).map(([name, value]) => [
        name,
        resolveRuntimeValue(value, { input: run.input, stepOutputs })
      ])
    );

    await store.completeLocalStep({
      runId,
      stepRunId,
      attemptId,
      stepId,
      output,
      workflowOutput
    });
    return { ok: true, runId };
  } catch (error) {
    const summary = safeErrorMessage(error);
    await store.failLocalStep({
      runId,
      stepRunId,
      attemptId,
      stepId,
      code: 'LOCAL_CAPABILITY_FAILED',
      summary
    });
    return { ok: false, runId, errorCode: 'LOCAL_CAPABILITY_FAILED' };
  }
}

async function failBeforeStep(
  store: D1WorkflowStore,
  runId: string,
  code: string,
  summary: string
): Promise<ExecutionOutcome> {
  const stepId = '__runtime__';
  const stepRunId = `step_${runId}_runtime`;
  const attemptId = `attempt_${runId}_runtime_1`;
  await store.markRunRunning(runId);
  await store.startLocalStep({
    runId,
    stepId,
    stepRunId,
    operationId: `op_${runId}_runtime`,
    attemptId,
    executorType: 'cloudflare'
  });
  await store.failLocalStep({ runId, stepRunId, attemptId, stepId, code, summary });
  return { ok: false, runId, errorCode: code };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown local capability error.';
  return message.slice(0, 500);
}
