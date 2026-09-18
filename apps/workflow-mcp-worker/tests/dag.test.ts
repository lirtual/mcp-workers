import { describe, expect, it } from 'vitest';
import { decideStep, deriveRunTerminalState, readyStepIds } from '../src/dag.js';
import type { RuntimePlan, RuntimeStep } from '../src/runtime-plan.js';

function step(overrides: Partial<RuntimeStep> = {}): RuntimeStep {
  return {
    uses: 'http.read',
    executor: 'cloudflare',
    needs: [],
    with: { url: 'https://example.com/' },
    ...overrides
  };
}

function plan(steps: Record<string, RuntimeStep>): RuntimePlan {
  return {
    dslVersion: 1,
    id: 'dag-test',
    name: 'DAG test',
    inputs: {},
    triggers: [{ type: 'manual' }],
    steps,
    outputs: {}
  };
}

describe('DAG scheduling semantics', () => {
  it('continues an independent branch after another branch fails', () => {
    const workflow = plan({
      a: step(),
      b: step({ needs: ['a'] }),
      c: step()
    });

    expect(readyStepIds(workflow, {})).toEqual(['a', 'c']);
    expect(readyStepIds(workflow, { a: 'failed', c: 'succeeded' })).toEqual(['b']);
    expect(decideStep(workflow.steps.b!, { a: 'failed' }, { input: {}, stepOutputs: {} })).toEqual({
      action: 'skip',
      skipState: 'skipped_dependency'
    });
  });

  it('runs explicit always() after dependency failure', () => {
    const definition = step({
      needs: ['a'],
      if: { kind: 'call', name: 'always' }
    });

    expect(decideStep(definition, { a: 'failed' }, { input: {}, stepOutputs: {} })).toEqual({
      action: 'run'
    });
  });

  it('evaluates failure() and success() from dependency terminal states', () => {
    const failureHandler = step({
      needs: ['a'],
      if: { kind: 'call', name: 'failure' }
    });
    const successHandler = step({
      needs: ['a'],
      if: { kind: 'call', name: 'success' }
    });

    expect(decideStep(failureHandler, { a: 'timed_out' }, { input: {}, stepOutputs: {} }).action).toBe('run');
    expect(decideStep(successHandler, { a: 'timed_out' }, { input: {}, stepOutputs: {} })).toEqual({
      action: 'skip',
      skipState: 'skipped_condition'
    });
  });

  it('can use workflow input and prior outputs in explicit conditions', () => {
    const definition = step({
      needs: ['a'],
      if: {
        kind: 'binary',
        op: 'and',
        left: {
          kind: 'binary',
          op: '==',
          left: { kind: 'ref', path: ['input', 'mode'] },
          right: { kind: 'literal', value: 'go' }
        },
        right: {
          kind: 'binary',
          op: '==',
          left: { kind: 'ref', path: ['steps', 'a', 'outputs', 'status'] },
          right: { kind: 'literal', value: 200 }
        }
      }
    });

    expect(
      decideStep(
        definition,
        { a: 'succeeded' },
        { input: { mode: 'go' }, stepOutputs: { a: { status: 200 } } }
      ).action
    ).toBe('run');
  });

  it('prioritizes indeterminate, then failure, then timeout in final run state', () => {
    expect(deriveRunTerminalState({ a: 'succeeded', b: 'indeterminate' })).toBe('indeterminate');
    expect(deriveRunTerminalState({ a: 'failed', b: 'timed_out' })).toBe('failed');
    expect(deriveRunTerminalState({ a: 'succeeded', b: 'timed_out' })).toBe('timed_out');
    expect(deriveRunTerminalState({ a: 'succeeded', b: 'skipped_condition' })).toBe('succeeded');
  });
});
