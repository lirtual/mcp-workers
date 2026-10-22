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
  'inputs.s3_production_smoke != true',
  'inputs.s2_cloud_e2e != true',
  'inputs.s3_product_e2e != true',
  'inputs.s3_oidc_probe != true',
  "(inputs.enable_workflow_s2 != true || inputs.worker == 'workflow-mcp-worker')",
  "(inputs.enable_workflow_s3 != true ||",
  "(inputs.worker == 'workflow-mcp-worker' && inputs.enable_workflow_s2 == true)",

])assert.ok(deploy.includes(required),'unsafe release gate: '+required);
assert.match(config,/      enable_workflow_s2:\n[\s\S]*?        default: false/);
assert.match(config,/      enable_workflow_s3:\n[\s\S]*?        default: false/);
assert.match(config,/      s3_production_smoke:\n[\s\S]*?        default: false/);
const smoke = jobExpression('workflow-s1-smoke');
for(const required of [
  'inputs.smoke_only == true',
  'inputs.deploy_to_production != true',
  'inputs.enable_workflow_s3 != true',
  '(inputs.s2_production_smoke != true || inputs.s3_production_smoke != true)',
]) assert.ok(smoke.includes(required),'S3 production smoke cannot release: '+required);
assert.ok(config.includes('WORKFLOW_S3_SMOKE: '+String.fromCharCode(36)+'{{ inputs.s3_production_smoke }}'),
  'S3 smoke selection must be wired only into the smoke Job');

assert.ok(config.includes('WORKFLOW_S3_RELEASE: ${{ inputs.enable_workflow_s3 }}'),
  'S3 mode must reach staging and readback');
assert.ok(config.includes('node scripts/verify-s3-release-token.mjs'),
  'S3 registered credential must pass no-job permission probe before deployment');
assert.ok(config.includes('S3_GITHUB_TOKEN: ${{ secrets.S3_GITHUB_TOKEN }}'),
  'S3 credential must be provided by selected environment');
assert.ok(config.includes("S3_CALLBACK_ORIGIN: ${{ vars.S3_CALLBACK_ORIGIN }}") &&
  config.includes("S3_GITHUB_AUDIENCE: ${{ vars.S3_GITHUB_AUDIENCE }}"),
  'Registered executor callback variables must be verified');

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
