import {dispatchGithubAttempt,selectedGithubExecutor,type DispatchOutcome} from './github-dispatch.ts';
import {recordGithubDispatchResult,registerGithubAttempt,type AttemptDatabase} from './github-claim.ts';

/** Eight 30-second wakes. The budget is fixed when the Attempt is created. */
export const GITHUB_ASYNC_WAKE_TIMEOUT='30 seconds';
export const GITHUB_ASYNC_WAKE_LIMIT=8;
export const GITHUB_ASYNC_WAKE_MS=30_000;
export const GITHUB_ASYNC_WAIT_MS=GITHUB_ASYNC_WAKE_LIMIT*GITHUB_ASYNC_WAKE_MS;

export type GithubAsyncPhase='dispatch_accepted'|'pending'|'external_terminal'|'indeterminate';
export type GithubAsyncAction={
  phase:GithubAsyncPhase;
  attempt_id:string;
  external_execution_id:string|null;
  receipt_outcome:'succeeded'|'failed'|null;
  deadline_at:number|null;
  timed_out:boolean;
};
export type GithubDispatchStep=
  | {disposition:'rejected';httpStatus:400|401|403|404|422;reason:string}
  | {disposition:'continued'};
type AsyncPhase=GithubAsyncPhase|'rejected';
export type GithubAsyncFact={
  stepId:string;
  phase:AsyncPhase;
  attemptId:string;
  externalExecutionId:string|null;
  receiptOutcome:'succeeded'|'failed'|null;
  deadlineAt:number|null;
  timedOut:boolean;
  errorCode:string|null;
  resultJson:string|null;
};
type AttemptFactRow={
  step_id:string;
  attempt_id:string;
  state:string;
  candidate_run_id:number|null;
  created_at:number;
  receipt_outcome:string|null;
  result_json:string|null;
};
type ExecutorEnv={
  WORKFLOW_EXECUTOR_GITHUB_TOKEN?:string;
  GITHUB_EXECUTOR_REPOSITORY?:string;
  GITHUB_EXECUTOR_REPOSITORY_ID?:string;
  GITHUB_EXECUTOR_REF?:string;
  GITHUB_EXECUTOR_AUDIENCE?:string;
  GITHUB_TEST_WORKER_NAME?:string;
  GITHUB_TEST_DEDICATED_EXECUTOR?:string;
};

const FACT_SQL=`SELECT a.step_id,a.attempt_id,a.state,a.candidate_run_id,a.created_at,
  c.outcome AS receipt_outcome,c.result_json
  FROM step_attempts a
  LEFT JOIN callback_receipts c ON c.attempt_id=a.attempt_id`;

function classify(row:AttemptFactRow,now:number,runOutcome:string,runError:string|null):GithubAsyncFact{
  const receipt:GithubAsyncFact['receiptOutcome']=
    row.receipt_outcome==='succeeded'||row.receipt_outcome==='failed'
      ?row.receipt_outcome:null;
  const external=row.candidate_run_id==null?null:String(row.candidate_run_id);
  const deadlineAt=row.created_at+GITHUB_ASYNC_WAIT_MS;
  const base={
    stepId:row.step_id,attemptId:row.attempt_id,externalExecutionId:external,
    receiptOutcome:receipt,deadlineAt,timedOut:false,errorCode:null as string|null,
    resultJson:row.result_json,
  };
  if(row.state==='rejected')
    return {...base,phase:'rejected',receiptOutcome:null,deadlineAt:null,
      errorCode:'github_dispatch_rejected_unknown_unknown'};
  if(row.state==='created'||row.state==='dispatch_unknown')
    return {...base,phase:'indeterminate',
      externalExecutionId:row.state==='dispatch_unknown'?external:null,
      receiptOutcome:null,deadlineAt:null,errorCode:'github_dispatch_unknown'};
  const open=row.state==='confirmed'||row.state==='claimed';
  const runTerminal=['succeeded','failed','indeterminate','cancelled'].includes(runOutcome);
  const past=now>=deadlineAt;
  const timedOut=runOutcome==='indeterminate'&&runError==='github_callback_unconfirmed'||past;
  if(receipt&&runOutcome!=='indeterminate'&&runOutcome!=='cancelled')
    return {...base,phase:'external_terminal'};
  if(open&&!receipt&&!runTerminal&&!past&&row.state==='claimed')
    return {...base,phase:'pending',receiptOutcome:null};
  if(open&&!receipt&&!runTerminal&&!past)
    return {...base,phase:'dispatch_accepted',receiptOutcome:null};
  if(open&&!receipt)
    return {...base,phase:'indeterminate',receiptOutcome:null,timedOut,
      errorCode:'github_callback_unconfirmed'};
  return {...base,phase:'indeterminate',receiptOutcome:null,timedOut,
    errorCode:runError??'github_callback_unconfirmed'};
}

function view(fact:GithubAsyncFact):GithubAsyncAction|null{
  if(fact.phase==='rejected')return null;
  return {
    phase:fact.phase,attempt_id:fact.attemptId,
    external_execution_id:fact.externalExecutionId,
    receipt_outcome:fact.phase==='external_terminal'?fact.receiptOutcome:null,
    deadline_at:fact.deadlineAt,timed_out:fact.timedOut,
  };
}

async function facts(db:AttemptDatabase,runId:string,stepId:string|undefined,now:number,runOutcome:string,runError:string|null){
  const sql=stepId?FACT_SQL+' WHERE a.run_id=? AND a.step_id=?':FACT_SQL+' WHERE a.run_id=?';
  const bound=db.prepare(sql).bind(...(stepId?[runId,stepId]:[runId]));
  const rows=await bound.all<AttemptFactRow>();
  return rows.results.map(row=>classify(row,now,runOutcome,runError));
}

/** Read the durable Attempt and receipt. No network and no second dispatch. */
export async function readGithubAsyncFact(
  db:AttemptDatabase,runId:string,stepId:string,now:number,
  runOutcome='running',runError:string|null=null,
):Promise<GithubAsyncFact|null>{
  const [fact]=await facts(db,runId,stepId,now,runOutcome,runError);
  return fact??null;
}

export async function githubAsyncViewsForRun(
  db:AttemptDatabase,runId:string,runOutcome:string,runError:string|null,now:number,
):Promise<Map<string,GithubAsyncAction>>{
  const map=new Map<string,GithubAsyncAction>();
  for(const fact of await facts(db,runId,undefined,now,runOutcome,runError)){
    const action=view(fact);
    if(action)map.set(fact.stepId,action);
  }
  return map;
}

/**
 * True only while a confirmed or claimed Attempt is still inside its deadline
 * and has no receipt. Caller must leave the Run running so replay can resume.
 */
export async function githubAsyncAwaitingExternal(db:AttemptDatabase,runId:string,now:number):Promise<boolean>{
  const open=await facts(db,runId,undefined,now,'running',null);
  return open.some(fact=>fact.phase==='dispatch_accepted'||fact.phase==='pending');
}

/**
 * One dispatch for a new Attempt. An existing row is never dispatched again,
 * including created, unknown, confirmed, claimed, rejected, and timed out.
 */
export async function dispatchOrResumeGithubAttempt(
  db:AttemptDatabase,env:ExecutorEnv,runId:string,stepId:string,
):Promise<GithubDispatchStep>{
  const existing=await db.prepare(
    'SELECT attempt_id,state FROM step_attempts WHERE run_id=? AND step_id=?'
  ).bind(runId,stepId).first<{attempt_id:string;state:string}>();
  if(existing){
    if(existing.state==='created')
      await recordGithubDispatchResult(db,existing.attempt_id,{status:'dispatch_unknown'});
    return {disposition:'continued'};
  }
  const attemptId=crypto.randomUUID(),dispatchId=crypto.randomUUID();
  try{
    const executor=selectedGithubExecutor(env);
    await registerGithubAttempt(db,{
      attemptId,dispatchId,runId,stepId,capabilityId:'github.workflow.check',
      repository:env.GITHUB_EXECUTOR_REPOSITORY!,
      repositoryId:env.GITHUB_EXECUTOR_REPOSITORY_ID!,
      ref:env.GITHUB_EXECUTOR_REF!,
      workflowRef:env.GITHUB_EXECUTOR_REPOSITORY+
        '/.github/workflows/'+executor.workflow+'@'+env.GITHUB_EXECUTOR_REF,
      audience:env.GITHUB_EXECUTOR_AUDIENCE!,
    });
    const result:DispatchOutcome=await dispatchGithubAttempt({
      repository:env.GITHUB_EXECUTOR_REPOSITORY!,
      ref:env.GITHUB_EXECUTOR_REF!,
      workflow:executor.workflow,
      ...(executor.workerName?{workerName:executor.workerName}:{}),
      dispatchToken:env.WORKFLOW_EXECUTOR_GITHUB_TOKEN!,
    },{attemptId,dispatchId,capabilityId:'github.workflow.check'});
    const persisted=await recordGithubDispatchResult(db,attemptId,result);
    if(!persisted)throw Error('dispatch_ack_not_persisted');
    if(result.status==='rejected')
      return {disposition:'rejected',httpStatus:result.httpStatus,reason:result.reason};
    return {disposition:'continued'};
  }catch(error){
    const row=await db.prepare(
      'SELECT attempt_id,state FROM step_attempts WHERE run_id=? AND step_id=?'
    ).bind(runId,stepId).first<{attempt_id:string;state:string}>();
    if(!row)throw error;
    if(row.state==='created')
      await recordGithubDispatchResult(db,row.attempt_id,{status:'dispatch_unknown'}).catch(()=>{});
    return {disposition:'continued'};
  }
}

export function githubAsyncOutcome(fact:GithubAsyncFact):{status:'succeeded'|'failed'|'indeterminate';output?:unknown;error_code?:string}|null{
  if(fact.phase==='dispatch_accepted'||fact.phase==='pending')return null;
  if(fact.phase==='rejected')
    return {status:'failed',error_code:fact.errorCode??'github_dispatch_rejected_unknown_unknown'};
  if(fact.phase==='external_terminal'&&fact.receiptOutcome==='failed')
    return {status:'failed',error_code:'github_job_failed'};
  if(fact.phase==='external_terminal')
    return {status:'succeeded'};
  return {status:'indeterminate',error_code:fact.errorCode??'github_dispatch_unknown'};
}
