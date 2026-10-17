import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const app = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixturePort = 22222;
const workerPort = 8791;
const scratch = await mkdtemp(join(tmpdir(), 'ssh-g0-'));
const authLog = join(scratch, 'auth.log');
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const hostKey = join(scratch, 'host_key');
const userKey = join(scratch, 'user_key');
const wrongUserKey = join(scratch, 'wrong_user_key');
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', userKey]);
run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', wrongUserKey]);
const fingerprintLine = run('ssh-keygen', ['-lf', `${hostKey}.pub`, '-E', 'sha256']);
const fingerprint = fingerprintLine.split(/\s+/)[1]!;
const privateKey = await readFile(userKey, 'utf8');
await writeFile(authLog, '');

const fixture = spawn(process.execPath, ['--experimental-strip-types', join(app, 'g0/fixture/server.ts')], {
  cwd: app,
  env: {
    ...process.env,
    FIXTURE_PORT: String(fixturePort),
    FIXTURE_HOST_KEY: hostKey,
    FIXTURE_USER_PUBLIC_KEY: `${userKey}.pub`,
    FIXTURE_PASSWORD: 'synthetic-password',
    FIXTURE_AUTH_LOG: authLog,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const wrangler = spawn('pnpm', [
  'exec', 'wrangler', 'dev', '--local', '--config', join(app, 'g0/wrangler.jsonc'), '--port', String(workerPort),
], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
let fixtureOutput = '';
let wranglerOutput = '';
fixture.stdout.setEncoding('utf8').on('data', (chunk: string) => { fixtureOutput += chunk; });
fixture.stderr.setEncoding('utf8').on('data', (chunk: string) => { fixtureOutput += chunk; });
wrangler.stdout.setEncoding('utf8').on('data', (chunk: string) => { wranglerOutput += chunk; });
wrangler.stderr.setEncoding('utf8').on('data', (chunk: string) => { wranglerOutput += chunk; });
const stop = (child: typeof fixture) => {
  if (child.exitCode === null) child.kill('SIGTERM');
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (fixture.exitCode !== null || wrangler.exitCode !== null) {
      throw new Error(`runtime exited before ready\nfixture: ${fixtureOutput}\nworkerd: ${wranglerOutput}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${workerPort}/`);
      if (response.status === 405) { ready = true; break; }
    } catch { /* wait for local workerd */ }
    await delay(250);
  }
  assert.ok(ready, `workerd did not become ready\n${wranglerOutput}`);

  const request = async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${workerPort}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: fixturePort, username: 'fixture', ...body }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const expected = { expectedFingerprint: fingerprint, command: 'fixture-output' };

  await writeFile(authLog, '');
  const rejected = await request({ mode: 'password', password: 'synthetic-password', ...expected, expectedFingerprint: 'SHA256:wrong-fixture-pin' });
  assert.equal(rejected.status, 502);
  assert.equal(rejected.body.error, 'host_key_rejected');
  assert.equal(rejected.body.hostKeyChecked, true);
  assert.doesNotMatch(await readFile(authLog, 'utf8'), /none|password|publickey/, 'wrong pin must fail before the server sees authentication');

  await writeFile(authLog, '');
  const wrongPassword = await request({ mode: 'password', password: 'wrong-fixture-password', ...expected });
  assert.equal(wrongPassword.status, 502);
  assert.equal(wrongPassword.body.error, 'SshAuthenticationError');
  assert.match(await readFile(authLog, 'utf8'), /password/);

  await writeFile(authLog, '');
  const passwordResult = await request({ mode: 'password', password: 'synthetic-password', ...expected });
  assert.equal(passwordResult.status, 200, `${JSON.stringify(passwordResult.body)} auth=${await readFile(authLog, 'utf8')} fixture=${fixtureOutput}`);
  assert.equal(passwordResult.body.ok, true);
  assert.equal(passwordResult.body.stdout, 'fixture stdout\n');
  assert.equal(passwordResult.body.stderr, 'fixture stderr\n');
  assert.equal(passwordResult.body.exitCode, 7);
  assert.equal(passwordResult.body.hostKeyChecked, true);
  console.log(`negotiated SSH algorithms: ${JSON.stringify(passwordResult.body.algorithms)}`);

  await writeFile(authLog, '');
  const wrongPrivateKeyResult = await request({
    mode: 'privateKey',
    privateKey: await readFile(wrongUserKey, 'utf8'),
    ...expected,
  });
  assert.equal(wrongPrivateKeyResult.status, 502);
  assert.equal(wrongPrivateKeyResult.body.error, 'SshAuthenticationError');
  assert.match(await readFile(authLog, 'utf8'), /publickey-wrong-query/);
  assert.doesNotMatch(await readFile(authLog, 'utf8'), /publickey-signed/);

  await writeFile(authLog, '');
  const privateKeyResult = await request({ mode: 'privateKey', privateKey, ...expected });
  assert.equal(privateKeyResult.status, 200);
  assert.equal(privateKeyResult.body.ok, true);
  assert.equal(privateKeyResult.body.exitCode, 7);
  assert.match(await readFile(authLog, 'utf8'), /publickey-query/);
  assert.match(await readFile(authLog, 'utf8'), /publickey-signed/);

  const disconnected = await request({ mode: 'disconnect', password: 'synthetic-password', ...expected, command: 'fixture-disconnect' });
  assert.equal(disconnected.status, 502);
  assert.equal(disconnected.body.ok, false);
  assert.equal(disconnected.body.error, 'SshDisconnectError');

  await writeFile(authLog, '');
  const started = await request({ mode: 'sessionStart', password: 'synthetic-password', ...expected });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.sessionId, 'g0-live-session');
  assert.equal(started.body.ptyRequested, true);
  await delay(1200); // A separate HTTP request follows after the start response has completed.
  const write = await request({ mode: 'sessionWrite', sessionId: 'g0-live-session', input: 'hello from client\n' });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  let shellOutput = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    const output = await request({ mode: 'sessionOutput', sessionId: 'g0-live-session' });
    shellOutput = String(output.body.output ?? '');
    if (shellOutput.includes('fixture says hello')) break;
    await delay(50);
  }
  assert.match(shellOutput, /fixture says hello/);
  const close = await request({ mode: 'sessionClose', sessionId: 'g0-live-session' });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  assert.equal(close.body.closed, true);
  await delay(100);
  const shellLog = await readFile(authLog, 'utf8');
  assert.match(shellLog, /pty-request/);
  assert.match(shellLog, /shell-open/);
  assert.match(shellLog, /shell-channel-closed/);
  assert.match(shellLog, /connection-closed/);

  const disconnectedShell = await request({ mode: 'sessionStart', password: 'synthetic-password', ...expected });
  assert.equal(disconnectedShell.status, 200, JSON.stringify(disconnectedShell.body));
  await request({ mode: 'sessionWrite', sessionId: 'g0-live-session', input: 'disconnect shell\n' });
  let shellLost = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const output = await request({ mode: 'sessionOutput', sessionId: 'g0-live-session' });
    shellLost = output.body.closed === true;
    if (shellLost) break;
    await delay(50);
  }
  assert.equal(shellLost, true, 'the DO must observe the remote PTY channel disconnect');
  await delay(100);
  assert.equal(((await readFile(authLog, 'utf8')).match(/pty-request/g) ?? []).length, 2);

  await writeFile(authLog, '');
  const list = await request({ mode: 'sftpList', password: 'synthetic-password', ...expected });
  assert.equal(list.status, 200, `${JSON.stringify(list.body)} fixture=${fixtureOutput} events=${await readFile(authLog, 'utf8')}`);
  assert.deepEqual(list.body.entries, ['hello.txt'], `${JSON.stringify(list.body)} events=${await readFile(authLog, 'utf8')}`);
  const read = await request({ mode: 'sftpRead', password: 'synthetic-password', path: '/fixture/hello.txt', ...expected });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.contents, 'héllo SSH\n');
  const writeFileResult = await request({ mode: 'sftpWrite', password: 'synthetic-password', path: '/fixture/out.txt', contents: 'short UTF-8 ✓', ...expected });
  assert.equal(writeFileResult.status, 200, JSON.stringify(writeFileResult.body));
  const readWritten = await request({ mode: 'sftpRead', password: 'synthetic-password', path: '/fixture/out.txt', ...expected });
  assert.equal(readWritten.status, 200, JSON.stringify(readWritten.body));
  assert.equal(readWritten.body.contents, 'short UTF-8 ✓');
  const missing = await request({ mode: 'sftpMissing', password: 'synthetic-password', path: '/fixture/missing.txt', ...expected });
  assert.equal(missing.status, 502);
  assert.equal(missing.body.ok, false);
  const sftpDisconnected = await request({ mode: 'sftpDisconnect', password: 'synthetic-password', ...expected });
  assert.equal(sftpDisconnected.status, 502);
  assert.equal(sftpDisconnected.body.ok, false);
  assert.equal(sftpDisconnected.body.error, 'SshDisconnectError');
  await delay(100);
  const sftpLog = await readFile(authLog, 'utf8');
  assert.match(sftpLog, /sftp-write:\/fixture\/out.txt:15/);
  assert.equal((sftpLog.match(/sftp-close:/g) ?? []).length, 4, sftpLog);
  assert.equal((sftpLog.match(/sftp-session-closed:open-files=0:open-dirs=0/g) ?? []).length, 6, sftpLog);
  assert.equal((sftpLog.match(/connection-closed/g) ?? []).length, 6, sftpLog);

  console.log('G0 workerd SSH fixture passed: bad pin before auth, valid/invalid password, authorized/unauthorized private key, exec stdout/stderr/exit, remote disconnect, PTY shell across HTTP requests, SFTP list/UTF-8 read/write/failure/disconnect and resource close.');
} finally {
  stop(wrangler);
  stop(fixture);
  await delay(100);
  await rm(scratch, { recursive: true, force: true });
}
