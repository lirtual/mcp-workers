import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// No dependencies: run before pnpm install for every selected CI check.
const config=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
function jobExpression(name){
  const start=config.indexOf('\n  '+name+':\n');
  assert.ok(start>=0,'missing job '+name);
  const remaining=config.slice(start+name.length+6);
  const match=/\n  [a-z][a-z0-9-]*:\n/.exec(remaining);
  const section=config.slice(start,match?start+name.length+6+match.index:undefined);
  const expr=section.match(/\n    if: >-\n([\s\S]*?)\n    runs-on:/)?.[1];
  assert.ok(expr,'missing gate for '+name);
  return expr;
}
const deploy=jobExpression('deploy');
const portal=jobExpression('workflow-s2-portal-probe');
assert.match(config,/      deploy_to_production:\n[\s\S]*?        default: false/);
for(const required of [
  "github.ref == 'refs/heads/main'",
  'inputs.deploy_to_production == true',
  'inputs.s2_portal_probe != true',
  'inputs.s2_cloud_e2e != true',
  'inputs.s3_product_e2e != true',
  'inputs.s3_oidc_probe != true',
  "(inputs.enable_workflow_s2 != true || inputs.worker == 'workflow-mcp-worker')",
])assert.ok(deploy.includes(required),'unsafe release gate: '+required);
assert.match(config,/      enable_workflow_s2:\n[\s\S]*?        default: false/);
assert.ok(config.includes('WORKFLOW_S2_RELEASE: ${{ inputs.enable_workflow_s2 }}'),
  'S2 deployment mode must reach preflight and readback');

for(const required of [
  "github.ref == 'refs/heads/main'",
  'inputs.s2_portal_probe == true',
  'inputs.deploy_to_production != true',
])assert.ok(portal.includes(required),'unsafe Portal probe gate: '+required);
// S2 release must not be enabled by merely selecting a Worker or by a
// read-only Portal probe. Its second explicit opt-in is false by default.
assert.ok(config.includes("inputs.enable_workflow_s2 != true || inputs.worker == 'workflow-mcp-worker'"),
  'S2 enablement must be scoped to Workflow MCP only');
assert.ok(config.includes('S2_PORTAL_CLIENT_ID: ${{ secrets.S2_PORTAL_CLIENT_ID }}') &&
  config.includes('S2_PORTAL_CLIENT_SECRET: ${{ secrets.S2_PORTAL_CLIENT_SECRET }}'),
  'S2 service identity must be read from the selected GitHub Environment');

console.log('WORKFLOW_RELEASE_GATE_CONTRACT_OK');
