import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync('.github/workflows/acceptance.yml', 'utf8');
const jobs = workflow.split('  secret-rename-seal:\n')[1]
  ?.split('\n  legacy-secret-cleanup-readback:\n')[0];
const helper = readFileSync('scripts/workflow-secret-real-migration.py', 'utf8');

test('one-shot Workflow jobs only execute for the reviewed main Owner and selected secret', () => {
  assert.ok(jobs, 'both temporary jobs present');
  assert.match(jobs, /github\.actor == 'lirtual'/g);
  assert.match(jobs, /github\.ref == 'refs\/heads\/main'/g);
  assert.match(jobs, /inputs\.confirm_portal_write == false/g);
  assert.match(jobs, /group: worker-release-/);
  assert.match(jobs, /retention-days: 1/);
  assert.match(jobs, /actions\/upload-artifact@/);
  assert.match(jobs, /contents: read/g);
  assert.ok(jobs.includes('SPEC733_OLD_SECRET: ${{ secrets.MCP_PORTAL_CLIENT_SECRET }}'));
  assert.ok(jobs.includes('SPEC733_NEW_SECRET: ${{ secrets.WORKFLOW_MCP_PORTAL_CLIENT_SECRET }}'));
  assert.doesNotMatch(jobs, /secrets\.CLOUDFLARE_API_TOKEN|secrets\.GH_TOKEN|GH_TOKEN:|wrangler deploy|gh secret set|gh api|portal-register|secret delete/);
});

test('helper uses GitHub public-key sealed box and only byte comparison; never writes GitHub Secrets', () => {
  assert.match(helper, /crypto_box_seal/);
  assert.match(helper, /hmac\.compare_digest/);
  assert.match(helper, /O_CREAT \| os\.O_EXCL \| os\.O_WRONLY, 0o600/);
  assert.doesNotMatch(helper, /subprocess|requests|urllib|httpx|urlopen|print\(old|print\(new|print\(ciphertext/);
});

test('synthetic Portal data is sealed and verified without revealing originals', () => {
  const temp = mkdtempSync(join(tmpdir(), 'spec733-workflow-real-fixtures-'));
  try {
    const publicKey = Buffer.alloc(32, 0x33).toString('base64');
    const baseline = {
      ...process.env,
      GITHUB_REPOSITORY: 'lirtual/mcp-workers',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_ACTOR: 'lirtual',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '42',
      SPEC733_PUBLIC_KEY: publicKey,
      SPEC733_PUBLIC_KEY_ID: 'synthetic-key-2026',
    };
    const execute = (mode, env, output) => spawnSync('python3',
      ['scripts/workflow-secret-real-migration.py', mode, output],
      { env, encoding: 'utf8' });
    for (const kind of ['portal']) {
      const value = 'synthetic-oauth-client-🔒-with-newline\n';
      const altered = value + '!';
      const env = { ...baseline, SPEC733_WORKFLOW_SECRET_KIND: kind,
        SPEC733_OLD_SECRET: value, SPEC733_NEW_SECRET: value };
      const valid = execute('verify', env, '-');
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /EXACT_BYTES_EQUAL:PASS/);
      const mismatch = execute('verify', { ...env, SPEC733_NEW_SECRET: altered }, '-');
      assert.notEqual(mismatch.status, 0);
      assert.equal(mismatch.stdout, '');
      assert.ok(!mismatch.stderr.includes(value));
      const empty = execute('verify', { ...env, SPEC733_NEW_SECRET: '' }, '-');
      assert.notEqual(empty.status, 0);
      const output = join(temp, kind + '.json');
      const sealEnv = { ...env }; delete sealEnv.SPEC733_NEW_SECRET;
      const sealed = execute('seal', sealEnv, output);
      assert.equal(sealed.status, 0, sealed.stderr);
      const contents = readFileSync(output, 'utf8');
      assert.ok(!contents.includes(value));
      assert.ok(!contents.includes(Buffer.from(value).toString('base64')));
      const envelope = JSON.parse(contents);
      assert.equal(envelope.target, 'WORKFLOW_MCP_PORTAL_CLIENT_SECRET');
      assert.equal(envelope.key_id, 'synthetic-key-2026');
      assert.equal(envelope.source_sha, 'a'.repeat(40));
      assert.equal(envelope.source_run_id, '42');
      assert.equal(Buffer.from(envelope.encrypted_value, 'base64').length, Buffer.byteLength(value) + 48);
      assert.notEqual(execute('seal', sealEnv, output).status, 0, 'never overwrite sealed file');
      assert.notEqual(execute('seal', { ...sealEnv, GITHUB_REF: 'refs/heads/other' }, join(temp, kind + '-fail.json')).status, 0);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
