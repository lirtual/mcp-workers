import { resolveRunConnectionPin } from './connection-revocation.js';
import { httpRead } from './http-read.js';
import {
  callMcpTool,
  McpToolCallTransportError,
  McpConnectionDeniedError
} from './mcp-client.js';
import type { EffectiveOperationPolicy } from './effective-policy.js';
import type { Env } from './types.js';

export interface CapabilityExecutionContext {
  env: Env;
  operationId: string;
  runId?: string;
  effectivePolicy: EffectiveOperationPolicy;
  dependencySnapshot?: Record<string, unknown>;
  timeoutMs?: number;
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

export async function executeCloudflareCapability(
  capability: string,
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContext
): Promise<CapabilityExecutionResult> {
  if (capability === 'http.read') {
    return executeHttpRead(input, context);
  }
  if (capability === 'mcp.call') {
    return executeMcpCall(input, context);
  }

  return {
    state: 'failed',
    errorCode: 'CAPABILITY_NOT_IMPLEMENTED',
    errorSummary: `Capability "${capability}" is not implemented by the Cloudflare executor yet.`
  };
}

async function executeHttpRead(
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContext
): Promise<CapabilityExecutionResult> {
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
      ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {})
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

async function executeMcpCall(
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContext
): Promise<CapabilityExecutionResult> {
  const connection = input.connection;
  const tool = input.tool;
  const rawArguments = input.arguments ?? {};

  if (
    typeof connection !== 'string' ||
    typeof tool !== 'string' ||
    !rawArguments ||
    typeof rawArguments !== 'object' ||
    Array.isArray(rawArguments)
  ) {
    return {
      state: 'failed',
      errorCode: 'INVALID_CAPABILITY_INPUT',
      errorSummary: 'mcp.call requires connection, tool, and an arguments object.'
    };
  }

  const argumentsWithIdempotency = applyOperationId(
    rawArguments as Record<string, unknown>,
    context.effectivePolicy,
    context.operationId
  );
  if (argumentsWithIdempotency instanceof Error) {
    return {
      state: 'failed',
      errorCode: 'IDEMPOTENCY_ARGUMENT_CONFLICT',
      errorSummary: argumentsWithIdempotency.message
    };
  }

  try {
    const pinned = context.runId
      ? await resolveRunConnectionPin(context.env.DB, context.runId, connection, tool, context.effectivePolicy.effect)
      : undefined;
    const result = await callMcpTool(
      context.env, connection, tool, argumentsWithIdempotency, fetch,
      pinned ? { db: context.env.DB, pinned } : undefined
    );
    return {
      state: 'succeeded',
      output: { result: result.result },
      dependencySnapshot: result.dependencySnapshot
    };
  } catch (error) {
    if (error instanceof McpConnectionDeniedError) {
      return {
        state: 'failed',
        errorCode: 'MCP_CONNECTION_REVOKED',
        errorSummary: 'Current Connection authority denies this external attempt.'
      };
    }
    if (error instanceof McpToolCallTransportError) {
      if (
        context.effectivePolicy.effect === 'unsafe_write' ||
        context.effectivePolicy.effect === 'unknown'
      ) {
        return {
          state: 'indeterminate',
          errorCode: 'EXTERNAL_RESULT_UNKNOWN',
          errorSummary:
            'MCP transport failed after the tool call may have been transmitted; the operation will not be retried automatically.',
          ...(context.dependencySnapshot
            ? { dependencySnapshot: context.dependencySnapshot }
            : {})
        };
      }
      return {
        state: 'failed',
        errorCode: 'MCP_TRANSPORT_FAILED',
        errorSummary: safeErrorMessage(error),
        ...(context.dependencySnapshot
          ? { dependencySnapshot: context.dependencySnapshot }
          : {})
      };
    }

    return {
      state: 'failed',
      errorCode: 'MCP_CALL_FAILED',
      errorSummary: safeErrorMessage(error),
      ...(context.dependencySnapshot
        ? { dependencySnapshot: context.dependencySnapshot }
        : {})
    };
  }
}

function applyOperationId(
  args: Record<string, unknown>,
  policy: EffectiveOperationPolicy,
  operationId: string
): Record<string, unknown> | Error {
  if (!policy.operationIdArgument) return { ...args };

  const existing = args[policy.operationIdArgument];
  if (existing !== undefined && existing !== operationId) {
    return new Error(
      `MCP invocation already defines "${policy.operationIdArgument}" with a value that conflicts with the stable Operation ID.`
    );
  }

  return {
    ...args,
    [policy.operationIdArgument]: operationId
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown capability error.';
  return message.slice(0, 500);
}
