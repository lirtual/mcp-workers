import { describe, expect, it } from 'vitest';
import {
  compileWorkflowText,
  generateRegistrySource,
  parseExpression
} from '../src/compiler.js';

const base = `
version: 1
id: compile-smoke
name: Compile smoke
inputs:
  url:
    type: string
triggers:
  - type: manual
steps:
  fetch:
    uses: http.read
    with:
      url: "\${{ input.url }}"
outputs:
  body: "\${{ steps.fetch.outputs.body }}"
`;

describe('workflow compiler', () => {
  it('produces the same digest for formatting and comments-only changes', () => {
    const first = compileWorkflowText(base, 'one.yaml');
    const second = compileWorkflowText(
      `# comment
version: 1
id: compile-smoke
name: Compile smoke

inputs:
  url: # another comment
    type: string
triggers:
  - type: manual
steps:
  fetch:
    uses: http.read
    with:
      url: "\${{   input.url   }}"
outputs:
  body: "\${{ steps.fetch.outputs.body }}"
`,
      'two.yaml'
    );

    expect(second.definitionDigest).toBe(first.definitionDigest);
  });

  it('normalizes expressions into a parsed AST', () => {
    expect(parseExpression('input.count >= 2 and not failure()')).toEqual({
      kind: 'binary',
      op: 'and',
      left: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'ref', path: ['input', 'count'] },
        right: { kind: 'literal', value: 2 }
      },
      right: {
        kind: 'unary',
        op: 'not',
        expr: { kind: 'call', name: 'failure' }
      }
    });
  });

  it('rejects cycles, unknown capabilities, and invalid references', () => {
    expect(() =>
      compileWorkflowText(`
version: 1
id: cycle
name: Cycle
triggers:
  - type: manual
steps:
  a:
    uses: http.read
    needs: b
    with:
      url: https://example.com
  b:
    uses: http.read
    needs: a
    with:
      url: https://example.com
`)
    ).toThrow(/cycle/i);

    expect(() =>
      compileWorkflowText(base.replace('http.read', 'unknown.capability'))
    ).toThrow(/Unknown capability/);

    expect(() =>
      compileWorkflowText(base.replace('input.url', 'input.missing'))
    ).toThrow(/unknown workflow input/i);
  });

  it('rejects unknown capability inputs and unsafe retry elevation', () => {
    expect(() =>
      compileWorkflowText(base.replace('url: "${{ input.url }}"', 'other: value'))
    ).toThrow(/unknown input/i);

    expect(() =>
      compileWorkflowText(
        base.replace('with:\n      url:', 'retry:\n      maxAttempts: 4\n    with:\n      url:')
      )
    ).toThrow(/permits at most 3/);
  });

  it('rejects plans larger than 256 KiB after normalization', () => {
    const huge = 'x'.repeat(270_000);
    expect(() =>
      compileWorkflowText(`
version: 1
id: huge
name: Huge
triggers:
  - type: manual
steps:
  archive:
    uses: github.archive_markdown
    with:
      content: "${huge}"
`)
    ).toThrow(/maximum is 262144/);
  });

  it('validates webhook secret references and schedule cron syntax at build time', () => {
    expect(() =>
      compileWorkflowText(`
version: 1
id: bad-webhook
name: Bad webhook
triggers:
  - type: webhook
    id: inbound
steps:
  fetch:
    uses: http.read
    with:
      url: https://example.com/
`)
    ).toThrow();

    expect(() =>
      compileWorkflowText(`
version: 1
id: bad-cron
name: Bad cron
triggers:
  - type: schedule
    id: bad
    cron: "0 0 L * *"
steps:
  fetch:
    uses: http.read
    with:
      url: https://example.com/
`)
    ).toThrow(/Invalid cron field/);
  });

  it('emits generated registry entries in workflow-id order', () => {
    const b = compileWorkflowText(base.replaceAll('compile-smoke', 'z-workflow'), 'z.yaml');
    const a = compileWorkflowText(base.replaceAll('compile-smoke', 'a-workflow'), 'a.yaml');
    const source = generateRegistrySource([b, a]);
    expect(source.indexOf('"a-workflow"')).toBeLessThan(source.indexOf('"z-workflow"'));
  });
});
