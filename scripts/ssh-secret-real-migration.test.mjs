import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const actualWorkflow = readFileSync('.github/workflows/acceptance.yml', 'utf8');
const realJobs = actualWorkflow.split('  secret-rename-seal:\n')[1]
  ?.split('\n  legacy-secret-cleanup-readback:\n')[0];

test('protected SSH original-value seal and verify share one owner/main-only scope', () => {
  assert.ok(realJobs);
  assert.match(realJobs, /github\.actor == 'lirtual'/);
  assert.match(realJobs, /github\.ref == 'refs\/heads\/main'/);
  assert.match(realJobs, /inputs\.confirm_portal_write == false/);
  assert.match(realJobs, /group: worker-release-/);
  assert.match(realJobs, /retention-days: 1/);
  assert.match(realJobs, /actions\/upload-artifact@/);
  assert.match(realJobs, /contents: read/);
  assert.ok(realJobs.includes('SPEC733_OLD_KEY: ${{ secrets.ENCRYPTION_KEY }}'));
  assert.ok(realJobs.includes('SPEC733_NEW_KEY: ${{ secrets.SSH_ENCRYPTION_KEY }}'));
  assert.doesNotMatch(realJobs, /secrets\.CLOUDFLARE_API_TOKEN|secrets\.GH_TOKEN|GH_TOKEN:|wrangler deploy|gh secret set|gh api|portal-register|secret delete/);
});

test('real-key migration helper is only a sealed-box producer and byte checker', () => {
  const helper = readFileSync('scripts/ssh-secret-real-migration.py', 'utf8');
  assert.match(helper, /crypto_box_seal/);
  assert.match(helper, /hmac\.compare_digest/);
  assert.match(helper, /O_CREAT \| os\.O_EXCL \| os\.O_WRONLY, 0o600/);
  assert.doesNotMatch(helper, /subprocess|requests|urllib|httpx|urlopen|print\(old|print\(new|print\(ciphertext|print\(envelope/);
});

test('synthetic-key-only guarded script rejects mismatches and emits only ciphertext', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'spec733-ssh-real-test-'));
  try {
    const path = join(tmp, 'only-encrypted.json');
    const original = Buffer.alloc(32, 0x7c).toString('base64');
    const alternative = Buffer.alloc(32, 0x7d).toString('base64');
    const env = { ...process.env,
      GITHUB_REPOSITORY: 'lirtual/mcp-workers',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_ACTOR: 'lirtual',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_SHA: '1'.repeat(40),
      GITHUB_RUN_ID: '42',
      SPEC733_OLD_KEY: original,
      SPEC733_NEW_KEY: original,
      SPEC733_PUBLIC_KEY: Buffer.alloc(32, 0x2f).toString('base64'),
      SPEC733_PUBLIC_KEY_ID: 'synthetic-key-id',
    };
    const execute = (mode, localEnv) =>
      spawnSync('python3', ['scripts/ssh-secret-real-migration.py', mode, mode === 'verify' ? '-' : path],
        { env: localEnv, encoding: 'utf8' });
    const same = execute('verify', env);
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /EXACT_BYTES_EQUAL:PASS/);
    const different = execute('verify', { ...env, SPEC733_NEW_KEY: alternative });
    assert.notEqual(different.status, 0);
    assert.equal(different.stdout, '');
    assert.doesNotMatch(different.stderr, new RegExp(original));
    const fakeOld = execute('verify', { ...env, SPEC733_OLD_KEY: 'not-canonical' });
    assert.notEqual(fakeOld.status, 0);
    const sealEnv = { ...env }; delete sealEnv.SPEC733_NEW_KEY;
    const sealed = execute('seal', sealEnv);
    assert.equal(sealed.status, 0, sealed.stderr);
    const content = readFileSync(path, 'utf8');
    assert.ok(!content.includes(original));
    const metadata = JSON.parse(content);
    assert.equal(metadata.target, 'SSH_ENCRYPTION_KEY');
    assert.equal(metadata.key_id, 'synthetic-key-id');
    assert.equal(metadata.source_run_id, '42');
    assert.equal(Buffer.from(metadata.encrypted_value, 'base64').length, 92);
    assert.notEqual(execute('seal', sealEnv).status, 0, 'never overwrite existing sealed artifact');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
