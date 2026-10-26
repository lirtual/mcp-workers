import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Offline release contract: test each GitHub Actions entry point independently.
const read = name => readFileSync(new URL('../.github/workflows/' + name + '.yml', import.meta.url), 'utf8');
const ci = read('ci');
const release = read('release');
const acceptance = read('acceptance');
const dollar = String.fromCharCode(36);
function job(source, name) {
  const start = source.indexOf('\n  ' + name + ':\n');
  assert.ok(start >= 0, 'Missing job ' + name);
  const rest = source.slice(start + name.length + 6);
  const next = /\n  [a-z][a-z0-9-]*:\n/.exec(rest);
  const content = source.slice(start, next ? start + name.length + 6 + next.index : undefined);
  const gate = content.match(/\n    if: >-\n([\s\S]*?)\n    runs-on:/)?.[1];
  assert.ok(gate, 'Missing gated job ' + name);
  return { content, gate };
}
assert.match(ci, /  push:/);
assert.match(ci, /  pull_request:/);
assert.match(ci, /  workflow_call:/);
assert.match(ci, /release_ready:/);
assert.match(ci, /release-gate:/);
assert.match(ci, /needs: \[checks, database-integration\]/);
assert.match(ci, /if: \$\{\{ always\(\) \}\}/);
assert.match(ci, /true:success\|false:skipped/);
assert.match(ci, /REUSABLE_WORKER: \$\{\{ inputs.worker \}\}/);
assert.doesNotMatch(ci.slice(0, ci.indexOf('permissions:')), /workflow_dispatch:/);
assert.doesNotMatch(ci, /^  deploy:$/m);
assert.match(ci, /node scripts\/select-affected-apps\.mjs/);
assert.match(ci, /database-integration:/);
assert.match(ci, /run: node scripts\/verify-workflow-dispatch-gates\.mjs/);

assert.match(release, /  workflow_dispatch:/);
assert.match(release, /      worker:/);
assert.match(release, /      deploy_to_production:/);
assert.match(release, /        default: false/);
assert.match(release, /uses: \.\/\.github\/workflows\/ci\.yml/);
assert.ok(release.includes('worker: ' + dollar + '{{ inputs.worker }}'));
const deploy = job(release, 'deploy');
for (const clause of [
  "github.event_name == 'workflow_dispatch'",
  "github.ref == 'refs/heads/main'",
  'inputs.deploy_to_production == true',
  "needs.checks.result == 'success'",
  "needs.checks.outputs.release_ready == 'true'",
]) assert.ok(deploy.gate.includes(clause), 'Unsafe production release: ' + clause);
for (const name of ['raindrop', 'ima', 'database', 'ssh', 'remote-control', 'github-actions', 'workflow'])
  assert.ok(deploy.gate.includes("inputs.worker == '" + name + "-mcp-worker'"), 'Missing allowlisted Worker ' + name);
assert.ok(deploy.content.includes('name: ' + dollar + '{{ inputs.worker }}'), 'Worker-scoped Environment missing');
assert.ok(deploy.content.includes('group: worker-release-' + dollar + '{{ inputs.worker }}'), 'Release lock missing');
for (const marker of [
  'Stage selected Worker Secrets for every release',
  'Stage approved Worker variables',
  'node scripts/manual-worker-release.mjs preflight',
  "WORKFLOW_REQUIRE_COMPLETE_SCHEMA: 'true'",
  'Apply complete Workflow D1 migrations',
  'Publish exactly selected Worker',
  'Verify exact active version and required production bindings',
  'Check unauthenticated MCP surface without credentials',
]) assert.ok(deploy.content.includes(marker), 'Missing release safeguard: ' + marker);
for (const key of ['MCP_PORTAL_CLIENT_SECRET', 'WORKFLOW_GITHUB_DISPATCH_TOKEN'])
  assert.ok(deploy.content.includes(key + ': ' + dollar + '{{ secrets.' + key + ' }}'), 'Missing scoped Secret ' + key);

for (const key of ['IMA_API_KEY', 'ENCRYPTION_KEY', 'ACTIONS_GITHUB_DISPATCH_TOKENS']) {
  assert.ok(deploy.content.includes(key + ': ' + dollar + '{{ secrets.' + key + ' }}'),
    'Missing selected release Secret ' + key);
}
for (const key of ['IMA_CLIENT_ID', 'MCP_PORTAL_CLIENT_ID']) {
  assert.ok(deploy.content.includes(key + ': ' + dollar + '{{ vars.' + key + ' }}'),
    'Missing selected release Variable ' + key);
}
assert.ok(smokeKeyPresent(release, 'WORKFLOW_GITHUB_DISPATCH_TOKEN', 'secrets'));
assert.ok(smokeKeyPresent(acceptance, 'WORKFLOW_GITHUB_DISPATCH_TOKEN', 'secrets'));
assert.ok(smokeKeyPresent(acceptance, 'MCP_PORTAL_CLIENT_ID', 'vars'));
assert.ok(smokeKeyPresent(release, 'MCP_PORTAL_CLIENT_ID', 'vars'));
for (const source of [release, acceptance]) {
  assert.ok(!smokeKeyPresent(source, 'MCP_PORTAL_CLIENT_ID', 'secrets'),
    'Portal Client ID incorrectly sourced from GitHub Secret');
  for (const old of ['WORKFLOW_EXECUTOR_GITHUB_TOKEN', 'MCP_BROKER_TOKEN', 'GH_TOKEN', 'API_KEY', 'ACTIONS_MCP_TOKENS']) {
    assert.ok(!source.includes(old + ': ' + dollar + '{{ secrets.' + old + ' }}'),
      'Legacy secret still staged: ' + old);
  }
}
function smokeKeyPresent(source, key, kind) {
  return source.includes(key + ': ' + dollar + '{{ ' + kind + '.' + key + ' }}');
}
assert.doesNotMatch(release, /Verify fixed GitHub registered executor|Verify dedicated GitHub token/);
assert.match(acceptance, /      test_type:/);
assert.match(acceptance, /      confirm_portal_write:/);
assert.match(acceptance, /        default: false/);
assert.match(acceptance, /        type: choice/);
assert.doesNotMatch(acceptance, /      deploy_to_production:/);
assert.doesNotMatch(acceptance, /      mcp_portal_target:/);
assert.match(acceptance, /uses: \.\/\.github\/workflows\/ci\.yml/);
for (const [name, option] of [
  ['workflow-production-smoke', 'production-native'],
  ['workflow-mcp-portal-probe', 'portal-readonly'],
  ['workflow-github-action-result-cloud', 'github-action-result-cloud'],
  ['workflow-portal-register', 'portal-register'],
]) {
  const checked = job(acceptance, name);
  assert.ok(checked.gate.includes("github.ref == 'refs/heads/main'"), 'Unsafe acceptance ref: ' + name);
  assert.ok(checked.gate.includes(option), 'Missing acceptance selector: ' + name);
}
const smoke = job(acceptance, 'workflow-production-smoke');
assert.ok(smoke.gate.includes("needs.checks.result == 'success'"));
assert.ok(smoke.gate.includes("needs.checks.outputs.release_ready == 'true'"));
for (const [env, option] of [
  ['WORKFLOW_MCP_SMOKE', 'production-mcp'],
  ['WORKFLOW_GITHUB_SMOKE', 'production-github'],
  ['WORKFLOW_ACTION_TASK_SMOKE', 'production-action-task'],
]) assert.ok(smoke.content.includes(env + ": " + dollar + "{{ inputs.test_type == '" + option + "' }}"), 'Smoke selector ' + env);
assert.doesNotMatch(job(acceptance, 'workflow-mcp-portal-probe').content, /MCP_PORTAL_TARGET:/);
const registration = job(acceptance, 'workflow-portal-register');
assert.ok(registration.gate.includes("needs.checks.result == 'success'"));
assert.ok(registration.gate.includes("needs.checks.outputs.release_ready == 'true'"));
assert.ok(registration.gate.includes('inputs.confirm_portal_write == true'));
assert.ok(registration.content.includes('group: worker-release-workflow-mcp-worker'));
assert.ok(registration.content.includes('run: node scripts/register-workflow-portal.mjs'));
assert.ok(ci.includes('run: node --test scripts/register-workflow-portal.test.mjs'));
for (const src of [ci, release, acceptance])
  assert.doesNotMatch(src, /wip\/workflow-mcp-public-readonly|wip\/workflow-github-executor/);
// Email acceptance is a credential-free manual gate; never grant it release
// authority or expose production secrets to the Draft PR being exercised.
const emailAcceptance = read('email-acceptance');
assert.match(emailAcceptance, /  workflow_dispatch:/);
assert.doesNotMatch(emailAcceptance, /\n  (?:push|pull_request|schedule):/);
assert.match(emailAcceptance, /github\.ref == 'refs\/heads\/main'/);
assert.match(emailAcceptance, /candidate_sha:/);
assert.match(emailAcceptance, /head\.sha/);
assert.match(emailAcceptance, /head\.repo\.full_name/);
assert.match(emailAcceptance, /conclusion == "success"/);
assert.match(emailAcceptance, /persist-credentials: false/);
assert.match(emailAcceptance, /pnpm --filter email-mcp-worker check/);
assert.match(emailAcceptance, /wrangler d1 migrations apply/);
assert.match(emailAcceptance, /pnpm dlx wrangler@4\.152\.0 dev/);
assert.match(emailAcceptance, /EMAIL_ISOLATED_LOCAL_WORKER_D1_AND_MCP_OK/);
assert.doesNotMatch(emailAcceptance, /secrets\.|CLOUDFLARE_API_TOKEN|wrangler deploy|release\.yml|environment:/);

// Cloud preview is a separate explicit approval path. It must never inherit
// the production release token, deploy to a permanent Worker or omit cleanup.
const emailCloud = read('email-cloud-acceptance');
assert.match(emailCloud, /  workflow_dispatch:/);
assert.doesNotMatch(emailCloud, /\\n  (?:push|pull_request|schedule):/);
assert.match(emailCloud, /confirm_cloud_preview:/);
assert.match(emailCloud, /confirm_cloud_preview == true/);
assert.match(emailCloud, /github\\.ref == 'refs\\/heads\\/main'/);
assert.match(emailCloud, /persist-credentials: false/);
assert.match(emailCloud, /name: email-mcp-acceptance/);
assert.match(emailCloud, /secrets\\.EMAIL_ACCEPTANCE_CLOUDFLARE_API_TOKEN/);
assert.match(emailCloud, /email-acc-/);
assert.match(emailCloud, /d1 migrations apply/);
assert.match(emailCloud, /dev --remote/);
assert.match(emailCloud, /method:'DELETE'/);
assert.match(emailCloud, /EMAIL_ACCEPTANCE_DISPOSABLE_D1_CLEANUP_OK/);
assert.match(emailCloud, /EMAIL_CLOUDFLARE_PREVIEW_REAL_D1_AND_MCP_OK/);
assert.doesNotMatch(emailCloud, /secrets\\.CLOUDFLARE_API_TOKEN|wrangler deploy|wrangler secret put|PORTAL_CLIENT_SECRET/);

console.log('WORKFLOW_RELEASE_GATE_CONTRACT_OK');
