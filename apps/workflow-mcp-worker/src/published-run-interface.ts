import type {Plan} from './plan.ts';
import {isEnvsharePlan} from './envshare-transient.ts';
import {isLitterboxPlan} from './litterbox-executor.ts';
import {isSessionDurationInputRef} from './github-action-inputs.ts';

type UnknownField={type:'not_declared';required:'not_declared';default:'not_declared'};
const UNKNOWN:UnknownField={type:'not_declared',required:'not_declared',default:'not_declared'};

/**
 * Expose only runtime behavior proven by the immutable Published Plan and
 * existing reviewed admission adapters. Never serialize Plan literals here.
 * In particular, Plan.inputs is NOT a declarative input schema.
 */
export function publishedRunInterface(plan:Plan,published_version_id:string){
 const declared=plan.inputs&&typeof plan.inputs==='object'&&!Array.isArray(plan.inputs)
   ?Object.keys(plan.inputs):[];
 const inputs:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
 for(const key of declared)inputs[key]=UNKNOWN;
 const base={
   published_version_id,
   inputs,
   undeclared_input_policy:'not_declared',
   idempotency_key:'optional',
   execution:'published_plan_only',
 };
 if(isLitterboxPlan(plan)){
   return {...base,kind:'litterbox_manual_file',
     inputs:{time:{type:'string',required:false,default:'24h',
       enum:['1h','12h','24h','72h']}},
     top_level_file:{required:true,source:'ChatGPT file descriptor',
       note:'File bytes are uploaded in plaintext to a public external service'},
     idempotency_key:'required',
     approval:'fresh_owner_public_upload_authorization_required',
     unknown_result:'never_retry'};
 }
 if(isEnvsharePlan(plan)&&!plan.triggers?.length&&
    plan.cloudflare_execution_approved===true){
   return {...base,kind:'envshare_manual',
     inputs:{
       text:{type:'string',required:true,min_utf8_bytes:1,max_utf8_bytes:16384},
       ttl_seconds:{type:'integer',required:false,default:86400,
         minimum:60,maximum:604800},
       max_reads:{type:'integer',required:false,default:1,minimum:1,maximum:10},
     },
     idempotency_key:'required',
     result:{delivery_key:'one_time_from_initial_workflow_run_only',
       share_url:'workflow_result_with_delivery_key_after_success',
       recovery:'not_recoverable_from_D1'},
     unknown_result:'never_retry'};
 }
 const sessions=plan.steps.filter(s=>s.uses==='github.run'&&
   (s.with.action as {type?:unknown}|undefined)?.type==='session');
 if(sessions.length&&sessions.every(s=>{
   const action=s.with.action as {inputs?:Record<string,unknown>}|undefined;
   return isSessionDurationInputRef(action?.inputs?.duration_minutes)&&
     action?.inputs?.duration_mode==='explicit';
 })&&plan.inputs?.duration_minutes===300){
   inputs.duration_minutes={type:'integer',required:false,default:300,
     minimum:1,maximum:300};
 }
 return {...base,kind:'generic',note:'Unproven field types, required flags and defaults are not declared.'};
}
