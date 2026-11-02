import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import YAML from 'yaml';
import {isRetiredWeixinAction} from '../src/cloudflare-action-contract.ts';

type Outcome='weixin'|'other'|'indeterminate';
const record=(x:unknown):x is Record<string,unknown> =>
 !!x && typeof x==='object' && !Array.isArray(x);
// Test-only interpretation of existing strict JSON/YAML parser and legacy identity predicate.
// Historical Drafts must NOT be recompiled: compilePlan intentionally retires Weixin Actions.
function classifyDraft(source:string):Outcome {
 let value:unknown;
 try {
  const doc=YAML.parseDocument(source,{uniqueKeys:true,strict:true});
  if(doc.errors.length)return 'indeterminate';
  value=doc.toJS({maxAliasCount:16});
 } catch{return 'indeterminate';}
 if(!record(value)||!Array.isArray(value.steps))return 'indeterminate';
 let uncertain=false;
 for(const step of value.steps){
  if(!record(step)){uncertain=true;continue;}
  if(isRetiredWeixinAction(step))return 'weixin';
  if('flow' in step || typeof step.uses!=='string' ||
     (step.uses==='action.run' && (!record(step.with)||
      typeof step.with.executor!=='string' || typeof step.with.action!=='string')))
    uncertain=true;
 }
 return uncertain?'indeterminate':'other';
}

const historicalWeixin=new Set([0,1,6,7,8,15,18]);
const withText=new Set([0,1,6,7,8]);
function definition(i:number):string {
 const isLegacy=historicalWeixin.has(i);
 if(!isLegacy)return JSON.stringify({version:1,name:'Regular example',steps:[
  {id:'emit',uses:'result.emit',with:{data:{status:'synthetic'}}}]});
 const provider=i===1||i===7?'bark':'weixin';
 const action=i===0||i===8||i===18?'send_text':
  i===1?'weixin.send_text':i===6?'weixin_legacy':
  i===7?'weixin.notify_download':'weixin-legacy';
 if(i===7)return `version: 1\nname: Legacy Draft\nsteps:\n  - id: notify\n    uses: action.run\n    with:\n      executor: cloudflare\n      provider: bark\n      action: weixin.notify_download\n      input:\n        text: synthetic test text\n`;
 return JSON.stringify({version:1,name:'Historical Draft',steps:[
  {id:'notify',uses:'action.run',with:{executor:'cloudflare',provider,action,
   input:withText.has(i)?{text:'synthetic test text'}:{}}}]});
}

test('historical 46 / 7 versus visible 14 never implies current seven',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const base=new URL('../migrations/',import.meta.url);
  for(const filename of ['0001_s1.sql','0014_workflow_deletion.sql'])
   db.exec(readFileSync(new URL(filename,base),'utf8'));
  const insert=db.prepare(`INSERT INTO workflows
   (id,name,draft,draft_revision,state,created_at,updated_at)
   VALUES(?,?,?,1,?,?,?)`);
  for(let i=0;i<46;i++)insert.run(`synthetic-${i}`,'Synthetic',definition(i),
   i<6?'active':'paused',1,1);
  const all=db.prepare('SELECT draft,state FROM workflows').all() as
   Array<{draft:string;state:string}>;
  assert.equal(all.length,46);
  assert.equal(all.filter(x=>x.state==='active').length,6);
  assert.equal(all.filter(x=>x.state==='paused').length,40);
  assert.equal(all.filter(x=>classifyDraft(x.draft)==='weixin').length,7);
  assert.equal(all.filter(x=>classifyDraft(x.draft)==='weixin'&&
   /synthetic test text/.test(x.draft)).length,5);
  db.exec('UPDATE workflows SET deleted_at=2,state=\'paused\' WHERE CAST(SUBSTR(id,11) AS INTEGER)>=14');
  const visible=db.prepare('SELECT draft,state FROM workflows WHERE deleted_at IS NULL')
   .all() as Array<{draft:string;state:string}>;
  assert.equal(visible.length,14);
  assert.equal(visible.filter(x=>x.state==='active').length,6);
  assert.equal(visible.filter(x=>x.state==='paused').length,8);
  assert.equal(visible.filter(x=>classifyDraft(x.draft)==='weixin').length,5);
  // This 32-row synthetic tombstone is a COUNTEREXAMPLE, not a production finding.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE deleted_at IS NOT NULL')
   .get() as {n:number}).n,32);
 } finally {db.close();}
});

test('identity comes from structural alias/provider, never incidental prose or YAML parser failure',()=>{
 assert.equal(classifyDraft('version: 1\nname: weixin.send_text notes\nsteps:\n  - id: emit\n    uses: result.emit\n    with: {data: ok}\n'),'other');
 assert.equal(classifyDraft('version: 1\nname: First\nname: Duplicate\nsteps: []\n'),'indeterminate');
 assert.equal(classifyDraft('version: 1\nname: Nested\nsteps:\n  - flow: {repeat: {times: 1, template: {uses: action.run}}}\n'),'indeterminate');
 for(const i of historicalWeixin)assert.equal(classifyDraft(definition(i)),'weixin');
 assert.equal(classifyDraft('unparseable: [yaml'),'indeterminate');
});
