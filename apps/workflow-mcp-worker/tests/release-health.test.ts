import { describe, expect, it, vi } from 'vitest';
import { assertWorkflowMcpHealth } from '../src/release-health.js';

describe('Workflow MCP release health probe', () => {
  it('accepts the healthy runtime payload', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'ok' }));
    await expect(assertWorkflowMcpHealth('https://worker.example', fetchImpl)).resolves.toBeUndefined();
  });

  it('rejects unhealthy responses and malformed payloads', async () => {
    await expect(
      assertWorkflowMcpHealth(
        'https://worker.example',
        vi.fn(async () => new Response('unavailable', { status: 503 }))
      )
    ).rejects.toThrow(/status 503/);
    await expect(
      assertWorkflowMcpHealth(
        'https://worker.example',
        vi.fn(async () => Response.json({ status: 'starting' }))
      )
    ).rejects.toThrow(/payload is invalid/);
  });
});
