import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeSshResources } from '../src/ssh-lifecycle.ts';

test('a stalled channel close cannot delay the independent SSH transport close attempt', async () => {
  let channelCloseAttempted = false;
  let clientCloseAttempted = false;
  const channel = {
    close: () => {
      channelCloseAttempted = true;
      return new Promise<void>(() => undefined);
    },
  };
  const client = {
    close: async ({ timeout }: { timeout?: number }) => {
      assert.equal(timeout, 1_000);
      clientCloseAttempted = true;
    },
  };
  const started = Date.now();

  await closeSshResources(channel as never, client as never);

  assert.equal(channelCloseAttempted, true);
  assert.equal(clientCloseAttempted, true);
  assert.ok(Date.now() - started < 500, 'transport close must be attempted without waiting for the stalled channel');
});

test('stalled channel and transport cleanup still returns within its hard bound', async () => {
  let clientCloseAttempted = false;
  const channel = { close: () => new Promise<void>(() => undefined) };
  const client = {
    close: () => {
      clientCloseAttempted = true;
      return new Promise<void>(() => undefined);
    },
  };
  const started = Date.now();

  await closeSshResources(channel as never, client as never);

  assert.equal(clientCloseAttempted, true);
  assert.ok(Date.now() - started < 1_500, 'cleanup must return even when both library close promises stall');
});
