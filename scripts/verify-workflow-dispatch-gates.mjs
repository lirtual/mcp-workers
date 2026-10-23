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
  "needs.checks.result == 'success'",
])assert.ok(portal.includes(clause),'Unsafe Portal registration: '+clause);
assert.ok(source.includes('run: node scripts/register-workflow-portal.mjs'));
assert.ok(source.includes('run: node --test scripts/register-workflow-portal.test.mjs'));
assert.ok(source.includes('group: worker-release-workflow-mcp-worker'));

const smoke=job('workflow-production-smoke').gate;
for(const clause of [
  'inputs.smoke_only == true',
  'inputs.deploy_to_production != true',
  '(inputs.mcp_production_smoke != true || inputs.github_production_smoke != true)',
])assert.ok(smoke.includes(clause),'Unsafe smoke gate: '+clause);
assert.ok(source.includes('WORKFLOW_GITHUB_SMOKE: '+dollar+'{{ inputs.github_production_smoke }}'));

const probe=job('workflow-mcp-portal-probe').gate;
for(const clause of [
  "github.ref == 'refs/heads/main'",
  'inputs.mcp_portal_probe == true',
  'inputs.deploy_to_production != true',
])assert.ok(probe.includes(clause),'Unsafe Portal probe gate: '+clause);

assert.ok(source.includes('MCP_PORTAL_CLIENT_ID: '+dollar+'{{ vars.MCP_PORTAL_CLIENT_ID }}'),
  'Missing selected Environment Variable MCP_PORTAL_CLIENT_ID');
assert.ok(!source.includes('MCP_PORTAL_CLIENT_ID: '+dollar+'{{ secrets.MCP_PORTAL_CLIENT_ID }}'),
  'Workflow Portal Client ID must not be staged as a Secret');
for(const key of ['MCP_PORTAL_CLIENT_SECRET','WORKFLOW_GITHUB_DISPATCH_TOKEN']){
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
