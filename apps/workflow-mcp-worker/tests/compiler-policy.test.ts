import { describe, expect, it } from 'vitest';
import { compileWorkflowText, type TrustedCompilePolicy } from '../src/compiler.js';

const yaml = `
version: 1
id: external-read
name: External read
triggers:
  - type: manual
steps:
  fetch:
    uses: mcp.call
    retry:
      maxAttempts: 3
    with:
      connection: external
      tool: read_item
      arguments: {}
`;

const policy: TrustedCompilePolicy = {
  revision: 1,
  connections: {
    external: { tools: { read_item: { effect: 'read' } } }
  }
};

describe('v0.2 trusted compile policy', () => {
  it('compiles a non-bundled approved connection from explicit trusted policy', () => {
    const compiled = compileWorkflowText(yaml, 'external.yaml', policy);
    expect(compiled.metadata.id).toBe('external-read');
    expect(compiled.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not hash a policy revision into the immutable plan', () => {
    expect(compileWorkflowText(yaml, 'a.yaml', policy).definitionDigest).toBe(
      compileWorkflowText(yaml, 'b.yaml', { ...policy, revision: 2 }).definitionDigest
    );
  });

  it('fails closed for an unknown connection, unapproved tool, and removed approval', () => {
    expect(() => compileWorkflowText(yaml, 'external.yaml', { ...policy, connections: {} }))
      .toThrow(/connection/i);
    expect(() => compileWorkflowText(yaml.replace('read_item', 'unknown_tool'), 'external.yaml', policy))
      .toThrow(/tool/i);
    expect(() => compileWorkflowText(yaml, 'external.yaml', {
      revision: 2,
      connections: { external: { tools: {} } }
    })).toThrow(/tool/i);
  });

  it('rejects retry elevation for an unsafe operation', () => {
    expect(() => compileWorkflowText(yaml, 'external.yaml', {
      revision: 1,
      connections: { external: { tools: { read_item: { effect: 'unsafe_write' } } } }
    })).toThrow(/permits at most 1/);
  });
});
