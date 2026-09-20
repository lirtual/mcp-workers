import { UpstreamError, ValidationError } from "../types/mcpErrors.js";

// Product limits are deliberately smaller than the Cloudflare platform ceilings.
// Instances live for one stateless HTTP/MCP request; they are never global.
export const EXECUTION_LIMITS = {
  attempts: 20,
  wallMs: 20_000,
  fetchMs: 8_000,
  requestBytes: 128 * 1024,
  responseBytes: 2 * 1024 * 1024,
  resultBytes: 2 * 1024 * 1024,
  concurrentReads: 3,
} as const;

export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Request.clone() tees the body; awaiting cancellation can hang while\n        // the other branch remains unread. Stop reading immediately instead.\n        void reader.cancel().catch(() => undefined);
        throw new ValidationError("Payload exceeds the configured byte limit");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export class ExecutionBudget {
  private readonly deadline = Date.now() + EXECUTION_LIMITS.wallMs;
  private activeReads = 0;
  private activeWrites = 0;
  private readonly writeQueue: Array<() => void> = [];
  private readonly readQueue: Array<() => void> = [];
  private attemptsUsed = 0;
  private writesStarted = 0;

  get requestCount(): number {
    return this.attemptsUsed;
  }

  get writeAttemptCount(): number {
    return this.writesStarted;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  private async acquireRead(): Promise<() => void> {
    if (this.activeReads >= EXECUTION_LIMITS.concurrentReads) {
      await new Promise<void>((resolve) => this.readQueue.push(resolve));
    }
    this.activeReads++;
    return () => {
      this.activeReads--;
      this.readQueue.shift()?.();
    };
  }

  private async acquireWrite(): Promise<() => void> {
    if (this.activeWrites >= 1) {
      await new Promise<void>((resolve) => this.writeQueue.push(resolve));
    }
    this.activeWrites++;
    return () => {
      this.activeWrites--;
      this.writeQueue.shift()?.();
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.origin !== "https://api.raindrop.io" ||
      !url.pathname.startsWith("/rest/v1/")
    ) {
      throw new ValidationError("Upstream host or path is not allowed");
    }

    const isRead = request.method === "GET";
    const release = isRead ? await this.acquireRead() : await this.acquireWrite();
    try {
      // Count bytes before sending anything; never rely on Content-Length.
      if (request.body) {
        await readBounded(request.clone().body, EXECUTION_LIMITS.requestBytes);
      }
      const remaining = this.remainingMs();
      if (remaining <= 0 || this.attemptsUsed >= EXECUTION_LIMITS.attempts) {
        throw new UpstreamError("Request budget exhausted before upstream submission", {
          submitted: false,
          budget: true,
        });
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(EXECUTION_LIMITS.fetchMs, remaining),
      );
      this.attemptsUsed++;
      if (!isRead) this.writesStarted++;
      try {
        // A redirect must not forward a bearer token to an untrusted host.
        const outgoing = new Request(request, {
          signal: controller.signal,
          redirect: "manual",
        });
        const response = await globalThis.fetch(outgoing);
        if (response.status >= 300 && response.status < 400) {
          throw new UpstreamError("Raindrop returned an unexpected redirect", {
            status: response.status,
            submitted: true,
          });
        }
        const bytes = await readBounded(
          response.body,
          EXECUTION_LIMITS.responseBytes,
        );
        return new Response(bytes.buffer as ArrayBuffer, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        if (error instanceof ValidationError) {
          throw new UpstreamError("Upstream response exceeds the byte limit", {
            submitted: true,
            oversized: true,
          });
        }
        throw new UpstreamError(
          controller.signal.aborted
            ? "Upstream request was aborted or timed out"
            : "Raindrop upstream network request failed",
          { submitted: true, network: true },
        );
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", onAbort);
      }
    } finally {
      release();
    }
  }
}
