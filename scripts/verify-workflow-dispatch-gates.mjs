import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { APPLICATIONS, RELEASE_WORKERS } from './select-affected-apps.mjs';

// Offline release contract: test each GitHub Actions entry point independently.
const read = name => readFileSync(new URL('../.github/workflows/' + name + '.yml', import.meta.url), 'utf8');

function sameMembers(actual, expected, name) {
  assert.equal(new Set(actual).size, actual.length, 'Duplicate ' + name);
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'Mismatched ' + name);
}

// Accept the current deliberately simple, explicit OR-list; changing the
// expression shape requires a security review rather than a permissive parser.
export function verifyReleaseWorkers(source, expectedWorkers) {
  assert.ok(expectedWorkers.length > 0, 'Empty releasable Worker list');
  const workerInput = source.match(/^      worker:\n([\s\S]*?)(?=^      [a-z][a-z0-9_]*:\n)/m);
  const options = workerInput?.[1].match(/^        options:\n((?:          - [^\n]+\n)+)/m);
  assert.ok(options, 'Missing manual release Worker choices');
  const choices = options[1].trim().split('\n').map(line => line.trim().slice(2).trim());
  sameMembers(choices, expectedWorkers, 'manual release choices');

  const gate = job(source, 'deploy').gate.replace(/\s+/g, ' ').trim();
  const prefix = dollar + "{{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.deploy_to_production == true && inputs.database_activation_id == '' && inputs.database_direct_preflight_approved != true && inputs.database_restore_approved != true && needs.checks.result == 'success' && needs.checks.outputs.release_ready == 'true' && ";
  assert.ok(gate.startsWith(prefix) && gate.endsWith(' }}'), 'Unsafe or unsupported release gate');
  const list = gate.slice(prefix.length, -3);
  assert.match(list, /^\(inputs\.worker == '[a-z0-9-]+'(?: \|\| inputs\.worker == '[a-z0-9-]+')*\)$/, 'Unsafe or unsupported Worker allowlist');
  const allowed = [...list.matchAll(/inputs\.worker == '([^']+)'/g)].map(match => match[1]);
  sameMembers(allowed, expectedWorkers, 'release allowlist');
}

/** Owner-only Hyperdrive activation must never be a second publish path. */
export function verifyDatabaseActivationGate(source) {
  const activation = job(source, 'database-activate');
  const gate = activation.gate.replace(/\s+/g, ' ').trim();
  const expected = dollar + "{{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == 'lirtual' && inputs.worker == 'database-mcp-worker' && inputs.deploy_to_production == false && inputs.database_activation_approved == true && inputs.database_activation_id != '' && inputs.database_activation_revision != '' && inputs.database_direct_preflight_approved != true && inputs.database_restore_approved != true }}";
  assert.equal(gate, expected, 'Unsafe Database activation gate');
  const checkStart = source.indexOf('\n  checks:\n');
  const deployStart = source.indexOf('\n  deploy:\n');
  assert.ok(checkStart >= 0 && deployStart > checkStart, 'Missing reusable release checks');
  const checks = source.slice(checkStart, deployStart);
  assert.ok(checks.includes("inputs.database_activation_id == ''"), 'Activation must never initiate release checks');
  const deploy = job(source, 'deploy').content;
  assert.ok(deploy.includes("inputs.database_activation_id == ''"), 'Activation must never initiate deployment');
  for (const item of [
    'name: database-mcp-worker',
    'group: worker-release-database-mcp-worker',
    'node scripts/activate-database-hyperdrive.mjs',
    "github.ref == 'refs/heads/main'",
    'git ls-remote origin refs/heads/main',
    'DATABASE_ACTIVATION_ID: ' + dollar + '{{ inputs.database_activation_id }}',
    'DATABASE_ACTIVATION_REVISION: ' + dollar + '{{ inputs.database_activation_revision }}',
    'CLOUDFLARE_API_TOKEN: ' + dollar + '{{ secrets.CLOUDFLARE_API_TOKEN }}',
    'MCP_ACCESS_TOKEN: ' + dollar + '{{ secrets.MCP_ACCESS_TOKEN }}'
  ]) assert.ok(activation.content.includes(item), 'Database activation safeguard missing: ' + item);
  assert.doesNotMatch(activation.content, /wrangler deploy|Publish exactly selected Worker|manual-worker-release\.mjs readback/,
    'Activation must not deploy a Worker');
}

// This is deliberately not a YAML or shell interpreter. It recognizes only
// literal local reusable-workflow references and supported static script calls.
// Unknown/dynamic commands are outside this check, not proof of correctness.
export function verifyStaticWorkflowReferences(workflows, exists) {
  const command = /(?:(?:pnpm\s+--filter\s+([a-z0-9-]+)\s+exec\s+)?node(?:\s+--[a-z0-9-]+)*|bash)\s+((?:(?:scripts|apps)\/[a-zA-Z0-9_./-]+\.(?:mjs|sh))(?:\s+(?:scripts|apps)\/[a-zA-Z0-9_./-]+\.(?:mjs|sh))*)/g;
  for (const [workflow, source] of Object.entries(workflows)) {
    for (const [index, line] of source.split('\n').entries()) {
      if (line.trimStart().startsWith('#')) continue;
      const loc = workflow + ':' + (index + 1);
      const local = line.match(/^\s*(?:-\s*)?uses:\s*(\.\/\.github\/workflows\/[a-zA-Z0-9_./-]+\.ya?ml)\s*(?:#.*)?$/);
      if (local) {
        const path = posix.normalize(local[1].slice(2));
        assert.match(path, /^\.github\/workflows\/[^/]+\.ya?ml$/, loc + ' invalid local workflow');
        assert.ok(exists(path), loc + ' missing workflow ' + path);
      }
      for (const match of line.matchAll(command)) {
        const prefix = match[1] ? 'apps/' + match[1] + '/' : '';
        for (const script of match[2].split(/\s+/)) {
          const path = posix.normalize(prefix + script);
          assert.ok(!posix.isAbsolute(path) && !path.startsWith('../'), loc + ' invalid script path');
          assert.ok(exists(path), loc + ' missing script ' + path);
        }
      }
    }
  }
}

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
assert.ok(RELEASE_WORKERS.every(worker => APPLICATIONS.includes(worker)), 'Releasable Worker missing from CI applications');
verifyReleaseWorkers(release, RELEASE_WORKERS);
verifyDatabaseActivationGate(release);
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
// Email acceptance is a manual production READ gate. Only the existing MCP
// bearer is available, never Cloudflare deploy credentials or write tools.
const emailAcceptance = read('email-acceptance');
const emailSmoke = readFileSync(new URL('./email-production-read-smoke.mjs', import.meta.url), 'utf8');
assert.match(emailAcceptance, /  workflow_dispatch:/);
assert.doesNotMatch(emailAcceptance, /\n  (?:push|pull_request|schedule):/);
assert.match(emailAcceptance, /github\.event_name == 'workflow_dispatch'/);
assert.match(emailAcceptance, /github\.ref == 'refs\/heads\/main'/);
assert.match(emailAcceptance, /persist-credentials: false/);
assert.match(emailAcceptance, /GITHUB_SHA/);
assert.match(emailAcceptance, /git ls-remote/);
assert.match(emailAcceptance, /group: email-production-readonly-acceptance/);
assert.match(emailAcceptance, /EMAIL_READONLY_ACCEPTANCE: "true"/);
assert.match(emailAcceptance, /EMAIL_REQUIRE_ATTACHMENT: "true"/);
assert.match(emailAcceptance, /EMAIL_TEST_SUBJECT: "test"/);
assert.match(emailSmoke, /email_smoke_target_subject_not_found/);
assert.match(emailSmoke, /email_smoke_attachment_not_verified/);

assert.match(emailAcceptance, /node scripts\/email-production-read-smoke\.mjs/);
assert.match(emailAcceptance, /secrets\.MCP_ACCESS_TOKEN/);
const emailSecrets = [...emailAcceptance.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]);
assert.deepEqual(emailSecrets, ['MCP_ACCESS_TOKEN'], 'Only shared read-side MCP bearer allowed');
assert.doesNotMatch(emailAcceptance, /CLOUDFLARE_API_TOKEN|wrangler|pnpm dlx|release\.yml|environment:/);
assert.match(emailSmoke, /process\.env\.EMAIL_READONLY_ACCEPTANCE==='true'/);
assert.match(emailSmoke, /call\('mail_search'/);
assert.match(emailSmoke, /call\('mail_get'/);
assert.match(emailSmoke, /call\('attachment_get'/);
assert.doesNotMatch(emailSmoke, /call\(['"](?:mail_send|mail_reply|mail_forward|mail_mark|mail_move|mail_trash|draft_create)['"]/);

// Narrow operator-documentation contracts: prevent unsafe release examples and
// credential-type regressions without introducing a general Markdown linter.
export function verifyDocumentationContracts({ imaContext, raindropReadme, githubActionsReadme }) {
  assert.match(imaContext, /`IMA_CLIENT_ID`[^\n]*Variable/, 'IMA Client ID must be documented as a Variable');
  assert.match(imaContext, /`IMA_API_KEY`[^\n]*Secret/, 'IMA API key must be documented as a Secret');
  assert.doesNotMatch(imaContext, /单用户 Worker Secrets/, 'IMA Client ID must not be documented as a Secret');
  assert.match(raindropReadme, /Release Worker/, 'Raindrop must use the selected-Worker release');
  assert.doesNotMatch(raindropReadme, /wrangler\s+secret\s+put/, 'Raindrop must not recommend direct production secret writes');
  assert.match(githubActionsReadme, /inputs=\{"worker":"github-actions-mcp-worker","deploy_to_production":"true"\}/,
    'GitHub Actions MCP example must select its own Worker');
}

verifyDocumentationContracts({
  imaContext: readFileSync(new URL('../apps/ima-mcp-worker/CONTEXT.md', import.meta.url), 'utf8'),
  raindropReadme: readFileSync(new URL('../apps/raindrop-mcp-worker/README.md', import.meta.url), 'utf8'),
  githubActionsReadme: readFileSync(new URL('../apps/github-actions-mcp-worker/README.md', import.meta.url), 'utf8'),
});

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(readdirSync(workflowDir)
  .filter(name => /\.ya?ml$/.test(name))
  .map(name => [name, readFileSync(new URL(name, workflowDir), 'utf8')]));
verifyStaticWorkflowReferences(workflows,
  path => existsSync(new URL('../' + path, import.meta.url)));

console.log('WORKFLOW_RELEASE_GATE_CONTRACT_OK');
