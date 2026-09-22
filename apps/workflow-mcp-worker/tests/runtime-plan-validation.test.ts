import { describe, expect, it } from 'vitest';
import { compileWorkflowText } from '../src/compiler.js';
import { validateVersionedWorkflowPlan } from '../src/runtime-plan-validation.js';

const source = `
version: 1
id: versioned-ir
name: Versioned IR
triggers:
  - type: manual
steps:
  fetch:
    uses: http.read
    with:
      url: https://example.com
outputs:
  url: "\${{ steps.fetch.outputs.url }}"
`;

describe('Workers-safe v1 normalized plan boundary', () => {
  const compiled = compileWorkflowText(source);
  it('accepts the existing canonical compiler IR', () => {
    expect(validateVersionedWorkflowPlan(compiled.plan)).toEqual(compiled.plan);
  });

  it('rejects unknown versions, malformed steps and injected properties', () => {
    const plan = compiled.plan as Record<string, unknown>;
    expect(() => validateVersionedWorkflowPlan({ ...plan, dslVersion: 2 })).toThrow();
    expect(() => validateVersionedWorkflowPlan({ ...plan, unexpected: 'untrusted' })).toThrow();
    expect(() => validateVersionedWorkflowPlan({
      ...plan, steps: { fetch: { uses: 'http.read', executor: 'cloudflare', needs: [], with: {}, retryMaxAttempts: 99 } }
    })).toThrow();
  });

  it('rejects cyclic normalized DAG even when all step references exist', () => {
    const plan = compiled.plan as Record<string, unknown>;
    expect(() => validateVersionedWorkflowPlan({
      ...plan,
      steps: {
        first: { uses: 'http.read', executor: 'cloudflare', needs: ['second'], with: {} },
        second: { uses: 'http.read', executor: 'cloudflare', needs: ['first'], with: {} }
      }
    })).toThrow();
  });

  it('rejects an invalid expression AST before runtime interpretation', () => {
    const plan = compiled.plan as Record<string, unknown>;
    expect(() => validateVersionedWorkflowPlan({
      ...plan, outputs: { bad: { $expr: { kind: 'call', name: 'unapproved' } } }
    })).toThrow();
  });
});
