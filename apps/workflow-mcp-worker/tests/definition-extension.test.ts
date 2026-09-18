import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileWorkflowText } from '../src/compiler.js';
import { decideStep, readyStepIds, type StepTerminalState } from '../src/dag.js';
import { executeCloudflareCapability } from '../src/execute-capability.js';
import { findWorkflow } from '../src/registry.js';
import { asRuntimePlan, resolveRuntimeValue } from '../src/runtime-plan.js';
import type { EffectiveOperationPolicy } from '../src/effective-policy.js';
import type { Env } from '../src/types.js';
import { readFile } from 'node:fs/promises';

const readPolicy: EffectiveOperationPolicy = {
  effect: 'read',
  source: 'capability',
  maxAutomaticAttempts: 3,
  defaultAutomaticAttempts: 1
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('definition-only workflow extension', () => {
  it('compiles the new definition to the checked-in registry entry', async () => {
    const source = await readFile(
      new URL('../workflows/sequential-http-smoke.yaml', import.meta.url),
      'utf8'
    );
    const compiled = compileWorkflowText(
      source,
      'workflows/sequential-http-smoke.yaml'
    );
    const registered = findWorkflow('sequential-http-smoke');

    expect(registered).toBeDefined();
    expect(registered?.definitionDigest).toBe(compiled.definitionDigest);
    expect(registered?.metadata.stepCapabilities).toEqual(['http.read']);
    expect(registered?.sourcePath).toBe(
      'workflows/sequential-http-smoke.yaml'
    );
  });

  it('runs the registered two-step DAG using only existing runtime primitives', async () => {
    const entry = findWorkflow('sequential-http-smoke');
    expect(entry).toBeDefined();
    const plan = asRuntimePlan(entry!.plan);
    const input = {
      first_url: 'https://first.example.test/',
      second_url: 'https://second.example.test/'
    };
    const states: Record<string, StepTerminalState> = {};
    const stepOutputs: Record<string, Record<string, unknown>> = {};

    const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === input.first_url) {
        return new Response('first-body', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      if (url === input.second_url) {
        return new Response('second-body', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      return new Response('unexpected', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    expect(readyStepIds(plan, states)).toEqual(['first']);
    const first = plan.steps.first!;
    expect(decideStep(first, {}, { input, stepOutputs })).toEqual({
      action: 'run'
    });
    const firstInput = resolveRuntimeValue(first.with, {
      input,
      stepOutputs
    }) as Record<string, unknown>;
    const firstResult = await executeCloudflareCapability(
      first.uses,
      firstInput,
      {
        env: {} as Env,
        operationId: 'op_first',
        effectivePolicy: readPolicy
      }
    );
    expect(firstResult.state).toBe('succeeded');
    if (firstResult.state !== 'succeeded') throw new Error('first step failed');
    states.first = 'succeeded';
    stepOutputs.first = firstResult.output;

    expect(readyStepIds(plan, states)).toEqual(['second']);
    const second = plan.steps.second!;
    expect(
      decideStep(
        second,
        { first: states.first },
        { input, stepOutputs }
      )
    ).toEqual({ action: 'run' });
    const secondInput = resolveRuntimeValue(second.with, {
      input,
      stepOutputs
    }) as Record<string, unknown>;
    const secondResult = await executeCloudflareCapability(
      second.uses,
      secondInput,
      {
        env: {} as Env,
        operationId: 'op_second',
        effectivePolicy: readPolicy
      }
    );
    expect(secondResult.state).toBe('succeeded');
    if (secondResult.state !== 'succeeded') throw new Error('second step failed');
    states.second = 'succeeded';
    stepOutputs.second = secondResult.output;

    expect(readyStepIds(plan, states)).toEqual([]);
    expect(
      resolveRuntimeValue(plan.outputs, { input, stepOutputs })
    ).toEqual({
      first_body: 'first-body',
      second_body: 'second-body'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
