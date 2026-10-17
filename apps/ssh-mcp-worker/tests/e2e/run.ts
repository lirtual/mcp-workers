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
  const sessionOutput = (id: number, sessionId: string, offset?: number, limit?: number) => call(id, 'ssh_session_output', {
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
  const sessionInput = (id: number, operationId: string, targetSessionId: string, input: string) => call(id, 'ssh_session_input', {
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
  assert.equal(await authedCall('wrong-bearer', 125, 'ssh_session_input', {
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
  assert.equal(await authedCall(testToken, 171, 'ssh_session_input', {
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

  console.log('Local MCP → SQLite DO → pinned SSH fixture passed: concurrent atomic admission, indexed bounded cleanup, legacy digest replay compatibility, restart recovery before dispatch, during live SSH and after effect/receipt-commit failure, fail-closed storage behavior, unknown tombstone retention, managed shell lifecycle, and no automatic redispatch.');
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
