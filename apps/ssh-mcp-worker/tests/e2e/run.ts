import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
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
let fixtureOutput = '';
let workerOutput = '';
fixture.stdout.setEncoding('utf8').on('data', (chunk: string) => { fixtureOutput += chunk; });
fixture.stderr.setEncoding('utf8').on('data', (chunk: string) => { fixtureOutput += chunk; });
const stop = (child: typeof fixture) => { if (child.exitCode === null) child.kill('SIGTERM'); };
let wrangler: ReturnType<typeof spawn> | undefined;
const startWorker = () => {
  const child = spawn('pnpm', ['exec', 'wrangler', 'dev', '--local', '--config', config, '--port', String(workerPort),
    '--persist-to', state, '--var', `MCP_ACCESS_TOKEN:${testToken}`, '--var', `ENCRYPTION_KEY:${encryptionKey}`], {
    cwd: app, stdio: ['ignore', 'pipe', 'pipe'],
  });
  wrangler = child;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { workerOutput += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { workerOutput += chunk; });
};
const waitForWorker = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.exitCode !== null || (wrangler && wrangler.exitCode !== null)) throw new Error(`fixture/runtime exited early\n${fixtureOutput}\n${workerOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${workerPort}/mcp`, { headers: { authorization: `Bearer ${testToken}` } });
      if (response.status === 405 || response.status === 400) return;
    } catch { /* wait for local workerd */ }
    await delay(200);
  }
  throw new Error(`local workerd not ready\n${workerOutput}`);
};
const stopWorker = async () => {
  const child = wrangler;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
};
const restartWorker = async () => {
  await stopWorker();
  startWorker();
  await waitForWorker();
};

try {
  startWorker();
  await waitForWorker();

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
  const control = async (method: 'PUT' | 'DELETE', path = 'receipt-store-failure') => {
    const response = await fetch(`${endpoint}/__fixture/${path}`, { method });
    assert.equal(response.status, 204);
  };
  const exec = (id: number, operationId: string, command: string, timeoutMs = 10_000, targetHostId = hostId) =>
    call(id, 'ssh_exec', { host_id: targetHostId, operation_id: operationId, command, timeout_ms: timeoutMs });
  const fixtureRequest = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${endpoint}/__fixture/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (response.status !== 204 && response.status !== 200) throw new Error(await response.text());
    return response.status === 200 ? response.json() as Promise<{ digest: string; status: string; result_json: string | null }> : undefined;
  };
  const digestVector = async (intent: Record<string, unknown>) => {
    const response = await fetch(`${endpoint}/__fixture/digest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intent),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ digest: string }>;
  };

  await control('PUT');
  const denied = await exec(1, '55555555-5555-4555-8555-555555555555', 'fixture-output');
  assert.equal(denied.value.error, 'receipt_store_unavailable');
  assert.doesNotMatch(await readFile(authLog, 'utf8'), /exec-command:/, 'failed receipt admission must precede SSH dispatch');
  await control('DELETE');

  const dispatchCountBeforeRunningFailure = (await readFile(authLog, 'utf8')).match(/exec-command:/g)?.length ?? 0;
  await control('PUT', 'running-update-failure');
  const runningUpdateFailure = await exec(9, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'fixture-output');
  assert.equal(runningUpdateFailure.value.error, 'receipt_store_unavailable');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:/g)?.length ?? 0, dispatchCountBeforeRunningFailure,
    'running receipt failure must not dispatch SSH exec');
  await control('DELETE', 'running-update-failure');
  await restartWorker();
  const preDispatchStatus = await call(10, 'get_operation_status', { operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.equal(preDispatchStatus.value.status, 'unknown', 'a DO restart converts admitted work with no live dispatch to an unknown tombstone');
  const preDispatchReplay = await exec(11, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'fixture-output');
  assert.equal(preDispatchReplay.value.status, 'unknown');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:/g)?.length ?? 0, dispatchCountBeforeRunningFailure,
    'replaying a pre-dispatch admission after restart does not dispatch SSH');
  const afterRunningUpdateFailure = await exec(10, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'fixture-output');
  assert.equal(afterRunningUpdateFailure.value.status, 'completed', 'a failed running receipt update must release its host lease');

  const uncertainId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const dispatchCountBeforeCommitFailure = (await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length ?? 0;
  await control('PUT', 'terminal-update-failure');
  const commitFailure = await exec(12, uncertainId, 'fixture-output');
  assert.equal(commitFailure.value.status, 'unknown', 'an effect whose terminal receipt cannot be committed is unknown');
  assert.equal(commitFailure.value.error, 'unknown_outcome');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length, dispatchCountBeforeCommitFailure + 1,
    'the synthetic remote effect occurred before the receipt commit failure');
  await stopWorker();
  startWorker();
  await waitForWorker();
  await control('DELETE', 'terminal-update-failure');
  const afterEffectStatus = await call(13, 'get_operation_status', { operation_id: uncertainId });
  assert.equal(afterEffectStatus.value.status, 'unknown', 'restart preserves the ambiguous receipt as unknown');
  const afterEffectReplay = await exec(14, uncertainId, 'fixture-output');
  assert.equal(afterEffectReplay.value.status, 'unknown');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length, dispatchCountBeforeCommitFailure + 1,
    'retry after effect/receipt-commit failure never repeats the remote command');

  const operationId = '55555555-5555-4555-8555-555555555555';
  const outputDispatchCountBeforePrimary = (await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length ?? 0;
  const first = await exec(2, operationId, 'fixture-output');
  assert.equal(first.value.status, 'completed', `${JSON.stringify(first)}\nfixture: ${await readFile(authLog, 'utf8')}\nworker: ${workerOutput}`);
  assert.equal(first.value.stdout, 'fixture stdout\n');
  assert.equal(first.value.stderr, 'fixture stderr\n');
  assert.equal(first.value.exit_code, 7);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-password-do-not-use|synthetic-initial-command-do-not-run/);
  const storedReceipt = await fixtureRequest('read-receipt', { operationId });
  assert.ok(storedReceipt);
  assert.equal(storedReceipt.digest, 'IDVXGZQrd7jGHolI8dsfxuOSCeG0RDgWEJ+ShIGJvCg=', 'the canonical JSON tuple and SHA-256 encoding are a stable cross-version vector');
  assert.doesNotMatch(JSON.stringify(storedReceipt), /fixture-output|fixture stdout|fixture stderr|synthetic-password|synthetic-initial-command/,
    'durable receipts contain intent digest and bounded status metadata, not command or remote output');
  const execDigest = await digestVector({ tool: 'ssh_exec', hostId, sessionId: null, normalizedArgs: ['fixture-output', 10_000] });
  const inputDigest = await digestVector({ tool: 'ssh_session_input', hostId, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', normalizedArgs: ['hello\n'] });
  const sftpDigest = await digestVector({ tool: 'sftp_write', hostId, sessionId: null, normalizedArgs: ['/fixture/out.txt', 'héllo', false] });
  assert.equal(execDigest.digest, 'IDVXGZQrd7jGHolI8dsfxuOSCeG0RDgWEJ+ShIGJvCg=');
  assert.equal(inputDigest.digest, 'vOxKJQLNWWY3mkpjb897VJQNYpDhKuL8n5uF5hQRf1I=');
  assert.equal(sftpDigest.digest, 'YajeZaNlhjYrjAac/KjGvf/QQODQ9uoEzjzViqgLlIA=');

  const replay = await exec(3, operationId, 'fixture-output');
  assert.equal(replay.value.status, 'completed');
  assert.equal(replay.value.stdout, undefined, 'receipt replay returns metadata without replaying remote output');
  const conflict = await exec(4, operationId, 'fixture-output-large');
  assert.equal(conflict.value.error, 'receipt_conflict');
  const hostConflict = await exec(15, operationId, 'fixture-output', 10_000, wrongPasswordHostId);
  assert.equal(hostConflict.value.error, 'receipt_conflict');
  const timeoutConflict = await exec(16, operationId, 'fixture-output', 11_000);
  assert.equal(timeoutConflict.value.error, 'receipt_conflict');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length, outputDispatchCountBeforePrimary + 1);

  const concurrentId = '12121212-1212-4212-8212-121212121212';
  const beforeConcurrent = (await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length ?? 0;
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) => exec(20 + index, concurrentId, 'fixture-output')));
  assert.ok(concurrent.every(result => ['running', 'completed'].includes(String(result.value.status))));
  const concurrentStatus = await call(28, 'get_operation_status', { operation_id: concurrentId });
  assert.equal(concurrentStatus.value.status, 'completed');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length, beforeConcurrent + 1,
    'concurrent external MCP calls for one operation ID admit exactly one SSH dispatch');

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
  assert.equal((log.match(/exec-command:fixture-output\n/g) ?? []).length, outputDispatchCountBeforePrimary + 2,
    'primary and concurrent operations each dispatch exactly once');
  assert.equal((log.match(/exec-command:fixture-output-large\n/g) ?? []).length, 1);
  assert.equal((log.match(/exec-command:fixture-timeout\n/g) ?? []).length, 1);
  const stalledId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const started = Date.now();
  const stalled = await Promise.race([
    exec(11, stalledId, 'fixture-stalled-exec-ack', 1_000),
    delay(3500).then(() => { throw new Error('operation deadline did not bound stalled SSH exec acknowledgement'); }),
  ]);
  assert.equal(stalled.value.status, 'unknown');
  assert.ok(Date.now() - started < 3_000, 'stalled exec acknowledgement must return within the operation deadline and bounded cleanup');
  const stalledReplay = await exec(12, stalledId, 'fixture-stalled-exec-ack', 1_000);
  assert.equal(stalledReplay.value.status, 'unknown');
  const afterStalledAck = await exec(13, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'fixture-output');
  assert.equal(afterStalledAck.value.status, 'completed', 'a stalled exec acknowledgement must not retain the host lease');
  const finalLog = await readFile(authLog, 'utf8');
  assert.equal((finalLog.match(/exec-command:fixture-stalled-exec-ack\n/g) ?? []).length, 1, 'replaying an uncertain dispatch must not send it again');
  const stalledConnectionId = finalLog.match(/stalled-ack-open:(\d+)/)?.[1];
  assert.ok(stalledConnectionId, 'fixture should identify the stalled SSH peer connection');
  assert.match(finalLog, new RegExp(`connection-closed:${stalledConnectionId}\\n`), 'transport close must reach the stalled SSH peer');
  assert.ok((finalLog.match(/connection-closed/g) ?? []).length >= 7, 'one-shot SSH connections close after success, authentication failure and timeout');
  await fixtureRequest('age-receipt', { operationId, createdAt: Date.now() - 31 * 24 * 60 * 60 * 1000 });
  const oldUnknownId = '77777777-7777-4777-8777-777777777777';
  await fixtureRequest('age-receipt', { operationId: oldUnknownId, createdAt: Date.now() - 31 * 24 * 60 * 60 * 1000 });
  await exec(30, '13131313-1313-4313-8313-131313131313', 'fixture-output');
  const expiredKnown = await call(31, 'get_operation_status', { operation_id: operationId });
  assert.equal(expiredKnown.value.error, 'operation_not_found', 'known terminal receipts are removed opportunistically after 30 days from admission');
  const retainedUnknown = await call(32, 'get_operation_status', { operation_id: oldUnknownId });
  assert.equal(retainedUnknown.value.status, 'unknown', 'unknown tombstones survive the normal terminal retention window');
  const unknownDispatchesBeforeReplay = (await readFile(authLog, 'utf8')).match(/exec-command:fixture-timeout\n/g)?.length ?? 0;
  const oldUnknownReplay = await exec(33, oldUnknownId, 'fixture-timeout', 1_000);
  assert.equal(oldUnknownReplay.value.status, 'unknown');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:fixture-timeout\n/g)?.length, unknownDispatchesBeforeReplay,
    'an aged unknown tombstone still prevents replay');
  console.log('Local MCP → SQLite DO → pinned SSH fixture passed: concurrent atomic admission, restart recovery before dispatch and after effect/receipt-commit failure, storage fail-closed behavior, stable digest vector, intent conflict, 30-day terminal cleanup, durable unknown tombstones, bounded output and transport cleanup.');
} finally {
  await stopWorker();
  stop(fixture);
  await delay(150);
  await rm(scratch, { recursive: true, force: true });
}
