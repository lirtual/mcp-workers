import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyBindings } from './manual-worker-release.mjs';

const obs = { enabled: true, logs: { invocation_logs: true } };
const plain = (name, text) => ({ name, type: 'plain_text', text });
const secret = name => ({ name, type: 'secret_text' });
const workflowBase = [{ name: 'DB', type: 'd1', id: 'a4a477cd-6339-478c-ab7c-f7d87bb0d772' }];
const workflowOptions = { mode: 'preflight', expectedWorkflowPortalClientId: 'original',
  expectedWorkflowGrants: '[{"repository":"lirtual/github-actions","repositoryId":42,"commitSha":"' + 'a'.repeat(40) + '"}]' };
const workflowSettings = variables => ({ bindings: [...workflowBase, ...variables], observability: obs });

test('Workflow preflight refuses conflicting old/new Portal identities', () => {
  const old = plain('MCP_PORTAL_CLIENT_ID', 'original');
  const newer = plain('WORKFLOW_MCP_PORTAL_CLIENT_ID', 'replacement');
  const approved = plain('GITHUB_ACTION_APPROVED_REPOSITORIES', workflowOptions.expectedWorkflowGrants);
  assert.throws(() => verifyBindings('workflow-mcp-worker', workflowSettings([old, newer, approved]), [], workflowOptions), /Portal client identity/);
  assert.equal(verifyBindings('workflow-mcp-worker', workflowSettings([old, plain(newer.name, 'original'), approved]), [], workflowOptions), true);
  assert.throws(() => verifyBindings('workflow-mcp-worker', workflowSettings([plain(newer.name, 'original'), approved]), [],
    {...workflowOptions, expectedWorkflowPortalClientId: ''}), /Portal client identity/);
});

test('Workflow preflight refuses conflicting old/new repository approvals', () => {
  const old = plain('MCP_PORTAL_CLIENT_ID', 'original');
  const legacy = plain('GITHUB_ACTION_APPROVED_REPOSITORIES', '[]');
  const newer = plain('WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES', workflowOptions.expectedWorkflowGrants);
  assert.throws(() => verifyBindings('workflow-mcp-worker', workflowSettings([old, legacy, newer]), [], workflowOptions), /approved repositories/);
  assert.equal(verifyBindings('workflow-mcp-worker', workflowSettings([old, plain(legacy.name, newer.text), newer]), [], workflowOptions), true);
  assert.throws(() => verifyBindings('workflow-mcp-worker', workflowSettings([old, plain(newer.name,'[]')]), [], workflowOptions), /approved repositories/);
});

const limits = {
  MAX_ROWS: ['DATABASE_MAX_ROWS', '500'],
  MAX_RESULT_BYTES: ['DATABASE_MAX_RESULT_BYTES', '1048576'],
  MAX_SCHEMA_BYTES: ['DATABASE_MAX_SCHEMA_BYTES', '524288'],
  QUERY_TIMEOUT_MS: ['DATABASE_QUERY_TIMEOUT_MS', '15000'],
  MAX_WRITE_AFFECTED_ROWS: ['DATABASE_MAX_WRITE_AFFECTED_ROWS', '20'],
};
const dbBase = [
  plain('ACCESS_TEAM_DOMAIN', 'owner.cloudflareaccess.com'),
  plain('OWNER_EMAIL', 'owner@example.com'),
  plain('ACCESS_AUD', 'a'.repeat(64)),
  {name:'RATE_LIMITER', type:'ratelimit', namespace_id:'1001', simple:{limit:120, period:60}},
  {name:'SETUP_RATE_LIMITER', type:'ratelimit', namespace_id:'1002', simple:{limit:20, period:60}},
];
const dbOptions = {mode:'preflight',sharedAccessTeamDomain:'owner.cloudflareaccess.com',sharedOwnerEmail:'owner@example.com',databaseAudience:'a'.repeat(64)};
const dbSettings = variables => ({bindings:[...dbBase, ...variables],observability:obs});

test('Database preflight preserves each of the five old effective numeric limits', () => {
  for(const [oldName,[name,defaultValue]] of Object.entries(limits)) {
    const newExpected = Object.fromEntries(Object.values(limits));
    newExpected[name] = String(Number(defaultValue) + 1);
    const old = plain(oldName,defaultValue);
    assert.throws(()=>verifyBindings('database-mcp-worker',dbSettings([old]),[],
      {...dbOptions,expectedDatabaseLimits:newExpected}),/Database.*limit|original value/);
    assert.throws(()=>verifyBindings('database-mcp-worker',dbSettings([old,plain(name,newExpected[name])]),[],
      {...dbOptions,expectedDatabaseLimits:newExpected}),/Database.*limit|original value/);
    assert.equal(verifyBindings('database-mcp-worker',dbSettings([old]),[],
      {...dbOptions,expectedDatabaseLimits:Object.fromEntries(Object.values(limits))}),true);
  }
});

test('Database first-cutover guards absence/default and malformed legacy limits', () => {
  const expected = Object.fromEntries(Object.values(limits));
  assert.equal(verifyBindings('database-mcp-worker',dbSettings([]),[],
    {...dbOptions,expectedDatabaseLimits:expected}),true);
  assert.throws(()=>verifyBindings('database-mcp-worker',dbSettings([]),[],
    {...dbOptions,expectedDatabaseLimits:{...expected,DATABASE_MAX_ROWS:'300'}}),/Database.*limit|original value/);
  assert.throws(()=>verifyBindings('database-mcp-worker',dbSettings([plain('MAX_ROWS','invalid')]),[],
    {...dbOptions,expectedDatabaseLimits:expected}),/Database.*limit|original value/);
});

test('unaffected Worker retains historical extra Secret readback compatibility', () => {
  const names=['MCP_ACCESS_TOKEN','ACTIONS_GITHUB_DISPATCH_TOKENS','LEGACY_AUDITED_SECRET'];
  assert.equal(verifyBindings('github-actions-mcp-worker',
    {bindings:names.map(secret),observability:obs},names.map(name=>({name})),{mode:'readback'}),true);
});

test('cleanup-readback is a separate read-only CLI mode, not a release',()=>{
  const run=spawnSync(process.execPath,['scripts/manual-worker-release.mjs','cleanup-readback','ssh-mcp-worker'],
    {cwd:process.cwd(),env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000});
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/cleanup readback environment missing|Required cleanup readback environment missing/);
});

test('Database source defaults and environment overrides resolve before preflight', async () => {
  const {expectedDatabaseLimits} = await import('./manual-worker-release.mjs');
  const source={vars:Object.fromEntries(Object.values(limits))};
  assert.deepEqual(expectedDatabaseLimits(source,{}),Object.fromEntries(Object.values(limits)));
  assert.equal(expectedDatabaseLimits(source,{DATABASE_MAX_ROWS:'75'}).DATABASE_MAX_ROWS,'75');
  for (const invalid of ['0','-1','5001',' 75 ','bad'])
    assert.throws(()=>expectedDatabaseLimits(source,{DATABASE_MAX_ROWS:invalid}),/Invalid Database limit/);
});

test('only SSH/Workflow readback requires exact legacy Secret removal',()=>{
  const req=['MCP_ACCESS_TOKEN','SSH_ENCRYPTION_KEY'];
  const base=[...req.map(secret),
    {name:'EDGE_SSH_DB',type:'d1',id:'bd5cfdc5-3db0-4af7-8e95-cbf3d65cfa94'},
    {name:'SSH_OPERATIONS',type:'durable_object_namespace',class_name:'SshOperationsDO'}];
  const settings = bindings => ({bindings,observability:obs});
  const listed = names => names.map(name=>({name}));
  const old = secret('ENCRYPTION_KEY');
  assert.equal(verifyBindings('ssh-mcp-worker',settings([...base,old]),listed([...req,old.name]),
    {mode:'readback'}),true);
  assert.throws(()=>verifyBindings('ssh-mcp-worker',settings([...base,old]),listed([...req,old.name]),
    {mode:'readback',cleanupVerified:true}),/Legacy Secret cleanup not complete/);
  assert.equal(verifyBindings('ssh-mcp-worker',settings(base),listed(req),
    {mode:'readback',cleanupVerified:true}),true);
  assert.throws(()=>verifyBindings('ssh-mcp-worker',settings([...base,secret('UNKNOWN_SECRET')]),
    listed([...req,'UNKNOWN_SECRET']),{mode:'readback'}),/Unexpected runtime Secret/);
});

test('cleanup read-only CLI rejects unsupported Worker even with no Cloudflare credentials',()=>{
  const result=spawnSync(process.execPath,['scripts/manual-worker-release.mjs','cleanup-readback','ima-mcp-worker'],
    {cwd:process.cwd(),env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/only supports SSH or Workflow/);
});

test('protected read-only cleanup selection cannot execute a release or portal-write path', async () => {
  const {readFileSync}=await import('node:fs');
  const acceptance=readFileSync('.github/workflows/acceptance.yml','utf8');
  const section=acceptance.split('  legacy-secret-cleanup-readback:\n')[1]?.split('\n  checks:\n')[0];
  assert.ok(section,'cleanup job must have its own isolated steps');
  for (const type of ['legacy-cleanup-readonly-ssh','legacy-cleanup-readonly-workflow']) {
    assert.ok(acceptance.includes('          - '+type));
    assert.ok(section.includes(type));
  }
  assert.match(section,/github\.actor == 'lirtual'/);
  assert.match(section,/github\.ref == 'refs\/heads\/main'/);
  assert.match(section,/inputs\.confirm_portal_write == false/);
  assert.match(section,/EXPECTED_VERSION_ID: \$\{\{ inputs\.cleanup_expected_version \}\}/);
  assert.match(section,/node scripts\/manual-worker-release\.mjs cleanup-readback/);
  assert.match(section,/github\.sha|GITHUB_SHA/);
  assert.doesNotMatch(section, /wrangler deploy|delete-secret|secret delete|portal-register|deploy_to_production|POST|PUT|PATCH|DELETE/);
  const source=readFileSync('scripts/manual-worker-release.mjs','utf8');
  assert.match(source,/mode === "cleanup-readback"/);
  assert.match(source,/cleanupVerified: true/);
  assert.match(source,/observed.version_id === process.env.EXPECTED_VERSION_ID/);
});

test('Database postflight proves exact numeric bindings and missing old names',()=>{
  const values=Object.fromEntries(Object.values(limits));
  const secrets=['MCP_ACCESS_TOKEN','DATABASE_ENCRYPTION_KEY','DATABASE_KEY_ID','DATABASE_GITHUB_ACTIONS_TOKEN'];
  const sourceConfig={d1_databases:[{database_id:'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a'}],
    vars:{DATABASE_SETUP_HOST:'database.lirtual.dpdns.org'},hyperdrive:[]};
  const base=[...dbBase.filter(b=>b.name!=='ACCESS_AUD'),plain('DATABASE_ACCESS_AUD','a'.repeat(64)),
    plain('DATABASE_SETUP_HOST','database.lirtual.dpdns.org'),
    {name:'DB',type:'d1',id:sourceConfig.d1_databases[0].database_id},
    ...secrets.map(secret)];
  const settings=extra=>({bindings:[...base,...extra],observability:obs});
  const options={...dbOptions,mode:'readback',sourceConfig,expectedDatabaseLimits:values};
  const good=Object.entries(values).map(([name,value])=>plain(name,value));
  const listed=secrets.map(name=>({name}));
  assert.equal(verifyBindings('database-mcp-worker',settings(good),listed,options),true);
  assert.throws(()=>verifyBindings('database-mcp-worker',settings(good.filter(b=>b.name!=='DATABASE_MAX_ROWS')),listed,options),
    /Database limit readback/);
  assert.throws(()=>verifyBindings('database-mcp-worker',settings(good.map(b=>b.name==='DATABASE_MAX_ROWS'
    ?plain(b.name,'75'):b)),listed,options),/Database limit readback/);
  assert.throws(()=>verifyBindings('database-mcp-worker',settings([...good,plain('MAX_ROWS','123')]),listed,options),
    /old unprefixed/);
});

test('Workflow old binding present as wrong type rejects even if new binding matches',()=>{
  const entries=[secret('MCP_PORTAL_CLIENT_ID'),plain('WORKFLOW_MCP_PORTAL_CLIENT_ID','original'),
    plain('GITHUB_ACTION_APPROVED_REPOSITORIES',workflowOptions.expectedWorkflowGrants)];
  assert.throws(()=>verifyBindings('workflow-mcp-worker',workflowSettings(entries),[],workflowOptions),/binding type/);
});


test('Workflow Portal readonly acceptance keeps legacy Environment source until GitHub migration', async () => {
  const {readFileSync} = await import('node:fs');
  const file = readFileSync('.github/workflows/acceptance.yml','utf8');
  const job = file.split('  workflow-mcp-portal-probe:\n')[1]?.split('\n  workflow-github-action-result-cloud:')[0];
  assert.ok(job, 'existing read-only acceptance job is present');
  assert.match(job, /inputs\.test_type == 'portal-readonly'/);
  assert.match(job, /github\.ref == 'refs\/heads\/main'/);
  assert.ok(job.includes('WORKFLOW_MCP_PORTAL_CLIENT_ID: ${{ vars.WORKFLOW_MCP_PORTAL_CLIENT_ID || vars.MCP_PORTAL_CLIENT_ID }}'));
  assert.ok(job.includes('WORKFLOW_MCP_PORTAL_CLIENT_SECRET: ${{ secrets.WORKFLOW_MCP_PORTAL_CLIENT_SECRET || secrets.MCP_PORTAL_CLIENT_SECRET }}'));
  assert.match(job, /node --experimental-strip-types apps\/workflow-mcp-worker\/tests\/mcp-portal-acceptance\.mjs/);
  assert.doesNotMatch(job, /wrangler deploy|secret delete|portal-register|deploy_to_production|workflow_create|workflow_run/);
});


test('Workflow-only Portal probe reads exclusively workflow_list after authenticated MCP discovery', async () => {
  const {readFileSync}=await import('node:fs');
  const acceptance=readFileSync('.github/workflows/acceptance.yml','utf8');
  const job=acceptance.split('  workflow-mcp-portal-probe:\n')[1]?.split('\n  workflow-github-action-result-cloud:')[0];
  assert.ok(job);
  assert.match(job, /Workflow-only Portal MCP authentication, tools\/list, and workflow_list/);
  const source=readFileSync('apps/workflow-mcp-worker/tests/mcp-portal-acceptance.mjs','utf8');
  assert.match(source, /await client\.connect\(transport\)/);
  assert.match(source, /await client\.listTools\(\)/);
  assert.match(source, /\/\(\^\|\[\._-\]\)workflow_list\$\//);
  assert.match(source, /t\.annotations\?\.readOnlyHint===true/);
  assert.match(source, /t\.annotations\?\.destructiveHint!==true/);
  assert.equal(source.match(/client\.callTool\(/g)?.length,1,'only one Portal tool may be called');
  assert.match(source, /client\.callTool\(\{name:workflow\.name,arguments:\{\}\}\)/);
  assert.match(source, /if\(result\.isError\) throw new Error\('workflow_readonly_tool_error'\)/);
  assert.doesNotMatch(source,/list_notebooks|IMA_READONLY|APPROVABLE_IMA|toolSchemaDigest|workflow_run|workflow_publish/);
});
