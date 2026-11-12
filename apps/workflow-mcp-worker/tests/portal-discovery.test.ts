import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedPortalTools} from '../src/portal-discovery.ts';

test('only source-reviewed Portal tools with bounded actual schemas are returned',async()=>{
  const valid={name:'ima_list_notebooks',inputSchema:{type:'object',
    properties:{limit:{type:'number'},cursor:{type:'string'}}},
    annotations:{readOnlyHint:true,destructiveHint:false}};
  const result=await reviewedPortalTools([
    valid,
    {...valid,name:'arbitrary_but_readonly'},
    {...valid,name:'ima_create_note'},
  ]);
  for(const unsafe of [
    {...valid,annotations:{readOnlyHint:false}},
    {...valid,inputSchema:{type:'object',properties:{command:{type:'string'}}}},
    {...valid,inputSchema:{type:'object',properties:{limit:{type:'string'}}}},
  ]) assert.deepEqual(await reviewedPortalTools([unsafe]),[]);
  assert.equal(result.length,1);
  assert.deepEqual(await reviewedPortalTools([valid,valid]),[]);
  assert.equal(result[0].tool,'ima_list_notebooks');
  assert.match(result[0].schema_digest,/^[0-9a-f]{64}$/);
  assert.equal(result[0].availability,'discovered_not_executed');
});
