import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const app = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const config = join(app, 'tests/e2e/wrangler.jsonc');
const scratch = await mkdtemp(join(tmpdir(), 'ssh-exec-e2e-'));
const authLog = join(scratch, 'fixture-auth.log');
const state = join(scratch, 'wrangler-state');
const hostKey = join(scratch, 'host_key');
const userKey = join(scratch, 'user_key');
const hostId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const encryptionKey = Buffer.alloc(32, 0x87).toString('base64');
const testToken = 'synthetic-mcp-bearer';
const wrongPasswordHostId = '88888888-8888-4888-8888-888888888888';
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { cwd: app, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};
async function availablePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  const ports = await Promise.all(servers.map(server => new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePort((server.address() as { port: number }).port));
  })));
  await Promise.all(servers.map(server => new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))));
  return ports;
}

const [fixturePort, workerPort] = await availablePorts(2);
const keyCommand = (file: string) => run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
keyCommand(hostKey);
keyCommand(userKey);
const fingerprint = run('ssh-keygen', ['-lf', `${hostKey}.pub`, '-E', 'sha256']).split(/\s+/)[1]!;
await writeFile(authLog, '');

const key = await crypto.subtle.importKey('raw', Buffer.from(encryptionKey, 'base64'), 'AES-GCM', false, ['encrypt']);
async function encryptedHost(id: string, password: string): Promise<string> {
  const payload = JSON.stringify({
    name: 'Synthetic exec fixture', group: 'Tests', host: 'fixture.example.test', port: fixturePort,
    username: 'fixture', authMethod: 'password', password,
    fingerprint, initialCommand: 'synthetic-initial-command-do-not-run', termType: 'xterm-256color', encoding: 'utf-8', location: null,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`edgessh:v1:${accountId}:${id}`),
  }, key, new TextEncoder().encode(payload));
  return `v1.${Buffer.from(iv).toString('base64')}.${Buffer.from(encrypted).toString('base64')}`;
}
const encryptedPayload = await encryptedHost(hostId, 'synthetic-password-do-not-use');
const badEncryptedPayload = await encryptedHost(wrongPasswordHostId, 'wrong-synthetic-password');
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const seed = join(scratch, 'seed.sql');
await writeFile(seed, `INSERT INTO workspace_state(id, account_id) VALUES(1, ${quote(accountId)});\nINSERT INTO hosts(id, account_id, encrypted_payload, updated_at) VALUES(${quote(hostId)}, ${quote(accountId)}, ${quote(encryptedPayload)}, 1);\nINSERT INTO hosts(id, account_id, encrypted_payload, updated_at) VALUES(${quote(wrongPasswordHostId)}, ${quote(accountId)}, ${quote(badEncryptedPayload)}, 1);\n`);
run('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'ssh-mcp-local-fixture', '--local', '--config', config,
  '--persist-to', state, '--file', join(app, 'tests/e2e/migrations/0001_fixture_catalog.sql')]);
run('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'ssh-mcp-local-fixture', '--local', '--config', config,
  '--persist-to', state, '--file', seed]);

const fixture = spawn(process.execPath, ['--experimental-strip-types', join(app, 'g0/fixture/server.ts')], {
  cwd: app,
  env: { ...process.env, FIXTURE_PORT: String(fixturePort), FIXTURE_HOST_KEY: hostKey,
    FIXTURE_USER_PUBLIC_KEY: `${userKey}.pub`, FIXTURE_PASSWORD: 'synthetic-password-do-not-use', FIXTURE_AUTH_LOG: authLog },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const wrangler = spawn('pnpm', ['exec', 'wrangler', 'dev', '--local', '--config', config, '--port', String(workerPort),
  '--persist-to', state, '--var', `MCP_ACCESS_TOKEN:${testToken}`, '--var', `ENCRYPTION_KEY:${encryptionKey}`], {
  cwd: app, stdio: ['ignore', 'pipe', 'pipe'],
});
let fixtureOutput = '';
let workerOutput = '';
fixture.stdout.setEncoding('utf8').on('data', (chunk: string) => { fixtureOutput += chunk; });
fixture.stderr.setEncoding('utf8').on('data', (chunk: string) => { fixtureOutput += chunk; });
wrangler.stdout.setEncoding('utf8').on('data', (chunk: string) => { workerOutput += chunk; });
wrangler.stderr.setEncoding('utf8').on('data', (chunk: string) => { workerOutput += chunk; });
const stop = (child: typeof fixture) => { if (child.exitCode === null) child.kill('SIGTERM'); };

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.exitCode !== null || wrangler.exitCode !== null) throw new Error(`fixture/runtime exited early\n${fixtureOutput}\n${workerOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${workerPort}/mcp`, { headers: { authorization: `Bearer ${testToken}` } });
      if (response.status === 405 || response.status === 400) { ready = true; break; }
    } catch { /* wait for local workerd */ }
    await delay(200);
  }
  assert.ok(ready, `local workerd not ready\n${workerOutput}`);

  const endpoint = `http://127.0.0.1:${workerPort}`;
  const call = async (id: number, name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${endpoint}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${testToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const data = responseText.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    assert.ok(data);
    const envelope = JSON.parse(data) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
    const text = envelope.result?.content?.[0]?.text;
    assert.ok(text, data);
    return { value: JSON.parse(text) as Record<string, unknown>, isError: envelope.result?.isError === true };
  };
  const control = async (method: 'PUT' | 'DELETE') => {
    const response = await fetch(`${endpoint}/__fixture/receipt-store-failure`, { method });
    assert.equal(response.status, 204);
  };
  const exec = (id: number, operationId: string, command: string, timeoutMs = 10_000, targetHostId = hostId) =>
    call(id, 'ssh_exec', { host_id: targetHostId, operation_id: operationId, command, timeout_ms: timeoutMs });

  await control('PUT');
  const denied = await exec(1, '55555555-5555-4555-8555-555555555555', 'fixture-output');
  assert.equal(denied.value.error, 'receipt_store_unavailable');
  assert.doesNotMatch(await readFile(authLog, 'utf8'), /exec-command:/, 'failed receipt admission must precede SSH dispatch');
  await control('DELETE');

  const operationId = '55555555-5555-4555-8555-555555555555';
  const first = await exec(2, operationId, 'fixture-output');
  assert.equal(first.value.status, 'completed', `${JSON.stringify(first)}\nfixture: ${await readFile(authLog, 'utf8')}\nworker: ${workerOutput}`);
  assert.equal(first.value.stdout, 'fixture stdout\n');
  assert.equal(first.value.stderr, 'fixture stderr\n');
  assert.equal(first.value.exit_code, 7);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-password-do-not-use|synthetic-initial-command-do-not-run/);

  const replay = await exec(3, operationId, 'fixture-output');
  assert.equal(replay.value.status, 'completed');
  assert.equal(replay.value.stdout, undefined, 'receipt replay returns metadata without replaying remote output');
  const conflict = await exec(4, operationId, 'fixture-output-large');
  assert.equal(conflict.value.error, 'receipt_conflict');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length, 1);

  const status = await call(5, 'get_operation_status', { operation_id: operationId });
  assert.equal(status.value.status, 'completed');
  assert.equal(status.value.stdout, undefined);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-password-do-not-use|synthetic-initial-command-do-not-run/);

  const failedAuth = await call(8, 'ssh_exec', { host_id: wrongPasswordHostId,
    operation_id: '99999999-9999-4999-8999-999999999999', command: 'fixture-output', timeout_ms: 10_000 });
  assert.equal(failedAuth.value.status, 'failed');
  assert.equal(failedAuth.value.error, 'host_unreachable');
  assert.doesNotMatch(JSON.stringify(failedAuth), /wrong-synthetic-password|synthetic-initial-command-do-not-run/);

  const large = await exec(6, '66666666-6666-4666-8666-666666666666', 'fixture-output-large');
  assert.equal(large.value.status, 'completed');
  assert.equal(large.value.truncated, true);
  assert.ok(String(large.value.stdout).length <= 3072);

  const timed = await exec(7, '77777777-7777-4777-8777-777777777777', 'fixture-timeout', 1000);
  assert.equal(timed.value.status, 'unknown');
  assert.equal(timed.value.error, 'unknown_outcome');
  await delay(150);
  const log = await readFile(authLog, 'utf8');
  assert.equal((log.match(/exec-command:fixture-output\n/g) ?? []).length, 1);
  assert.equal((log.match(/exec-command:fixture-output-large\n/g) ?? []).length, 1);
  assert.equal((log.match(/exec-command:fixture-timeout\n/g) ?? []).length, 1);
  assert.ok((log.match(/connection-closed/g) ?? []).length >= 4, 'one-shot SSH connections close after success, authentication failure and timeout');
  console.log('Local MCP → SQLite DO → pinned SSH fixture passed: durable pre-dispatch admission, store-failure fail-closed, same-ID replay suppression, changed-intent conflict, secret-free status receipt, bounded output and timeout/connection close.');
} finally {
  stop(wrangler);
  stop(fixture);
  await delay(150);
  await rm(scratch, { recursive: true, force: true });
}
