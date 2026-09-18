import { describe, expect, it } from 'vitest';
import { cancellationBlocksNewStep } from '../src/cancellation-gate.js';
import { decideStep } from '../src/dag.js';
import type { RuntimeStep } from '../src/runtime-plan.js';

describe('run-level cancellation gate', () => {
  it('wins over an always() Step condition', () => {
    const definition: RuntimeStep = {
      uses: 'http.read',
      executor: 'cloudflare',
      needs: ['upstream'],
      if: { kind: 'call', name: 'always' },
      with: { url: 'https://example.com/' }
    };

    expect(
      decideStep(
        definition,
        { upstream: 'failed' },
        { input: {}, stepOutputs: {} }
      )
    ).toEqual({ action: 'run' });
    expect(cancellationBlocksNewStep('cancel_requested')).toBe(true);
  });

  it('does not block normal running state', () => {
    expect(cancellationBlocksNewStep('running')).toBe(false);
  });
});
