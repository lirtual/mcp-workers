import { httpRead } from './http-read.js';

export interface CapabilityExecutionContext {
  timeoutMs?: number;
}

export type CapabilityExecutionResult =
  | { state: 'succeeded'; output: Record<string, unknown> }
  | { state: 'failed'; errorCode: string; errorSummary: string }
  | { state: 'indeterminate'; errorCode: string; errorSummary: string };

export async function executeCloudflareCapability(
  capability: string,
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContext = {}
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

  return {
    state: 'failed',
    errorCode: 'CAPABILITY_NOT_IMPLEMENTED',
    errorSummary: `Capability "${capability}" is not implemented by the Cloudflare executor yet.`
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown capability error.';
  return message.slice(0, 500);
}
