import { describe, expect, it } from 'vitest';
import { resolveRuntimeValue } from '../src/runtime-plan.js';

describe('runtime plan expression resolution', () => {
  it('resolves pinned input and step-output references without consulting the registry', () => {
    const resolved = resolveRuntimeValue(
      {
        url: { $expr: { kind: 'ref', path: ['input', 'url'] } },
        result: { $expr: { kind: 'ref', path: ['steps', 'fetch', 'outputs', 'body'] } }
      },
      {
        input: { url: 'https://example.com/' },
        stepOutputs: { fetch: { body: 'hello' } }
      }
    );

    expect(resolved).toEqual({
      url: 'https://example.com/',
      result: 'hello'
    });
  });
});
