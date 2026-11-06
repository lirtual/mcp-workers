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
  assert.doesNotMatch(source, /MAIL_ENCRYPTION_KEY/, 'Retired Email Secret reference remains');
  const workerInput = source.match(/^      worker:\n([\s\S]*?)(?=^      [a-z][a-z0-9_]*:\n)/m);
  const options = workerInput?.[1].match(/^        options:\n((?:          - [^\n]+\n)+)/m);
  assert.ok(options, 'Missing manual release Worker choices');
  const choices = options[1].trim().split('\n').map(line => line.trim().slice(2).trim());
  sameMembers(choices, expectedWorkers, 'manual release choices');

  const gate = job(source, 'deploy').gate.replace(/\s+/g, ' ').trim();
  const prefix = dollar + "{{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == 'lirtual' && inputs.deploy_to_production == true && needs.checks.result == 'success' && needs.checks.outputs.release_ready == 'true' && inputs.actions_migration_prepare != true && inputs.actions_gate_reopen != true && ";
  assert.ok(gate.startsWith(prefix) && gate.endsWith(' }}'), 'Unsafe or unsupported release gate');
  const list = gate.slice(prefix.length, -3);
  assert.match(list, /^\(inputs\.worker == '[a-z0-9-]+'(?: \|\| inputs\.worker == '[a-z0-9-]+')*\)$/, 'Unsafe or unsupported Worker allowlist');
  const allowed = [...list.matchAll(/inputs\.worker == '([^']+)'/g)].map(match => match[1]);
  sameMembers(allowed, expectedWorkers, 'release allowlist');

  // Spec #733: GitHub keeps exactly three historical Environment Secret names
  // while the selected Worker stages only canonical runtime binding keys.
  const stageStart=source.indexOf('      - name: Stage selected Worker Secrets for every release');
  const stageEnd=source.indexOf('      - name: Stage approved Worker variables',stageStart);
  assert.ok(stageStart>0 && stageEnd>stageStart, 'Missing selected Worker Secret staging boundary');
  const secretStage=source.slice(stageStart,stageEnd);
  for(const [runtime,github,worker] of [
    ['SSH_ENCRYPTION_KEY','ENCRYPTION_KEY','ssh-mcp-worker'],
    ['WORKFLOW_MCP_PORTAL_CLIENT_SECRET','MCP_PORTAL_CLIENT_SECRET','workflow-mcp-worker'],
    ['WORKFLOW_SESSION_RUNTIME_DATA_KEY','SESSION_RUNTIME_DATA_KEY','workflow-mcp-worker'],
  ]) {
    const line=runtime+': '+String.fromCharCode(36)+
      "{{ inputs.worker == '"+worker+"' && secrets."+github+" || '' }}";
    assert.equal(secretStage.split('          '+runtime+': ').length-1,1,'Duplicate or missing scoped input '+runtime);
    assert.ok(secretStage.includes('          '+line),'Wrong GitHub Secret source for '+runtime);
    assert.ok(!source.includes('secrets.'+runtime),
      'Parallel canonical GitHub Secret source forbidden: '+runtime);
    assert.ok(!secretStage.includes('          '+github+': '),
      'Old GitHub name may not be added as a runtime binding: '+github);
  }
}

/** The superseded historical D1 activation job must never be reachable. */
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
  const gate = content.match(/\n    if: >-\n([\s\S]*?)\n    runs-on:/)?.[1] ?? content.match(/\n    if: (\$\{\{[^\n]+\}\})\n/)?.[1];
  assert.ok(gate, 'Missing gated job ' + name);
  return { content, gate };
}

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
const dispatchInputs = release.slice(release.indexOf('    inputs:'),release.indexOf('\npermissions:'));
assert.ok([...dispatchInputs.matchAll(/^      [a-z][a-z0-9_]*:$/gm)].length === 9,
  'Release workflow_dispatch must have exactly nine reviewed inputs');
const prepare = job(release, 'workflow-actions-migration-prepare');
assert.ok(prepare.gate.includes("inputs.actions_migration_prepare == true")&&
  prepare.gate.includes("inputs.deploy_to_production == false")&&
  prepare.gate.includes("github.actor == 'lirtual'"),'Migration-only release gate missing');
assert.ok(!prepare.content.includes('wrangler deploy'),'Migration preparation must never deploy');
assert.ok(deploy.gate.includes('inputs.actions_migration_prepare != true'),
  'Production release must not overlap migration-only mode');
assert.ok(deploy.gate.includes("github.actor == 'lirtual'"), 'Production release Owner gate missing');
assert.ok(deploy.content.includes('[[ "$GITHUB_SHA" == "$DATABASE_EXPECTED_RELEASE_SHA" ]]'),
  'Database release expected SHA gate missing');
verifyReleaseWorkers(release, RELEASE_WORKERS);
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
for (const key of ['WORKFLOW_GITHUB_DISPATCH_TOKEN','IMA_API_KEY','ACTIONS_GITHUB_DISPATCH_TOKENS']) {
  assert.ok(deploy.content.includes(key + ': ' + dollar) && deploy.content.includes('secrets.' + key),
    'Missing selected release Secret ' + key);
}
for (const key of ['IMA_CLIENT_ID', 'WORKFLOW_MCP_PORTAL_CLIENT_ID']) {
  assert.ok(deploy.content.includes(key + ': ' + dollar) && deploy.content.includes('vars.' + key),
    'Missing selected release Variable ' + key);
}
assert.ok(smokeKeyPresent(release, 'WORKFLOW_GITHUB_DISPATCH_TOKEN', 'secrets'));
assert.ok(smokeKeyPresent(acceptance, 'WORKFLOW_GITHUB_DISPATCH_TOKEN', 'secrets'));
assert.ok(smokeKeyPresent(acceptance, 'WORKFLOW_MCP_PORTAL_CLIENT_ID', 'vars'));
assert.ok(smokeKeyPresent(release, 'WORKFLOW_MCP_PORTAL_CLIENT_ID', 'vars'));
for (const source of [release, acceptance]) {
  assert.ok(!smokeKeyPresent(source, 'WORKFLOW_MCP_PORTAL_CLIENT_ID', 'secrets'),
    'Portal Client ID incorrectly sourced from GitHub Secret');
  for (const old of ['WORKFLOW_EXECUTOR_GITHUB_TOKEN', 'MCP_BROKER_TOKEN', 'GH_TOKEN', 'API_KEY', 'ACTIONS_MCP_TOKENS']) {
    assert.ok(!source.includes(old + ': ' + dollar + '{{ secrets.' + old + ' }}'),
      'Legacy secret still staged: ' + old);
  }
}
function smokeKeyPresent(source, key, kind) {
  return source.includes(key + ': ' + dollar) && source.includes(kind + '.' + key);
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
