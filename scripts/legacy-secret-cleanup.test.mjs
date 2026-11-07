import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  CLEANUP_LEGACY_SECRETS, verifyCleanupRequest, verifyCandidateVersion, verifyLiveVersion,
  verifyScopedCleanupInventory,
} from './legacy-secret-cleanup.mjs';

test('Database Prepare pins Wrangler with non-deploying bulk null deletion support', () => {
  const pkg = JSON.parse(readFileSync('apps/database-mcp-worker/package.json', 'utf8'));
  const version = pkg.devDependencies.wrangler;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 4 || (major === 4 && minor >= 148),
    'Wrangler versions secret bulk null deletion requires Wrangler 4.148.0+');
  const lock = readFileSync('pnpm-lock.yaml', 'utf8');
  const importer = lock.split('  apps/database-mcp-worker:\n')[1]
    ?.split('\n  apps/github-actions-mcp-worker:')[0];
  assert.ok(importer?.includes('specifier: ' + version) &&
    importer.includes('version: ' + version + '('),
    'Database Wrangler manifest and lockfile must agree on exact version');
  const help = spawnSync('pnpm',
    ['--filter', 'database-mcp-worker', 'exec', 'wrangler', 'versions', 'secret', 'bulk', '--help'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(help.status, 0, 'Installed Wrangler CLI help is unavailable');
  assert.match(help.stdout, /Set a key to null in the JSON file to delete it/,
    'Installed Wrangler must support deleting Secret bindings via JSON null');
});

test('Spec 733 SSH and Workflow Prepare pin a CLI supporting versioned bulk null deletion', () => {
  const lock = readFileSync('pnpm-lock.yaml', 'utf8');
  for (const worker of ['ssh-mcp-worker', 'workflow-mcp-worker']) {
    const pkg = JSON.parse(readFileSync('apps/' + worker + '/package.json', 'utf8'));
    const version = pkg.devDependencies.wrangler;
    assert.match(version, /^\d+\.\d+\.\d+$/, 'Wrangler must be exact, not a range');
    const [major, minor] = version.split('.').map(Number);
    assert.ok(major > 4 || (major === 4 && minor >= 148),
      worker + ' cannot delete versioned Secret bindings using JSON null with older Wrangler');
    const importer = lock.split('  apps/' + worker + ':\n')[1]
      ?.split('\n  apps/')[0];
    assert.ok(importer?.includes('specifier: ' + version) &&
      importer.includes('version: ' + version + '('),
      worker + ' Wrangler manifest and lockfile do not match');
    const help = spawnSync('pnpm',
      ['--filter', worker, 'exec', 'wrangler', 'versions', 'secret', 'bulk', '--help'],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(help.status, 0, worker + ' installed Wrangler CLI help is unavailable');
    assert.match(help.stdout, /Set a key to null in the JSON file to delete it/,
      worker + ' CLI must explicitly support deleting a Secret with JSON null');
  }
});

const SSH = 'ssh-mcp-worker';
const WORKFLOW = 'workflow-mcp-worker';
const DATABASE = 'database-mcp-worker';
const oldSecretNames = {
  [DATABASE]: CLEANUP_LEGACY_SECRETS[DATABASE],
  [SSH]: ['ENCRYPTION_KEY'],
  [WORKFLOW]: ['MCP_PORTAL_CLIENT_SECRET', 'SESSION_RUNTIME_DATA_KEY'],
};
const required = {
  [DATABASE]: ['MCP_ACCESS_TOKEN','DATABASE_B2B_PASSWORD','DATABASE_SCRAPE_RELAY_PASSWORD'],
  [SSH]: ['MCP_ACCESS_TOKEN', 'SSH_ENCRYPTION_KEY'],
  [WORKFLOW]: [
    'MCP_ACCESS_TOKEN', 'WORKFLOW_MCP_PORTAL_CLIENT_SECRET',
    'WORKFLOW_GITHUB_DISPATCH_TOKEN',
  ],
};
const secret = name => ({ name, type: 'secret_text' });
const variable = (name, text) => ({ name, type: 'plain_text', text });
const version = (worker, versionNumber, deleted = true) => ({
  id: versionNumber === 10 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
  number: versionNumber,
  resources: {
    script: { etag: 'identical-code-etag', handlers: ['fetch'], named_handlers: [] },
    script_runtime: { compatibility_date: '2026-09-10', usage_model: 'standard' },
    bindings: [
      ...required[worker].map(secret),
      ...(!deleted ? oldSecretNames[worker].map(secret) : []),
      variable('APPROVED_VALUE', 'preserved'),
      { name: 'DB', type: 'd1', id: 'same-database-id' },
    ],
  },
});
const sample = worker => [version(worker, 10, false), version(worker, 11, true)];

test('only Owner-reviewed SHA, exact worker and version inputs can select cleanup phase', () => {
  const o = {
    worker: SSH, phase: 'prepare', expectedSha: 'a'.repeat(40),
    actualSha: 'a'.repeat(40), currentVersion: sample(SSH)[0].id, candidateVersion: '',
  };
  assert.equal(verifyCleanupRequest(o), true);
  assert.equal(verifyCleanupRequest({...o, phase: 'publish', candidateVersion: sample(SSH)[1].id}), true);
  for(const mutation of [
    {worker: 'other-worker'}, {phase: 'delete'}, {actualSha: 'b'.repeat(40)},
    {expectedSha: 'x'.repeat(40)}, {currentVersion: 'not-uuid'},
    {candidateVersion: sample(SSH)[1].id},
    {phase:'publish',candidateVersion:''}, {phase:'publish',candidateVersion:sample(SSH)[0].id},
  ]) assert.throws(() => verifyCleanupRequest({...o,...mutation}));
});

test('Database cleanup removes exactly three runtime Secrets and preserves all other metadata', () => {
  const [before, after] = sample(DATABASE);
  for (const version of [before, after]) {
    version.resources.bindings = version.resources.bindings.filter(binding=>binding.name!=='DB');
    version.resources.bindings.push(
    variable('DATABASE_CONNECTIONS','{}'), variable('DB_HOST','db.example.invalid'),
    {name:'RATE_LIMITER',type:'ratelimit',namespace_id:'1001',simple:{limit:120,period:60}},
    );
  }
  assert.equal(verifyCandidateVersion(DATABASE,before,after),true);
  for (const mutate of [
    b => ({...b,resources:{...b.resources,bindings:b.resources.bindings.filter(x=>x.name!=='DATABASE_B2B_PASSWORD')}}),
    b => ({...b,resources:{...b.resources,bindings:[...b.resources.bindings,secret('DATABASE_ENCRYPTION_PREVIOUS_KEY')]}}),
    b => ({...b,resources:{...b.resources,bindings:b.resources.bindings.map(x=>x.name==='DATABASE_CONNECTIONS'?variable(x.name,'changed'):x)}}),
    b => ({...b,resources:{...b.resources,bindings:b.resources.bindings.map(x=>x.name==='RATE_LIMITER'?{...x,simple:{limit:1,period:60}}:x)}}),
    b => ({...b,resources:{...b.resources,bindings:b.resources.bindings.map(x=>x.name==='RATE_LIMITER'?{...x,namespace_id:'different'}:x)}}),
    b => ({...b,resources:{...b.resources,bindings:[...b.resources.bindings,{name:'DB',type:'d1',id:'unexpected'}]}}),
    b => ({...b,resources:{...b.resources,script:{...b.resources.script,etag:'changed'}}}),
    b => ({...b,resources:{...b.resources,script_runtime:{compatibility_date:'2026-11-06'}}}),
  ]) assert.throws(()=>verifyCandidateVersion(DATABASE,before,mutate(after)));
  for (const omitted of oldSecretNames[DATABASE]) {
    const wrong={...before,resources:{...before.resources,bindings:before.resources.bindings.filter(x=>x.name!==omitted)}};
    assert.throws(()=>verifyCandidateVersion(DATABASE,wrong,after),/inventory/);
  }
});

test('version-scoped cleanup uses deployed baseline when latest Settings are an approved candidate', () => {
  for (const worker of [DATABASE, SSH, WORKFLOW]) {
    const [before, after] = sample(worker);
    const settings = { bindings: after.resources.bindings.map(binding => ({ ...binding })) };
    const inventory = after.resources.bindings.filter(b => b.type === 'secret_text')
      .map(b => ({ name: b.name }));
    const result = verifyScopedCleanupInventory(worker, before, after, settings, inventory);
    assert.deepEqual(result.bindings, before.resources.bindings);
    assert.deepEqual(result.secrets.map(s => s.name).sort(),
      [...required[worker], ...oldSecretNames[worker]].sort());
    assert.equal(verifyScopedCleanupInventory(worker, before, null,
      {bindings:before.resources.bindings}, before.resources.bindings
        .filter(b => b.type === 'secret_text').map(b => ({ name:b.name }))).bindings.length,
      before.resources.bindings.length);
    // Without an approved candidate, latest Settings that are no longer
    // equivalent to the deployed version must be rejected.
    assert.throws(() => verifyScopedCleanupInventory(worker, before, null, settings, inventory),
      /Latest Worker Settings/);
    assert.throws(() => verifyScopedCleanupInventory(worker, before, after,
      {bindings:settings.bindings.filter(b => b.name !== 'MCP_ACCESS_TOKEN')}, inventory),
      /Latest Worker Settings/);
    assert.throws(() => verifyScopedCleanupInventory(worker, before, after, settings,
      [...inventory, {name:'UNREVIEWED_SECRET'}]), /Latest Worker Settings/);
    assert.throws(() => verifyScopedCleanupInventory(worker, before, after, settings,
      [...inventory, inventory[0]]), /Latest Worker Settings/);
    assert.throws(() => verifyScopedCleanupInventory(worker, before, after,
      {bindings:settings.bindings.map(b => b.name === 'MCP_ACCESS_TOKEN'
        ? {...b, type:'plain_text'} : b)}, inventory), /Latest Worker Settings/);
    assert.throws(() => verifyScopedCleanupInventory(worker, before, after,
      {...settings}, inventory.filter(s => s.name !== 'MCP_ACCESS_TOKEN')),
      /Latest Worker Settings/);
    assert.throws(() => verifyScopedCleanupInventory(worker, before, after,
      settings, inventory.map(s=>({name: s.name === 'MCP_ACCESS_TOKEN'
        ? 'WRONG_TOKEN' : s.name}))), /Latest Worker Settings/);
    const broken = {...after, resources:{...after.resources, script:{...after.resources.script,etag:'changed'}}};
    assert.throws(() => verifyScopedCleanupInventory(worker, before, broken, settings, inventory),
      /etag/);
    const unsafeBaseline = {...before, resources:{...before.resources,
      bindings:before.resources.bindings.filter(b=>b.name!==oldSecretNames[worker][0])}};
    assert.throws(() => verifyScopedCleanupInventory(worker, unsafeBaseline, after, settings, inventory),
      /Deployed version Secret inventory/);
  }
});

test('single SSH and grouped Workflow removal preserve all other bindings and source', () => {
  for(const worker of [SSH, WORKFLOW]) {
    const [before, after] = sample(worker);
    assert.equal(verifyCandidateVersion(worker, before, after), true);
    assert.throws(()=>verifyCandidateVersion(worker, after, before), /newer/);
    assert.throws(()=>verifyCandidateVersion(worker, before, {...after,id:before.id}), /newer/);
    assert.throws(()=>verifyCandidateVersion(worker, before,
      {...after,resources:{...after.resources,script:{...after.resources.script,etag:'changed-code'}}}), /etag/);
    assert.throws(()=>verifyCandidateVersion(worker, before,
      {...after,resources:{...after.resources,script_runtime:{compatibility_date:'2026-11-06'}}}), /runtime/);
    assert.throws(()=>verifyCandidateVersion(worker, before,
      {...after,resources:{...after.resources,bindings:[...after.resources.bindings,secret('UNREVIEWED')]}}), /inventory/);
    assert.throws(()=>verifyCandidateVersion(worker, before,
      {...after,resources:{...after.resources,bindings:[...after.resources.bindings,secret(oldSecretNames[worker][0])]}}), /inventory/);
    assert.throws(()=>verifyCandidateVersion(worker, before,
      {...after,resources:{...after.resources,bindings:after.resources.bindings.filter(x=>x.name!=='MCP_ACCESS_TOKEN')}}), /inventory/);
    assert.throws(()=>verifyCandidateVersion(worker, before,
      {...after,resources:{...after.resources,bindings:after.resources.bindings.map(x=>x.name==='APPROVED_VALUE'?variable(x.name,'changed'):x)}}), /resources/);
    assert.throws(()=>verifyCandidateVersion(worker, before,
      {...after,resources:{...after.resources,bindings:after.resources.bindings.map(x=>x.name==='DB'?{...x,id:'different'}:x)}}), /resources/);
  }
});

test('active Worker check rejects split traffic, stale and missing deployment', () => {
  const id = sample(SSH)[0].id;
  const current = {deployments:[{id:'deploy',versions:[{version_id:id,percentage:100}]}]};
  assert.equal(verifyLiveVersion(current,id),true);
  for(const bad of [
    {deployments:[]},
    {deployments:[{versions:[{version_id:id,percentage:50}]}]},
    {deployments:[{versions:[{version_id:id,percentage:100},{version_id:sample(SSH)[1].id,percentage:0}]}]},
    {deployments:[{versions:[{version_id:sample(SSH)[1].id,percentage:100}]}]},
  ]) assert.throws(()=>verifyLiveVersion(bad,id),/Active production version/);
});

test('Spec 733 cleanup mode is isolated from ordinary selected Worker release and requires existing gates',()=>{
  const yml = readFileSync('.github/workflows/release.yml','utf8');
  const normal = yml.split('  deploy:\n')[1]?.split('\n  legacy-secret-cleanup:\n')[0];
  const cleanup = yml.split('  legacy-secret-cleanup:\n')[1]?.split('\n  database-hyperdrive-finalize:\n')[0];
  assert.ok(normal && cleanup);
  assert.match(normal,/inputs\.legacy_secret_cleanup_mode == 'none'/);
  assert.match(cleanup,/needs: checks/);
  assert.match(cleanup,/github\.actor == 'lirtual'/);
  assert.match(cleanup,/github\.ref == 'refs\/heads\/main'/);
  assert.match(cleanup,/inputs\.deploy_to_production == true/);
  assert.match(cleanup,/needs\.checks\.outputs\.release_ready == 'true'/);
  assert.match(cleanup,/group: worker-release-/);
  assert.match(cleanup,/cancel-in-progress: false/);
  assert.match(cleanup,/environment:/);
  assert.match(cleanup,/node scripts\/legacy-secret-cleanup\.mjs preflight/);
  assert.match(cleanup,/node scripts\/legacy-secret-cleanup\.mjs candidate/);
  assert.match(cleanup,/wrangler versions secret bulk/);
  assert.match(cleanup,/wrangler versions deploy/);
  // Wrangler 4.151.0 does not support --strict for versions deploy.
  const promotion=cleanup.split('- name: Deploy only the independently approved candidate to 100 percent')[1]
    ?.split('- name: Verify exact live version')[0];
  assert.ok(promotion);
  assert.match(promotion,/\$CANDIDATE_VERSION_ID@100" --yes\)/);
  assert.doesNotMatch(promotion,/--strict/);
  assert.match(promotion,/manual-worker-release\.mjs diagnostic "\$log" deploy \|\| true/);
  assert.match(promotion,/Candidate promotion failed\/unknown; read active deployment/);
  assert.doesNotMatch(promotion,/cat "\$log"|tee "\$log"/);
  assert.match(cleanup,/node scripts\/manual-worker-release\.mjs cleanup-readback/);
  assert.match(cleanup,/manual-worker-release\.mjs diagnostic "\$log" prepare \|\| true/);
  assert.match(cleanup,/Candidate creation failed\/unknown; do not retry/);
  assert.doesNotMatch(cleanup,/cat "\$log"|tee "\$log"/);
  assert.match(cleanup,/inputs\.workflow_code_only != true/);
  assert.match(cleanup,/inputs\.actions_old_ingress_quiesced != true/);
  assert.match(cleanup,/if: inputs\.legacy_secret_cleanup_mode == 'prepare'/);
  assert.match(cleanup,/if: inputs\.legacy_secret_cleanup_mode == 'publish'/);
  assert.match(cleanup,/inputs\.worker == 'database-mcp-worker'/);
  assert.match(cleanup,/\{"DATABASE_ENCRYPTION_KEY":null,"DATABASE_GITHUB_ACTIONS_TOKEN":null,"DATABASE_KEY_ID":null\}/);
  assert.doesNotMatch(cleanup, /pnpm exec wrangler secret delete|wrangler deploy --secrets-file|gh secret|portal-register|workflow_run/);
  assert.match(yml,/default: none/);
});

test('installed Wrangler CLI supports approved version deploy flags without --strict', () => {
  for (const worker of [DATABASE, SSH, WORKFLOW]) {
    const help = spawnSync('pnpm', ['--filter', worker, 'exec', 'wrangler',
      'versions', 'deploy', '--help'], {encoding:'utf8', timeout:30000});
    assert.equal(help.status, 0, worker + ' version deploy help unavailable');
    assert.match(help.stdout, /--yes/, worker + ' version deploy must accept --yes');
    assert.doesNotMatch(help.stdout, /--strict/, worker + ' unsupported --strict flag');
  }
});

test('cleanup read-only helper has no mutation path and no GitHub Secret name migration',()=>{
  const source=readFileSync('scripts/legacy-secret-cleanup.mjs','utf8');
  assert.match(source,/GET/);
  assert.match(source,/SELECT name FROM d1_migrations/);
  assert.match(source,/CANDIDATE_VERSION_ID/);
  assert.match(source,/etag/);
  assert.doesNotMatch(source,/method:\s*['"](?:PUT|PATCH|DELETE)['"]/);
  assert.doesNotMatch(source,/pnpm exec wrangler|wrangler deploy|wrangler secret delete|versions deploy/);
  assert.doesNotMatch(source,/writeFile|spawnSync|execSync|gh secret/);
});

test('cleanup baseline retains old Secrets, while post-publish readback requires their absence', () => {
  const baseline = readFileSync('scripts/legacy-secret-cleanup.mjs','utf8');
  const check = baseline.split('verifyBindings(worker, { ...settings.result, bindings: deployed.bindings }, deployed.secrets, {')[1]
    ?.split('\n  });')[0];
  assert.ok(check?.includes("mode: 'readback'"));
  assert.doesNotMatch(check, /cleanupVerified:\s*true/);
  assert.match(baseline, /verifyScopedCleanupInventory\(worker, current.result, candidate,/);
  assert.match(baseline, /candidate\?\.id === candidateId/);
  const readback = readFileSync('scripts/manual-worker-release.mjs','utf8')
    .split('if (mode === "cleanup-readback")')[1]?.split('return;')[0];
  assert.ok(readback);
  assert.match(readback, /cleanupVerified:\s*true/);
  const release = readFileSync('.github/workflows/release.yml','utf8');
  const publish = release.split('- name: Revalidate reviewed candidate immediately before production promotion')[1]
    ?.split('- name: Deploy only the independently approved candidate to 100 percent')[0];
  assert.ok(publish);
  assert.match(publish, /CANDIDATE_VERSION_ID:/);
  assert.match(publish, /legacy-secret-cleanup\.mjs preflight/);
  assert.match(publish, /legacy-secret-cleanup\.mjs candidate/);
});
