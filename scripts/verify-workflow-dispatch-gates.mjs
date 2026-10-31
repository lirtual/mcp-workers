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
  const prefix = dollar + "{{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == 'lirtual' && inputs.deploy_to_production == true && needs.checks.result == 'success' && needs.checks.outputs.release_ready == 'true' && inputs.actions_migration_prepare != true && inputs.database_hyperdrive_rotation_mode == '' && ";
  assert.ok(gate.startsWith(prefix) && gate.endsWith(' }}'), 'Unsafe or unsupported release gate');
  const list = gate.slice(prefix.length, -3);
  assert.match(list, /^\(inputs\.worker == '[a-z0-9-]+'(?: \|\| inputs\.worker == '[a-z0-9-]+')*\)$/, 'Unsafe or unsupported Worker allowlist');
  const allowed = [...list.matchAll(/inputs\.worker == '([^']+)'/g)].map(match => match[1]);
  sameMembers(allowed, expectedWorkers, 'release allowlist');
}

/** The superseded historical D1 activation job must never be reachable. */
export function verifyDatabaseActivationGate(source) {
  assert.ok(!source.includes('\n  database-activate:\n'), 'Historical Database activation job must be absent');
  assert.ok(!source.includes('database_activation_id:') &&
    !source.includes('database_activation_approved:') &&
    !source.includes('database_activation_revision:'),
    'Historical Database activation input or script remains exposed');
  // Newly approved Hyperdrive activation is distinct from the retired
  // historical D1 activation. Allow one script call in a strictly guarded
  // Owner/main/Environment-scoped job; reject stray or duplicated invocations.
  const name = '\n  database-hyperdrive-enable:\n';
  const count = source.split('run: node scripts/activate-database-hyperdrive.mjs').length - 1;
  const job = source.split(name)[1]?.split(/\n  [a-z][a-z0-9-]*:\n/, 1)[0];
  if (job === undefined) {
    assert.equal(count, 0, 'Unprotected Hyperdrive activation invocation');
  } else {
    assert.equal(count, 1, 'Duplicate or missing protected Hyperdrive activation invocation');
    for (const clause of [
      "github.event_name == 'workflow_dispatch'", "github.ref == 'refs/heads/main'",
      "github.actor == 'lirtual'", "inputs.worker == 'database-mcp-worker'",
      'inputs.database_hyperdrive_enable_approved == true',
      'inputs.deploy_to_production == false', "inputs.database_hyperdrive_prepare_id == ''",
      "inputs.database_hyperdrive_id != ''", "inputs.database_hyperdrive_revision != ''",
      'name: database-mcp-worker', 'group: worker-release-database-mcp-worker',
      'secrets.CLOUDFLARE_API_TOKEN', 'secrets.MCP_ACCESS_TOKEN',
      'inputs.database_hyperdrive_id', 'inputs.database_hyperdrive_revision',
      'run: node scripts/activate-database-hyperdrive.mjs'
    ]) assert.ok(job.includes(clause), 'Unsafe Hyperdrive activation job: ' + clause);
  }
  for (const legacy of [
    'database_aiven_provision_approved:', '\n  database-aiven-provision:\n',
    'node scripts/database-aiven-hyperdrive-prepare-344.mjs',
    'database_prepare_approved:', 'database_direct_preflight_approved:',
    'database_restore_approved:', 'database_restore_expected_version:',
    '\n  database-prepare:\n', '\n  database-direct-preflight:\n',
    '\n  database-restore:\n', 'node scripts/database-legacy-restore-',
    'node scripts/database-prep-344.mjs', 'node scripts/database-direct-preflight-344.mjs'
  ]) assert.ok(!source.includes(legacy), 'Retired Database compatibility entry remains: ' + legacy);
}

/** Final apply is mutually exclusive with deploy and all other lifecycle actions. */
export function verifyDatabaseApplyGate(source) {
  const {content,gate} = job(source,'database-hyperdrive-apply');
  const expected = dollar + "{{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == 'lirtual' && inputs.worker == 'database-mcp-worker' && inputs.deploy_to_production == false && inputs.database_hyperdrive_apply_id != '' && inputs.database_hyperdrive_prepare_id == '' && inputs.database_hyperdrive_enable_approved != true && inputs.database_hyperdrive_retire_approved != true && inputs.database_hyperdrive_id == '' && inputs.database_hyperdrive_revision == '' && inputs.database_expected_release_sha == '' && inputs.database_hyperdrive_rotation_mode == '' }}";
  assert.equal(gate.replace(/\s+/g,' ').trim(),expected,'Unsafe Hyperdrive apply gate');
  for (const clause of ['name: database-mcp-worker','group: worker-release-database-mcp-worker',
    'cancel-in-progress: false','contents: write','pull-requests: write','checks: read','statuses: read','actions: read',
    'persist-credentials: false','secrets.DATABASE_GITHUB_ACTIONS_TOKEN',
    'DATABASE_HYPERDRIVE_OPERATION_ID: '+dollar+'{{ inputs.database_hyperdrive_apply_id }}',
    'run: node scripts/apply-database-hyperdrive-476.mjs']) {
    assert.ok(content.includes(clause),'Unsafe Hyperdrive apply job: '+clause);
  }
  assert.equal(source.split('run: node scripts/apply-database-hyperdrive-476.mjs').length-1,1);
  assert.ok(!content.includes('wrangler deploy') && !content.includes('DATABASE_ENCRYPTION_KEY'));
  for(const name of ['database-hyperdrive-prepare','database-hyperdrive-enable','database-hyperdrive-retire']) {
    assert.ok(job(source,name).gate.includes("inputs.database_hyperdrive_apply_id == ''"),'Conflicting lifecycle action');
  }
  assert.ok(job(source,'checks').gate.includes("inputs.deploy_to_production == true && inputs.database_hyperdrive_prepare_id == ''"));
  verifyDatabaseFinalizeGate(source);
  const inputs=source.slice(source.indexOf('    inputs:'),source.indexOf('\npermissions:'));
  assert.equal([...inputs.matchAll(/^      ([a-z][a-z0-9_]*):$/gm)].length,12,'Expected exactly twelve inputs');
}

/** Only the successful existing deploy can supply a published version receipt. */
export function verifyDatabaseFinalizeGate(source) {
  const {content,gate}=job(source,'database-hyperdrive-finalize');
  const expected=dollar+"{{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == 'lirtual' && inputs.worker == 'database-mcp-worker' && inputs.deploy_to_production == true && needs.deploy.result == 'success' && inputs.database_hyperdrive_apply_id != '' && inputs.database_expected_release_sha != '' && inputs.database_hyperdrive_prepare_id == '' && inputs.database_hyperdrive_enable_approved != true && inputs.database_hyperdrive_retire_approved != true && inputs.database_hyperdrive_id == '' && inputs.database_hyperdrive_revision == '' && inputs.database_hyperdrive_rotation_mode == '' }}";
  assert.equal(gate.replace(/\s+/g,' ').trim(),expected,'Unsafe postrelease gate');
  for(const clause of ['needs: deploy','name: database-mcp-worker','group: worker-release-database-mcp-worker',
    'cancel-in-progress: false','persist-credentials: false','ref: '+dollar+'{{ github.sha }}',
    'DATABASE_EXPECTED_RELEASE_SHA: '+dollar+'{{ inputs.database_expected_release_sha }}',
    'DATABASE_HYPERDRIVE_OPERATION_ID: '+dollar+'{{ inputs.database_hyperdrive_apply_id }}',
    'EXPECTED_VERSION_ID: '+dollar+'{{ needs.deploy.outputs.version_id }}',
    'DATABASE_RELEASE_ENVIRONMENT: database-mcp-worker',
    'run: node scripts/finalize-database-hyperdrive-476.mjs'])assert.ok(content.includes(clause),'Missing protected reconciliation: '+clause);
  assert.match(content,/permissions:\n      contents: read\n      actions: read\n    steps:/);
  assert.ok(!content.includes('wrangler') && !content.includes('DATABASE_ENCRYPTION_KEY'));
  assert.equal(source.split('run: node scripts/finalize-database-hyperdrive-476.mjs').length-1,1);
  assert.ok(job(source,'deploy').content.includes('version_id: '+dollar+'{{ steps.publish.outputs.version_id }}'));
  assert.ok(!job(source,'checks').gate.includes("inputs.database_hyperdrive_apply_id == ''"));
}

/** No automatic unbinding merge or production deployment until an independent
 * in-flight and rollback isolation proof exists. This is a release contract,
 * not a replacement for executing Owner approval or Cloudflare readback. */
export function verifyDatabaseRetireStagingGate(source,stageSource) {
  const {content,gate}=job(source,'database-hyperdrive-retire');
  const expected=dollar+"{{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == 'lirtual' && inputs.worker == 'database-mcp-worker' && inputs.database_hyperdrive_retire_approved == true && inputs.deploy_to_production == false && inputs.database_hyperdrive_prepare_id == '' && inputs.database_hyperdrive_apply_id == '' && inputs.database_hyperdrive_enable_approved != true && inputs.database_hyperdrive_id != '' && inputs.database_hyperdrive_revision != '' && inputs.database_hyperdrive_rotation_mode == '' }}";
  assert.equal(gate.replace(/\s+/g,' ').trim(),expected,'Unsafe Hyperdrive retire gate');
  for(const required of ['name: database-mcp-worker','group: worker-release-database-mcp-worker',
    'cancel-in-progress: false','contents: write','pull-requests: write',
    'id: unbind','run: node scripts/prepare-database-hyperdrive-unbind-476.mjs',
    "if: steps.unbind.outputs.action == 'retire'",
    'run: node scripts/retire-database-hyperdrive.mjs']){
    assert.ok(content.includes(required),'Unsafe Hyperdrive retire staging: '+required);
  }
  for(const forbidden of ['wrangler deploy','/pulls/merge','DATABASE_ENCRYPTION_KEY:'])
    assert.ok(!content.includes(forbidden),'Unreviewed unbind or release action');
  assert.ok(stageSource.includes('draft:true,body:') &&
    stageSource.includes("return {phase:'awaiting_unbind_review'") &&
    !/github\(\s*['"][^'"]*\/merge['"]/.test(stageSource) &&
    !/github\(\s*['"][^'"]*actions\/workflows\/release\.yml\/dispatches/.test(stageSource),
    'Unbinding stage must not merge or deploy');
  assert.equal(source.split('run: node scripts/prepare-database-hyperdrive-unbind-476.mjs').length-1,1);
}

/** This mode is read-only and must be mutually exclusive with every write,
 * activation, retirement and deploy entrypoint. Do not repurpose as an Apply. */
export function verifyDatabaseRotationGate(source, script){
  const {content,gate}=job(source,'database-hyperdrive-rotation-check');
  const expected=dollar+"{{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == 'lirtual' && inputs.worker == 'database-mcp-worker' && inputs.deploy_to_production == false && (inputs.database_hyperdrive_rotation_mode == 'credentials' || inputs.database_hyperdrive_rotation_mode == 'ca') && inputs.database_hyperdrive_id != '' && inputs.database_hyperdrive_revision != '' && inputs.database_hyperdrive_prepare_id == '' && inputs.database_hyperdrive_apply_id == '' && inputs.database_expected_release_sha == '' && inputs.database_hyperdrive_enable_approved != true && inputs.database_hyperdrive_retire_approved != true }}";
  assert.equal(gate.replace(/\s+/g,' ').trim(),expected,'Unsafe rotation preflight job');
  for(const text of ['name: database-mcp-worker','group: worker-release-database-mcp-worker',
    'cancel-in-progress: false','permissions:\n      contents: read',
    'persist-credentials: false','git ls-remote origin refs/heads/main',
    'DATABASE_ROTATION_MODE: '+dollar+'{{ inputs.database_hyperdrive_rotation_mode }}',
    'DATABASE_ROTATION_ID: '+dollar+'{{ inputs.database_hyperdrive_id }}',
    'DATABASE_ROTATION_REVISION: '+dollar+'{{ inputs.database_hyperdrive_revision }}',
    'run: node scripts/check-database-hyperdrive-rotation-476.mjs']){
    assert.ok(content.includes(text),'Missing read-only rotation gate: '+text);
  }
  for(const forbidden of ['contents: write','pull-requests: write','wrangler deploy',
    'DATABASE_ENCRYPTION_KEY:','DATABASE_GITHUB_ACTIONS_TOKEN:','/merge','/dispatches']){
    assert.ok(!content.includes(forbidden),'Unsafe read-only rotation action: '+forbidden);
  }
  for(const name of ['database-hyperdrive-prepare','database-hyperdrive-apply',
    'database-hyperdrive-enable','database-hyperdrive-retire','checks','deploy',
    'database-hyperdrive-finalize']){
    assert.ok(job(source,name).gate.includes("inputs.database_hyperdrive_rotation_mode == ''"),
      'Rotation conflicts with '+name);
  }
  assert.equal(source.split('run: node scripts/check-database-hyperdrive-rotation-476.mjs').length-1,1);
  assert.ok(script.includes("method:sql?'POST':'GET'") &&
    !/method\s*:\s*['"](?:PATCH|PUT|DELETE)['"]/.test(script) &&
    !/wrangler\s+deploy|\/restart['"]/.test(script) &&
    !/\b(?:UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|REPLACE)\s+(?:FROM\s+|INTO\s+)?(?:database_connections|hyperdrive_operations|d1_migrations)\b/i.test(script),
    'Rotation readiness must only read Cloudflare and query D1');
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
  const gate = content.match(/\n    if: >-\n([\s\S]*?)\n    runs-on:/)?.[1] ?? content.match(/\n    if: (\$\{\{[^\n]+\}\})\n/)?.[1];
  assert.ok(gate, 'Missing gated job ' + name);
  return { content, gate };
}
export function verifyCandidateCiGate(workflow) {
  assert.match(workflow, /  workflow_dispatch:/);
  assert.match(workflow, /      candidate_sha:/);
  assert.ok(workflow.includes("if: ${{ github.event_name != 'workflow_dispatch' || !contains(github.workflow_ref, '/.github/workflows/ci.yml@') || (github.repository == 'lirtual/mcp-workers' && github.actor == 'lirtual' && inputs.worker == 'database-mcp-worker' && startsWith(github.ref, 'refs/heads/db476-')) }}"));
  assert.ok(workflow.includes("if: github.event_name == 'workflow_dispatch' && contains(github.workflow_ref, '/.github/workflows/ci.yml@')"));
  assert.doesNotMatch(workflow, /\$\{\{[^}]*secrets\.|^\s*(?:secrets|environment):|^  deploy:/m);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  for (const invariant of ['Verify candidate provenance',
    '"$GITHUB_SHA" == "$CANDIDATE_SHA"', 'git rev-parse HEAD',
    'git show -s --format=%P HEAD', 'git fetch --no-tags origin main',
    'git diff --no-renames --name-status "$parent" HEAD',
    'git ls-tree HEAD -- "$file"',
    "expected=$'M\\tapps/database-mcp-worker/hyperdrive-bindings.json\\nM\\tapps/database-mcp-worker/wrangler.jsonc'",
    '^refs/heads/db476-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$']) {
    assert.ok(workflow.includes(invariant), 'Missing candidate CI gate: ' + invariant);
  }
  assert.ok(workflow.indexOf('Verify candidate provenance') < workflow.indexOf('run: node scripts/'),
    'Candidate provenance must precede candidate scripts');
}
assert.match(ci, /  push:/);
assert.match(ci, /  pull_request:/);
assert.match(ci, /  workflow_call:/);
assert.match(ci, /release_ready:/);
assert.match(ci, /release-gate:/);
assert.match(ci, /needs: \[checks, database-integration\]/);
assert.match(ci, /if: \$\{\{ always\(\) \}\}/);
assert.match(ci, /true:success\|false:skipped/);
assert.ok(ci.includes("REUSABLE_WORKER: ${{ !contains(github.workflow_ref, '/.github/workflows/ci.yml@') && inputs.worker || '' }}"));
verifyCandidateCiGate(ci);
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
assert.ok([...dispatchInputs.matchAll(/^      [a-z][a-z0-9_]*:$/gm)].length === 12,
  'Release workflow_dispatch must have exactly twelve reviewed inputs');
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
verifyDatabaseActivationGate(release);
verifyDatabaseApplyGate(release);
verifyDatabaseRotationGate(release,readFileSync(new URL('./check-database-hyperdrive-rotation-476.mjs',import.meta.url),'utf8'));
verifyDatabaseRetireStagingGate(release,readFileSync(new URL('./prepare-database-hyperdrive-unbind-476.mjs',import.meta.url),'utf8'));
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
