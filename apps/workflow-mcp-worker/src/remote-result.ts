import type { CapabilityExecutionResult } from './execute-capability.js';

export function parseRemoteExecutorResult(
  capability: string,
  value: unknown
): CapabilityExecutionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('Remote executor result must be an object.');
  }
  const result = value as Record<string, unknown>;

  if (result.state === 'failed') {
    if (typeof result.errorCode !== 'string' || typeof result.errorSummary !== 'string') {
      return invalid('Remote executor failure result is missing errorCode/errorSummary.');
    }
    return {
      state: 'failed',
      errorCode: result.errorCode.slice(0, 120),
      errorSummary: result.errorSummary.slice(0, 500)
    };
  }

  if (result.state !== 'succeeded') {
    return invalid('Remote executor result state is not supported.');
  }

  if (capability === 'github.archive_markdown') {
    const output = asObject(result.output);
    const artifact = asObject(output?.artifact);
    if (
      !output ||
      !artifact ||
      typeof artifact.artifactId !== 'string' ||
      !/^artifact_[A-Za-z0-9-]+$/.test(artifact.artifactId) ||
      artifact.name !== 'archive.md' ||
      artifact.mediaType !== 'text/markdown' ||
      typeof artifact.size !== 'number' ||
      !Number.isInteger(artifact.size) ||
      artifact.size < 0 ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      typeof artifact.sourceUrl !== 'string'
    ) {
      return invalid('github.archive_markdown returned an invalid output contract.');
    }
    return {
      state: 'succeeded',
      output: {
        artifact: {
          artifactId: artifact.artifactId,
          name: 'archive.md',
          mediaType: 'text/markdown',
          size: artifact.size,
          sha256: artifact.sha256,
          sourceUrl: artifact.sourceUrl
        }
      }
    };
  }

  return invalid(`Remote capability "${capability}" has no registered output contract.`);
}

function invalid(message: string): CapabilityExecutionResult {
  return {
    state: 'failed',
    errorCode: 'INVALID_EXECUTOR_RESULT',
    errorSummary: message
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
