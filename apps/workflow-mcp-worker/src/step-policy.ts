import { getCapabilityDescriptor } from './capabilities.js';
import {
  allowedAttempts,
  resolveMcpOperationPolicy,
  type EffectiveOperationPolicy
} from './effective-policy.js';
import { inspectMcpTool } from './mcp-client.js';
import type { RuntimeStep } from './runtime-plan.js';
import type { D1WorkflowStore } from './storage.js';
import type { Env } from './types.js';

export type StepPolicyResolution =
  | {
      ok: true;
      policy: EffectiveOperationPolicy;
      maxAttempts: number;
      dependencySnapshot?: Record<string, unknown>;
    }
  | {
      ok: false;
      policy: EffectiveOperationPolicy;
      errorCode: string;
      errorSummary: string;
      dependencySnapshot?: Record<string, unknown>;
    };

export async function resolveStepExecutionPolicy(input: {
  env: Env;
  store: D1WorkflowStore;
  stepRunId: string;
  definition: RuntimeStep;
  capabilityInput: Readonly<Record<string, unknown>>;
}): Promise<StepPolicyResolution> {
  const stored = parseStoredPolicy(await input.store.getStepRunPolicy(input.stepRunId));

  if (input.definition.uses !== 'mcp.call') {
    const descriptor = getCapabilityDescriptor(input.definition.uses);
    if (!descriptor) {
      const policy = conservativePolicy();
      return {
        ok: false,
        policy,
        errorCode: 'UNKNOWN_CAPABILITY',
        errorSummary: `Capability "${input.definition.uses}" is not registered.`
      };
    }

    const policy =
      stored ??
      ({
        effect: descriptor.effect,
        source: 'capability',
        maxAutomaticAttempts: descriptor.maxAutomaticAttempts,
        defaultAutomaticAttempts: descriptor.defaultAutomaticAttempts
      } satisfies EffectiveOperationPolicy);

    try {
      return {
        ok: true,
        policy,
        maxAttempts: allowedAttempts(policy, input.definition.retryMaxAttempts)
      };
    } catch (error) {
      return {
        ok: false,
        policy,
        errorCode: 'INVALID_RETRY_POLICY',
        errorSummary: safeMessage(error)
      };
    }
  }

  const connectionId = input.capabilityInput.connection;
  const toolName = input.capabilityInput.tool;
  if (typeof connectionId !== 'string' || typeof toolName !== 'string') {
    const policy = stored ?? conservativePolicy();
    return {
      ok: false,
      policy,
      errorCode: 'INVALID_CAPABILITY_INPUT',
      errorSummary: 'mcp.call requires literal connection and tool values.'
    };
  }

  try {
    const inspection = await inspectMcpTool(input.env, connectionId, toolName);
    const policy =
      stored ?? resolveMcpOperationPolicy(connectionId, toolName, inspection.tool.annotations);

    return {
      ok: true,
      policy,
      maxAttempts: allowedAttempts(policy, input.definition.retryMaxAttempts),
      dependencySnapshot: inspection.dependencySnapshot
    };
  } catch (error) {
    const policy = stored ?? conservativePolicy();
    return {
      ok: false,
      policy,
      errorCode: 'DEPENDENCY_DISCOVERY_FAILED',
      errorSummary: safeMessage(error)
    };
  }
}

function parseStoredPolicy(value: Record<string, unknown> | null): EffectiveOperationPolicy | null {
  if (!value) return null;
  const effect = value.effect;
  const source = value.source;
  const maxAutomaticAttempts = value.maxAutomaticAttempts;
  const defaultAutomaticAttempts = value.defaultAutomaticAttempts;
  const operationIdArgument = value.operationIdArgument;

  if (
    (effect !== 'read' &&
      effect !== 'idempotent_write' &&
      effect !== 'unsafe_write' &&
      effect !== 'unknown') ||
    (source !== 'capability' &&
      source !== 'local_tool_policy' &&
      source !== 'trusted_mcp_annotation' &&
      source !== 'conservative_default') ||
    typeof maxAutomaticAttempts !== 'number' ||
    typeof defaultAutomaticAttempts !== 'number' ||
    (operationIdArgument !== undefined && typeof operationIdArgument !== 'string')
  ) {
    throw new Error('Stored Effective Operation Policy is invalid.');
  }

  return {
    effect,
    source,
    maxAutomaticAttempts,
    defaultAutomaticAttempts,
    ...(operationIdArgument ? { operationIdArgument } : {})
  };
}

function conservativePolicy(): EffectiveOperationPolicy {
  return {
    effect: 'unknown',
    source: 'conservative_default',
    maxAutomaticAttempts: 1,
    defaultAutomaticAttempts: 1
  };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : 'Operation policy resolution failed.').slice(0, 500);
}
