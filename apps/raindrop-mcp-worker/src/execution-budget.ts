export const DEFAULT_READ_RETRIES = 3;
export const MAX_READ_RETRIES = 3;
export const MAX_CONCURRENT_READS = 3;
export const DEFAULT_WALL_MS = 20_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

export function clampReadRetries(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return DEFAULT_READ_RETRIES;
  }
  return Math.min(MAX_READ_RETRIES, value);
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class UnknownWriteError extends Error {
  readonly state = "unknown" as const;
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "UnknownWriteError";
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class ExecutionBudget {
  readonly maxAttempts: number;
  readonly deadlineMs: number;
  readonly fetchTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  attempts = 0;

  constructor(options: {
    maxReadRetries: number;
    nowMs?: number;
    wallMs?: number;
    fetchTimeoutMs?: number;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
  }) {
    const retries = clampReadRetries(options.maxReadRetries);
    this.maxAttempts = retries + 1;
    this.deadlineMs = (options.nowMs ?? Date.now()) + (options.wallMs ?? DEFAULT_WALL_MS);
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  remainingMs(nowMs = Date.now()): number {
    return Math.max(0, this.deadlineMs - nowMs);
  }

  consumeAttempt(): void {
    this.attempts += 1;
    if (this.attempts > this.maxAttempts) {
      throw new BudgetExceededError(
        `Shared attempt budget exhausted after ${this.maxAttempts} attempt(s).`,
      );
    }
  }
}

export class ConcurrencyGate {
  private reads = 0;
  private writeActive = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(isWrite: boolean): Promise<() => void> {
    while (true) {
      if (isWrite) {
        if (!this.writeActive) {
          this.writeActive = true;
          return () => {
            this.writeActive = false;
            this.flush();
          };
        }
      } else if (this.reads < MAX_CONCURRENT_READS) {
        this.reads += 1;
        return () => {
          this.reads -= 1;
          this.flush();
        };
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private flush(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }
}
