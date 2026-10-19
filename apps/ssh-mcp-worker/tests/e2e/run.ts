import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
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
const resetAllow = join(scratch, 'pty-reset-allow');
const state = join(scratch, 'wrangler-state');
const hostKey = join(scratch, 'host_key');
const userKey = join(scratch, 'user_key');
const hostId = '33333333-3333-4333-8333-333333333333';
const secondHostId = '12121212-1212-4212-8212-121212121212';
const accountId = '44444444-4444-4444-8444-444444444444';
const encryptionKey = Buffer.alloc(32, 0x87).toString('base64');
const testToken = 'synthetic-mcp-bearer';
let activeToken = testToken;
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
await writeFile(resetAllow, '');

const key = await crypto.subtle.importKey('raw', Buffer.from(encryptionKey, 'base64'), 'AES-GCM', false, ['encrypt']);
async function encryptedHost(id: string, password: string, patch: Record<string, unknown> = {}): Promise<string> {
  const payload = JSON.stringify({
    name: 'Synthetic exec fixture', group: 'Tests', host: 'fixture.example.test', port: fixturePort,
    username: 'fixture', authMethod: 'password', password,
    fingerprint, initialCommand: 'synthetic-initial-command-do-not-run', termType: 'xterm-256color', encoding: 'utf-8', location: null,
    ...patch,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`edgessh:v1:${accountId}:${id}`),
  }, key, new TextEncoder().encode(payload));
  return `v1.${Buffer.from(iv).toString('base64')}.${Buffer.from(encrypted).toString('base64')}`;
}
const encryptedPayload = await encryptedHost(hostId, 'synthetic-password-do-not-use');
const secondEncryptedPayload = await encryptedHost(secondHostId, 'synthetic-password-do-not-use');
const badEncryptedPayload = await encryptedHost(wrongPasswordHostId, 'wrong-synthetic-password');
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const seed = join(scratch, 'seed.sql');
await writeFile(seed, `INSERT INTO workspace_state(id, account_id) VALUES(1, ${quote(accountId)});\nINSERT INTO hosts(id, account_id, encrypted_payload, updated_at) VALUES(${quote(hostId)}, ${quote(accountId)}, ${quote(encryptedPayload)}, 1);\nINSERT INTO hosts(id, account_id, encrypted_payload, updated_at) VALUES(${quote(secondHostId)}, ${quote(accountId)}, ${quote(secondEncryptedPayload)}, 1);\nINSERT INTO hosts(id, account_id, encrypted_payload, updated_at) VALUES(${quote(wrongPasswordHostId)}, ${quote(accountId)}, ${quote(badEncryptedPayload)}, 1);\n`);
run('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'ssh-mcp-local-fixture', '--local', '--config', config,
  '--persist-to', state, '--file', join(app, 'tests/e2e/migrations/0001_fixture_catalog.sql')]);
run('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'ssh-mcp-local-fixture', '--local', '--config', config,
  '--persist-to', state, '--file', seed]);

const fixture = spawn(process.execPath, ['--experimental-strip-types', join(app, 'g0/fixture/server.ts')], {
  cwd: app,
  env: { ...process.env, FIXTURE_PORT: String(fixturePort), FIXTURE_HOST_KEY: hostKey,
    FIXTURE_USER_PUBLIC_KEY: `${userKey}.pub`, FIXTURE_PASSWORD: 'synthetic-password-do-not-use', FIXTURE_AUTH_LOG: authLog,
    FIXTURE_RESET_ALLOW: resetAllow },
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
    '--persist-to', state, '--var', `MCP_ACCESS_TOKEN:${activeToken}`, '--var', `ENCRYPTION_KEY:${encryptionKey}`], {
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
      if (response.status === 405 || response.status === 400 || response.status === 401) return;
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
let cleanupPtyIds: string[] = [];

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
  const fixtureRequest = async <T = { digest: string; status: string; result_json: string | null }>(path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${endpoint}/__fixture/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (response.status !== 204 && response.status !== 200) throw new Error(await response.text());
    return response.status === 200 ? response.json() as Promise<T> : undefined;
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

  const legacyDigest = createHash('sha256').update(JSON.stringify(['ssh_exec', hostId, 'fixture-output', 10_000])).digest('base64');
  assert.equal(legacyDigest, 'S6kKWAfytnyb1sftfM0PewlYbATaplqYmmnwkVH9Y5k=', 'fixed digest for the pre-upgrade [tool, host, command, timeout] tuple');
  const legacyKnownId = 'abababab-abab-4bab-8bab-abababababab';
  const legacyUnknownId = 'acacacac-acac-4cac-8cac-acacacacacac';
  await fixtureRequest('seed-legacy', { operationId: legacyKnownId, hostId, digest: legacyDigest, status: 'completed',
    resultJson: JSON.stringify({ operation_id: legacyKnownId, status: 'completed', exit_code: 7 }) });
  await fixtureRequest('seed-legacy', { operationId: legacyUnknownId, hostId, digest: legacyDigest, status: 'unknown', resultJson: null });
  await restartWorker();
  const beforeLegacyReplay = (await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length ?? 0;
  const legacyKnownReplay = await exec(15, legacyKnownId, 'fixture-output');
  assert.equal(legacyKnownReplay.value.status, 'completed', 'same intent in a pre-upgrade receipt returns its persisted result metadata');
  assert.equal(legacyKnownReplay.value.exit_code, 7);
  assert.equal(legacyKnownReplay.value.stdout, undefined, 'legacy receipts continue to omit remote output');
  const legacyKnownConflict = await exec(16, legacyKnownId, 'fixture-output-large');
  assert.equal(legacyKnownConflict.value.error, 'receipt_conflict', 'legacy receipt digest still rejects changed intent');
  const legacyUnknownReplay = await exec(17, legacyUnknownId, 'fixture-output');
  assert.equal(legacyUnknownReplay.value.status, 'unknown', 'legacy unknown markers survive a DO restart and block replay');
  const legacyUnknownConflict = await exec(18, legacyUnknownId, 'fixture-output-large');
  assert.equal(legacyUnknownConflict.value.error, 'receipt_conflict');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length ?? 0, beforeLegacyReplay,
    'legacy known and unknown receipt replay does not dispatch SSH');

  const cleanupCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const cleanupCreatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await fixtureRequest('seed-cleanup', { count: 125, createdAt: cleanupCreatedAt });
  type CleanupState = { expiredTerminal: number; expiredUnknown: number; expiredInFlight: number; queryPlan: string[] };
  const cleanupState = async () => fixtureRequest<CleanupState>('cleanup-state', { cutoff: cleanupCutoff });
  const beforeCleanup = await cleanupState();
  assert.equal(beforeCleanup?.expiredTerminal, 125);
  assert.equal(beforeCleanup?.expiredUnknown, 1);
  assert.equal(beforeCleanup?.expiredInFlight, 2);
  assert.match(beforeCleanup?.queryPlan.join('\n') ?? '', /operations_terminal_cleanup/);
  assert.doesNotMatch(beforeCleanup?.queryPlan.join('\n') ?? '', /SCAN operations/i);
  await exec(40, '14141414-1414-4414-8414-141414141414', 'fixture-output');
  const firstCleanup = await cleanupState();
  assert.equal(firstCleanup?.expiredTerminal, 75, 'one request removes no more than the fixed 50-row cleanup batch');
  assert.equal(firstCleanup?.expiredUnknown, 1);
  assert.equal(firstCleanup?.expiredInFlight, 2);
  await exec(41, '15151515-1515-4515-8515-151515151515', 'fixture-output');
  const secondCleanup = await cleanupState();
  assert.equal(secondCleanup?.expiredTerminal, 25, 'a later request prunes the next bounded batch');
  assert.equal(secondCleanup?.expiredUnknown, 1);
  assert.equal(secondCleanup?.expiredInFlight, 2);
  await exec(42, '16161616-1616-4616-8616-161616161616', 'fixture-output');
  const completeCleanup = await cleanupState();
  assert.equal(completeCleanup?.expiredTerminal, 0, 'repeated requests eventually clean all eligible terminal rows');
  assert.equal(completeCleanup?.expiredUnknown, 1, 'expired unknown tombstones remain protected');
  assert.equal(completeCleanup?.expiredInFlight, 2, 'admitted and running rows remain outside cleanup');

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
  const stopDigest = await digestVector({ tool: 'ssh_session_stop', hostId, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', normalizedArgs: [] });
  assert.equal(stopDigest.digest, 'kqiDKEvDcrrzcMJgZ95OUG7GASCh0RcvUjn5tw1WNNo=');
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
  assert.equal(stalled.value.status, 'unknown', JSON.stringify(stalled));
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

  const liveOperationId = '17171717-1717-4717-8717-171717171717';
  let liveRequestOutcome: 'response' | 'connection_lost' = 'response';
  const liveRequest = exec(50, liveOperationId, 'fixture-live-long-running', 60_000)
    .then(() => { liveRequestOutcome = 'response'; }, () => { liveRequestOutcome = 'connection_lost'; });
  let liveConnectionId: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const fixtureLog = await readFile(authLog, 'utf8');
    liveConnectionId = fixtureLog.match(/live-command-started:(\d+)/)?.[1];
    if (liveConnectionId) break;
    await delay(50);
  }
  assert.ok(liveConnectionId, 'the synthetic SSH peer confirms the long-running command started');
  const liveReceipt = await fixtureRequest('read-receipt', { operationId: liveOperationId });
  assert.equal(liveReceipt?.status, 'running', 'the operation remains durably running while the SSH command is still in flight');
  await stopWorker();
  await Promise.race([liveRequest, delay(3_000)]);
  assert.equal(liveRequestOutcome, 'connection_lost', 'the outer MCP request is interrupted by the real local runtime restart');
  startWorker();
  await waitForWorker();
  const liveStatus = await call(51, 'get_operation_status', { operation_id: liveOperationId });
  assert.equal(liveStatus.value.status, 'unknown', 'a restart during active SSH work recovers the persisted running row as unknown');
  const liveReplay = await exec(52, liveOperationId, 'fixture-live-long-running', 60_000);
  assert.equal(liveReplay.value.status, 'unknown');
  const outputDispatchesBeforeFreshConnection = (await readFile(authLog, 'utf8')).match(/exec-command:fixture-output\n/g)?.length ?? 0;
  const afterRestartId = '18181818-1818-4818-8818-181818181818';
  const afterRestart = await exec(53, afterRestartId, 'fixture-output');
  assert.equal(afterRestart.value.status, 'completed', 'the same SSH fixture accepts a fresh valid connection after the expected runtime reset');
  const afterLiveRestartLog = await readFile(authLog, 'utf8');
  assert.equal((afterLiveRestartLog.match(/exec-command:fixture-live-long-running\n/g) ?? []).length, 1,
    'status lookup and same-ID retry after an in-flight restart never reconnect or redispatch');
  assert.doesNotMatch(afterLiveRestartLog, /unexpected-fixture-error:/,
    'fixture errors other than the intentional live-command reset still fail the peer');
  const resetConnectionIds = [...afterLiveRestartLog.matchAll(/expected-runtime-reset:(\d+)/g)].map((match) => match[1]);
  assert.ok(resetConnectionIds.every((id) => id === liveConnectionId),
    'only the connection interrupted by the intentional runtime restart may consume ECONNRESET');
  assert.equal((afterLiveRestartLog.match(/exec-command:fixture-output\n/g) ?? []).length, outputDispatchesBeforeFreshConnection + 1,
    'a new SSH operation succeeds through the same fixture after the interrupted connection is reset');
  assert.match(afterLiveRestartLog, new RegExp(`connection-closed:${liveConnectionId}\\n`), 'runtime restart closes the synthetic live SSH transport');

  const readPtyIds = async () => [...(await readFile(authLog, 'utf8')).matchAll(/pty-connection:(\d+)/g)].map(match => match[1]!);
  let notedPtyIds: string[] = [];
  const noteNewPtyIds = async () => {
    const current = await readPtyIds();
    const fresh = current.filter(id => !notedPtyIds.includes(id));
    notedPtyIds = current;
    return fresh;
  };
  const allowPtyResets = (ids: string[]) => writeFile(resetAllow, ids.length ? `${ids.join('\n')}\n` : '');
  const clearPtyResets = () => writeFile(resetAllow, '');
  const shellOpens = () => readFile(authLog, 'utf8').then(log => (log.match(/shell-open/g) ?? []).length);
  const passwordAuths = () => readFile(authLog, 'utf8').then(log => (log.match(/^password$/gm) ?? []).length);
  const sessionStart = (id: number, operationId: string, term?: string, targetHostId = hostId) => call(id, 'ssh_session_start', {
    host_id: targetHostId, operation_id: operationId, ...(term ? { term_type: term } : {}),
  });
  const sessionOutput = (id: number, sessionId: string, offset?: number, limit?: number) => call(id, 'ssh_session_read', {
    session_id: sessionId, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }),
  });
  const sessionStatus = (id: number, sessionId: string) => call(id, 'ssh_session_status', { session_id: sessionId });
  const waitForOutput = async (id: number, sessionId: string, pattern: RegExp) => {
    let latest = await sessionOutput(id, sessionId);
    for (let attempt = 0; attempt < 40 && !pattern.test(String(latest.value.output ?? '')); attempt++) {
      await delay(50);
      latest = await sessionOutput(id, sessionId, 0, 1024);
    }
    return latest;
  };

  const shellsBefore = await shellOpens();
  const authsBefore = await passwordAuths();
  const invalidTerm = await sessionStart(60, '19191919-1919-4919-8919-191919191919', 'bad term');
  assert.equal(invalidTerm.isError, true);
  assert.equal(invalidTerm.value.error, 'invalid_args');
  const startOperationId = '20202020-2020-4202-8202-202020202020';
  const startedSession = await sessionStart(61, startOperationId);
  assert.equal(startedSession.value.status, 'live', JSON.stringify(startedSession));
  const sessionId = String(startedSession.value.session_id);
  const [startedPty] = await noteNewPtyIds();
  assert.ok(startedPty, 'the first managed shell has one PTY connection');
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(startedSession.value.idle_deadline_at, Number(startedSession.value.last_activity_at) + 10 * 60 * 1000);
  assert.equal(startedSession.value.absolute_deadline_at, Number(startedSession.value.created_at) + 60 * 60 * 1000);
  const firstOutput = await waitForOutput(62, sessionId, /fixture-shell-ready/);
  assert.match(String(firstOutput.value.output), /fixture-shell-ready/);
  assert.equal(firstOutput.value.truncated, false);
  const listed = await call(63, 'list_hosts', { limit: 10 });
  const fetched = await call(64, 'get_host', { host_id: hostId });
  const operationStatus = await call(65, 'get_operation_status', { operation_id: startOperationId });
  assert.equal(listed.isError, false);
  assert.equal(fetched.value.host && typeof fetched.value.host === 'object', true);
  assert.equal(operationStatus.value.status, 'completed');
  assert.equal(operationStatus.value.session_id, sessionId);
  assert.equal(operationStatus.value.output, undefined);
  assert.doesNotMatch(JSON.stringify([startedSession, firstOutput, operationStatus]), /synthetic-password|synthetic-initial-command|privateKey/);
  assert.equal(await shellOpens(), shellsBefore + 1, 'metadata and receipt reads must not open another shell');
  assert.equal(await passwordAuths(), authsBefore + 1, 'list/get/status must not authenticate a new SSH connection');
  const replayedStart = await sessionStart(66, startOperationId);
  assert.equal(replayedStart.value.status, 'completed');
  assert.equal(replayedStart.value.session_id, sessionId);
  const conflictedStart = await sessionStart(67, startOperationId, 'vt100');
  assert.equal(conflictedStart.value.error, 'receipt_conflict');
  assert.equal(await shellOpens(), shellsBefore + 1, 'replaying or conflicting with a start receipt must not open a shell');
  const missing = await sessionStatus(68, '30303030-3030-4303-8303-303030303030');
  assert.equal(missing.isError, true);
  assert.equal(missing.value.error, 'session_not_found');

  const wrongPasswordSession = await sessionStart(69, '21212121-2121-4212-8212-212121212121', undefined, wrongPasswordHostId);
  assert.equal(wrongPasswordSession.value.status, 'failed');
  assert.equal(wrongPasswordSession.value.error, 'host_unreachable');
  const quotaA = await sessionStart(70, '22222222-2222-4222-8222-222222222222');
  assert.equal(quotaA.value.status, 'live', JSON.stringify(quotaA));
  const quotaB = await sessionStart(71, '23232323-2323-4232-8232-232323232323', undefined, secondHostId);
  const quotaC = await sessionStart(72, '24242424-2424-4242-8242-242424242424', undefined, secondHostId);
  assert.equal(quotaB.value.status, 'live', JSON.stringify(quotaB));
  assert.equal(quotaC.value.status, 'live', JSON.stringify(quotaC));
  const quotaPtys = await noteNewPtyIds();
  assert.equal(quotaPtys.length, 3, 'quota shells are the only new PTY connections');
  const overHost = await sessionStart(73, '25252525-2525-4252-8252-252525252525');
  assert.equal(overHost.value.error, 'capacity_reached');
  const overTotal = await sessionStart(74, '26262626-2626-4262-8262-262626262626', undefined, secondHostId);
  assert.equal(overTotal.value.error, 'capacity_reached');
  const leasesAtCap = await fixtureRequest<{ total: number; perHost: Record<string, number> }>('lease-count', {});
  assert.equal(leasesAtCap?.total, 4);
  assert.equal(leasesAtCap?.perHost[hostId], 2);
  assert.equal(leasesAtCap?.perHost[secondHostId], 2);
  const execWhileSessions = await exec(75, '27272727-2727-4272-8272-272727272727', 'fixture-output');
  assert.equal(execWhileSessions.value.error, 'capacity_reached', 'live shells occupy the shared exec connection budget');
  assert.equal(await shellOpens(), shellsBefore + 4, 'rejected starts must not open extra shells');

  const createdAt = Number(startedSession.value.created_at);
  const activityAt = Number(startedSession.value.last_activity_at);
  await fixtureRequest('session-clock', { now: createdAt + 10 * 60 * 1000 - 1000 });
  const polled = await sessionOutput(76, sessionId, 0, 64);
  assert.equal(polled.value.status, 'live');
  assert.equal(polled.value.last_activity_at, activityAt, 'output polling does not extend the idle deadline');
  const scheduledAlarm = await fixtureRequest<{ alarm: number | null }>('session-alarm-time', {});
  assert.equal(scheduledAlarm?.alarm, activityAt + 10 * 60 * 1000);
  await fixtureRequest('session-clock', { now: createdAt + 10 * 60 * 1000 });
  await allowPtyResets([startedPty]);
  const idleClosed = await sessionStatus(77, sessionId);
  assert.equal(idleClosed.value.status, 'closed', 'the next session request closes an idle shell without waiting for wall-clock time');
  await clearPtyResets();
  await allowPtyResets(quotaPtys);
  await fixtureRequest('session-clock', { now: Date.now() + 11 * 60 * 1000 });
  await fixtureRequest('session-alarm', {});
  await clearPtyResets();
  const afterIdleExec = await exec(78, '28282828-2828-4282-8282-282828282828', 'fixture-output');
  assert.equal(afterIdleExec.value.status, 'completed', 'idle closure releases the shared connection lease');
  await fixtureRequest('session-clock', { now: null });

  const absoluteStart = await sessionStart(79, '29292929-2929-4292-8292-292929292929');
  assert.equal(absoluteStart.value.status, 'live', JSON.stringify(absoluteStart));
  const absoluteSessionId = String(absoluteStart.value.session_id);
  const [absolutePty] = await noteNewPtyIds();
  assert.ok(absolutePty, 'the absolute-deadline shell has one PTY connection');
  const absoluteCreatedAt = Number(absoluteStart.value.created_at);
  const bumped = await fixtureRequest<{ updated: boolean }>('session-activity', {
    sessionId: absoluteSessionId, lastActivityAt: absoluteCreatedAt + 51 * 60 * 1000,
  });
  assert.equal(bumped?.updated, true);
  const absoluteAlarm = await fixtureRequest<{ alarm: number | null }>('session-alarm-time', {});
  assert.equal(absoluteAlarm?.alarm, absoluteCreatedAt + 60 * 60 * 1000, 'an active shell is still capped by the absolute deadline');
  await allowPtyResets([absolutePty]);
  await fixtureRequest('session-clock', { now: absoluteCreatedAt + 60 * 60 * 1000 });
  await fixtureRequest('session-alarm', {});
  const absoluteClosed = await sessionStatus(80, absoluteSessionId);
  assert.equal(absoluteClosed.value.status, 'closed');
  await clearPtyResets();
  await fixtureRequest('session-clock', { now: null });

  const disconnectStart = await sessionStart(81, '31313131-3131-4313-8313-313131313131', 'fixture-disconnect');
  assert.ok(disconnectStart.value.status === 'live' || disconnectStart.value.status === 'closing' || disconnectStart.value.status === 'lost', JSON.stringify(disconnectStart));
  const disconnectSessionId = String(disconnectStart.value.session_id);
  assert.equal((await noteNewPtyIds()).length, 1, 'the disconnect shell has one PTY connection');
  let disconnected = await sessionStatus(82, disconnectSessionId);
  for (let attempt = 0; attempt < 40 && disconnected.value.status !== 'lost'; attempt++) {
    await delay(50);
    disconnected = await sessionStatus(83, disconnectSessionId);
  }
  assert.equal(disconnected.value.status, 'lost', 'a remote SSH disconnect is lost rather than reconnected');
  const shellsAfterDisconnect = await shellOpens();
  const disconnectReplay = await sessionStart(84, '31313131-3131-4313-8313-313131313131', 'fixture-disconnect');
  assert.equal(disconnectReplay.value.session_id, disconnectSessionId);
  assert.equal(await shellOpens(), shellsAfterDisconnect, 'a lost session id is not a credential to reopen or replay the shell');

  const restartStart = await sessionStart(85, '32323232-3232-4232-8232-323232323232');
  assert.equal(restartStart.value.status, 'live', JSON.stringify(restartStart));
  const restartSessionId = String(restartStart.value.session_id);
  const [restartPty] = await noteNewPtyIds();
  assert.ok(restartPty, 'the restart shell has one PTY connection');
  const shellsBeforeRestart = await shellOpens();
  await allowPtyResets([restartPty]);
  await restartWorker();
  const restarted = await sessionStatus(86, restartSessionId);
  assert.equal(restarted.value.status, 'lost', 'a DO restart loses the shell and does not infer ownership from the stored id');
  await clearPtyResets();
  const restartedOutput = await sessionOutput(87, restartSessionId);
  assert.equal(restartedOutput.value.status, 'lost');
  assert.equal(restartedOutput.value.output, '');
  assert.equal(restartedOutput.value.truncated, true);
  const restartReplay = await sessionStart(88, '32323232-3232-4232-8232-323232323232');
  assert.equal(restartReplay.value.status, 'completed');
  assert.equal(await shellOpens(), shellsBeforeRestart, 'restart recovery must not reconnect the SSH session');

  const inputHash = (value: string) => createHash('sha256').update(value).digest('hex');
  const shellInputCount = async (hash?: string) => {
    const matches = [...(await readFile(authLog, 'utf8')).matchAll(/shell-input:([0-9a-f]+)/g)].map(match => match[1]!);
    return hash === undefined ? matches.length : matches.filter(item => item === hash).length;
  };
  const sessionInput = (id: number, operationId: string, targetSessionId: string, input: string) => call(id, 'ssh_session_send', {
    session_id: targetSessionId, operation_id: operationId, input,
  });
  const sessionStop = (id: number, operationId: string, targetSessionId: string) => call(id, 'ssh_session_stop', {
    session_id: targetSessionId, operation_id: operationId,
  });
  const mutateHost = async (body: Record<string, unknown>) => {
    const response = await fetch(`${endpoint}/__fixture/host-row`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 204, await response.text());
  };
  const authedCall = async (token: string, id: number, name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${endpoint}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
    return response.status;
  };

  const lostInputs = await shellInputCount();
  const lostInput = await sessionInput(120, '40404040-4040-4404-8404-404040404040', restartSessionId, 'hello from client\n');
  assert.equal(lostInput.value.error, 'session_not_live');
  assert.equal(lostInput.value.write_accepted, false);
  const lostStop = await sessionStop(121, '41414141-4141-4414-8414-414141414141', restartSessionId);
  assert.equal(lostStop.value.error, 'session_not_live');
  const missingInput = await sessionInput(122, '42424242-4242-4424-8424-424242424242', '30303030-3030-4303-8303-303030303030', 'hello from client\n');
  assert.equal(missingInput.isError, true);
  assert.equal(missingInput.value.error, 'session_not_found');
  assert.equal(await shellInputCount(), lostInputs, 'lost or unknown sessions must not receive PTY input');
  assert.equal(await shellOpens(), shellsBeforeRestart, 'rejected input must not open a shell');

  const interactiveStart = await sessionStart(123, '43434343-4343-4434-8434-434343434343');
  assert.equal(interactiveStart.value.status, 'live', JSON.stringify(interactiveStart));
  const interactiveSessionId = String(interactiveStart.value.session_id);
  const [interactivePty] = await noteNewPtyIds();
  assert.ok(interactivePty, 'the interactive shell has one PTY connection');
  const ready = await waitForOutput(124, interactiveSessionId, /fixture-shell-ready/);
  assert.match(String(ready.value.output), /fixture-shell-ready/);
  const authsAtInput = await passwordAuths();
  const shellsAtInput = await shellOpens();
  const leasesBeforeInput = await fixtureRequest<{ total: number }>('lease-count', {});
  const inputsBeforeAuth = await shellInputCount();
  assert.equal(await authedCall('wrong-bearer', 125, 'ssh_session_send', {
    session_id: interactiveSessionId, operation_id: '44444444-4444-4444-8444-444444444444', input: 'hello from client\n',
  }), 401);
  assert.equal(await authedCall('rotated-mcp-bearer', 126, 'ssh_session_stop', {
    session_id: interactiveSessionId, operation_id: '45454545-4545-4454-8454-454545454545',
  }), 401);
  assert.equal(await shellInputCount(), inputsBeforeAuth, 'a rejected bearer must not write PTY input');
  const emptyInput = await sessionInput(127, '46464646-4646-4464-8464-464646464646', interactiveSessionId, '');
  assert.equal(emptyInput.isError, true);
  assert.equal(emptyInput.value.error, 'invalid_args');
  const oversizedInput = await sessionInput(128, '47474747-4747-4474-8474-474747474747', interactiveSessionId, 'x'.repeat(16 * 1024 + 1));
  assert.equal(oversizedInput.value.error, 'invalid_args');
  const rejectedReceipt = await call(129, 'get_operation_status', { operation_id: '47474747-4747-4474-8474-474747474747' });
  assert.equal(rejectedReceipt.value.error, 'operation_not_found', 'over-limit input is rejected before admission');
  const hello = 'hello from client\n';
  const helloOperation = '48484848-4848-4484-8484-484848484848';
  const beforeHello = await shellInputCount(inputHash(hello));
  const activityBefore = Number((await sessionStatus(130, interactiveSessionId)).value.last_activity_at);
  const sent = await sessionInput(131, helloOperation, interactiveSessionId, hello);
  assert.equal(sent.value.status, 'completed', JSON.stringify(sent));
  assert.equal(sent.value.admitted, true);
  assert.equal(sent.value.write_accepted, true);
  assert.doesNotMatch(JSON.stringify(sent), /hello from client|synthetic-password|synthetic-initial-command/);
  let echoed = await sessionOutput(132, interactiveSessionId);
  for (let attempt = 0; attempt < 30 && !String(echoed.value.output).includes('fixture says hello'); attempt++) {
    await delay(50);
    echoed = await sessionOutput(133, interactiveSessionId);
  }
  assert.match(String(echoed.value.output), /fixture says hello/);
  assert.equal(await shellInputCount(inputHash(hello)), beforeHello + 1);
  const afterInput = await sessionStatus(134, interactiveSessionId);
  assert.equal(afterInput.value.status, 'live');
  assert.ok(Number(afterInput.value.last_activity_at) >= activityBefore);
  assert.equal(afterInput.value.idle_deadline_at, Number(afterInput.value.last_activity_at) + 10 * 60 * 1000);
  const inputReceipt = await fixtureRequest('read-receipt', { operationId: helloOperation });
  assert.equal(inputReceipt?.status, 'completed');
  assert.doesNotMatch(JSON.stringify(inputReceipt), /hello from client/);
  const inputStatus = await call(135, 'get_operation_status', { operation_id: helloOperation });
  assert.equal(inputStatus.value.write_accepted, true);
  assert.equal(inputStatus.value.output, undefined);
  const replayedInput = await sessionInput(136, helloOperation, interactiveSessionId, hello);
  assert.equal(replayedInput.value.write_accepted, true);
  assert.equal(await shellInputCount(inputHash(hello)), beforeHello + 1, 'replaying an input operation must not resend bytes');
  const conflictedInput = await sessionInput(137, helloOperation, interactiveSessionId, 'different batch\n');
  assert.equal(conflictedInput.value.error, 'receipt_conflict');
  assert.equal(await shellInputCount(inputHash(hello)), beforeHello + 1);
  assert.equal(await shellInputCount(inputHash('different batch\n')), 0);
  const concurrentInput = 'concurrent-batch\n';
  const concurrentOperation = '49494949-4949-4494-8494-494949494949';
  const concurrentResults = await Promise.all(Array.from({ length: 6 }, (_, index) => sessionInput(140 + index, concurrentOperation, interactiveSessionId, concurrentInput)));
  assert.ok(concurrentResults.some(result => result.value.write_accepted === true || result.value.status === 'completed' || result.value.status === 'unknown'));
  const concurrentReceipt = await call(146, 'get_operation_status', { operation_id: concurrentOperation });
  assert.equal(concurrentReceipt.value.status, 'completed');
  assert.equal(await shellInputCount(inputHash(concurrentInput)), 1, 'concurrent retries of one input id write once');
  const firstBatch = 'batch-one\n';
  const secondBatch = 'batch-two\n';
  await Promise.all([
    sessionInput(147, '50505050-5050-4505-8505-505050505050', interactiveSessionId, firstBatch),
    sessionInput(148, '51515151-5151-4515-8515-515151515151', interactiveSessionId, secondBatch),
  ]);
  assert.equal(await shellInputCount(inputHash(firstBatch)), 1);
  assert.equal(await shellInputCount(inputHash(secondBatch)), 1);
  const inputsBeforeRead = await shellInputCount();
  await sessionOutput(149, interactiveSessionId, 0, 32);
  await sessionStatus(150, interactiveSessionId);
  assert.equal(await shellInputCount(), inputsBeforeRead, 'output and status reads must not write to the PTY');
  assert.equal(await passwordAuths(), authsAtInput, 'input reuses the already authenticated transport');
  assert.equal(await shellOpens(), shellsAtInput, 'input does not open another shell');
  const leasesAfterInput = await fixtureRequest<{ total: number }>('lease-count', {});
  assert.equal(leasesAfterInput?.total, leasesBeforeInput?.total, 'input and its receipt do not take another connection slot');

  const renamed = await encryptedHost(hostId, 'synthetic-password-do-not-use', { name: 'Renamed without security change' });
  await mutateHost({ action: 'update', hostId, encryptedPayload: renamed, updatedAt: 1 });
  const renamedInput = 'name-only-change\n';
  const renamedSend = await sessionInput(151, '52525252-5252-4525-8525-525252525252', interactiveSessionId, renamedInput);
  assert.equal(renamedSend.value.write_accepted, true, JSON.stringify(renamedSend));
  assert.equal(await shellInputCount(inputHash(renamedInput)), 1);
  const changedPassword = await encryptedHost(hostId, 'changed-synthetic-password');
  await mutateHost({ action: 'update', hostId, encryptedPayload: changedPassword, updatedAt: 1 });
  const inputsBeforeChange = await shellInputCount();
  await allowPtyResets([interactivePty]);
  const changedSend = await sessionInput(152, '53535353-5353-4535-8535-535353535353', interactiveSessionId, 'should-not-send\n');
  assert.equal(changedSend.value.error, 'host_changed', JSON.stringify(changedSend));
  assert.equal(changedSend.value.write_accepted, false);
  const changedStatus = await sessionStatus(153, interactiveSessionId);
  assert.equal(changedStatus.value.status, 'closed');
  assert.equal(await shellInputCount(), inputsBeforeChange, 'a changed credential closes the owned channel instead of sending input');
  await clearPtyResets();
  await mutateHost({ action: 'update', hostId, encryptedPayload, updatedAt: 1 });

  const deleteStart = await sessionStart(154, '54545454-5454-4545-8545-545454545454');
  assert.equal(deleteStart.value.status, 'live', JSON.stringify(deleteStart));
  const deleteSessionId = String(deleteStart.value.session_id);
  const [deletePty] = await noteNewPtyIds();
  assert.ok(deletePty);
  await mutateHost({ action: 'delete', hostId });
  await allowPtyResets([deletePty]);
  const deletedInput = await sessionInput(155, '56565656-5656-4565-8565-565656565656', deleteSessionId, 'missing-host\n');
  assert.equal(deletedInput.value.error, 'host_not_found', JSON.stringify(deletedInput));
  const deletedStatus = await sessionStatus(157, deleteSessionId);
  assert.equal(deletedStatus.value.status, 'closed');
  assert.equal(await shellInputCount(inputHash('missing-host\n')), 0);
  await clearPtyResets();
  await mutateHost({ action: 'insert', hostId, accountId, encryptedPayload, updatedAt: 1 });

  const emergencyStart = await sessionStart(158, '57575757-5757-4575-8575-575757575757');
  assert.equal(emergencyStart.value.status, 'live', JSON.stringify(emergencyStart));
  const emergencySessionId = String(emergencyStart.value.session_id);
  const [emergencyPty] = await noteNewPtyIds();
  assert.ok(emergencyPty);
  await control('PUT');
  const blockedInput = await sessionInput(159, '58585858-5858-4585-8585-585858585858', emergencySessionId, 'blocked-input\n');
  assert.equal(blockedInput.value.error, 'receipt_store_unavailable');
  assert.equal(await shellInputCount(inputHash('blocked-input\n')), 0);
  const stillLive = await sessionStatus(160, emergencySessionId);
  assert.equal(stillLive.value.status, 'live');
  const blockedExec = await exec(161, '59595959-5959-4595-8595-595959595959', 'fixture-output');
  assert.equal(blockedExec.value.error, 'receipt_store_unavailable');
  await allowPtyResets([emergencyPty]);
  const emergency = await sessionStop(162, '60606060-6060-4606-8606-606060606060', emergencySessionId);
  assert.equal(emergency.value.status, 'unknown', JSON.stringify(emergency));
  assert.equal(emergency.value.unverified, true);
  assert.equal(emergency.value.error, 'unknown_outcome');
  assert.equal(emergency.value.remote_descendants, 'not_observed');
  assert.equal(emergency.value.channel_close_attempted, true);
  const emergencyAgain = await sessionStop(163, '61616161-6161-4616-8616-616161616161', emergencySessionId);
  assert.equal(emergencyAgain.value.error, 'session_not_live');
  const emergencyState = await sessionStatus(164, emergencySessionId);
  assert.ok(emergencyState.value.status === 'closed' || emergencyState.value.status === 'lost', JSON.stringify(emergencyState));
  await clearPtyResets();
  await control('DELETE');

  const uncertainInputStart = await sessionStart(165, '62626262-6262-4626-8626-626262626262');
  assert.equal(uncertainInputStart.value.status, 'live', JSON.stringify(uncertainInputStart));
  const uncertainInputSessionId = String(uncertainInputStart.value.session_id);
  const [uncertainInputPty] = await noteNewPtyIds();
  assert.ok(uncertainInputPty);
  const uncertainText = 'uncertain-batch\n';
  await control('PUT', 'terminal-update-failure');
  const uncertainInput = await sessionInput(166, '63636363-6363-4636-8636-636363636363', uncertainInputSessionId, uncertainText);
  assert.equal(uncertainInput.value.status, 'unknown', JSON.stringify(uncertainInput));
  assert.equal(uncertainInput.value.error, 'unknown_outcome');
  assert.equal(await shellInputCount(inputHash(uncertainText)), 1);
  const uncertainInputReplay = await sessionInput(167, '63636363-6363-4636-8636-636363636363', uncertainInputSessionId, uncertainText);
  assert.equal(uncertainInputReplay.value.status, 'unknown');
  assert.equal(await shellInputCount(inputHash(uncertainText)), 1, 'an uncertain PTY write is not replayed');
  await control('DELETE', 'terminal-update-failure');
  await allowPtyResets([uncertainInputPty]);
  const controlledStop = await sessionStop(168, '64646464-6464-4646-8646-646464646464', uncertainInputSessionId);
  assert.equal(controlledStop.value.status, 'completed', JSON.stringify(controlledStop));
  assert.equal(controlledStop.value.session_status, 'closed');
  assert.equal(controlledStop.value.channel_close_attempted, true);
  assert.equal(controlledStop.value.transport_close_attempted, true);
  assert.equal(controlledStop.value.remote_descendants, 'not_observed');
  assert.doesNotMatch(JSON.stringify(controlledStop), /stopped|reaped|pid/i);
  const stopReceipt = await fixtureRequest('read-receipt', { operationId: '64646464-6464-4646-8646-646464646464' });
  assert.equal(stopReceipt?.status, 'completed');
  assert.doesNotMatch(JSON.stringify(stopReceipt), /uncertain-batch|synthetic-password/);
  const shellsAfterStop = await shellOpens();
  const replayedStop = await sessionStop(169, '64646464-6464-4646-8646-646464646464', uncertainInputSessionId);
  assert.equal(replayedStop.value.status, 'completed');
  assert.equal(replayedStop.value.remote_descendants, 'not_observed');
  assert.equal(await shellOpens(), shellsAfterStop, 'replaying a stop receipt must not open or signal another channel');
  const execsBeforeStop = (await readFile(authLog, 'utf8')).match(/exec-command:/g)?.length ?? 0;
  const stoppedInput = await sessionInput(170, '65656565-6565-4565-8565-656565656565', uncertainInputSessionId, 'after-stop\n');
  assert.equal(stoppedInput.value.error, 'session_not_live');
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:/g)?.length ?? 0, execsBeforeStop, 'stop does not run a remote command');
  await clearPtyResets();

  activeToken = 'rotated-mcp-bearer';
  await restartWorker();
  assert.equal(await authedCall(testToken, 171, 'ssh_session_send', {
    session_id: interactiveSessionId, operation_id: '66666666-6666-4666-8666-666666666666', input: 'rotated-away\n',
  }), 401);
  assert.equal(await authedCall(testToken, 172, 'ssh_session_stop', {
    session_id: interactiveSessionId, operation_id: '67676767-6767-4676-8676-676767676767',
  }), 401);
  assert.equal(await authedCall(testToken, 173, 'ssh_session_status', { session_id: interactiveSessionId }), 401);
  assert.equal(await authedCall(activeToken, 174, 'ssh_session_status', { session_id: interactiveSessionId }), 200);
  activeToken = testToken;
  await restartWorker();

  const floodStart = await sessionStart(89, '34343434-3434-4343-8343-343434343434', 'fixture-flood');
  assert.equal(floodStart.value.status, 'live', JSON.stringify(floodStart));
  const floodSessionId = String(floodStart.value.session_id);
  const [floodPty] = await noteNewPtyIds();
  assert.ok(floodPty, 'the flood shell has one PTY connection');
  let floodCursor = 0;
  let floodOffset = 0;
  for (let attempt = 0; attempt < 50 && floodCursor < 300 * 1024; attempt++) {
    const probe = await sessionOutput(90, floodSessionId, 0, 1024);
    floodCursor = Number(probe.value.output_cursor ?? 0);
    floodOffset = Number(probe.value.output_offset ?? 0);
    if (floodCursor < 300 * 1024) await delay(50);
  }
  assert.equal(floodCursor, 300 * 1024);
  assert.equal(floodOffset, floodCursor - 256 * 1024, 'the ring retains only the trailing 256 KiB');
  let combined = '';
  let next = floodOffset;
  let reads = 0;
  while (next < floodCursor && reads < 8) {
    const page = await sessionOutput(91 + reads, floodSessionId, next, 65_536);
    const text = String(page.value.output ?? '');
    const pageBytes = Buffer.byteLength(text);
    assert.ok(pageBytes <= 64 * 1024);
    assert.equal(page.value.truncated, next + pageBytes < floodCursor);
    combined += text;
    next = Number(page.value.next_offset);
    reads += 1;
  }
  assert.ok(reads >= 4);
  assert.ok(combined.endsWith('FLOOD-END'));
  assert.ok(Buffer.byteLength(combined) <= 256 * 1024);
  assert.equal(await shellOpens() > shellsBeforeRestart, true);
  await allowPtyResets([floodPty]);
  await fixtureRequest('session-clock', { now: Date.now() + 11 * 60 * 1000 });
  await fixtureRequest('session-alarm', {});
  await clearPtyResets();
  await fixtureRequest('session-clock', { now: null });

  const uncertainOperationId = '38383838-3838-4383-8383-383838383838';
  const shellsBeforeUncertain = await shellOpens();
  await control('PUT', 'terminal-update-failure');
  const uncertainStart = await sessionStart(110, uncertainOperationId, 'fixture-interrupt');
  assert.equal(uncertainStart.value.status, 'unknown', JSON.stringify(uncertainStart));
  assert.equal(uncertainStart.value.error, 'unknown_outcome');
  assert.equal(await shellOpens(), shellsBeforeUncertain + 1, 'an uncertain session start still opened the shell once');
  assert.equal((await noteNewPtyIds()).length, 1, 'the uncertain shell has one PTY connection');
  const uncertainReceipt = await fixtureRequest('read-receipt', { operationId: uncertainOperationId });
  assert.equal(uncertainReceipt?.status, 'unknown', 'a terminal receipt that cannot store result_json is still persisted as unknown');
  const uncertainStatus = await call(111, 'get_operation_status', { operation_id: uncertainOperationId });
  assert.equal(uncertainStatus.value.status, 'unknown');
  const uncertainReplay = await sessionStart(112, uncertainOperationId, 'fixture-interrupt');
  assert.equal(uncertainReplay.value.status, 'unknown');
  assert.equal(uncertainReplay.value.error, 'unknown_outcome');
  assert.equal(await shellOpens(), shellsBeforeUncertain + 1, 'an unknown session start is not opened again');
  await control('DELETE', 'terminal-update-failure');

  const closingStart = await sessionStart(113, '39393939-3939-4393-8393-393939393939');
  assert.equal(closingStart.value.status, 'live', JSON.stringify(closingStart));
  const closingSessionId = String(closingStart.value.session_id);
  const [closingPty] = await noteNewPtyIds();
  assert.ok(closingPty, 'the closing shell has one PTY connection');
  await fixtureRequest('session-close-delay', {});
  await allowPtyResets([closingPty]);
  await fixtureRequest('session-clock', { now: Number(closingStart.value.created_at) + 10 * 60 * 1000 });
  const closingAlarm = fetch(`${endpoint}/__fixture/session-alarm`, { method: 'POST' });
  await fixtureRequest('session-close-entered', {});
  let closingStatus = await sessionStatus(114, closingSessionId);
  for (let attempt = 0; attempt < 40 && closingStatus.value.status !== 'closing'; attempt++) {
    await delay(50);
    closingStatus = await sessionStatus(115, closingSessionId);
  }
  assert.equal(closingStatus.value.status, 'closing', JSON.stringify(closingStatus));
  assert.equal(typeof closingStatus.value.created_at, 'number');
  assert.equal(typeof closingStatus.value.last_activity_at, 'number');
  assert.equal(typeof closingStatus.value.idle_deadline_at, 'number');
  assert.equal(typeof closingStatus.value.absolute_deadline_at, 'number');
  assert.equal(typeof closingStatus.value.output_cursor, 'number');
  await fixtureRequest('session-close-release', {});
  assert.equal((await closingAlarm).status, 204);
  const closedAfterDelay = await sessionStatus(116, closingSessionId);
  assert.equal(closedAfterDelay.value.status, 'closed');
  await clearPtyResets();
  await fixtureRequest('session-clock', { now: null });

  const shellsBeforeStall = await shellOpens();
  const stalledSession = sessionStart(100, '35353535-3535-4353-8353-353535353535', 'fixture-stall-shell');
  void stalledSession.catch(() => undefined);
  let stallSeen = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    stallSeen = (await readFile(authLog, 'utf8')).includes('shell-stall');
    if (stallSeen) break;
    await delay(50);
  }
  assert.equal(stallSeen, true, 'an in-flight shell start remains reserved before the channel is accepted');
  const stallPtys = await noteNewPtyIds();
  assert.equal(stallPtys.length, 1, 'the stalled shell has one PTY connection');
  const duringStall = await fixtureRequest<{ total: number; perHost: Record<string, number> }>('lease-count', {});
  assert.ok((duringStall?.total ?? 0) >= 1);
  const besideStall = await sessionStart(101, '36363636-3636-4363-8363-363636363636');
  assert.equal(besideStall.value.status, 'live', JSON.stringify(besideStall));
  const besidePtys = await noteNewPtyIds();
  assert.equal(besidePtys.length, 1, 'the shell beside the stall has one PTY connection');
  cleanupPtyIds = [...stallPtys, ...besidePtys];
  const rejectedDuringStall = await sessionStart(102, '37373737-3737-4373-8373-373737373737');
  assert.equal(rejectedDuringStall.value.error, 'capacity_reached', 'a start that has not finished still consumes the host connection quota');
  assert.equal(await shellOpens(), shellsBeforeStall + 1);

  const sftpCallsBefore = {
    auth: await passwordAuths(),
    shells: await shellOpens(),
    exec: (await readFile(authLog, 'utf8')).match(/exec-command:/g)?.length ?? 0,
    sftp: (await readFile(authLog, 'utf8')).match(/sftp-subsystem/g)?.length ?? 0,
  };
  const operationsBefore = await fixtureRequest<{ count: number }>('operation-count', {});
  const blockedList = await call(200, 'file_list', { host_id: hostId, path: '/fixture' });
  assert.equal(blockedList.value.error, 'capacity_reached', 'live shells occupy the shared SFTP connection budget');
  assert.equal(blockedList.value.entries, undefined);
  const blockedWrite = await call(215, 'file_write_text', {
    host_id: hostId, operation_id: 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1',
    path: '/fixture/created-92.txt', text: 'must-not-write', overwrite: true,
  });
  assert.equal(blockedWrite.value.error, 'capacity_reached', 'a full host quota rejects SFTP write before SSH');
  assert.equal(blockedWrite.value.partial_write, undefined);
  const blockedRename = await call(240, 'file_move', {
    host_id: hostId, operation_id: 'd6d6d6d6-d6d6-46d6-86d6-d6d6d6d6d6d6',
    old_path: '/fixture/created-92.txt', new_path: '/fixture/renamed-93.txt', overwrite: false,
  });
  assert.equal(blockedRename.value.error, 'capacity_reached', 'a full host quota rejects SFTP rename before SSH');
  const blockedDelete = await call(241, 'file_delete', {
    host_id: hostId, operation_id: 'd7d7d7d7-d7d7-47d7-87d7-d7d7d7d7d7d7',
    path: '/fixture/created-92.txt', kind: 'file', confirm: true,
  });
  assert.equal(blockedDelete.value.error, 'capacity_reached', 'a full host quota rejects SFTP delete before SSH');
  const blockedMkdir = await call(242, 'file_mkdir', {
    host_id: hostId, operation_id: 'd8d8d8d8-d8d8-48d8-88d8-d8d8d8d8d8d8', path: '/fixture/created-dir-93',
  });
  assert.equal(blockedMkdir.value.error, 'capacity_reached', 'a full host quota rejects SFTP mkdir before SSH');
  const privateHostId = '14141414-1414-4414-8414-141414141414';
  const wrongPinHostId = '15151515-1515-4515-8515-151515151515';
  const missingCredentialHostId = '16161616-1616-4616-8616-161616161616';
  await mutateHost({ action: 'insert', hostId: privateHostId, accountId, encryptedPayload: await encryptedHost(privateHostId, 'synthetic-password-do-not-use', { host: '10.1.2.3' }) });
  await mutateHost({ action: 'insert', hostId: wrongPinHostId, accountId, encryptedPayload: await encryptedHost(wrongPinHostId, 'synthetic-password-do-not-use', { fingerprint: `SHA256:${'A'.repeat(43)}` }) });
  await mutateHost({ action: 'insert', hostId: missingCredentialHostId, accountId, encryptedPayload: await encryptedHost(missingCredentialHostId, '', {}) });
  const privateTarget = await call(201, 'file_list', { host_id: privateHostId, path: '/fixture' });
  assert.equal(privateTarget.value.error, 'invalid_target');
  const wrongPin = await call(202, 'file_read_text', { host_id: wrongPinHostId, path: '/fixture/hello.txt' });
  assert.equal(wrongPin.value.error, 'host_untrusted');
  assert.equal(wrongPin.value.text, undefined);
  const missingCredential = await call(203, 'file_read_text', { host_id: missingCredentialHostId, path: '/fixture/hello.txt' });
  assert.equal(missingCredential.value.error, 'host_record_invalid');
  const unauthenticated = await authedCall('wrong-bearer', 204, 'file_read_text', { host_id: secondHostId, path: '/fixture/hello.txt' });
  assert.equal(unauthenticated, 401);
  const overlongPath = await call(205, 'file_list', { host_id: secondHostId, path: '😀'.repeat(1025) });
  assert.equal(overlongPath.isError, true);
  assert.equal(overlongPath.value.error, 'invalid_args');
  const overlongWrite = await call(216, 'file_write_text', {
    host_id: secondHostId, operation_id: 'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2',
    path: '😀'.repeat(1025), text: 'x', overwrite: false,
  });
  assert.equal(overlongWrite.isError, true);
  assert.equal(overlongWrite.value.error, 'invalid_args');
  const hugeWrite = await call(217, 'file_write_text', {
    host_id: secondHostId, operation_id: 'd3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3',
    path: '/fixture/created-92.txt', text: 'x'.repeat(64 * 1024 + 1), overwrite: false,
  });
  assert.equal(hugeWrite.isError, true);
  assert.equal(hugeWrite.value.error, 'invalid_args');
  const missingOverwrite = await call(218, 'file_write_text', {
    host_id: secondHostId, operation_id: 'd4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4',
    path: '/fixture/created-92.txt', text: 'x',
  });
  assert.equal(missingOverwrite.isError, true);
  assert.equal(missingOverwrite.value.error, 'invalid_args');
  const unauthenticatedWrite = await authedCall('wrong-bearer', 219, 'file_write_text', {
    host_id: secondHostId, operation_id: 'd5d5d5d5-d5d5-45d5-85d5-d5d5d5d5d5d5',
    path: '/fixture/created-92.txt', text: 'x', overwrite: true,
  });
  assert.equal(unauthenticatedWrite, 401);
  const overlongRename = await call(243, 'file_move', {
    host_id: secondHostId, operation_id: 'd9d9d9d9-d9d9-49d9-89d9-d9d9d9d9d9d9',
    old_path: '😀'.repeat(1025), new_path: '/fixture/b.txt', overwrite: false,
  });
  assert.equal(overlongRename.isError, true);
  assert.equal(overlongRename.value.error, 'invalid_args');
  const overlongDestination = await call(244, 'file_move', {
    host_id: secondHostId, operation_id: 'dadadada-dada-4ada-8ada-dadadadadada',
    old_path: '/fixture/a.txt', new_path: '😀'.repeat(1025), overwrite: true,
  });
  assert.equal(overlongDestination.isError, true);
  assert.equal(overlongDestination.value.error, 'invalid_args');
  const missingOverwriteRename = await call(245, 'file_move', {
    host_id: secondHostId, operation_id: 'dbdbdbdb-dbdb-4bdb-8bdb-dbdbdbdbdbdb',
    old_path: '/fixture/a.txt', new_path: '/fixture/b.txt',
  });
  assert.equal(missingOverwriteRename.isError, true);
  assert.equal(missingOverwriteRename.value.error, 'invalid_args');
  const unauthenticatedRename = await authedCall('wrong-bearer', 246, 'file_move', {
    host_id: secondHostId, operation_id: 'dcdcdcdc-dcdc-4cdc-8cdc-dcdcdcdcdcdc',
    old_path: '/fixture/a.txt', new_path: '/fixture/b.txt', overwrite: false,
  });
  assert.equal(unauthenticatedRename, 401);
  const implicitDelete = await call(247, 'file_delete', {
    host_id: secondHostId, operation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    path: '/fixture/a.txt', kind: 'file',
  });
  assert.equal(implicitDelete.isError, true);
  assert.equal(implicitDelete.value.error, 'invalid_args');
  const recursiveDelete = await call(248, 'file_delete', {
    host_id: secondHostId, operation_id: 'dededede-dede-4ede-8ede-dededededede',
    path: '/fixture/a.txt', kind: 'file', confirm: true, recursive: true,
  });
  assert.equal(recursiveDelete.isError, true);
  assert.equal(recursiveDelete.value.error, 'invalid_args');
  const wrongDeleteKind = await call(249, 'file_delete', {
    host_id: secondHostId, operation_id: 'dfdfdfdf-dfdf-4fdf-8fdf-dfdfdfdfdfdf',
    path: '/fixture/a.txt', kind: 'directory', confirm: true,
  });
  assert.equal(wrongDeleteKind.isError, true);
  assert.equal(wrongDeleteKind.value.error, 'invalid_args');
  const unauthenticatedDelete = await authedCall('wrong-bearer', 250, 'file_delete', {
    host_id: secondHostId, operation_id: 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0',
    path: '/fixture/a.txt', kind: 'file', confirm: true,
  });
  assert.equal(unauthenticatedDelete, 401);
  const overlongMkdir = await call(251, 'file_mkdir', {
    host_id: secondHostId, operation_id: 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1', path: '😀'.repeat(1025),
  });
  assert.equal(overlongMkdir.isError, true);
  assert.equal(overlongMkdir.value.error, 'invalid_args');
  const unauthenticatedMkdir = await authedCall('wrong-bearer', 252, 'file_mkdir', {
    host_id: secondHostId, operation_id: 'e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2', path: '/fixture/new-dir',
  });
  assert.equal(unauthenticatedMkdir, 401);
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-subsystem/g)?.length ?? 0, sftpCallsBefore.sftp, 'rejected SFTP targets must not open a subsystem');
  assert.equal(await passwordAuths(), sftpCallsBefore.auth, 'capacity, private, wrong pin, missing credential, and bad bearer must not authenticate');

  const sftpListed = await call(206, 'file_list', { host_id: secondHostId, path: '/fixture' });
  assert.equal(sftpListed.value.status, 'completed', JSON.stringify(sftpListed));
  assert.deepEqual(sftpListed.value.entries, [
    { name: 'hello.txt', type: 'file', size: Buffer.byteLength('héllo SSH\n') },
    { name: 'out.txt', type: 'file', size: 0 },
    { name: 'binary.bin', type: 'file', size: 3 },
    { name: 'big.txt', type: 'file', size: 64 * 1024 + 1 },
    { name: 'envelope.txt', type: 'file', size: 65_000 },
    { name: 'many', type: 'directory', size: 0 },
  ]);
  assert.equal(sftpListed.value.truncated, false);
  const readText = await call(207, 'file_read_text', { host_id: secondHostId, path: '/fixture/hello.txt' });
  assert.equal(readText.value.status, 'completed', JSON.stringify(readText));
  assert.equal(readText.value.text, 'héllo SSH\n');
  assert.equal(readText.value.bytes, Buffer.byteLength('héllo SSH\n'));
  assert.equal(readText.value.cursor, readText.value.bytes);
  assert.equal(readText.value.truncated, false);
  const many = await call(208, 'file_list', { host_id: secondHostId, path: '/fixture/many' });
  assert.equal(many.value.status, 'completed', JSON.stringify(many));
  assert.equal((many.value.entries as unknown[]).length, 100);
  assert.equal(many.value.truncated, true);
  assert.equal((many.value.entries as Array<{ name: string }>).some(entry => entry.name === 'item-100.txt'), false);
  const binary = await call(209, 'file_read_text', { host_id: secondHostId, path: '/fixture/binary.bin' });
  assert.equal(binary.value.error, 'output_truncated');
  assert.equal(binary.value.text, undefined);
  const oversized = await call(210, 'file_read_text', { host_id: secondHostId, path: '/fixture/big.txt' });
  assert.equal(oversized.value.error, 'output_truncated');
  assert.equal(oversized.value.truncated, true);
  assert.equal(oversized.value.text, undefined);
  const envelope = await call(214, 'file_read_text', { host_id: secondHostId, path: '/fixture/envelope.txt' });
  assert.equal(envelope.value.status, 'failed');
  assert.equal(envelope.value.error, 'output_truncated');
  assert.equal(envelope.value.text, undefined);
  assert.equal(envelope.value.cursor, undefined);
  assert.doesNotMatch(JSON.stringify(envelope.value), /a{64}/, 'an over-budget UTF-8 file must not return a partial body');
  const missingFile = await call(211, 'file_read_text', { host_id: secondHostId, path: '/fixture/missing.txt' });
  assert.equal(missingFile.value.status, 'failed');
  assert.equal(missingFile.value.error, 'host_unreachable');
  assert.equal(missingFile.value.text, undefined);
  const sftpResults = [blockedList, privateTarget, wrongPin, missingCredential, sftpListed, readText, many, binary, oversized, envelope, missingFile];
  assert.doesNotMatch(JSON.stringify(sftpResults), /synthetic-password|synthetic-initial-command|privateKey|ENCRYPTION_KEY/);
  assert.equal((await readFile(authLog, 'utf8')).match(/exec-command:/g)?.length ?? 0, sftpCallsBefore.exec, 'SFTP must not run initialCommand or another exec');
  assert.equal(await shellOpens(), sftpCallsBefore.shells, 'SFTP must not open a managed shell');
  const operationsAfter = await fixtureRequest<{ count: number }>('operation-count', {});
  assert.equal(operationsAfter?.count, operationsBefore?.count, 'SFTP list and read do not write a mutation receipt');
  const subsystemsBeforePrivateRename = (await readFile(authLog, 'utf8')).match(/sftp-subsystem/g)?.length ?? 0;
  const privateRename = await call(253, 'file_move', {
    host_id: privateHostId, operation_id: 'e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3',
    old_path: '/fixture/a.txt', new_path: '/fixture/b.txt', overwrite: false,
  });
  assert.equal(privateRename.value.error, 'invalid_target');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-subsystem/g)?.length ?? 0, subsystemsBeforePrivateRename, 'a private rename target must not open SFTP');
  assert.doesNotMatch(JSON.stringify(privateRename), /synthetic-password|privateKey|ENCRYPTION_KEY/);
  const leasesAfterReads = await fixtureRequest<{ total: number; perHost: Record<string, number> }>('lease-count', {});
  assert.equal(leasesAfterReads?.perHost[secondHostId] ?? 0, 0, 'a finished SFTP call releases its connection lease');

  const sftpLogBeforeStall = await readFile(authLog, 'utf8');
  const closedBeforeStall = sftpLogBeforeStall.match(/connection-closed:/g)?.length ?? 0;
  const sessionsBeforeStall = sftpLogBeforeStall.match(/sftp-session-closed:/g)?.length ?? 0;
  const stalledList = call(212, 'file_list', { host_id: secondHostId, path: '/fixture/stall', timeout_ms: 1_000 });
  let stallConnectionId: string | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    stallConnectionId = (await readFile(authLog, 'utf8')).match(/sftp-stall:(\d+)/)?.[1];
    if (stallConnectionId) break;
    await delay(50);
  }
  assert.ok(stallConnectionId, 'the stalled directory open identifies its SSH connection');
  await allowPtyResets([stallConnectionId]);
  const duringSftpStall = await fixtureRequest<{ total: number; perHost: Record<string, number> }>('lease-count', {});
  assert.equal(duringSftpStall?.perHost[secondHostId], 1, 'an SFTP call that has not finished still holds the host connection quota');
  const stalledListResult = await stalledList;
  assert.equal(stalledListResult.value.status, 'failed');
  assert.equal(stalledListResult.value.error, 'host_unreachable');
  await clearPtyResets();
  const releasedAfterStall = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
  assert.equal(releasedAfterStall?.perHost[secondHostId] ?? 0, 0, 'an SFTP timeout releases the connection lease');
  let stallClosed = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const log = await readFile(authLog, 'utf8');
    stallClosed = log.includes(`connection-closed:${stallConnectionId}\n`) && (log.match(/sftp-session-closed:/g)?.length ?? 0) >= sessionsBeforeStall;
    if (stallClosed && (log.match(/connection-closed:/g)?.length ?? 0) > closedBeforeStall) break;
    await delay(50);
  }
  assert.equal(stallClosed, true, 'SFTP timeout closes the short SSH connection');
  const afterSftp = await call(213, 'file_read_text', { host_id: secondHostId, path: '/fixture/hello.txt' });
  assert.equal(afterSftp.value.text, 'héllo SSH\n', 'a later read can connect after the timed-out lease is released');
  const finalSftpLog = await readFile(authLog, 'utf8');
  assert.doesNotMatch(finalSftpLog, /unexpected-fixture-error:/, 'only the intentional stalled SFTP connection may absorb ECONNRESET');
  assert.equal((finalSftpLog.match(/exec-command:/g) ?? []).length, sftpCallsBefore.exec);

  const writeTextBody = 'héllo write';
  const writePath = '/fixture/created-92.txt';
  const writeOperationId = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
  const created = await call(220, 'file_write_text', {
    host_id: secondHostId, operation_id: writeOperationId, path: writePath, text: writeTextBody, overwrite: false,
  });
  assert.equal(created.value.status, 'completed', JSON.stringify(created));
  assert.equal(created.value.bytes, Buffer.byteLength(writeTextBody));
  assert.equal(created.value.text, undefined);
  assert.equal(created.value.partial_write, undefined);
  assert.doesNotMatch(JSON.stringify(created), /héllo write|synthetic-password|synthetic-initial-command|privateKey|ENCRYPTION_KEY/);
  const writeReceipt = await fixtureRequest('read-receipt', { operationId: writeOperationId });
  assert.ok(writeReceipt);
  assert.equal(writeReceipt.status, 'completed');
  assert.doesNotMatch(JSON.stringify(writeReceipt), /héllo write|synthetic-password|privateKey|ENCRYPTION_KEY/);
  const expectedWriteDigest = await digestVector({
    tool: 'sftp_write', hostId: secondHostId, sessionId: null, normalizedArgs: [writePath, writeTextBody, false],
  });
  assert.equal(writeReceipt.digest, expectedWriteDigest.digest);
  const readCreated = await call(221, 'file_read_text', { host_id: secondHostId, path: writePath });
  assert.equal(readCreated.value.text, writeTextBody);
  const replayWrite = await call(222, 'file_write_text', {
    host_id: secondHostId, operation_id: writeOperationId, path: writePath, text: writeTextBody, overwrite: false, timeout_ms: 15_000,
  });
  assert.equal(replayWrite.value.status, 'completed');
  assert.equal(replayWrite.value.bytes, Buffer.byteLength(writeTextBody));
  assert.equal(replayWrite.value.text, undefined);
  const conflictWrite = await call(223, 'file_write_text', {
    host_id: secondHostId, operation_id: writeOperationId, path: writePath, text: 'changed', overwrite: false,
  });
  assert.equal(conflictWrite.value.error, 'receipt_conflict');
  const overwriteFlagConflict = await call(224, 'file_write_text', {
    host_id: secondHostId, operation_id: writeOperationId, path: writePath, text: writeTextBody, overwrite: true,
  });
  assert.equal(overwriteFlagConflict.value.error, 'receipt_conflict');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-write:\/fixture\/created-92.txt:/g)?.length ?? 0, 1,
    'same-id replay and argument conflicts must not write again');

  const exists = await call(225, 'file_write_text', {
    host_id: secondHostId, operation_id: 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2',
    path: '/fixture/hello.txt', text: 'nope', overwrite: false,
  });
  assert.equal(exists.value.status, 'failed', JSON.stringify(exists));
  assert.equal(exists.value.error, 'conflict');
  assert.equal(exists.value.partial_write, undefined);
  const helloStill = await call(226, 'file_read_text', { host_id: secondHostId, path: '/fixture/hello.txt' });
  assert.equal(helloStill.value.text, 'héllo SSH\n');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-write:\/fixture\/hello.txt:/g)?.length ?? 0, 0);

  const replaced = await call(227, 'file_write_text', {
    host_id: secondHostId, operation_id: 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3',
    path: '/fixture/out.txt', text: 'first overwrite', overwrite: true,
  });
  assert.equal(replaced.value.status, 'completed', JSON.stringify(replaced));
  assert.equal(replaced.value.text, undefined);
  const replacedAgain = await call(228, 'file_write_text', {
    host_id: secondHostId, operation_id: 'c4c4c4c4-c4c4-44c4-84c4-c4c4c4c4c4c4',
    path: '/fixture/out.txt', text: 'second', overwrite: true,
  });
  assert.equal(replacedAgain.value.status, 'completed');
  const readReplaced = await call(229, 'file_read_text', { host_id: secondHostId, path: '/fixture/out.txt' });
  assert.equal(readReplaced.value.text, 'second');

  const privateWrite = await call(230, 'file_write_text', {
    host_id: privateHostId, operation_id: 'c5c5c5c5-c5c5-45c5-85c5-c5c5c5c5c5c5',
    path: writePath, text: 'x', overwrite: true,
  });
  assert.equal(privateWrite.value.error, 'invalid_target');
  const wrongPinWrite = await call(231, 'file_write_text', {
    host_id: wrongPinHostId, operation_id: 'c6c6c6c6-c6c6-46c6-86c6-c6c6c6c6c6c6',
    path: writePath, text: 'x', overwrite: true,
  });
  assert.equal(wrongPinWrite.value.error, 'host_untrusted');
  assert.doesNotMatch(JSON.stringify(wrongPinWrite), /synthetic-password|privateKey|ENCRYPTION_KEY/);
  const missingCredentialWrite = await call(232, 'file_write_text', {
    host_id: missingCredentialHostId, operation_id: 'c7c7c7c7-c7c7-47c7-87c7-c7c7c7c7c7c7',
    path: writePath, text: 'x', overwrite: true,
  });
  assert.equal(missingCredentialWrite.value.error, 'host_record_invalid');

  const dropId = 'c8c8c8c8-c8c8-48c8-88c8-c8c8c8c8c8c8';
  const dropBody = 'partial-body-must-not-persist';
  const drop = await call(233, 'file_write_text', {
    host_id: secondHostId, operation_id: dropId, path: '/fixture/drop-write', text: dropBody, overwrite: true, timeout_ms: 10_000,
  });
  assert.equal(drop.value.status, 'unknown', JSON.stringify(drop));
  assert.equal(drop.value.error, 'unknown_outcome');
  assert.equal(drop.value.partial_write, 'possible');
  assert.equal(drop.value.text, undefined);
  assert.doesNotMatch(JSON.stringify(drop), /partial-body-must-not-persist|synthetic-password/);
  const dropReplay = await call(234, 'file_write_text', {
    host_id: secondHostId, operation_id: dropId, path: '/fixture/drop-write', text: dropBody, overwrite: true,
  });
  assert.equal(dropReplay.value.status, 'unknown');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-write-drop:/g)?.length ?? 0, 1, 'a disconnected write is not replayed');
  const dropReceipt = await fixtureRequest('read-receipt', { operationId: dropId });
  assert.doesNotMatch(JSON.stringify(dropReceipt), /partial-body-must-not-persist/);

  const stallWriteId = 'c9c9c9c9-c9c9-49c9-89c9-c9c9c9c9c9c9';
  const stalledWrite = call(235, 'file_write_text', {
    host_id: secondHostId, operation_id: stallWriteId, path: '/fixture/stall-write', text: 'stalled', overwrite: true, timeout_ms: 1_000,
  });
  let stallWriteConnection: string | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    stallWriteConnection = (await readFile(authLog, 'utf8')).match(/sftp-stall-write:(\d+)/)?.[1];
    if (stallWriteConnection) break;
    await delay(50);
  }
  assert.ok(stallWriteConnection, 'the stalled write identifies its SSH connection');
  await allowPtyResets([stallWriteConnection]);
  const duringWriteStall = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
  assert.equal(duringWriteStall?.perHost[secondHostId], 1, 'an in-flight SFTP write holds the host connection quota');
  const stalledWriteResult = await stalledWrite;
  assert.equal(stalledWriteResult.value.status, 'unknown', JSON.stringify(stalledWriteResult));
  assert.equal(stalledWriteResult.value.error, 'unknown_outcome');
  assert.equal(stalledWriteResult.value.partial_write, 'possible');
  await clearPtyResets();
  const releasedWrite = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
  assert.equal(releasedWrite?.perHost[secondHostId] ?? 0, 0, 'a timed-out SFTP write releases the connection lease');
  const stallReplay = await call(236, 'file_write_text', {
    host_id: secondHostId, operation_id: stallWriteId, path: '/fixture/stall-write', text: 'stalled', overwrite: true, timeout_ms: 1_000,
  });
  assert.equal(stallReplay.value.status, 'unknown');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-stall-write:/g)?.length ?? 0, 1, 'replaying an uncertain write must not open SFTP again');

  const commitWriteId = 'cacacaca-caca-4aca-8aca-cacacacacaca';
  const commitBody = 'commit-body-must-not-persist';
  await control('PUT', 'terminal-update-failure');
  const commitWrite = await call(237, 'file_write_text', {
    host_id: secondHostId, operation_id: commitWriteId, path: '/fixture/commit-write.txt', text: commitBody, overwrite: false,
  });
  assert.equal(commitWrite.value.status, 'unknown', JSON.stringify(commitWrite));
  assert.equal(commitWrite.value.partial_write, 'possible');
  assert.doesNotMatch(JSON.stringify(commitWrite), /commit-body-must-not-persist|synthetic-password/);
  await control('DELETE', 'terminal-update-failure');
  const commitReplay = await call(238, 'file_write_text', {
    host_id: secondHostId, operation_id: commitWriteId, path: '/fixture/commit-write.txt', text: commitBody, overwrite: false,
  });
  assert.equal(commitReplay.value.status, 'unknown');
  const commitRead = await call(239, 'file_read_text', { host_id: secondHostId, path: '/fixture/commit-write.txt' });
  assert.equal(commitRead.value.text, commitBody, 'the remote write happened once before the receipt failure');
  const commitReceipt = await fixtureRequest('read-receipt', { operationId: commitWriteId });
  assert.doesNotMatch(JSON.stringify(commitReceipt), /commit-body-must-not-persist/);
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-write:\/fixture\/commit-write.txt:/g)?.length ?? 0, 1);

  const renameBody = 'rename-body-93';
  const renameSource = '/fixture/rename-src-93.txt';
  const renameDestination = '/fixture/rename-dst-93.txt';
  const renameOperationId = 'e4e4e4e4-e4e4-44e4-84e4-e4e4e4e4e4e4';
  const seeded = await call(260, 'file_write_text', {
    host_id: secondHostId, operation_id: 'e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5',
    path: renameSource, text: renameBody, overwrite: false,
  });
  assert.equal(seeded.value.status, 'completed', JSON.stringify(seeded));
  const renamedFile = await call(261, 'file_move', {
    host_id: secondHostId, operation_id: renameOperationId,
    old_path: renameSource, new_path: renameDestination, overwrite: false,
  });
  assert.equal(renamedFile.value.status, 'completed', JSON.stringify(renamedFile));
  assert.equal(renamedFile.value.partial_write, undefined);
  assert.doesNotMatch(JSON.stringify(renamedFile), /rename-body-93|synthetic-password|privateKey|ENCRYPTION_KEY/);
  const renameReceipt = await fixtureRequest('read-receipt', { operationId: renameOperationId });
  assert.ok(renameReceipt);
  assert.equal(renameReceipt.status, 'completed');
  const expectedRenameDigest = await digestVector({
    tool: 'sftp_rename', hostId: secondHostId, sessionId: null, normalizedArgs: [renameSource, renameDestination, false],
  });
  assert.equal(renameReceipt.digest, expectedRenameDigest.digest);
  assert.doesNotMatch(renameReceipt.result_json ?? '', /rename-body-93|synthetic-password|privateKey|ENCRYPTION_KEY|rename-src-93/);
  const readRenamed = await call(262, 'file_read_text', { host_id: secondHostId, path: renameDestination });
  assert.equal(readRenamed.value.text, renameBody);
  const readOld = await call(263, 'file_read_text', { host_id: secondHostId, path: renameSource });
  assert.equal(readOld.value.error, 'host_unreachable');
  const replayRename = await call(264, 'file_move', {
    host_id: secondHostId, operation_id: renameOperationId,
    old_path: renameSource, new_path: renameDestination, overwrite: false, timeout_ms: 15_000,
  });
  assert.equal(replayRename.value.status, 'completed');
  const conflictRename = await call(265, 'file_move', {
    host_id: secondHostId, operation_id: renameOperationId,
    old_path: renameSource, new_path: '/fixture/elsewhere-93.txt', overwrite: false,
  });
  assert.equal(conflictRename.value.error, 'receipt_conflict');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-rename:\/fixture\/rename-src-93.txt:\/fixture\/rename-dst-93.txt/g)?.length ?? 0, 1,
    'same-id replay and argument conflicts must not rename again');

  const occupied = await call(266, 'file_move', {
    host_id: secondHostId, operation_id: 'e6e6e6e6-e6e6-46e6-86e6-e6e6e6e6e6e6',
    old_path: '/fixture/out.txt', new_path: renameDestination, overwrite: false,
  });
  assert.equal(occupied.value.status, 'failed', JSON.stringify(occupied));
  assert.equal(occupied.value.error, 'conflict');
  const stillThere = await call(267, 'file_read_text', { host_id: secondHostId, path: '/fixture/out.txt' });
  assert.equal(stillThere.value.text, 'second');
  const replacedName = await call(268, 'file_move', {
    host_id: secondHostId, operation_id: 'e7e7e7e7-e7e7-47e7-87e7-e7e7e7e7e7e7',
    old_path: '/fixture/out.txt', new_path: renameDestination, overwrite: true,
  });
  assert.equal(replacedName.value.status, 'completed', JSON.stringify(replacedName));
  assert.equal(replacedName.value.partial_write, undefined);
  const readReplacedName = await call(269, 'file_read_text', { host_id: secondHostId, path: renameDestination });
  assert.equal(readReplacedName.value.text, 'second');
  const oldOut = await call(270, 'file_read_text', { host_id: secondHostId, path: '/fixture/out.txt' });
  assert.equal(oldOut.value.error, 'host_unreachable');
  const missingRename = await call(271, 'file_move', {
    host_id: secondHostId, operation_id: 'e8e8e8e8-e8e8-48e8-88e8-e8e8e8e8e8e8',
    old_path: '/fixture/missing-93.txt', new_path: '/fixture/missing-dst-93.txt', overwrite: false,
  });
  assert.equal(missingRename.value.status, 'failed');
  assert.equal(missingRename.value.error, 'host_unreachable');

  const mkdirId = 'e9e9e9e9-e9e9-49e9-89e9-e9e9e9e9e9e9';
  const made = await call(272, 'file_mkdir', {
    host_id: secondHostId, operation_id: mkdirId, path: '/fixture/tree-93',
  });
  assert.equal(made.value.status, 'completed', JSON.stringify(made));
  const mkdirReceipt = await fixtureRequest('read-receipt', { operationId: mkdirId });
  const expectedMkdirDigest = await digestVector({
    tool: 'sftp_mkdir', hostId: secondHostId, sessionId: null, normalizedArgs: ['/fixture/tree-93'],
  });
  assert.equal(mkdirReceipt?.digest, expectedMkdirDigest.digest);
  assert.doesNotMatch(mkdirReceipt?.result_json ?? '', /synthetic-password|privateKey|ENCRYPTION_KEY/);
  const madeChild = await call(273, 'file_mkdir', {
    host_id: secondHostId, operation_id: 'eaeaeaea-eaea-4aea-8aea-eaeaeaeaeaea', path: '/fixture/tree-93/child',
  });
  assert.equal(madeChild.value.status, 'completed', JSON.stringify(madeChild));
  const missingParent = await call(274, 'file_mkdir', {
    host_id: secondHostId, operation_id: 'ebebebeb-ebeb-4beb-8beb-ebebebebebeb', path: '/fixture/tree-93/missing/leaf',
  });
  assert.equal(missingParent.value.status, 'failed', JSON.stringify(missingParent));
  assert.equal(missingParent.value.error, 'host_unreachable');
  const missingParentList = await call(275, 'file_list', { host_id: secondHostId, path: '/fixture/tree-93/missing' });
  assert.equal(missingParentList.value.error, 'host_unreachable');
  const mkdirAgain = await call(276, 'file_mkdir', {
    host_id: secondHostId, operation_id: 'ecececec-ecec-4cec-8cec-ecececececec', path: '/fixture/tree-93',
  });
  assert.equal(mkdirAgain.value.error, 'conflict');
  const mkdirFile = await call(277, 'file_mkdir', {
    host_id: secondHostId, operation_id: 'edededed-eded-4ded-8ded-edededededed', path: '/fixture/hello.txt',
  });
  assert.equal(mkdirFile.value.error, 'conflict');
  const helloAfterMkdir = await call(278, 'file_read_text', { host_id: secondHostId, path: '/fixture/hello.txt' });
  assert.equal(helloAfterMkdir.value.text, 'héllo SSH\n');
  const listedRoot = await call(279, 'file_list', { host_id: secondHostId, path: '/fixture' });
  assert.deepEqual(listedRoot.value.entries, [
    { name: 'hello.txt', type: 'file', size: Buffer.byteLength('héllo SSH\n') },
    { name: 'binary.bin', type: 'file', size: 3 },
    { name: 'big.txt', type: 'file', size: 64 * 1024 + 1 },
    { name: 'envelope.txt', type: 'file', size: 65_000 },
    { name: 'created-92.txt', type: 'file', size: Buffer.byteLength(writeTextBody) },
    { name: 'drop-write', type: 'file', size: 0 },
    { name: 'stall-write', type: 'file', size: 0 },
    { name: 'commit-write.txt', type: 'file', size: Buffer.byteLength(commitBody) },
    { name: 'rename-dst-93.txt', type: 'file', size: Buffer.byteLength('second') },
    { name: 'tree-93', type: 'directory', size: 0 },
    { name: 'many', type: 'directory', size: 0 },
  ]);
  const listedTree = await call(280, 'file_list', { host_id: secondHostId, path: '/fixture/tree-93' });
  assert.equal(listedTree.value.status, 'completed', JSON.stringify(listedTree));
  assert.deepEqual(listedTree.value.entries, [{ name: 'child', type: 'directory', size: 0 }]);
  const replayMkdir = await call(281, 'file_mkdir', {
    host_id: secondHostId, operation_id: mkdirId, path: '/fixture/tree-93',
  });
  assert.equal(replayMkdir.value.status, 'completed');
  const mkdirConflict = await call(282, 'file_mkdir', {
    host_id: secondHostId, operation_id: mkdirId, path: '/fixture/tree-93/other',
  });
  assert.equal(mkdirConflict.value.error, 'receipt_conflict');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-mkdir:\/fixture\/tree-93\n/g)?.length ?? 0, 1,
    'same-id replay and argument conflicts must not create the directory again');

  const childFile = await call(283, 'file_write_text', {
    host_id: secondHostId, operation_id: 'a93a93a9-93a9-493a-893a-93a93a93a93a',
    path: '/fixture/tree-93/child/note.txt', text: 'kept', overwrite: false,
  });
  assert.equal(childFile.value.status, 'completed', JSON.stringify(childFile));
  const deleteTree = await call(284, 'file_delete', {
    host_id: secondHostId, operation_id: 'efefefef-efef-4fef-8fef-efefefefefef',
    path: '/fixture/tree-93/child', kind: 'empty_directory', confirm: true,
  });
  assert.equal(deleteTree.value.status, 'failed', JSON.stringify(deleteTree));
  assert.equal(deleteTree.value.error, 'conflict');
  const keptNote = await call(285, 'file_read_text', { host_id: secondHostId, path: '/fixture/tree-93/child/note.txt' });
  assert.equal(keptNote.value.text, 'kept');
  const deleteFileAsDir = await call(286, 'file_delete', {
    host_id: secondHostId, operation_id: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0',
    path: '/fixture/tree-93/child/note.txt', kind: 'empty_directory', confirm: true,
  });
  assert.equal(deleteFileAsDir.value.error, 'conflict');
  const deleteNoteId = 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1';
  const deletedNote = await call(287, 'file_delete', {
    host_id: secondHostId, operation_id: deleteNoteId,
    path: '/fixture/tree-93/child/note.txt', kind: 'file', confirm: true,
  });
  assert.equal(deletedNote.value.status, 'completed', JSON.stringify(deletedNote));
  assert.equal(deletedNote.value.partial_write, undefined);
  assert.doesNotMatch(JSON.stringify(deletedNote), /kept|synthetic-password|privateKey|ENCRYPTION_KEY/);
  const noteReceipt = await fixtureRequest('read-receipt', { operationId: deleteNoteId });
  const expectedDeleteDigest = await digestVector({
    tool: 'sftp_delete', hostId: secondHostId, sessionId: null,
    normalizedArgs: ['/fixture/tree-93/child/note.txt', 'file', true],
  });
  assert.equal(noteReceipt?.digest, expectedDeleteDigest.digest);
  assert.doesNotMatch(noteReceipt?.result_json ?? '', /kept|note\.txt|synthetic-password|privateKey|ENCRYPTION_KEY/);
  const replayDelete = await call(288, 'file_delete', {
    host_id: secondHostId, operation_id: deleteNoteId,
    path: '/fixture/tree-93/child/note.txt', kind: 'file', confirm: true,
  });
  assert.equal(replayDelete.value.status, 'completed');
  const deleteKindConflict = await call(289, 'file_delete', {
    host_id: secondHostId, operation_id: deleteNoteId,
    path: '/fixture/tree-93/child/note.txt', kind: 'empty_directory', confirm: true,
  });
  assert.equal(deleteKindConflict.value.error, 'receipt_conflict');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-delete:file:\/fixture\/tree-93\/child\/note.txt/g)?.length ?? 0, 1,
    'same-id replay and argument conflicts must not delete again');
  const deletedChild = await call(290, 'file_delete', {
    host_id: secondHostId, operation_id: 'f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2',
    path: '/fixture/tree-93/child', kind: 'empty_directory', confirm: true,
  });
  assert.equal(deletedChild.value.status, 'completed', JSON.stringify(deletedChild));
  const childGone = await call(291, 'file_list', { host_id: secondHostId, path: '/fixture/tree-93/child' });
  assert.equal(childGone.value.error, 'host_unreachable');
  const wrongPinRename = await call(292, 'file_move', {
    host_id: wrongPinHostId, operation_id: 'f3f3f3f3-f3f3-43f3-83f3-f3f3f3f3f3f3',
    old_path: renameDestination, new_path: '/fixture/nope-93.txt', overwrite: false,
  });
  assert.equal(wrongPinRename.value.error, 'host_untrusted');
  assert.doesNotMatch(JSON.stringify(wrongPinRename), /synthetic-password|privateKey|ENCRYPTION_KEY/);

  const stallRenameId = 'f4f4f4f4-f4f4-44f4-84f4-f4f4f4f4f4f4';
  const stalledRename = call(293, 'file_move', {
    host_id: secondHostId, operation_id: stallRenameId,
    old_path: '/fixture/stall-rename', new_path: '/fixture/stall-rename-dst', overwrite: false, timeout_ms: 1_000,
  });
  let stallRenameConnection: string | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    stallRenameConnection = (await readFile(authLog, 'utf8')).match(/sftp-stall-rename:(\d+)/)?.[1];
    if (stallRenameConnection) break;
    await delay(50);
  }
  assert.ok(stallRenameConnection, 'the stalled rename identifies its SSH connection');
  await allowPtyResets([stallRenameConnection]);
  const duringRenameStall = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
  assert.equal(duringRenameStall?.perHost[secondHostId], 1, 'an in-flight SFTP rename holds the host connection quota');
  const stalledRenameResult = await stalledRename;
  assert.equal(stalledRenameResult.value.status, 'unknown', JSON.stringify(stalledRenameResult));
  assert.equal(stalledRenameResult.value.error, 'unknown_outcome');
  assert.equal(stalledRenameResult.value.partial_write, undefined);
  await clearPtyResets();
  const releasedRename = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
  assert.equal(releasedRename?.perHost[secondHostId] ?? 0, 0, 'a timed-out SFTP rename releases the connection lease');
  const stallRenameReplay = await call(294, 'file_move', {
    host_id: secondHostId, operation_id: stallRenameId,
    old_path: '/fixture/stall-rename', new_path: '/fixture/stall-rename-dst', overwrite: false, timeout_ms: 1_000,
  });
  assert.equal(stallRenameReplay.value.status, 'unknown');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-stall-rename:/g)?.length ?? 0, 1, 'replaying an uncertain rename must not open SFTP again');

  const dropRenameId = 'f5f5f5f5-f5f5-45f5-85f5-f5f5f5f5f5f5';
  const droppedRename = await call(295, 'file_move', {
    host_id: secondHostId, operation_id: dropRenameId,
    old_path: '/fixture/drop-rename', new_path: '/fixture/drop-rename-dst', overwrite: false, timeout_ms: 10_000,
  });
  assert.equal(droppedRename.value.status, 'unknown', JSON.stringify(droppedRename));
  assert.equal(droppedRename.value.partial_write, undefined);
  const droppedReplay = await call(296, 'file_move', {
    host_id: secondHostId, operation_id: dropRenameId,
    old_path: '/fixture/drop-rename', new_path: '/fixture/drop-rename-dst', overwrite: false,
  });
  assert.equal(droppedReplay.value.status, 'unknown');
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-rename-drop:/g)?.length ?? 0, 1, 'a disconnected rename is not replayed');

  await control('PUT', 'terminal-update-failure');
  const commitRenameId = 'f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6';
  const commitRename = await call(297, 'file_move', {
    host_id: secondHostId, operation_id: commitRenameId,
    old_path: renameDestination, new_path: '/fixture/commit-rename-93.txt', overwrite: false,
  });
  assert.equal(commitRename.value.status, 'unknown', JSON.stringify(commitRename));
  assert.equal(commitRename.value.partial_write, undefined);
  assert.doesNotMatch(JSON.stringify(commitRename), /synthetic-password|privateKey|ENCRYPTION_KEY/);
  await control('DELETE', 'terminal-update-failure');
  const commitRenameReplay = await call(298, 'file_move', {
    host_id: secondHostId, operation_id: commitRenameId,
    old_path: renameDestination, new_path: '/fixture/commit-rename-93.txt', overwrite: false,
  });
  assert.equal(commitRenameReplay.value.status, 'unknown');
  const commitRenamed = await call(299, 'file_read_text', { host_id: secondHostId, path: '/fixture/commit-rename-93.txt' });
  assert.equal(commitRenamed.value.text, 'second', 'the remote rename happened once before the receipt failure');
  const commitRenameReceipt = await fixtureRequest('read-receipt', { operationId: commitRenameId });
  assert.doesNotMatch(commitRenameReceipt?.result_json ?? '', /second|synthetic-password|privateKey/);
  assert.equal((await readFile(authLog, 'utf8')).match(/sftp-rename:\/fixture\/rename-dst-93.txt:\/fixture\/commit-rename-93.txt/g)?.length ?? 0, 1);

  const afterWriteLog = await readFile(authLog, 'utf8');
  assert.doesNotMatch(afterWriteLog, /unexpected-fixture-error:/, 'only an intentional interrupted write may absorb ECONNRESET');
  assert.equal((afterWriteLog.match(/exec-command:/g) ?? []).length, sftpCallsBefore.exec, 'SFTP write must not run initialCommand or another exec');
  const leasesAfterWrite = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
  assert.equal(leasesAfterWrite?.perHost[secondHostId] ?? 0, 0, 'finished SFTP writes release the host connection lease');

  const slowHostId = '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a';
  const thirdHostId = '1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b';
  const fourthHostId = '1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c';
  await mutateHost({ action: 'insert', hostId: slowHostId, accountId, encryptedPayload: await encryptedHost(slowHostId, 'synthetic-password-do-not-use', { host: 'slow-dns.example.test' }) });
  await mutateHost({ action: 'insert', hostId: thirdHostId, accountId, encryptedPayload: await encryptedHost(thirdHostId, 'synthetic-password-do-not-use') });
  await mutateHost({ action: 'insert', hostId: fourthHostId, accountId, encryptedPayload: await encryptedHost(fourthHostId, 'synthetic-password-do-not-use') });
  const authsBeforeSlowDns = await passwordAuths();
  const slowStarted = Date.now();
  const slowDns = await call(400, 'file_list', { host_id: slowHostId, path: '/fixture', timeout_ms: 1_000 });
  const slowElapsed = Date.now() - slowStarted;
  assert.equal(slowDns.value.error, 'host_unreachable', JSON.stringify(slowDns));
  assert.ok(slowElapsed < 3_000, `SFTP setup must be inside the 1s deadline, took ${slowElapsed}ms`);
  assert.equal(await passwordAuths(), authsBeforeSlowDns, 'a deadline that expires during DNS setup must not authenticate');
  const slowLeases = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
  assert.equal(slowLeases?.perHost[slowHostId] ?? 0, 0, 'an expired SFTP setup releases its lease');

  const acceptanceLog = await readFile(authLog, 'utf8');
  await allowPtyResets(cleanupPtyIds);
  const besideSessionId = String(besideStall.value.session_id);
  const releasedBeside = await sessionStop(399, '3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a', besideSessionId);
  assert.equal(releasedBeside.value.session_status, 'closed', JSON.stringify(releasedBeside));
  let hostLeases = 1;
  for (let attempt = 0; attempt < 80 && hostLeases !== 0; attempt++) {
    const counted = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
    hostLeases = counted?.perHost[hostId] ?? 0;
    if (hostLeases === 0) break;
    await delay(500);
  }
  assert.equal(hostLeases, 0, 'the stalled shell open releases its lease when the shell deadline expires');
  const mixedSession = sessionStart(401, '1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d', undefined, secondHostId);
  const mixedList = call(402, 'file_list', { host_id: secondHostId, path: '/fixture/stall', timeout_ms: 4_000 });
  const mixedWrite = call(403, 'file_write_text', {
    host_id: thirdHostId, operation_id: '1e1e1e1e-1e1e-41e1-81e1-1e1e1e1e1e1e',
    path: '/fixture/stall-write', text: 'hold', overwrite: true, timeout_ms: 4_000,
  });
  const mixedRead = call(404, 'file_list', { host_id: thirdHostId, path: '/fixture/stall', timeout_ms: 4_000 });
  for (const pending of [mixedSession, mixedList, mixedWrite, mixedRead]) pending.catch(() => undefined);
  let mixedLeases: { total: number; perHost: Record<string, number> } | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    mixedLeases = await fixtureRequest<{ total: number; perHost: Record<string, number> }>('lease-count', {});
    if ((mixedLeases?.perHost[secondHostId] ?? 0) === 2 && (mixedLeases?.perHost[thirdHostId] ?? 0) === 2) break;
    await delay(50);
  }
  assert.equal(mixedLeases?.perHost[secondHostId], 2, JSON.stringify(mixedLeases));
  assert.equal(mixedLeases?.perHost[thirdHostId], 2, JSON.stringify(mixedLeases));
  const startedMixed = await mixedSession;
  assert.equal(startedMixed.value.status, 'live', JSON.stringify(startedMixed));
  const mixedSessionId = String(startedMixed.value.session_id);
  let freshLog = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    freshLog = (await readFile(authLog, 'utf8')).slice(acceptanceLog.length);
    if ([...freshLog.matchAll(/sftp-stall:(\d+)/g)].length >= 2 && /sftp-stall-write:\d+/.test(freshLog)) break;
    await delay(50);
  }
  const mixedResetIds = [
    ...[...freshLog.matchAll(/sftp-stall:(\d+)/g)].map(match => match[1]!),
    ...[...freshLog.matchAll(/sftp-stall-write:(\d+)/g)].map(match => match[1]!),
    ...(await noteNewPtyIds()),
  ];
  assert.ok(mixedResetIds.length >= 4, `missing intentional reset ids in ${freshLog.slice(-500)}`);
  await allowPtyResets([...cleanupPtyIds, ...mixedResetIds]);
  const rejectStarted = Date.now();
  const [mixedExec, mixedStart, mixedMkdir] = await Promise.all([
    exec(405, '1f1f1f1f-1f1f-41f1-81f1-1f1f1f1f1f1f', 'fixture-output', 10_000, secondHostId),
    sessionStart(406, '2a2a2a2a-2a2a-42a2-82a2-2a2a2a2a2a2a', undefined, fourthHostId),
    call(407, 'file_mkdir', { host_id: thirdHostId, operation_id: '2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b', path: '/fixture/mixed-dir' }),
  ]);
  assert.ok(Date.now() - rejectStarted < 1_000, 'over quota rejects without waiting for an in-flight connection');
  assert.equal(mixedExec.value.error, 'capacity_reached');
  assert.equal(mixedStart.value.error, 'capacity_reached');
  assert.equal(mixedMkdir.value.error, 'capacity_reached');
  const metadata = await call(408, 'list_hosts', { limit: 10 });
  const hostMetadata = await call(409, 'get_host', { host_id: secondHostId });
  const mixedStatus = await sessionStatus(410, mixedSessionId);
  const mixedReceipt = await call(411, 'get_operation_status', { operation_id: '1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d' });
  assert.equal(metadata.isError, false);
  assert.equal(hostMetadata.isError, false);
  assert.equal(mixedStatus.value.status, 'live');
  assert.equal(mixedReceipt.value.status, 'completed');
  assert.doesNotMatch(JSON.stringify([metadata, hostMetadata, mixedStatus, mixedReceipt]), /synthetic-password|privateKey|ENCRYPTION_KEY/);
  const leasesDuringMetadata = await fixtureRequest<{ perHost: Record<string, number> }>('lease-count', {});
  assert.equal(leasesDuringMetadata?.perHost[secondHostId], 2, 'metadata and status do not take a connection slot');
  assert.equal(leasesDuringMetadata?.perHost[thirdHostId], 2);
  const mixedStop = await sessionStop(412, '2c2c2c2c-2c2c-42c2-82c2-2c2c2c2c2c2c', mixedSessionId);
  assert.equal(mixedStop.value.session_status, 'closed', JSON.stringify(mixedStop));
  const afterStop = await fixtureRequest<{ total: number; perHost: Record<string, number> }>('lease-count', {});
  assert.equal(afterStop?.perHost[secondHostId], 1, 'owned stop releases only the session lease');
  const [mixedStalledList, mixedStalledWrite, mixedStalledRead] = await Promise.all([mixedList, mixedWrite, mixedRead]);
  assert.equal(mixedStalledList.value.error, 'host_unreachable');
  assert.equal(mixedStalledRead.value.error, 'host_unreachable');
  assert.equal(mixedStalledWrite.value.status, 'unknown');
  const releasedMixed = await fixtureRequest<{ total: number; perHost: Record<string, number> }>('lease-count', {});
  assert.equal(releasedMixed?.perHost[secondHostId] ?? 0, 0, 'SFTP timeout releases the remaining host lease');
  assert.equal(releasedMixed?.perHost[thirdHostId] ?? 0, 0);
  const closedBeforeRecovery = (await readFile(authLog, 'utf8')).match(/connection-closed:/g)?.length ?? 0;
  const recovered = await exec(413, '2d2d2d2d-2d2d-42d2-82d2-2d2d2d2d2d2d', 'fixture-output', 10_000, secondHostId);
  assert.equal(recovered.value.status, 'completed', JSON.stringify(recovered));
  const failedRead = await call(414, 'file_read_text', { host_id: secondHostId, path: '/fixture/missing-mixed.txt' });
  assert.equal(failedRead.value.error, 'host_unreachable');
  let closedAfterFailure = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const closed = (await readFile(authLog, 'utf8')).match(/connection-closed:/g)?.length ?? 0;
    closedAfterFailure = closed >= closedBeforeRecovery + 2;
    if (closedAfterFailure) break;
    await delay(50);
  }
  assert.equal(closedAfterFailure, true, 'successful and failed one-shot calls close TCP');
  const acceptanceTail = (await readFile(authLog, 'utf8')).slice(acceptanceLog.length);
  assert.doesNotMatch(acceptanceTail, /unexpected-fixture-error:/);
  await allowPtyResets(cleanupPtyIds);

  console.log('Local MCP → SQLite DO → pinned SSH fixture passed: concurrent atomic admission, indexed bounded cleanup, legacy digest replay compatibility, restart recovery before dispatch, during live SSH and after effect/receipt-commit failure, fail-closed storage behavior, unknown tombstone retention, managed shell lifecycle, authenticated SFTP list/read limits, receipt-protected SFTP UTF-8 create and explicit overwrite, receipt-protected SFTP rename, explicit delete, and single-level mkdir, and no automatic redispatch.');
} finally {
  if (cleanupPtyIds.length) await writeFile(resetAllow, `${cleanupPtyIds.join('\n')}\n`);
  await stopWorker();
  for (let attempt = 0; attempt < 40 && cleanupPtyIds.length; attempt++) {
    const log = await readFile(authLog, 'utf8');
    if (cleanupPtyIds.every(id => log.includes(`connection-closed:${id}\n`))) break;
    await delay(50);
  }
  await writeFile(resetAllow, '');
  stop(fixture);
  await delay(150);
  await rm(scratch, { recursive: true, force: true });
}
