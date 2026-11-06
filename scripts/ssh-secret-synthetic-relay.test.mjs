import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('synthetic acceptance stays owner-only, main-only and never injects SSH Secrets', () => {
  const all = readFileSync('.github/workflows/acceptance.yml', 'utf8');
  const temporary = all.split('  ssh-secret-synthetic-seal:\n')[1]
    ?.split('\n  legacy-secret-cleanup-readback:\n')[0];
  assert.ok(temporary, 'temporary jobs must be separately isolated');
  assert.match(temporary, /github\.actor == 'lirtual'/);
  assert.match(temporary, /github\.ref == 'refs\/heads\/main'/);
  assert.match(temporary, /inputs\.confirm_portal_write == false/);
  assert.match(temporary, /ssh-mcp-worker/);
  assert.match(temporary, /retention-days: 1/);
  assert.match(temporary, /actions\/upload-artifact@/);
  assert.match(temporary, /actions\/download-artifact@/);
  assert.match(temporary, /ssh-secret-synthetic-relay\.py seal/);
  assert.match(temporary, /ssh-secret-synthetic-relay\.py verify/);
  assert.doesNotMatch(temporary, /\$\{\{\s*secrets\.|GH_TOKEN:|CLOUDFLARE_API_TOKEN:|wrangler deploy|secret set|secret delete/);
});

test('synthetic script cannot access live keys or write GitHub Secrets', () => {
  const script = readFileSync('scripts/ssh-secret-synthetic-relay.py', 'utf8');
  assert.match(script, /"ENCRYPTION_KEY" not in os\.environ/);
  assert.match(script, /"SSH_ENCRYPTION_KEY" not in os\.environ/);
  assert.match(script, /SPEC733_SYNTHETIC_ONLY_NEVER_SUBMIT/);
  assert.match(script, /crypto_box_seal_open/);
  assert.match(script, /hmac\.compare_digest/);
  assert.doesNotMatch(script, /subprocess|requests|urllib|httpx|urlopen|gh secret set/);
});
