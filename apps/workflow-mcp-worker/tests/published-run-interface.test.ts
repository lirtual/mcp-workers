import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedRunInterface} from '../src/published-run-interface.ts';
import type {Plan} from '../src/plan.ts';

const VERSION='22222222-2222-4222-8222-222222222222';
const describe=(plan:unknown):Record<string,any>=>publishedRunInterface(plan as Plan,VERSION);

test('generic Published input values are never interpreted as type/default or echoed',()=>{
 const viewed=describe({inputs:{token:'PROD_SECRET_SHOULD_NOT_ESCAPE',limit:42},
   steps:[{uses:'result.emit',with:{data:'secret output'}}]});
 assert.equal(viewed.kind,'generic');
 assert.equal(viewed.published_version_id,VERSION);
 assert.deepEqual(viewed.inputs.token,{type:'not_declared',required:'not_declared',
   default:'not_declared'});
 assert.equal(JSON.stringify(viewed).includes('PROD_SECRET_SHOULD_NOT_ESCAPE'),false);
 assert.equal(JSON.stringify(viewed).includes('secret output'),false);
});
test('EnvShare manual Published adapter describes exact defaults and secret handling',()=>{
 const viewed=describe({inputs:{},cloudflare_execution_approved:true,triggers:[],
   steps:[{uses:'action.run',needs:[],with:{provider:'envshare',action:'envshare.share_text'}}]});
 assert.equal(viewed.kind,'envshare_manual');
 assert.deepEqual(viewed.inputs.text,{type:'string',required:true,
   min_utf8_bytes:1,max_utf8_bytes:16384});
 assert.equal(viewed.inputs.ttl_seconds.default,86400);
 assert.equal(viewed.inputs.ttl_seconds.minimum,60);
 assert.equal(viewed.inputs.ttl_seconds.maximum,604800);
 assert.equal(viewed.inputs.max_reads.default,1);
 assert.equal(viewed.inputs.max_reads.minimum,1);
 assert.equal(viewed.inputs.max_reads.maximum,10);
 assert.equal(viewed.idempotency_key,'required');
 assert.equal(viewed.result.recovery,'not_recoverable_from_D1');
});
test('Litterbox declares file only when the frozen single manual file gate is valid',()=>{
 const raw={inputs:{},triggers:[],cloudflare_execution_approved:true,
  steps:[{uses:'action.run',needs:[],with:{executor:'cloudflare',
   provider:'litterbox',action:'litterbox.upload_file',
   input:Object.fromEntries(['file_name','size_bytes','sha256','time']
     .map(name=>[name,{ref:'inputs.'+name}]))}}]};
 const viewed=describe(raw);
 assert.equal(viewed.kind,'litterbox_manual_file');
 assert.deepEqual(viewed.inputs.time.enum,['1h','12h','24h','72h']);
 assert.equal(viewed.inputs.time.default,'24h');
 assert.equal(viewed.top_level_file.required,true);
 assert.equal(viewed.idempotency_key,'required');
 assert.equal(viewed.unknown_result,'never_retry');
 assert.equal(describe({...raw,triggers:[{type:'cron'}]}).kind,'generic');
});
test('Session override only when every Published Session opts into explicit 1-300 range',()=>{
 const make=(duration:unknown,mode='explicit')=>({
   inputs:{duration_minutes:300,other:'DO_NOT_DISCLOSE'},
   steps:[{uses:'github.run',with:{action:{type:'session',inputs:{
     duration_minutes:duration,duration_mode:mode}}}}]});
 const dynamic=describe(make({ref:'inputs.duration_minutes'}));
 assert.deepEqual(dynamic.inputs.duration_minutes,{type:'integer',required:false,
   default:300,minimum:1,maximum:300});
 const literal=describe(make(300));
 assert.equal(literal.inputs.duration_minutes.type,'not_declared');
 assert.equal(describe(make({ref:'inputs.duration_minutes'},'auto'))
   .inputs.duration_minutes.type,'not_declared');
});
