import { describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../../src/db/timeout.js';
import type { PublicError } from '../../src/errors.js';

describe('withTimeout', () => {
  it('fails with QUERY_TIMEOUT and calls cleanup', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const promise = withTimeout(new Promise<string>(() => undefined), 50, cleanup);
    const rejection = expect(promise).rejects.toMatchObject(
      { code: 'QUERY_TIMEOUT' } satisfies Partial<PublicError>
    );

    await vi.advanceTimersByTimeAsync(51);
    await rejection;

    expect(cleanup).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
