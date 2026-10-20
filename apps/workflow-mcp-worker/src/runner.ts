import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { evaluateArguments, evaluateCondition } from './plan.ts';
import type { Plan, Step } from './plan.ts';
import type { Env } from './store.ts';
import { limitResult } from './store.ts';

type Outcome={status:'succeeded'|'failed'|'skipped';output?:any;error_code?:string};
const now=()=>Date.now();
async function callFixture(env:Env,args:Record<string,unknown>):Promise<unknown>{
  const client=new Client({name:'workflow-s1-worker',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL('https://s1-fixture.invalid/mcp'),{
    fetch: ((input:Request|string|URL,init?:RequestInit)=>env.READONLY_TARGET.fetch(input as Request,init)) as typeof fetch,
  });
  try{
    await client.connect(transport);
    const result=await client.callTool({name:'echo',arguments:args});
    if(result.isError)throw Error('readonly_tool_failed');
    return limitResult(result);
  }finally{await client.close();}
}

export class WorkflowRunner extends WorkflowEntrypoint<Env,{run_id:string}> {
  async run(event:WorkflowEvent<{run_id:string}>,step:WorkflowStep){
    const id=event.payload.run_id;
    const db=this.env.DB;
    const row=await db.prepare('SELECT version_id,inputs,outcome FROM runs WHERE id=?').bind(id).first<{version_id:string;inputs:string;outcome:string}>();
    if(!row)throw Error('run_missing');
    // An expired ambiguous admission is terminally uncertain. A Workflow
    // started much later must not run the abandoned queued S1 plan.
    if(row.outcome!=='queued'&&row.outcome!=='running')return;
    const version=await db.prepare('SELECT plan FROM workflow_versions WHERE id=?').bind(row.version_id).first<{plan:string}>();
    if(!version)throw Error('version_missing');
    const plan=JSON.parse(version.plan) as Plan;
    const ctx:{inputs:Record<string,unknown>;steps:Record<string,Outcome>}={inputs:JSON.parse(row.inputs),steps:{}};
    if(row.outcome==='queued'){
      const transition=await db.prepare("UPDATE runs SET outcome='running',updated_at=? WHERE id=? AND outcome='queued'").bind(now(),id).run();
      if(!transition.meta.changes)return;
    }
    const pending=new Map(plan.steps.map(s=>[s.id,s]));
    let emitted:unknown=null;
    let failed=false;
    try{
      while(pending.size){
        const ready=[...pending.values()].filter(s=>s.needs.every(n=>ctx.steps[n])).slice(0,8);
        if(!ready.length)throw Error('invalid_execution_graph');
        const outcomes=await Promise.all(ready.map(async (s:Step):Promise<Outcome>=>{
          const result=(await step.do('s1-'+s.id,{retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async ():Promise<Outcome>=>{
            try{
              if(s.needs.some(n=>ctx.steps[n].status!=='succeeded'))return {status:'skipped'};
              if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'};
              if(s.uses==='s1.readonly_mcp'){
                const a=evaluateArguments(s.with.arguments,ctx);
                return {status:'succeeded',output:await callFixture(this.env,a as Record<string,unknown>)};
              }
              return {status:'succeeded',output:limitResult(evaluateArguments(s.with.data,ctx))};
            }catch{return {status:'failed',error_code:'step_execution_failed'};}
          })) as Outcome;
          await db.prepare('INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,output=excluded.output,error_code=excluded.error_code,updated_at=excluded.updated_at')
          .bind(id,s.id,result.status,result.output===undefined?null:JSON.stringify(result.output),result.error_code??null,now()).run();
          return result;
        }));
        ready.forEach((s,i)=>{ctx.steps[s.id]=outcomes[i];pending.delete(s.id);if(outcomes[i].status==='failed')failed=true;
          if(s.uses==='result.emit'&&outcomes[i].status==='succeeded')emitted=outcomes[i].output;});
      }
      const output=limitResult(emitted??ctx.steps[plan.steps.at(-1)!.id]?.output??null);
      await db.prepare("UPDATE runs SET outcome=?,result=?,updated_at=? WHERE id=? AND outcome='running'").bind(failed?'failed':'succeeded',JSON.stringify(output),now(),id).run();
    }catch{
      await db.prepare("UPDATE runs SET outcome='indeterminate',error_code='execution_interrupted',updated_at=? WHERE id=? AND outcome='running'").bind(now(),id).run();
      throw Error('execution_interrupted');
    }
  }
}
