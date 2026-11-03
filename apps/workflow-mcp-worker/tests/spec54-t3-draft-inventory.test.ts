import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import YAML from 'yaml';
import {isRetiredWeixinAction} from '../src/cloudflare-action-contract.ts';

type Outcome='weixin'|'other'|'indeterminate';
const record=(x:unknown):x is Record<string,unknown> =>
 !!x && typeof x==='object' && !Array.isArray(x);
// Treat unreviewed nested executable shapes as unknown; this is a test-only
// conservative screen, not a production source parser or a deletion rule.
function unreviewedNested(value:unknown,depth=0):boolean {
 if(depth>16)return true;
 if(Array.isArray(value))return value.some(x=>unreviewedNested(x,depth+1));
 if(!record(value))return false;
 if(['flow','steps','template','templates'].some(key=>Object.hasOwn(value,key)) ||
   value.uses==='action.run' ||
   (typeof value.uses==='string'&&value.uses.startsWith('flow.')))
  return true;
 return Object.values(value).some(x=>unreviewedNested(x,depth+1));
}
// Test-only interpretation of existing strict JSON/YAML parser and legacy identity predicate.
// Historical Drafts must NOT be recompiled: compilePlan intentionally retires Weixin Actions.
function classifyDraft(source:string):Outcome {
 let value:unknown;
 try {
  const doc=YAML.parseDocument(source,{uniqueKeys:true,strict:true});
  if(doc.errors.length)return 'indeterminate';
  value=doc.toJS({maxAliasCount:16});
 } catch{return 'indeterminate';}
 if(!record(value)||!Array.isArray(value.steps)||!value.steps.length)return 'indeterminate';
 let uncertain=false;
 for(const step of value.steps){
  if(!record(step)){uncertain=true;continue;}
  if(isRetiredWeixinAction(step))return 'weixin';
  if('flow' in step || typeof step.uses!=='string' ||
     step.uses.startsWith('flow.') ||
     (step.uses==='action.run' && (!record(step.with)||
      typeof step.with.executor!=='string' || typeof step.with.action!=='string')) ||
     Object.entries(step).some(([key,value])=>
      key!=='uses'&&unreviewedNested(value)))
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


test('YAML historical Drafts classify by structured Action identity, not text search',()=>{
 const legacy=[
  'version: 1','name: Old provider',
  'steps:','  - id: notify','    uses: action.run','    with:',
  '      executor: cloudflare','      provider: WEIXIN','      action: send_text',
 ].join('\n');
 const alias=[
  'version: 1','name: Old alias',
  'steps:','  - id: notify','    uses: action.run','    with:',
  '      executor: cloudflare','      provider: bark','      action: WeIxIn_legacy',
 ].join('\n');
 const other=[
  'version: 1','name: "weixin.send_text is documentation only"',
  'steps:','  - id: emit','    uses: result.emit',
  '    with:','      data: safe',
 ].join('\n');
 assert.equal(classifyDraft(legacy),'weixin');
 assert.equal(classifyDraft(alias),'weixin');
 assert.equal(classifyDraft(other),'other');
 assert.equal(classifyDraft(JSON.stringify({version:1,name:'Regular',steps:[
  {id:'emit',uses:'result.emit',with:{data:'weixin.send_text only as text'}}]})),
  'other');
});

test('historical Flow nesting and unknown executable shapes fail closed',()=>{
 const action={uses:'action.run',with:{executor:'cloudflare',
  provider:'weixin',action:'weixin.send_text'}};
 const unknowns=[
  {id:'repeat',flow:'repeat',times:1,template:action},
  {id:'foreach',flow:'foreach',items:{ref:'inputs.list'},max_items:1,
   template:{steps:[action]}},
  {id:'compiled',uses:'flow.foreach',with:{templates:[action]}},
  {id:'wrapper',uses:'result.emit',with:{data:{child:action}}},
  {id:'unknown',uses:'flow.custom',with:{}},
 ];
 for(const step of unknowns){
  const source={version:1,name:'Historical nested',steps:[step]};
  assert.equal(classifyDraft(JSON.stringify(source)),'indeterminate');
  assert.equal(classifyDraft(YAML.stringify(source)),'indeterminate');
 }
 const malformed=[
  'version: 1\nname: First\nname: Duplicate\nsteps: []\n',
  'version: 1\nsteps: [unclosed\n',
 ];
 for(const source of malformed)assert.equal(classifyDraft(source),'indeterminate');
 // A known retired top-level Action remains a positive even with other unknown Steps.
 assert.equal(classifyDraft(YAML.stringify({version:1,name:'Mixed',steps:
  [action,unknowns[0]]})),'weixin');
});

test('no executable Step array cannot count as a confirmed negative',()=>{
 for(const source of [
  JSON.stringify({version:1,name:'Empty',steps:[]}),
  YAML.stringify({version:1,name:'Missing'}),
  YAML.stringify({version:1,name:'Bad',steps:[null]}),
 ]) assert.equal(classifyDraft(source),'indeterminate');
});
