import { compilePlan, PlanError } from './plan.ts';
import type { Plan } from './plan.ts';

export type Env = {
  DB: D1Database;
  MCP_ACCESS_TOKEN: string;
  WORKFLOW: {
    create(options:{id:string;params:{run_id:string}}):Promise<unknown>;
    get(id:string):Promise<{status():Promise<{status:string}>}>;
  };
  READONLY_TARGET: Fetcher;
};
export class StateError extends Error {
  code:string;
  constructor(code: string) { super(code); this.code=code; this.name='StateError'; }
}
const now=()=>Date.now();
const MAX_RESULT=64*1024;
const safeId=(v:string)=>/^[a-zA-Z0-9_-]{1,128}$/.test(v);
function assertId(v:string){if(!safeId(v))throw new StateError('invalid_id');}
function json(value:unknown):string {
  const string=JSON.stringify(value);
  if(!string||new TextEncoder().encode(string).byteLength>64*1024)throw new StateError('payload_too_large');
  return string;
}
async function digest(s:string):Promise<string>{
  const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  return [...new Uint8Array(result)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function cleanError(e:unknown):string {return e instanceof StateError||e instanceof PlanError?e instanceof StateError?e.code:e.code:'internal_error';}
export function limitResult<T>(value:T):T {if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_RESULT)throw new StateError('result_too_large');return value;}
export function applyStatus(native:string, outcome:string):string {
  if(['succeeded','failed','indeterminate','cancelled'].includes(outcome))return outcome;
  if(native==='errored')return 'failed';
  if(native==='complete')return 'indeterminate';
  return outcome;
}
type WorkflowRow={id:string;name:string;draft:string;draft_revision:number;active_version_id:string|null;state:string};
type VersionRow={id:string;plan:string;digest:string};
type RunRow={id:string;workflow_id:string;version_id:string;instance_id:string;request_digest:string;start_state:string;outcome:string;result:string|null;error_code:string|null;inputs:string;created_at:number};
const workflowView=(row:WorkflowRow)=>({workflow_id:row.id,name:row.name,draft_revision:row.draft_revision,definition:JSON.parse(row.draft),published_version_id:row.active_version_id,state:row.state});
export class WorkflowService {
  private env:Env;
  constructor(env:Env){this.env=env;}
  private get db(){return this.env.DB;}
  async list(){const out=await this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC LIMIT 100').all<WorkflowRow>();
    return {workflows:out.results.map(r=>({workflow_id:r.id,name:r.name,draft_revision:r.draft_revision,published_version_id:r.active_version_id,state:r.state}))};}
  async get(workflow_id:string){assertId(workflow_id);const row=await this.row(workflow_id);return workflowView(row);}
  private async row(id:string){const row=await this.db.prepare('SELECT * FROM workflows WHERE id=?').bind(id).first<WorkflowRow>();if(!row)throw new StateError('workflow_not_found');return row;}
  async create(definition:string){
    const {plan}=await compilePlan(definition);
    const id=crypto.randomUUID(),time=now();
    await this.db.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,\'draft\',?,?)').bind(id,plan.name,definition,time,time).run();
    return {workflow_id:id,draft_revision:1,state:'draft'};
  }
  async update(workflow_id:string,expected_revision:number,definition:string){
    assertId(workflow_id);if(!Number.isSafeInteger(expected_revision)||expected_revision<1)throw new StateError('invalid_revision');
    const {plan}=await compilePlan(definition);
    const x=await this.db.prepare('UPDATE workflows SET draft=?,name=?,draft_revision=draft_revision+1,updated_at=? WHERE id=? AND draft_revision=?').bind(definition,plan.name,now(),workflow_id,expected_revision).run();
    if(!x.meta.changes) {await this.row(workflow_id);throw new StateError('revision_conflict');}
    return {workflow_id,draft_revision:expected_revision+1};
  }
  async validate(workflow_id:string,revision:number){
    assertId(workflow_id);const row=await this.row(workflow_id);
    if(row.draft_revision!==revision)throw new StateError('revision_conflict');
    const {digest,plan}=await compilePlan(row.draft);
    return {valid:true,digest,steps:plan.steps.length};
  }
  async publish(workflow_id:string,expected_revision:number){
    assertId(workflow_id);const row=await this.row(workflow_id);
    if(row.draft_revision!==expected_revision)throw new StateError('revision_conflict');
    const {plan,digest:plan_digest}=await compilePlan(row.draft);
    const version=crypto.randomUUID(),t=now();
    const batch=await this.db.batch([
      this.db.prepare('UPDATE workflows SET active_version_id=?,state=\'active\',updated_at=? WHERE id=? AND draft_revision=?').bind(version,t,workflow_id,expected_revision),
      this.db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) SELECT ?,id,?,?,? FROM workflows WHERE id=? AND active_version_id=?').bind(version,plan_digest,json(plan),t,workflow_id,version),
    ]);
    if(!batch[0].meta.changes||!batch[1].meta.changes)throw new StateError('revision_conflict');
    return {workflow_id,published_version_id:version,digest:plan_digest,state:'active'};
  }
  async pause(workflow_id:string){assertId(workflow_id);const x=await this.db.prepare("UPDATE workflows SET state='paused',updated_at=? WHERE id=? AND state='active'").bind(now(),workflow_id).run();if(!x.meta.changes)throw new StateError('not_active');return {workflow_id,state:'paused'};}
  async resume(workflow_id:string){assertId(workflow_id);const x=await this.db.prepare("UPDATE workflows SET state='active',updated_at=? WHERE id=? AND state='paused' AND active_version_id IS NOT NULL").bind(now(),workflow_id).run();if(!x.meta.changes)throw new StateError('not_paused');return {workflow_id,state:'active'};}
  async start(workflow_id:string,inputs:Record<string,unknown>={},idempotency_key?:string){
    assertId(workflow_id);if(idempotency_key!==undefined&&(idempotency_key.length>128||!safeId(idempotency_key)))throw new StateError('invalid_idempotency_key');
    const inputJson=json(inputs);
    const request_digest=await digest(inputJson);
    // An accepted admission keeps its pinned version across republish/pause.
    if(idempotency_key){
      const original=await this.db.prepare('SELECT * FROM runs WHERE workflow_id=? AND admission_key=?').bind(workflow_id,idempotency_key).first<RunRow>();
      if(original){if(original.request_digest!==request_digest)throw new StateError('idempotency_conflict');return this.reconcileStart(original);}
    }
    const wf=await this.row(workflow_id);
    if(wf.state!=='active'||!wf.active_version_id)throw new StateError('workflow_not_active');
    const version=wf.active_version_id;
    const id=crypto.randomUUID(),t=now();
    const insert=await this.db.prepare(
      "INSERT OR IGNORE INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) SELECT ?,?,?,?,?,?,?, 'reserved','queued',?,? WHERE EXISTS (SELECT 1 FROM workflows WHERE id=? AND state='active' AND active_version_id=?) AND (SELECT COUNT(*) FROM runs WHERE outcome IN ('queued','running')) < 8"
    ).bind(id,workflow_id,version,id,idempotency_key??null,request_digest,inputJson,t,t,workflow_id,version).run();
    if(!insert.meta.changes){
      if(idempotency_key){const prior=await this.db.prepare('SELECT * FROM runs WHERE workflow_id=? AND admission_key=?').bind(workflow_id,idempotency_key).first<RunRow>();
        if(prior){if(prior.request_digest!==request_digest)throw new StateError('idempotency_conflict');return this.reconcileStart(prior);}}
      const latest=await this.row(workflow_id);
      if(latest.state!=='active')throw new StateError('workflow_not_active');
      if(latest.active_version_id!==version)throw new StateError('published_version_changed');
      throw new StateError('run_capacity_exceeded');
    }
    try{await this.env.WORKFLOW.create({id,params:{run_id:id}});await this.db.prepare("UPDATE runs SET start_state='started',updated_at=? WHERE id=? AND start_state IN ('reserved','start_unknown')").bind(now(),id).run();return {run_id:id,published_version_id:version,status:'queued',start_state:'started'};}
    catch {
      await this.db.prepare("UPDATE runs SET start_state='start_unknown',updated_at=? WHERE id=? AND start_state='reserved'").bind(now(),id).run();
      const prior=await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>();return this.reconcileStart(prior!);
    }
  }
  private async reconcileStart(row:RunRow){
    if(row.start_state==='started')return {run_id:row.id,published_version_id:row.version_id,status:row.outcome,start_state:'started',idempotent_replay:true};
    try{const instance=await this.env.WORKFLOW.get(row.instance_id);await instance.status();
      await this.db.prepare("UPDATE runs SET start_state='started' WHERE id=? AND start_state IN ('reserved','start_unknown')").bind(row.id).run();
      return {run_id:row.id,published_version_id:row.version_id,status:row.outcome,start_state:'started',idempotent_replay:true};
    }catch{return {run_id:row.id,published_version_id:row.version_id,status:'start_unknown',start_state:'start_unknown',idempotent_replay:true};}
  }
  async status(run_id:string){
    assertId(run_id);let row=await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(run_id).first<RunRow>();
    if(!row)throw new StateError('run_not_found');
    if(row.start_state==='reserved'||row.start_state==='start_unknown'){
      await this.reconcileStart(row);
      row=(await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(run_id).first<RunRow>())!;
    }
    let native='unknown';if(row.start_state==='started')try{native=(await (await this.env.WORKFLOW.get(row.instance_id)).status()).status;}catch{}
    const steps=(await this.db.prepare('SELECT step_id,status,error_code FROM run_steps WHERE run_id=? ORDER BY step_id').bind(run_id).all<{step_id:string;status:string;error_code:string|null}>()).results;
    return {run_id,workflow_id:row.workflow_id,published_version_id:row.version_id,start_state:row.start_state,status:row.start_state==='start_unknown'?'start_unknown':applyStatus(native,row.outcome),steps};
  }
  async result(run_id:string){
    const meta=await this.status(run_id);
    const row=await this.db.prepare('SELECT result,error_code FROM runs WHERE id=?').bind(run_id).first<{result:string|null;error_code:string|null}>();
    return limitResult({...meta,result:row?.result?JSON.parse(row.result):null,error_code:row?.error_code??null});
  }
}
