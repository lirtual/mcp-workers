import { describe, expect, it } from 'vitest';
import type { McpConnection } from '../src/connections.js';
import {
  allowedAttempts,
  resolveMcpOperationPolicy,
  resolveMcpOperationPolicyForConnection
} from '../src/effective-policy.js';

function customConnection(
  overrides: Partial<McpConnection> = {}
): McpConnection {
  return {
    id: 'custom',
    transport: 'streamable-http',
    protocolVersion: '2026-07-28',
    endpoint: 'https://example.invalid/mcp',
    auth: {
      header: 'Authorization',
      format: 'raw',
      secret: 'TOKEN'
    },
    trustAnnotations: false,
    tools: {},
    ...overrides
  };
}

describe('MCP Effective Operation Policy', () => {
  it('prefers explicit local tool policy over contradictory annotations', () => {
    const policy = resolveMcpOperationPolicy('workflow-self', 'workflow_list', {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false
    });

    expect(policy).toMatchObject({
      effect: 'read',
      source: 'local_tool_policy',
      maxAutomaticAttempts: 3
    });
  });

  it('ignores annotations when a connection does not trust them', () => {
    const policy = resolveMcpOperationPolicy('workflow-self', 'unclassified', {
      readOnlyHint: true
    });

    expect(policy).toMatchObject({
      effect: 'unknown',
      source: 'conservative_default',
      maxAutomaticAttempts: 1
    });
  });

  it('uses annotations only for an explicitly trusted connection', () => {
    const policy = resolveMcpOperationPolicyForConnection(
      customConnection({ trustAnnotations: true }),
      'read_tool',
      { readOnlyHint: true }
    );

    expect(policy).toMatchObject({
      effect: 'read',
      source: 'trusted_mcp_annotation',
      maxAutomaticAttempts: 3
    });
  });

  it('keeps unknown and unsafe writes at one automatic attempt', () => {
    const unknown = resolveMcpOperationPolicyForConnection(
      customConnection(),
      'unknown',
      undefined
    );
    expect(allowedAttempts(unknown, undefined)).toBe(1);
    expect(() => allowedAttempts(unknown, 2)).toThrow(/at most 1/);

    const unsafe = resolveMcpOperationPolicyForConnection(
      customConnection({
        tools: { delete: { effect: 'unsafe_write' } }
      }),
      'delete',
      { idempotentHint: true }
    );
    expect(unsafe.source).toBe('local_tool_policy');
    expect(() => allowedAttempts(unsafe, 2)).toThrow(/at most 1/);
  });
});
