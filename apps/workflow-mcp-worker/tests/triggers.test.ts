import { describe, expect, it } from 'vitest';
import { handleWebhookTrigger } from '../src/triggers.js';
import type { Env } from '../src/types.js';

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    MCP_ACCESS_TOKEN: 'portal',
    TRIGGER_SMOKE_WEBHOOK_TOKEN: 'hook-secret',
    ...overrides
  } as unknown as Env;
}

describe('webhook trigger ingress', () => {
  it('rejects missing or invalid trigger authentication before touching runtime bindings', async () => {
    const missing = await handleWebhookTrigger(
      new Request('https://workflow.example/hooks/trigger-http-smoke/inbound', { method: 'POST' }),
      env(),
      'trigger-http-smoke',
      'inbound'
    );
    expect(missing.status).toBe(401);

    const invalid = await handleWebhookTrigger(
      new Request('https://workflow.example/hooks/trigger-http-smoke/inbound', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' }
      }),
      env(),
      'trigger-http-smoke',
      'inbound'
    );
    expect(invalid.status).toBe(401);
  });

  it('requires a stable caller-supplied event key', async () => {
    const response = await handleWebhookTrigger(
      new Request('https://workflow.example/hooks/trigger-http-smoke/inbound', {
        method: 'POST',
        headers: { Authorization: 'Bearer hook-secret' }
      }),
      env(),
      'trigger-http-smoke',
      'inbound'
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'EVENT_KEY_REQUIRED' }
    });
  });

  it('rejects unknown webhook trigger routes', async () => {
    const response = await handleWebhookTrigger(
      new Request('https://workflow.example/hooks/trigger-http-smoke/missing', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer hook-secret',
          'X-Workflow-Event-Key': 'evt-1'
        }
      }),
      env(),
      'trigger-http-smoke',
      'missing'
    );
    expect(response.status).toBe(404);
  });
});
