import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Executed by CI before pnpm install. Keep the owner release gates static and
// independent of GitHub-hosted runtime credentials.
const source=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
const dollar=String.fromCharCode(36);
function job(name){
  const start=source.indexOf('\n  '+name+':\n');
  assert.ok(start>=0,'Missing CI job '+name);
  const rest=source.slice(start+name.length+6);
  const next=/\n  [a-z][a-z0-9-]*:\n/.exec(rest);
  const content=source.slice(start,next?start+name.length+6+next.index:undefined);
  const gate=content.match(/\n    if: >-\n([\s\S]*?)\n    runs-on:/)?.[1];
  assert.ok(gate,'Missing CI gate '+name);
  return {content,gate};
}
const release=job('deploy').gate;
for(const clause of [
  "github.event_name == 'workflow_dispatch'",
  "github.ref == 'refs/heads/main'",
  'inputs.deploy_to_production == true',
  'inputs.smoke_only != true',
  'inputs.workflow_portal_register != true',
  'inputs.mcp_cron_e2e != true',
  "needs.checks.result == 'success'",
])assert.ok(release.includes(clause),'Unsafe production gate: '+clause);
assert.match(source,/      deploy_to_production:\n[\s\S]*?        default: false/);
assert.doesNotMatch(source,/enable_workflow_mcp|enable_workflow_github|confirm_workflow_capability_disable|WORKFLOW_MCP_RELEASE|WORKFLOW_GITHUB_RELEASE|WORKFLOW_ALLOW_CAPABILITY_DISABLE/);

const portal=job('workflow-portal-register').gate;
for(const clause of [
  "github.event_name == 'workflow_dispatch'",
  "github.ref == 'refs/heads/main'",
  "inputs.worker == 'workflow-mcp-worker'",
  'inputs.workflow_portal_register == true',
  'inputs.deploy_to_production != true',
  'inputs.smoke_only != true',
  'inputs.mcp_cron_e2e != true',
  "needs.checks.result == 'success'",
])assert.ok(portal.includes(clause),'Unsafe Portal registration: '+clause);
assert.ok(source.includes('run: node scripts/register-workflow-portal.mjs'));
assert.ok(source.includes('run: node --test scripts/register-workflow-portal.test.mjs'));
assert.ok(source.includes('group: worker-release-workflow-mcp-worker'));

const smoke=job('workflow-production-smoke').gate;
for(const clause of [
  'inputs.smoke_only == true',
  'inputs.deploy_to_production != true',
  'inputs.mcp_cron_e2e != true',
  '(inputs.mcp_production_smoke != true || inputs.github_production_smoke != true)',
])assert.ok(smoke.includes(clause),'Unsafe smoke gate: '+clause);
assert.ok(source.includes('WORKFLOW_GITHUB_SMOKE: '+dollar+'{{ inputs.github_production_smoke }}'));

const probe=job('workflow-mcp-portal-probe').gate;
for(const clause of [
  "github.ref == 'refs/heads/main'",
  'inputs.mcp_portal_probe == true',
  'inputs.deploy_to_production != true',
  'inputs.mcp_cron_e2e != true',
])assert.ok(probe.includes(clause),'Unsafe Portal probe gate: '+clause);

assert.match(source,/      mcp_cron_e2e:\n[\s\S]*?        type: boolean\n        default: false/);
const cron=job('workflow-mcp-isolated-cron-e2e');
for(const clause of [
  "github.event_name == 'workflow_dispatch'",
  "github.ref == 'refs/heads/wip/workflow-mcp-public-readonly'",
  "inputs.worker == 'workflow-mcp-worker'",
  'inputs.mcp_cron_e2e == true',
  'inputs.mcp_portal_probe != true',
  'inputs.mcp_cloud_e2e != true',
  'inputs.smoke_only != true',
  'inputs.mcp_production_smoke != true',
  'inputs.github_production_smoke != true',
  'inputs.deploy_to_production != true',
  'inputs.workflow_portal_register != true',
])assert.ok(cron.gate.includes(clause),'Unsafe isolated Cron E2E gate: '+clause);
assert.ok(cron.content.includes('timeout-minutes: 26'),'Cron E2E needs propagation time and cleanup reserve');
assert.ok(cron.content.includes("MCP_CRON_E2E: 'true'"));
assert.ok(cron.content.includes('mcp-portal-cloud-e2e.mjs'));
assert.ok(cron.content.includes('CLOUDFLARE_API_TOKEN: '+dollar+'{{ secrets.CLOUDFLARE_API_TOKEN }}'));
assert.ok(!cron.content.includes('MCP_PORTAL_CLIENT_SECRET:'));
assert.ok(!cron.content.includes('WORKFLOW_EXECUTOR_GITHUB_TOKEN:'));
assert.ok(!cron.content.includes('production-smoke.mjs'));
const checks=job('checks').content;
assert.ok(checks.includes('inputs.mcp_cron_e2e == true'),'Cron cloud dispatch must skip generic application checks');
assert.ok(source.includes("inputs.mcp_cloud_e2e == true &&\n          inputs.mcp_portal_probe != true &&\n          inputs.mcp_cron_e2e != true"),
  'Cron E2E must not share the existing IMA cloud acceptance job');

for(const key of ['MCP_PORTAL_CLIENT_ID','MCP_PORTAL_CLIENT_SECRET','WORKFLOW_EXECUTOR_GITHUB_TOKEN']){
  assert.ok(source.includes(key+': '+dollar+'{{ secrets.'+key+' }}'),
    'Missing selected Environment Secret '+key);
}
assert.ok(source.includes('run: node scripts/verify-github-release-token.mjs'),
  'GitHub token must be probed without dispatch before release');
assert.ok(source.includes('node scripts/manual-worker-release.mjs preflight'),
  'Cloudflare preflight required before deployment');
assert.ok(source.includes('WORKFLOW_REQUIRE_COMPLETE_SCHEMA: '+"'true'"),
  'Complete schema must be verified after migration');
console.log('WORKFLOW_RELEASE_GATE_CONTRACT_OK');
