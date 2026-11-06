import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

test('real Wrangler source distinguishes production extra Secrets from explicit local Secret declarations', { timeout: 60000 }, async () => {
  const app = resolve('apps/database-mcp-worker');
  const dir = await mkdtemp(join(tmpdir(), 'database-760-'));
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  // Keep the real source contract, including its production secrets.required.
  // Only the main path and synthetic catalog are adapted to this isolated fixture.
  const config = JSON.parse(await readFile(join(app, 'wrangler.jsonc'), 'utf8'));
  config.main = join(app, config.main);
  config.vars.DATABASE_CONNECTIONS = '{"b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@8.8.8.8/b2b"}';
  assert.deepEqual(config.secrets.required, ['MCP_ACCESS_TOKEN']);
  const secrets = { MCP_ACCESS_TOKEN: 'local-synthetic-token', DATABASE_B2B_PASSWORD: 'synthetic@/%:password' };
  const configPath = join(dir, 'wrangler.json');
  try {
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(dir, 'secrets.json'), JSON.stringify(secrets), { mode: 0o600 });
    await writeFile(join(dir, '.dev.vars'), Object.entries(secrets)
      .map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n'), { mode: 0o600 });
    // Production permits extra --secrets-file names without making them globally required.
    // No credentials or remote publication; never print deployment diagnostics.
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--config', configPath,
      '--secrets-file', join(dir, 'secrets.json'), '--outdir', join(dir, 'bundle')],
    { cwd: app, stdio: 'pipe', timeout: 30000 });

    for (const localDeclaration of [false, true]) {
      if (localDeclaration) {
        // Documented local-only config declares only the password actually referenced.
        config.secrets.required.push('DATABASE_B2B_PASSWORD');
        await writeFile(configPath, JSON.stringify(config));
      }
      const workerProcess = spawn('pnpm', ['exec', 'wrangler', 'dev', '--local', '--config', configPath,
        '--port', String(port), '--ip', '127.0.0.1'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
      let client;
      try {
        let ready = false;
        workerProcess.stdout.on('data', chunk => { if (chunk.toString().includes('Ready on')) ready = true; });
        workerProcess.stderr.on('data', () => {});
        const deadline = Date.now() + 20000;
        while (!ready && Date.now() < deadline && workerProcess.exitCode === null)
          await new Promise(r => setTimeout(r, 100));
        assert.ok(ready, 'local Workers runtime must start');
        const base = `http://127.0.0.1:${port}`;
        assert.equal((await fetch(base + '/setup')).status, 404);
        assert.equal((await fetch(base + '/mcp')).status, 401);
        client = new Client({ name: 'workers-config-regression', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
          requestInit: { headers: { Authorization: 'Bearer ' + secrets.MCP_ACCESS_TOKEN } }
        }));
        const result = await client.callTool({ name: 'list_connections', arguments: {} });
        if (localDeclaration) {
          assert.notEqual(result.isError, true);
          assert.match(JSON.stringify(result), /b2b/);
        } else {
          assert.equal(result.isError, true, 'production required list alone does not load optional .dev.vars Secrets');
          assert.match(JSON.stringify(result), /CONFIGURATION_UNAVAILABLE/);
        }
        assert.ok(!JSON.stringify(result).includes(secrets.DATABASE_B2B_PASSWORD));
      } finally {
        await client?.close();
        if (workerProcess.exitCode === null && workerProcess.signalCode === null) {
          const closed = new Promise(r => workerProcess.once('close', r));
          workerProcess.kill('SIGTERM');
          await closed;
        }
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
