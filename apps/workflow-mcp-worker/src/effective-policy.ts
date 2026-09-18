import type { EffectClass } from './capabilities.js';
import { getConnection, getLocalToolPolicy, type McpConnection } from './connections.js';

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
}

export interface EffectiveOperationPolicy {
  effect: EffectClass;
  source: 'capability' | 'local_tool_policy' | 'trusted_mcp_annotation' | 'conservative_default';
  maxAutomaticAttempts: number;
  defaultAutomaticAttempts: number;
  operationIdArgument?: string;
}

export function resolveMcpOperationPolicy(
  connectionId: string,
  toolName: string,
  annotations: McpToolAnnotations | undefined
): EffectiveOperationPolicy {
  const connection = getConnection(connectionId);
  if (!connection) return policyForEffect('unknown', 'conservative_default');
  return resolveMcpOperationPolicyForConnection(connection, toolName, annotations);
}

export function resolveMcpOperationPolicyForConnection(
  connection: McpConnection,
  toolName: string,
  annotations: McpToolAnnotations | undefined
): EffectiveOperationPolicy {
  const local = connection.tools[toolName];
  if (local) {
    return {
      ...policyForEffect(local.effect, 'local_tool_policy'),
      ...(local.operationIdArgument ? { operationIdArgument: local.operationIdArgument } : {})
    };
  }

  if (connection.trustAnnotations) {
    const hinted = policyFromAnnotations(annotations);
    if (hinted) return hinted;
  }

  return policyForEffect('unknown', 'conservative_default');
}

export function compileTimeMcpRetryLimit(connectionId: string, toolName: string): number {
  const local = getLocalToolPolicy(connectionId, toolName);
  if (!local) return 1;
  return policyForEffect(local.effect, 'local_tool_policy').maxAutomaticAttempts;
}

export function configuredConnection(connectionId: string): McpConnection | undefined {
  return getConnection(connectionId);
}

export function allowedAttempts(
  policy: EffectiveOperationPolicy,
  requestedAttempts: number | undefined
): number {
  const value = requestedAttempts ?? policy.defaultAutomaticAttempts;
  if (value < 1 || value > policy.maxAutomaticAttempts) {
    throw new Error(
      `Operation policy "${policy.effect}" permits at most ${policy.maxAutomaticAttempts} automatic attempt(s).`
    );
  }
  return value;
}

function policyFromAnnotations(
  annotations: McpToolAnnotations | undefined
): EffectiveOperationPolicy | null {
  if (!annotations) return null;
  if (annotations.readOnlyHint === true) {
    return policyForEffect('read', 'trusted_mcp_annotation');
  }
  if (annotations.idempotentHint === true) {
    return policyForEffect('idempotent_write', 'trusted_mcp_annotation');
  }
  if (annotations.destructiveHint === true) {
    return policyForEffect('unsafe_write', 'trusted_mcp_annotation');
  }
  return null;
}

function policyForEffect(
  effect: EffectClass,
  source: EffectiveOperationPolicy['source']
): EffectiveOperationPolicy {
  switch (effect) {
    case 'read':
      return { effect, source, maxAutomaticAttempts: 3, defaultAutomaticAttempts: 1 };
    case 'idempotent_write':
      return { effect, source, maxAutomaticAttempts: 2, defaultAutomaticAttempts: 1 };
    case 'unsafe_write':
    case 'unknown':
      return { effect, source, maxAutomaticAttempts: 1, defaultAutomaticAttempts: 1 };
  }
}
