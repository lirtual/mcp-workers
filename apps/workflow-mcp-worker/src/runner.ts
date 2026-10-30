import {runPublishedCloudflareAction} from './cloudflare-action-executor.ts';
import {watchPersistedSessions} from './github-action-session-watch.ts';
import {awaitedChildRunId,transferAwaitedChildCapacity,admitDetachedChild,startReservedDetachedChild,startReservedAwaitedChild} from './child-capacity.ts';
import {canonicalJsonString} from './plan.ts';
import {eventTypeForStep,payloadDigest} from './event-wait.ts';
import {waitForRuntimeApproval} from './runtime-approval.ts';
import { runPublishedGitHubActionTask } from './github-action-task.ts';
import {dynamicForeachTaskInputs,reviewedForeachTaskContract,checkedFrozenTaskInputs,frozenTaskInputDigest} from './github-action-foreach-inputs.ts';
import { runPublishedGitHubActionSession } from './github-action-session.ts';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { evaluateArguments, evaluateCondition, toolSchemaDigest } from './plan.ts';
import type { Plan, Step } from './plan.ts';
import type { Env } from './store.ts';
import { limitResult,WorkflowService } from './store.ts';
import { scopedPublicMcpFetch, PRODUCTION_PORTAL_ENDPOINT, type PortalServiceToken } from './mcp-public-fetch.ts';

type Outcome={status:'succeeded'|'failed'|'skipped'|'indeterminate';output?:any;error_code?:string};
/** Branch joins permit skipped alternatives, but no branch executing must not
 * accidentally authorize downstream Action effects (especially github.run).
 * Preserve all_succeeded for old Plans and for Steps without an explicit join.
 */
function dependenciesPermitRun(s:Step,completed:Record<string,Outcome>):boolean{
  const states=s.needs.map(id=>completed[id]?.status);
  if(s.needs_policy!=='allow_skipped')return states.every(status=>status==='succeeded');
  return states.some(status=>status==='succeeded')&&
    states.every(status=>status==='succeeded'||status==='skipped');
}
const now=()=>Date.now();
// A missing Run-input reference must not silently disappear during JSON
// serialization, changing the meaning of an approved external MCP call.
const hasUnresolvedArgument=(value:unknown):boolean=>
  value===undefined||(Array.isArray(value)?value.some(hasUnresolvedArgument):
    value!==null&&typeof value==='object'&&Object.values(value).some(hasUnresolvedArgument));
async function callApprovedReadonly(env:Env,plan:Plan,step:Step,args:Record<string,unknown>):Promise<unknown>{
  // Enforce the approved published contract before any remote call.
  if(plan.mcp_target_risks_accepted!==true)throw Error('target_risk_acknowledgment_required');
  const endpoint=step.with.endpoint,tool=step.with.tool,schema_digest=step.with.schema_digest;
  const grant=plan.mcp_approvals?.some(g=>g.endpoint===endpoint&&g.tool===tool&&g.scope==='read'&&g.schema_digest===schema_digest);
  if(!grant||step.with.scope!=='read'||typeof endpoint!=='string'||typeof tool!=='string'||
     typeof schema_digest!=='string'||!/^[0-9a-f]{64}$/.test(schema_digest))
    throw Error('external_approval_required');
  // Recompute from the pinned contract so a tampered Plan cannot replace the
  // expected schema while keeping an older authorized digest.
  if(await toolSchemaDigest(step.with.input_schema,step.with.output_schema)!==schema_digest)
    throw Error('approved_schema_changed');
  const client=new Client({name:'workflow-mcp-readonly-candidate',version:'0.1.0'});
  // Environment-scoped Portal identity cannot be changed by a Draft, a
  // Published Plan, or Run inputs. Only the production Portal is supported.
  const chosenPortal=env.MCP_PORTAL_ENDPOINT;
  if(chosenPortal===undefined)throw Error('portal_target_not_configured');
  if(chosenPortal!==PRODUCTION_PORTAL_ENDPOINT || endpoint!==PRODUCTION_PORTAL_ENDPOINT)
    throw Error('portal_target_not_authorized');
  let portalToken:PortalServiceToken|undefined;
  if(endpoint===PRODUCTION_PORTAL_ENDPOINT){
    // Fail closed before making a network request; never fall back to
    // unauthenticated access or pass credentials through Workflow inputs.
    if(!env.MCP_PORTAL_CLIENT_ID||!env.MCP_PORTAL_CLIENT_SECRET)
      throw Error('portal_auth_not_configured');
    portalToken={clientId:env.MCP_PORTAL_CLIENT_ID,clientSecret:env.MCP_PORTAL_CLIENT_SECRET};
  }
  const transport=new StreamableHTTPClientTransport(new URL(endpoint),{
    fetch:scopedPublicMcpFetch(endpoint,fetch,portalToken,PRODUCTION_PORTAL_ENDPOINT),
  });
  try{
    await client.connect(transport);
    const discovered=await client.listTools();
    const candidate=discovered.tools.find(t=>t.name===tool);
    // Tool annotations are untrusted claims, not a grant. This is a second
    // restrictive gate on top of the owner's exact publish approval.
    if(!candidate||candidate.annotations?.readOnlyHint!==true||
       candidate.annotations?.destructiveHint===true)throw Error('readonly_tool_unconfirmed');
    if(await toolSchemaDigest(candidate.inputSchema,candidate.outputSchema)!==schema_digest)
      throw Error('tool_schema_drift');
    // Once tools/call is attempted, a thrown error, remote error, or unreadable
    // result does not prove the external tool had no side effects.
    try{
      const output=await client.callTool({name:tool,arguments:args});
      if(output.isError)throw Error('remote_tool_failed');
      return limitResult(output);
    }catch{throw Error('external_outcome_unknown');}
  }finally{
    // A stateful peer's optional HTTP DELETE can hang even after tools/call
    // succeeded. Never block the durable Run result on remote teardown; the
    // trusted peer owns expiration of its unused session.
    // SDK close() releases local transport state without sending DELETE.
    await client.close().catch(()=>{});
  }
}

/** GitHub Action dispatch/terminal verification is handled by its own durable helpers. */
async function runGithubStep(
  env:Env,plan:Plan,s:Step,runId:string,step:WorkflowStep,
):Promise<Outcome>{
  if(plan.github_execution_approved!==true)
    return {status:'failed',error_code:'github_execution_approval_required'};
  // A malformed persisted Plan must never regain retired executor privileges.
  if(s.with.capability!=='github.action')
    return {status:'failed',error_code:'github_capability_not_registered'};
  return (s.with.action as {type?:unknown}|undefined)?.type==='session'
    ?runPublishedGitHubActionSession(env,plan,s,runId,step)
    :runPublishedGitHubActionTask(env,plan,s,runId,step);
}

const templateIsExternal=(step:Step)=>
  ['mcp.call','github.run'].includes(
    String((step.with.template as {uses?:unknown}|undefined)?.uses));

/** Bounded per-item sequential template. A native array checkpoint freezes
 * expansion before execution, and each external child's own native arguments
 * checkpoint freezes its effective request after same-item dependencies.
 * Mixed templates may contain one reviewed GitHub Task and approved read-only
 * MCP calls; skipped stages never authorize subsequent external dispatch.
 */
async function runMultiForeach(
  env:Env,plan:Plan,s:Step,runId:string,step:WorkflowStep,
  ctx:{inputs:Record<string,unknown>;steps:Record<string,Outcome>},
):Promise<Outcome>{
  const config=s.with;
  const children=config.templates as Array<{id:string;uses:string;with:{data?:unknown;arguments?:unknown;action?:unknown};if?:unknown}>;
  const taskStages=Array.isArray(children)?children.flatMap((c,i)=>c?.uses==='github.run'?[i]:[]):[];
  // Keep checkpoint names and decisions for previously Published Plans.
  const legacyTaskShape=taskStages.length===1&&taskStages[0]===1&&
    children?.length===3&&children[0]?.uses==='result.emit'&&children[2]?.uses==='result.emit';
  if(!Array.isArray(children)||children.length<2||children.length>4||
     children.some(c=>!['result.emit','mcp.call','github.run'].includes(c?.uses)||typeof c.id!=='string')||
     taskStages.length>1||
     !Number.isSafeInteger(config.max_items)||Number(config.max_items)<1||
     Number(config.max_items)>8||Number(config.max_items)*children.length+1>32)
    return {status:'failed',error_code:'invalid_foreach_plan'};
  let externalMayHaveStarted=false;
  try{
    const snapshot=await step.do('workflow-'+s.id+'-snapshot',
      {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async()=>{
        const items=evaluateArguments(config.items,ctx);
        if(!Array.isArray(items)||items.length>Number(config.max_items))
          return {valid:false,items:[]} as const;
        return {valid:true,items:limitResult(items)} as const;
      });
    if(!snapshot.valid||!Array.isArray(snapshot.items)||
       snapshot.items.length>Number(config.max_items))
      return {status:'failed',error_code:'invalid_foreach_items'};
    const collected:unknown[]=[];
    let succeeded=0;
    for(const [index,value] of snapshot.items.entries()){
      const localSteps:Record<string,Outcome>={...ctx.steps};
      let final:Outcome={status:'skipped'};
      for(const [stage,child] of children.entries()){
        const childId=s.id+'_'+index+'_'+child.id;
        const localCtx={...ctx,steps:localSteps,item:{value,index}};
        const earlierSucceeded=children.slice(0,stage)
          .every(prior=>localSteps[prior.id]?.status==='succeeded');
        let outcome:Outcome;
        // New mixed sequences fail closed after a skipped prerequisite.
        // Original three-stage Plans retain their native checkpoint names.
        if(taskStages.length>0&&!legacyTaskShape&&!earlierSucceeded){
          outcome=await step.do('workflow-'+childId+'-blocked',
            {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
            async():Promise<Outcome>=>({status:'skipped'}));
        }else if(child.uses==='result.emit'){
          outcome=await step.do('workflow-'+childId,
            {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async():Promise<Outcome>=>{
              // A skipped Task cannot authorize a follow-up stage or
              // manufacture a successful result from an absent receipt.
              if(legacyTaskShape&&child.id===children[2]!.id&&
                 localSteps[children[1]!.id]?.status!=='succeeded')
                return {status:'skipped'};
              if(child.if!==undefined&&!evaluateCondition(child.if,localCtx))
                return {status:'skipped'};
              return {status:'succeeded',output:limitResult(evaluateArguments(child.with.data,localCtx))};
            });
        }else if(child.uses==='github.run'){
          // Only the compiler-authorized emit -> literal Task -> emit shape.
          // Selection is frozen BEFORE any GitHub dispatch; an upstream
          // skipped emit may never trigger the external Task.
          const selected=await step.do('workflow-'+childId+'-selection',
            {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async()=>({
              selected:(legacyTaskShape?
                localSteps[children[0]!.id]?.status==='succeeded':earlierSucceeded)&&
                (child.if===undefined||evaluateCondition(child.if,localCtx)),
            }));
          if(!selected.selected){
            outcome={status:'skipped'};
          }else{
            await env.DB.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
              SELECT ?,?,'running',? WHERE EXISTS(
                SELECT 1 FROM runs WHERE id=? AND outcome='running')
              ON CONFLICT(run_id,step_id) DO NOTHING`)
              .bind(runId,childId,now(),runId).run();
            externalMayHaveStarted=true;
            const task:Step={id:childId,uses:'github.run',needs:s.needs,with:child.with};
            outcome=await runPublishedGitHubActionTask(env,plan,task,runId,step);
          }
        }else{
          // Never evaluate mutable previous outputs again after this checkpoint.
          // The output is an ordinary JSON object, not a dynamic expression.
          let frozen:{selected:boolean;args_json:string|null};
          try{
            frozen=await step.do('workflow-'+childId+'-args',
              {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async()=>{
                const selected=child.if===undefined||evaluateCondition(child.if,localCtx);
                if(!selected)return {selected:false,args_json:null};
                const evaluated=evaluateArguments(child.with.arguments,localCtx);
                if(!evaluated||typeof evaluated!=='object'||Array.isArray(evaluated)||
                   hasUnresolvedArgument(evaluated))
                  throw Error('invalid_foreach_arguments');
                return {selected:true,args_json:JSON.stringify(limitResult(evaluated as Record<string,unknown>))};
              });
          }catch{
            outcome={status:'failed',error_code:'invalid_foreach_arguments'};
            await env.DB.prepare(`INSERT INTO run_steps(run_id,step_id,status,error_code,updated_at)
              VALUES(?,?,'failed',?,?) ON CONFLICT(run_id,step_id) DO NOTHING`)
              .bind(runId,childId,outcome.error_code,now()).run();
            return {status:'failed',error_code:'foreach_child_failed'};
          }
          if(!frozen.selected){
            outcome=await step.do('workflow-'+childId,
              {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
              async():Promise<Outcome>=>({status:'skipped'}));
          }else if(!frozen.args_json||typeof frozen.args_json!=='string'){
            outcome={status:'failed',error_code:'invalid_foreach_arguments'};
          }else{
            let args:Record<string,unknown>;
            try{
              const candidate=JSON.parse(frozen.args_json) as unknown;
              if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||
                 hasUnresolvedArgument(candidate))throw Error('bad_snapshot');
              args=candidate as Record<string,unknown>;
            }catch{
              return {status:'failed',error_code:'invalid_foreach_snapshot'};
            }
            // After entering a dispatch checkpoint, loss of native progress or
            // D1 response is ambiguous. The durable child fence prevents a
            // second tools/call even if this checkpoint is lost on replay.
            externalMayHaveStarted=true;
            outcome=await step.do('workflow-'+childId,
              {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async():Promise<Outcome>=>{
                const fenced=await env.DB.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
                  SELECT ?,?,'running',? WHERE EXISTS(
                    SELECT 1 FROM runs WHERE id=? AND outcome='running')
                  ON CONFLICT(run_id,step_id) DO NOTHING`)
                  .bind(runId,childId,now(),runId).run();
                if(fenced.meta.changes!==1)
                  return {status:'indeterminate',error_code:'foreach_dispatch_unconfirmed'};
                const childStep:Step={id:childId,uses:'mcp.call',needs:s.needs,with:child.with};
                try{
                  return {status:'succeeded',
                    output:await callApprovedReadonly(env,plan,childStep,args)};
                }catch(error){
                  return error instanceof Error&&error.message==='external_outcome_unknown'
                    ?{status:'indeterminate',error_code:'external_outcome_unknown'}
                    :{status:'failed',error_code:'step_execution_failed'};
                }
              });
          }
        }
        await env.DB.prepare(`INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id)
          DO UPDATE SET status=excluded.status,output=excluded.output,
          error_code=excluded.error_code,updated_at=excluded.updated_at
          WHERE run_steps.status IN ('waiting','running')`)
          .bind(runId,childId,outcome.status,
            outcome.output===undefined?null:JSON.stringify(outcome.output),
            outcome.error_code??null,now()).run();
        localSteps[child.id]=outcome;
        final=outcome;
        if(outcome.status==='succeeded')succeeded++;
        if(outcome.status==='indeterminate')
          return {status:'indeterminate',error_code:'foreach_child_indeterminate'};
        if(outcome.status==='failed')
          return {status:'failed',error_code:'foreach_child_failed'};
      }
      collected.push(final.status==='succeeded'?final.output:null);
    }
    return succeeded?{status:'succeeded',output:limitResult(collected)}:{status:'skipped'};
  }catch{
    return externalMayHaveStarted
      ?{status:'indeterminate',error_code:'foreach_execution_unconfirmed'}
      :{status:'failed',error_code:'foreach_execution_failed'};
  }
}

/** Freeze all conditions and arguments in a native checkpoint before effects.
 * MCP read children use run_steps as a durable one-shot dispatch fence.
 * Reviewed GitHub Task children reuse the existing Attempt-before-POST fence,
 * OIDC Claim and native physical completion checks, never Session lifecycle.
 */
async function runForeachStep(
  env:Env,plan:Plan,s:Step,runId:string,step:WorkflowStep,
  ctx:{inputs:Record<string,unknown>;steps:Record<string,Outcome>},
):Promise<Outcome>{
  const db=env.DB;
  try{
    await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
      .bind(runId,s.id,now()).run();
    if(!dependenciesPermitRun(s,ctx.steps))return {status:'skipped'};
    const config=s.with;
    if(Array.isArray(config.templates))
      return await runMultiForeach(env,plan,s,runId,step,ctx);
    const template=config.template as {id:string;uses:string;with:Record<string,unknown>;if?:unknown};
    const dynamic=dynamicForeachTaskInputs(s);
    // Never trust a shape-only check for a mutable external input:
    // the exact GitHub-reviewed contract is persisted at Publish.
    const typedContract=dynamic?await reviewedForeachTaskContract(plan,s):undefined;
    if(!['result.emit','mcp.call','github.run'].includes(template?.uses)||!Number.isSafeInteger(config.max_items)||
       Number(config.max_items)<1||Number(config.max_items)>8)
      return {status:'failed',error_code:'invalid_foreach_plan'};
    const snapshot=await step.do('workflow-'+s.id+'-snapshot',
      {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
      async()=>{
        const list=evaluateArguments(config.items,ctx);
        if(!Array.isArray(list)||list.length>Number(config.max_items))
          return {valid:false,items:[]} as const;
        const entries=list.map((value,index)=>{
          const itemCtx={...ctx,item:{value,index}};
          const selected=template.if===undefined||evaluateCondition(template.if,itemCtx);
          const candidate=selected?evaluateArguments(
            template.uses==='mcp.call'?template.with.arguments:
              template.uses==='github.run'?(template.with.action as {inputs?:unknown})?.inputs:
              template.with.data,itemCtx):null;
          // All selected Task inputs are fully typed (including choices and
          // required fields) within this single durable snapshot. A late
          // malformed item cannot cause a preceding item to dispatch.
          // The input validator deliberately uses a null-prototype object
          // for key safety, but native Cloudflare Workflow checkpoints must
          // persist an ordinary JSON value. Only reviewed input names survive.
          const evaluated=selected&&typedContract?
            Object.fromEntries(Object.entries(checkedFrozenTaskInputs(typedContract,candidate))):candidate;
          // Before any external dispatch, reject unresolved arguments across the
          // entire bounded array. Partial pre-dispatch validation is not enough.
          if(selected&&template.uses==='mcp.call'&&
             (!evaluated||typeof evaluated!=='object'||Array.isArray(evaluated)||
              hasUnresolvedArgument(evaluated)))throw Error('invalid_foreach_arguments');
          return {id:s.id+'_'+index+'_'+template.id,selected,
            output:evaluated===undefined?null:evaluated};
        });
        return {valid:true,items:limitResult(entries)} as const;
      }).catch(()=>({valid:false,items:[]} as const));
    // Snapshot evaluation/checkpoint is pure. A failure here happens before
    // every child dispatch, so do not misclassify it as an external ambiguity.
    if(!snapshot.valid)return {status:'failed',error_code:'invalid_foreach_items'};
    if(!Array.isArray(snapshot.items)||snapshot.items.length>Number(config.max_items))
      return {status:'failed',error_code:'invalid_foreach_snapshot'};
    const collected:unknown[]=[];
    let succeeded=0;
    for(let i=0;i<snapshot.items.length;i++){
      const entry=snapshot.items[i];
      if(entry.id!==s.id+'_'+i+'_'+template.id||typeof entry.selected!=='boolean')
        return {status:'failed',error_code:'invalid_foreach_snapshot'};
      // GitHub Task already wraps its dispatch and every physical poll in
      // separate native checkpoints; do not place a long-running Task under
      // the ordinary 30-second emission checkpoint.
      const outcome=template.uses==='github.run'&&entry.selected
        ? await (async():Promise<Outcome>=>{
            try{
              if(dynamic){
                const values=entry.output as Record<string,string>;
                const sha=await frozenTaskInputDigest(values);
                const marker=JSON.stringify({input_sha256:sha});
                // D1 stores only a digest, not a raw dynamically generated
                // argument or secret. Preserve an existing marker on replay.
                await db.prepare(`INSERT INTO run_steps(run_id,step_id,status,output,updated_at)
                  SELECT ?,?,'running',?,? WHERE EXISTS(
                    SELECT 1 FROM runs WHERE id=? AND outcome='running')
                  ON CONFLICT(run_id,step_id) DO NOTHING`)
                  .bind(runId,entry.id,marker,now(),runId).run();
                const frozen=await db.prepare(`SELECT status,output FROM run_steps
                  WHERE run_id=? AND step_id=?`).bind(runId,entry.id)
                  .first<{status:string;output:string|null}>();
                if(frozen?.status!=='running'||frozen.output!==marker)
                  return {status:'indeterminate',error_code:'github_input_snapshot_unconfirmed'};
              }else{
                await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
                  .bind(runId,entry.id,now()).run();
              }
              const childWith=dynamic?{...template.with,action:{
                ...(template.with.action as Record<string,unknown>),inputs:entry.output,
              }}:template.with;
              const child:Step={id:entry.id,uses:'github.run',needs:s.needs,with:childWith};
              // The Task's native dispatch checkpoint first registers a
              // UNIQUE D1 Attempt. A lost response cannot dispatch again.
              return await runPublishedGitHubActionTask(env,plan,child,runId,step);
            }catch{
              return {status:'indeterminate',error_code:'github_dispatch_unknown'};
            }
          })()
        : await step.do('workflow-'+entry.id,
        {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
        async():Promise<Outcome>=>{
          if(!entry.selected){
            await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
              .bind(runId,entry.id,now()).run();
            return {status:'skipped'};
          }
          if(template.uses==='result.emit'){
            await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
              .bind(runId,entry.id,now()).run();
            return {status:'succeeded',output:limitResult(entry.output)};
          }
          // Persist BEFORE calling an external peer. If a native checkpoint is
          // lost or the worker restarts mid-call, a repeated callback sees the
          // existing fence and returns indeterminate without a second call.
          // No new D1 table or at-most-once claim about the remote system.
          const fenced=await db.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
            SELECT ?,?,'running',? WHERE EXISTS (
              SELECT 1 FROM runs WHERE id=? AND outcome='running'
            ) ON CONFLICT(run_id,step_id) DO NOTHING`)
            .bind(runId,entry.id,now(),runId).run();
          if(fenced.meta.changes!==1)
            return {status:'indeterminate',error_code:'foreach_dispatch_unconfirmed'};
          const child:Step={id:entry.id,uses:'mcp.call',needs:s.needs,with:template.with};
          try{
            const args=entry.output as Record<string,unknown>;
            return {status:'succeeded',output:await callApprovedReadonly(env,plan,child,args)};
          }catch(error){
            return error instanceof Error&&error.message==='external_outcome_unknown'
              ?{status:'indeterminate',error_code:'external_outcome_unknown'}
              :{status:'failed',error_code:'step_execution_failed'};
          }
        });
      await db.prepare("INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,output=excluded.output,error_code=excluded.error_code,updated_at=excluded.updated_at WHERE run_steps.status IN ('waiting','running','waiting_approval')")
        .bind(runId,entry.id,outcome.status,outcome.output===undefined?null:JSON.stringify(outcome.output),
          outcome.error_code??null,now()).run();
      collected.push(outcome.status==='succeeded'?outcome.output:null);
      if(outcome.status==='succeeded')succeeded++;
      if(outcome.status==='indeterminate')return {status:'indeterminate',error_code:'foreach_child_indeterminate'};
      if(outcome.status==='failed')return {status:'failed',error_code:'foreach_child_failed'};
    }
    return succeeded?{status:'succeeded',output:limitResult(collected)}:{status:'skipped'};
  }catch{
    // On an MCP child, a native checkpoint/DB failure can have occurred
    // after the external request. Never classify that as confirmed failure.
    return templateIsExternal(s)
      ?{status:'indeterminate',error_code:'foreach_execution_unconfirmed'}
      :{status:'failed',error_code:'foreach_execution_failed'};
  }
}

/** A bounded time wait uses Cloudflare's native, replayable sleep checkpoint.
 * No JS timer, external poller, D1 deadline table or second scheduler. The
 * persisted waiting Step is readable while the Workflow instance is asleep.
 */
async function runDurableWait(
  env:Env,s:Step,runId:string,step:WorkflowStep,
  outcomes:Record<string,Outcome>,
):Promise<Outcome>{
  if(!dependenciesPermitRun(s,outcomes))return {status:'skipped'};
  const duration=Number(s.with.duration_seconds);
  if(!Number.isSafeInteger(duration)||duration<1||duration>300)
    return {status:'failed',error_code:'invalid_wait_duration'};
  try{
    await env.DB.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
      SELECT ?,?,'waiting',? WHERE EXISTS (
        SELECT 1 FROM runs WHERE id=? AND outcome='running'
      ) ON CONFLICT(run_id,step_id) DO NOTHING`)
      .bind(runId,s.id,now(),runId).run();
    const recorded=await env.DB.prepare(
      'SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
      .bind(runId,s.id).first<{status:string}>();
    if(recorded?.status==='succeeded')return {status:'succeeded',output:null};
    if(recorded?.status!=='waiting')
      return {status:'indeterminate',error_code:'wait_admission_unconfirmed'};
    // The stable name and literal duration are pinned to this Published Plan.
    // A replay resumes the existing native sleep rather than restarting a timer.
    await step.sleep('workflow-'+s.id+'-wait',duration*1000);
    const active=await env.DB.prepare('SELECT outcome FROM runs WHERE id=?')
      .bind(runId).first<{outcome:string}>();
    if(active?.outcome!=='running')
      return {status:'indeterminate',error_code:'wait_owner_not_active'};
    return {status:'succeeded',output:null};
  }catch{
    return {status:'indeterminate',error_code:'wait_resume_unconfirmed'};
  }
}

/** One native event wait. The durable D1 receipt pre-dates the native
 * signal and prevents distinct logical events from racing to this Step.
 */
async function runWaitForEvent(
  env:Env,s:Step,runId:string,step:WorkflowStep,
  outcomes:Record<string,Outcome>,
):Promise<Outcome>{
  if(!dependenciesPermitRun(s,outcomes))return {status:'skipped'};
  const timeout=Number(s.with.timeout_seconds);
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3600)
    return {status:'failed',error_code:'invalid_event_wait_timeout'};
  try{
    await env.DB.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
      SELECT ?,?,'waiting',? WHERE EXISTS (
        SELECT 1 FROM runs WHERE id=? AND outcome='running'
      ) ON CONFLICT(run_id,step_id) DO NOTHING`)
      .bind(runId,s.id,now(),runId).run();
    const recorded=await env.DB.prepare(
      'SELECT status,output FROM run_steps WHERE run_id=? AND step_id=?')
      .bind(runId,s.id).first<{status:string;output:string|null}>();
    if(recorded?.status==='succeeded')
      return {status:'succeeded',output:recorded.output?JSON.parse(recorded.output):null};
    if(recorded?.status!=='waiting')
      return {status:'indeterminate',error_code:'event_wait_admission_unconfirmed'};
    const event=await step.waitForEvent(
      'workflow-'+s.id+'-event',{type:eventTypeForStep(s.id),timeout:`${timeout} seconds`});
    const payload=event.payload as {event_id?:unknown;data?:unknown}|null;
    const receipt=await env.DB.prepare(`SELECT event_id,payload_digest FROM wait_event_receipts
      WHERE run_id=? AND step_id=?`).bind(runId,s.id)
      .first<{event_id:string;payload_digest:string}>();
    const active=await env.DB.prepare('SELECT outcome FROM runs WHERE id=?')
      .bind(runId).first<{outcome:string}>();
    // Even a natively delivered event cannot resume business effects after
    // Run cancellation, and it must equal the D1-reserved event identity.
    if(active?.outcome!=='running')
      return {status:'indeterminate',error_code:'event_wait_owner_not_active'};
    if(!receipt||typeof payload?.event_id!=='string'||
       payload.event_id!==receipt.event_id||
       !payload.data||typeof payload.data!=='object'||
       Array.isArray(payload.data)||
       await payloadDigest(payload.data)!==receipt.payload_digest)
      return {status:'indeterminate',error_code:'event_wait_receipt_mismatch'};
    return {status:'succeeded',output:limitResult(payload!.data)};
  }catch(error){
    const message=error instanceof Error?error.message:'';
    if(/timed?\s*out|timeout/i.test(message))
      return {status:'failed',error_code:'event_wait_timeout'};
    return {status:'indeterminate',error_code:'event_wait_unconfirmed'};
  }
}

/** One awaited, non-recursive child per parent, with its own Published Plan.
 * D1 child lineage is durable before native create; all loop sleeps are
 * Cloudflare-native, not a polling Worker or an external scheduler.
 */
async function runAwaitedChild(
 env:Env,plan:Plan,s:Step,runId:string,step:WorkflowStep,
 ctx:{inputs:Record<string,unknown>;steps:Record<string,Outcome>},
):Promise<Outcome>{
 if(!dependenciesPermitRun(s,ctx.steps))return {status:'skipped'};
 const detached=s.with.mode==='detached';
 const target=s.with.workflow_id,version=s.with.version_id;
 const approval=plan.child_approvals?.find(x=>x.workflow_id===target&&x.version_id===version);
 if(!approval||typeof target!=='string'||typeof version!=='string')
   return {status:'failed',error_code:'child_approval_required'};
 let childId:string;
 let frozen:{inputJson:string;digest:string};
 try{
   childId=await awaitedChildRunId(runId,s.id);
   frozen=await step.do('workflow-'+s.id+'-child-inputs',
     {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async()=>{
       const inputs=evaluateArguments(s.with.inputs,ctx);
       if(!inputs||typeof inputs!=='object'||Array.isArray(inputs)||hasUnresolvedArgument(inputs))
         throw Error('invalid_child_inputs');
       const inputJson=canonicalJsonString(limitResult(inputs));
       const sha=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(inputJson));
       return {inputJson,digest:[...new Uint8Array(sha)].map(x=>x.toString(16).padStart(2,'0')).join('')};
     });
   if(typeof frozen.inputJson!=='string'||typeof frozen.digest!=='string')
     return {status:'failed',error_code:'invalid_child_snapshot'};
 }catch{return {status:'failed',error_code:'invalid_child_inputs'};}
 try{
   const published=await env.DB.prepare(`SELECT v.digest,w.state,w.active_version_id
     FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id
     WHERE v.id=? AND w.id=?`)
     .bind(version,target).first<{digest:string;state:string;active_version_id:string|null}>();
   if(published?.digest!==approval.digest)
     return {status:'failed',error_code:'child_approved_version_changed'};
   // An explicitly paused (or republished) child is a known rejection,
   // not an ambiguous D1/native admission. Keep the atomic reservation
   // predicate as the final authority if this state races with a change.
   if(published.state!=='active'||published.active_version_id!==version)
     return {status:'failed',error_code:'child_target_unavailable'};
   const reservation={parentRunId:runId,parentStepId:s.id,childRunId:childId,
     childWorkflowId:target,childVersionId:version,
     admissionKey:'child-'+childId,requestDigest:frozen.digest,
     inputJson:frozen.inputJson,timestamp:now()};
   if(detached)await admitDetachedChild(env.DB,reservation);
   else await transferAwaitedChildCapacity(env.DB,reservation);
 }catch(error){
   if(detached&&error instanceof Error&&error.message==='detached_child_admission_rejected')
     return {status:'failed',error_code:'detached_child_admission_rejected'};
   return {status:'indeterminate',error_code:'child_admission_unconfirmed'};
 }
 if(detached){
   const childReference={run_id:childId,published_version_id:version};
   for(let i=0;i<=20;i++){
     try{
       const started=await step.do('workflow-'+s.id+'-detached-child-start-'+i,
         {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
         async()=>startReservedDetachedChild(env,{
           parentRunId:runId,parentStepId:s.id,childRunId:childId,timestamp:now(),
         }));
       // A detached child completes the calling Step at confirmed native
       // creation, not after its independent business Run completes.
       if(started.start_state==='started')
         return {status:'succeeded',output:childReference};
       if(started.start_state==='rejected')
         return {status:'failed',error_code:'detached_parent_not_active'};
       if(started.start_state==='indeterminate')break;
     }catch{
       // Unknown native creation must not trigger a second create().
     }
     if(i<20)await step.sleep('workflow-'+s.id+'-detached-child-reconcile-'+i,30_000);
   }
   // Keep the child identity visible even when a native ACK cannot be
   // established. A provider outcome is never guessed from a timeout.
   return {status:'indeterminate',output:childReference,
     error_code:'detached_child_start_unconfirmed'};
 }
 // Child start and every observation use the SAME derived ID. If an ACK
 // disappears, the helper only retries on a proven native not-found.
 for(let i=0;i<120;i++){
   try{
     const start=await step.do('workflow-'+s.id+'-child-start-'+i,
       {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
       async()=>startReservedAwaitedChild(env,{
         parentRunId:runId,parentStepId:s.id,childRunId:childId,timestamp:now(),
       }));
     if(start.start_state==='indeterminate')
       return {status:'indeterminate',error_code:'child_start_unconfirmed'};
     const status=await step.do('workflow-'+s.id+'-child-status-'+i,
       {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async()=>{
         // Reconcile native child errors/termination without confusing a
         // native complete ACK with a successful D1 business result.
         await new WorkflowService(env).status(childId);
         return env.DB.prepare('SELECT outcome,result FROM runs WHERE id=? AND parent_run_id=? AND parent_step_id=?')
           .bind(childId,runId,s.id).first<{outcome:string;result:string|null}>();
       });
     if(!status)return {status:'indeterminate',error_code:'child_lineage_missing'};
     if(status.outcome==='succeeded'){
       // A child may finish after its native termination request lost an ACK.
       // This read MUST be outside step.do: replay can return a cached successful
       // status, but a subsequently committed cancellation still wins over
       // parent dependency authorization. Preserve the child's real D1 result.
       const cancelled=await env.DB.prepare(
         'SELECT child_run_id FROM child_cancellations WHERE child_run_id=?')
         .bind(childId).first<{child_run_id:string}>();
       if(cancelled)return {status:'failed',error_code:'child_cancel_requested'};
       try{return {status:'succeeded',output:limitResult(status.result===null?null:JSON.parse(status.result))};}
       catch{return {status:'indeterminate',error_code:'child_result_unreadable'};}
     }
     if(status.outcome==='failed'||status.outcome==='cancelled')
       return {status:'failed',error_code:'child_failed'};
     if(status.outcome==='indeterminate')
       return {status:'indeterminate',error_code:'child_outcome_unknown'};
   }catch{
     // D1 or native admission uncertainty is not a confirmed child failure.
     return {status:'indeterminate',error_code:'child_observation_unconfirmed'};
   }
   if(i<119)await step.sleep('workflow-'+s.id+'-child-sleep-'+i,30_000);
 }
 return {status:'indeterminate',error_code:'child_wait_expired'};
}

export class WorkflowOrchestrator extends WorkflowEntrypoint<Env,{run_id:string}> {
  async run(event:WorkflowEvent<{run_id:string}>,step:WorkflowStep){
    const id=event.payload.run_id;
    const db=this.env.DB;
    const row=await db.prepare('SELECT version_id,inputs,outcome FROM runs WHERE id=?').bind(id).first<{version_id:string;inputs:string;outcome:string}>();
    if(!row)throw Error('run_missing');
    // An expired ambiguous admission is terminally uncertain. A Workflow
    // started much later must not run the abandoned queued Workflow plan.
    if(row.outcome!=='queued'&&row.outcome!=='running')return;
    const version=await db.prepare('SELECT plan FROM workflow_versions WHERE id=?').bind(row.version_id).first<{plan:string}>();
    if(!version)throw Error('version_missing');
    const plan=JSON.parse(version.plan) as Plan;
    const ctx:{inputs:Record<string,unknown>;steps:Record<string,Outcome>}={inputs:JSON.parse(row.inputs),steps:{}};
    if(row.outcome==='queued'){
      // A native child create can become visible AFTER a cancellation request
      // (e.g. when create() loses its ACK). Fence the first business step with
      // the durable child cancellation in the SAME atomic D1 transition.
      const transition=await db.prepare(`UPDATE runs
        SET outcome='running',updated_at=? WHERE id=? AND outcome='queued'
        AND NOT EXISTS(SELECT 1 FROM child_cancellations WHERE child_run_id=runs.id)`)
        .bind(now(),id).run();
      if(!transition.meta.changes){
        // Native execution was prevented before its first business step.
        // Report a failed, side-effect-free admission, not a successful native
        // termination (which was never independently observed).
        await db.prepare(`UPDATE runs SET outcome='failed',
          error_code='child_cancel_requested',updated_at=?
          WHERE id=? AND outcome='queued' AND parent_run_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM child_cancellations WHERE child_run_id=runs.id)`)
          .bind(now(),id).run();
        return;
      }
    }
    const pending=new Map(plan.steps.map(s=>[s.id,s]));
    let emitted:unknown=null;
    let hasEmitted=false;
    let failed=false;
    let uncertain=false;
    let uncertainCode:string|null=null;
    const hasEventWait=plan.steps.some(s=>s.uses==='flow.wait_event'||s.uses==='action.run'||s.approval?.required===true);
    try{
      while(pending.size){
        // Cancellation can commit after the native event was received but
        // before its dependent wave begins. Recheck the durable Run fence.
        // Existing plans without external event waits retain their flow.
        if(hasEventWait){
          const owner=await db.prepare('SELECT outcome FROM runs WHERE id=?')
            .bind(id).first<{outcome:string}>();
          if(owner?.outcome==='cancelled'){
            // Do not execute another wave after the cancellation fence.
            // Persist pending Steps as skipped, not an unexplained unknown
            // status; previously completed/failed Steps retain their result.
            for(const pendingStep of pending.values()){
              await db.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
                VALUES(?,?,'skipped',?) ON CONFLICT(run_id,step_id)
                DO UPDATE SET status='skipped',output=NULL,error_code=NULL,updated_at=excluded.updated_at
                WHERE run_steps.status IN ('waiting','running')`)
                .bind(id,pendingStep.id,now()).run();
            }
            return;
          }
          if(owner?.outcome!=='running')return;
        }
        const ready=[...pending.values()].filter(s=>s.needs.every(n=>ctx.steps[n])).slice(0,8);
        if(!ready.length)throw Error('invalid_execution_graph');
        const outcomes=await Promise.all(ready.map(async (s:Step):Promise<Outcome>=>{
          const result=(s.uses==='flow.wait'
            ? await runDurableWait(this.env,s,id,step,ctx.steps)
            : s.uses==='flow.wait_event'
            ? await runWaitForEvent(this.env,s,id,step,ctx.steps)
            : s.uses==='flow.child'
            ? await runAwaitedChild(this.env,plan,s,id,step,ctx)
            : s.uses==='flow.foreach'
            ? await runForeachStep(this.env,plan,s,id,step,ctx)
            : s.uses==='action.run'
            ? await step.do('workflow-'+s.id,
              {retries:{limit:0,delay:'1 second'},timeout:'90 seconds'},async():Promise<Outcome>=>{
                try{
                  await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
                    .bind(id,s.id,now()).run();
                  if(!dependenciesPermitRun(s,ctx.steps))return {status:'skipped'};
                  if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'};
                  return await runPublishedCloudflareAction(this.env,plan,s,id,undefined,ctx);
                }catch{return {status:'indeterminate',error_code:'cloudflare_dispatch_unconfirmed'};}
              })
            : s.uses==='github.run'
            ? await (async()=>{
              try{
                await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
                  .bind(id,s.id,now()).run();
                if(!dependenciesPermitRun(s,ctx.steps))
                  return {status:'skipped'} as Outcome;
                if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'} as Outcome;
                if(s.approval?.required){
                  // Native wake is only a hint; D1 holds the one-use decision.
                  // No GitHub Attempt or POST exists before this gate succeeds.
                  const approval=await waitForRuntimeApproval(db,step,id,s.id,row.version_id,
                    async()=>{
                      const state=await db.prepare('SELECT outcome FROM runs WHERE id=?')
                        .bind(id).first<{outcome:string}>();
                      return state?.outcome!=='running';
                    });
                  if(!approval.ok)return {status:'failed',error_code:approval.error_code};
                  await db.prepare(`UPDATE run_steps SET status='running',updated_at=?
                    WHERE run_id=? AND step_id=? AND status='waiting_approval'`)
                    .bind(now(),id,s.id).run();
                }
                return await runGithubStep(this.env,plan,s,id,step);
              }catch{
                // Never retry an uncertain GitHub dispatch on a Workflow replay.
                return {status:'indeterminate',error_code:'github_dispatch_unknown'} as Outcome;
              }
            })()
            : await step.do('workflow-'+s.id,{retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async ():Promise<Outcome>=>{
            try{
              // Only an executing callback marks a Step running. Cached replay
              // must never replace a previously persisted terminal Step state.
              await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
                .bind(id,s.id,now()).run();
              if(!dependenciesPermitRun(s,ctx.steps))
                  return {status:'skipped'};
              if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'};
              // Exhaustive runtime dispatch is required even for a pinned plan
              // read from D1. Never reinterpret a future/unknown capability as
              // a successful result.emit operation.
              if(s.uses==='result.emit')
                return {status:'succeeded',output:limitResult(evaluateArguments(s.with.data,ctx))};
              if(s.uses==='mcp.call'){
                const a=evaluateArguments(s.with.arguments,ctx);
                if(!a||typeof a!=='object'||Array.isArray(a)||hasUnresolvedArgument(a))
                  throw Error('invalid_arguments');
                try{
                  return {status:'succeeded',output:await callApprovedReadonly(this.env,plan,s,a as Record<string,unknown>)};
                }catch(error){
                  if(error instanceof Error&&error.message==='external_outcome_unknown')
                    return {status:'indeterminate',error_code:'external_outcome_unknown'};
                  throw error;
                }
              }
              throw Error('unsupported_capability');
            }catch{return {status:'failed',error_code:'step_execution_failed'};}
          })) as Outcome;
          await db.prepare("INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,output=excluded.output,error_code=excluded.error_code,updated_at=excluded.updated_at WHERE run_steps.status IN ('waiting','running','waiting_approval')")
          .bind(id,s.id,result.status,result.output===undefined?null:JSON.stringify(result.output),result.error_code??null,now()).run();
          return result;
        }));
        ready.forEach((s,i)=>{ctx.steps[s.id]=outcomes[i];pending.delete(s.id);if(outcomes[i].status==='failed')failed=true;
          if(outcomes[i].status==='indeterminate'){
            uncertain=true;uncertainCode??=outcomes[i].error_code??'external_outcome_unknown';
          }
          if(s.uses==='result.emit'&&outcomes[i].status==='succeeded'){emitted=outcomes[i].output;hasEmitted=true;}});
      }
      const output=limitResult(hasEmitted?emitted:ctx.steps[plan.steps.at(-1)!.id]?.output??null);
      await db.prepare("UPDATE runs SET outcome=?,result=?,error_code=?,updated_at=? WHERE id=? AND outcome='running'")
        .bind(uncertain?'indeterminate':failed?'failed':'succeeded',JSON.stringify(output),uncertain?uncertainCode:null,now(),id).run();
    }catch{
      await db.prepare("UPDATE runs SET outcome='indeterminate',error_code='execution_interrupted',updated_at=? WHERE id=? AND outcome='running'").bind(now(),id).run();
      throw Error('execution_interrupted');
    }finally{
      // The parent business Run can finish at Session Ready, but its GitHub
      // job is a separate physical resource. Keep THIS native Workflow
      // sleeping and reconciling until terminal evidence or the bounded
      // watch window. No external scheduler, false completion, or slot leak
      // on a successful Ready. Expiry requests normal cancellation only.
      if(plan.steps.some(s=>s.uses==='github.run'&&
         s.with.capability==='github.action'&&
         (s.with.action as {type?:unknown}|undefined)?.type==='session')){
        try{await watchPersistedSessions(this.env,id,step);}
        catch{
          // The independent Session record still holds quota, and explicit
          // workflow_status performs a verified recovery readback.
        }
      }
    }
  }
}

