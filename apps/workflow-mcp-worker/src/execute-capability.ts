import { getCapabilityDescriptor } from './capabilities.js';
import { getConnection } from './connections.js';
import {
  allowedAttempts,
  resolveMcpOperationPolicy,
  type EffectiveOperationPolicy
} from './effective-policy.js';
import { httpRead } from './http-read.js';
import {
  callMcpTool,
  inspectMcpTool,
  McpToolCallTransportError
} from './mcp-client.js';
import type { Env } from './types.js';

export interface CapabilityExecutionContext {
  env: Env;
  timeoutMs?: number;
  operationId: string;
  effectivePolicy: EffectiveOperationPolicy;
  fetchImpl?: typeof fetch;
}

export interface PreparedCapabilityExecution {
  policy: EffectiveOperationPolicy;
  maxAttempts: number;
  dependencySnapshot?: Record<string, unknown>;
}

export type CapabilityExecutionResult =
  | {
      state: 'succeeded';
      output: Record<string, unknown>;
      dependencySnapshot?: Record<string, unknown>;
    }
  | {
      state: 'failed';
      errorCode: string;
      errorSummary: string;
      dependencySnapshot?: Record<string, unknown>;
    }
  | {
      state: 'indeterminate';
      errorCode: string;
      errorSummary: string;
      dependencySnapshot?: Record<string, unknown>;
    };

export async function prepareCloudflareCapability(
  env: Env,
  capability: string,
  input: Readonly<Record<string, unknown>>,
  requestedAttempts: number | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<PreparedCapabilityExecution> {
  if (capability !== 'mcp.call') {
    const descriptor = getCapabilityDescriptor(capability);
    if (!descriptor) throw new Error(`Unknown capability "${capability}".`);
    const policy: EffectiveOperationPolicy = {
      effect: descriptor.effect,
      source: 'capability',
      maxAutomaticAttempts: descriptor.maxAutomaticAttempts,
      defaultAutomaticAttempts: descriptor.defaultAutomaticAttempts
    };
    return {
      policy,
      maxAttempts: allowedAttempts(policy, requestedAttempts)
    };
  }

  const connectionId = stringField(input, 'connection');
  const toolName = stringField(input, 'tool');
  const connection = getConnection(connectionId);
  if (!connection) throw new Error(`MCP connection "${connectionId}" is not configured.`);

  const inspection = await inspectMcpTool(env, connectionId, toolName, fetchImpl);
  const policy = resolveMcpOperationPolicy(connectionId, toolName, inspection.tool.annotations);
  return {
    policy,
    maxAttempts: allowedAttempts(policy, requestedAttempts),
    dependencySnapshot: inspection.dependencySnapshot
  };
}

export async function executeCloudflareCapability(
  capability: string,
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContext
): Promise<CapabilityExecutionResult> {
  if (capability === 'http.read') {
    const url = input.url;
    if (typeof url !== 'string') {
      return {
        state: 'failed',
        errorCode: 'INVALID_CAPABILITY_INPUT',
        errorSummary: 'http.read requires a string url input.'
      };
    }

    try {
      const result = await httpRead(url, {
        ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}),
        ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {})
      });
      return {
        state: 'succeeded',
        output: {
          url: result.url,
          status: result.status,
          contentType: result.contentType,
          body: result.body
        }
      };
    } catch (error) {
      return {
        state: 'failed',
        errorCode: 'LOCAL_CAPABILITY_FAILED',
        errorSummary: safeErrorMessage(error)
      };
    }
  }

  if (capability === 'mcp.call') {
    const connectionId = stringField(input, 'connection');
    const toolName = stringField(input, 'tool');
    const rawArguments = input.arguments;
    if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
      return {
        state: 'failed',
        errorCode: 'INVALID_CAPABILITY_INPUT',
        errorSummary: 'mcp.call arguments must be an object.'
      };
    }

    const args = { ...(rawArguments as Record<string, unknown>) };
    const operationIdArgument = context.effectivePolicy.operationIdArgument;
    if (operationIdArgument) {
      const existing = args[operationIdArgument];
      if (existing !== undefined && existing !== context.operationId) {
        return {
          state: 'failed',
          errorCode: 'OPERATION_ID_CONFLICT',
          errorSummary: `MCP argument "${operationIdArgument}" conflicts with the stable Operation ID.`
        };
      }
      args[operationIdArgument] = context.operationId;
    }

    try {
      const result = await callMcpTool(
        context.env,
        connectionId,
        toolName,
        args,
        context.fetchImpl ?? fetch
      );
      return {
        state: 'succeeded',
        output: { result: result.result },
        dependencySnapshot: result.dependencySnapshot
      };
    } catch (error) {
      const dependencySnapshot = undefined;
      if (error instanceof McpToolCallTransportError && isUnsafeToRepeat(context.effectivePolicy)) {
        return {
          state: 'indeterminate',
          errorCode: 'MCP_RESULT_UNKNOWN',
          errorSummary: safeErrorMessage(error),
          ...(dependencySnapshot ? { dependencySnapshot } : {})
        };
      }
      return {
        state: 'failed',
        errorCode: classifyMcpError(error),
        errorSummary: safeErrorMessage(error),
        ...(dependencySnapshot ? { dependencySnapshot } : {})
      };
    }
  }

  return {
    state: 'failed',
    errorCode: 'CAPABILITY_NOT_IMPLEMENTED',
    errorSummary: `Capability "${capability}" is not implemented by the Cloudflare executor yet.`
  };
}

function isUnsafeToRepeat(policy: EffectiveOperationPolicy): boolean {
  return policy.effect === 'unsafe_write' || policy.effect === 'unknown';
}

function classifyMcpError(error: unknown): string {
  const message = safeErrorMessage(error);
  if (message.includes('MCP_INPUT_SCHEMA_MISMATCH')) return 'MCP_INPUT_SCHEMA_MISMATCH';
  if (message.includes('was not found')) return 'MCP_TOOL_NOT_FOUND';
  if (message.includes('credential is not configured')) return 'MCP_CONNECTION_NOT_CONFIGURED';
  return 'MCP_CALL_FAILED';
}

function stringField(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Capability input "${key}" must be a non-empty string.`);
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown capability error.';
  return message.slice(0, 500);
}
