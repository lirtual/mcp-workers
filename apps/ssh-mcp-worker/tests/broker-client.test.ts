import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHost, getSshHostCredentials, listHosts } from '../src/hosts.ts';
import type { Env } from '../src/types.ts';
import type { HostBroker } from '../src/broker-client.ts';

const cloudcone = 'df4cb05d-30e9-4436-9948-33c05a26cb79';
const pin = 'SHA256:' + 'A'.repeat(43);
const safeHost = {
  id: cloudcone, name: 'CloudCone', group: 'Personal', host: 'example.com', port: 22,
  username: 'root', authMethod: 'password', trustReady: true, readinessReason: 'ready',
} as const;
const credential = {
  id: cloudcone, host: 'example.com', port: 22, username: 'root',
  authMethod: 'password', password: 'SYNTHETIC_DO_NOT_STORE', fingerprint: pin,
} as const;

function brokerEnv(options: { token?: string; deny?: boolean } = {}): { env: Env; calls: string[] } {
  const calls: string[] = [];
  const reply = <T>(value: T) => options.deny
    ? { ok: false as const, error: 'broker_forbidden' as const } : { ok: true as const, value };
  const broker: HostBroker = {
    async listHostMetadata(input) {
      calls.push('list');
      assert.equal(input.token, options.token ?? 'temporary-broker-token-for-tests-only-abcdef');
      return reply({ hosts: [safeHost], nextCursor: null });
    },
    async getHostMetadata(input) {
      calls.push('get');
      assert.equal(input.hostId, cloudcone);
      return reply(safeHost);
    },
    async resolveHostForConnection(input) {
      calls.push('resolve');
      assert.equal(input.hostId, cloudcone);
      return reply(credential);
    },
  };
  const env = {
    EDGE_SSH_BROKER: broker,
    MCP_BROKER_TOKEN: options.token ?? 'temporary-broker-token-for-tests-only-abcdef',
    // These are intentionally absent: broker must not fall back to a production D1 or encryption key.
  } as unknown as Env;
  return { env, calls };
}

test('metadata is sanitized, and credential is fetched only for an actual connection', async () => {
  const { env, calls } = brokerEnv();
  assert.deepEqual(await listHosts(env, { limit: 5 }), { hosts: [safeHost], nextCursor: null });
  assert.deepEqual(await getHost(env, cloudcone), safeHost);
  assert.deepEqual(calls, ['list', 'get']);
  assert.equal(JSON.stringify(await listHosts(env, {})).includes(credential.password), false);
  assert.deepEqual(await getSshHostCredentials(env, cloudcone), credential);
  assert.equal(calls.at(-1), 'resolve');
});

test('a missing caller token never falls back to a local D1', async () => {
  const { env, calls } = brokerEnv();
  delete env.MCP_BROKER_TOKEN;
  await assert.rejects(() => getHost(env, cloudcone), /host_catalog_unavailable/);
  assert.deepEqual(calls, []);
});

test('a denied broker request never falls back to synthetic or production D1', async () => {
  const { env } = brokerEnv({ deny: true });
  await assert.rejects(() => getSshHostCredentials(env, cloudcone), /host_catalog_unavailable/);
  await assert.rejects(() => listHosts(env, {}), /host_catalog_unavailable/);
});

test('broken remote credentials and host-key pins fail closed', async () => {
  const { env } = brokerEnv();
  const old = env.EDGE_SSH_BROKER!;
  env.EDGE_SSH_BROKER = {
    ...old,
    async resolveHostForConnection() {
      return { ok: true, value: { ...credential, fingerprint: '' } };
    },
  };
  await assert.rejects(() => getSshHostCredentials(env, cloudcone), /host_catalog_unavailable/);
});
