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
])assert.ok(deploy.includes(required),'unsafe release gate: '+required);
for(const required of [
  "github.ref == 'refs/heads/main'",
  'inputs.s2_portal_probe == true',
  'inputs.deploy_to_production != true',
])assert.ok(portal.includes(required),'unsafe Portal probe gate: '+required);
console.log('WORKFLOW_RELEASE_GATE_CONTRACT_OK');
