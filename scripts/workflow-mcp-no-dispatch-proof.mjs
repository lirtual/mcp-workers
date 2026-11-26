// Exact #176 first live MCP write acceptance: never dispatched (zero D1 fence).
// Importing this module is pure; the CLI reads only existing D1 and native logs.

export const EIGHTH_MCP_RUN_ID='391e075f-3d5c-449e-ad88-fa13c6d4eb6d';
const WORKFLOW_ID='1e070f56-b5a4-43e6-8671-670d120740b4';
const VERSION_ID='30a01b13-8a94-48d8-b349-dba2ec4dced4';
const WORKFLOW='workflow-mcp-orchestrator';
// One exact prior protected release independently verified the ephemeral
// Cloudflare Native instance before retention expired. Never accept 404 alone.
const PRIOR_RELEASE_ID=41451130475;
const PRIOR_JOB_ID=125296945646;
const PRIOR_SHA='4c422150237d50f67210c75e39a4ef1fc0b53a6c';
const PRIOR_PROOF_STEP='Verify eighth MCP no-dispatch Run proof (read-only)';
const VERIFIED_PRIOR=Symbol('pinned-eighth-native-proof');
const requireProof=(condition,message)=>{if(!condition)throw Error('MCP no-dispatch release blocked: '+message);};

export function verifyPriorMcpNoDispatchProof(run,jobs){
  requireProof(run?.id===PRIOR_RELEASE_ID&&run.workflow_id===394912681&&
    run.head_sha===PRIOR_SHA&&run.head_branch==='main'&&
    run.event==='workflow_dispatch'&&run.run_attempt===1&&
    run.status==='completed'&&run.conclusion==='success',
    'pinned previous Consumer release not verified');
  const job=jobs?.jobs?.find(x=>x.id===PRIOR_JOB_ID);
  requireProof(job?.run_id===PRIOR_RELEASE_ID&&
    job?.name==='Manual selected Worker release'&&
    job.head_sha===PRIOR_SHA&&job.run_attempt===1&&
    job.status==='completed'&&job.conclusion==='success'&&
    job.steps?.filter(x=>x.name===PRIOR_PROOF_STEP&&x.number===23&&
      x.status==='completed'&&x.conclusion==='success').length===1,
    'pinned prior eighth native proof step not successful');
  return Object.freeze({[VERIFIED_PRIOR]:true});
}

export function verifyMcpNoDispatchEvidence(data,native){
  requireProof(Array.isArray(data)&&data.length===5&&data.every(x=>x?.success===true&&Array.isArray(x.results)),
    'D1 proof statements unavailable');
  const [runRows,stepRows,fenceRows,sessionRows,versions]=data.map(x=>x.results);
  const run=runRows[0],step=stepRows[0],version=versions[0];
  requireProof(runRows.length===1&&run?.id===EIGHTH_MCP_RUN_ID&&
    run.workflow_id===WORKFLOW_ID&&run.version_id===VERSION_ID&&
    run.outcome==='indeterminate'&&run.start_state==='started'&&
    run.error_code==='execution_interrupted','pinned Run state changed');
  requireProof(stepRows.length===1&&step?.run_id===EIGHTH_MCP_RUN_ID&&
    step.step_id==='create_note'&&step.status==='running'&&step.error_code===null,
    'pinned Step state changed');
  requireProof(fenceRows.length===0,'MCP outbound dispatch may have been reserved');
  requireProof(sessionRows.length===0,'unexpected live Session');
  requireProof(versions.length===1&&version.id===VERSION_ID,'published Plan not found');
  let plan;try{plan=JSON.parse(version.plan);}catch{requireProof(false,'Plan cannot be parsed');}
  requireProof(plan.steps?.length===1&&plan.steps[0]?.id==='create_note'&&
    plan.steps[0]?.uses==='mcp.call'&&plan.steps[0]?.with?.scope==='write'&&
    plan.steps[0]?.with?.tool==='ima_create_note'&&
    plan.steps[0]?.with?.endpoint==='https://mcp.lirtual.dpdns.org/mcp'&&
    plan.steps[0]?.with?.arguments?.content?.includes('Spec #176 · One-time Workflow MCP write production E2E')&&
    plan.mcp_write_execution_approved===true,'published write Plan identity changed');
  if(native?.[VERIFIED_PRIOR]!==true){
    requireProof(native?.status==='errored'&&native?.error?.message==='execution_interrupted'&&
      native?.end&&native?.step_count===1&&native?.steps?.length===1,
      'native Workflow terminal error unconfirmed');
    const n=native.steps[0];
    requireProof(n.name==='workflow-create_note-1'&&n.success===false&&
      n.config?.timeout==='30 seconds'&&n.config?.retries?.limit===0&&
      n.attempts?.length===1&&n.attempts[0].success===false&&
      n.attempts[0].error?.name==='WorkflowTimeoutError'&&
      n.attempts[0].error?.message==='Execution timed out after 30000ms',
      'native timeout, retry or Step identity changed');
  }
  return EIGHTH_MCP_RUN_ID;
}

// #1046: reuse the exact prior protected proof only during v22 backfill.
export function historicalMcpNoDispatchTerminalProof(d1,priorRun,priorJobs){
  const native=verifyPriorMcpNoDispatchProof(priorRun,priorJobs);
  const id=verifyMcpNoDispatchEvidence(d1,native);
  const job=priorJobs.jobs.find(j=>j.id===PRIOR_JOB_ID);
  const step=job.steps.find(s=>s.name===PRIOR_PROOF_STEP);
  const at=Date.parse(step.completed_at);
  requireProof(d1[0].results[0].instance_id===id&&Number.isSafeInteger(at)&&at>0,
    'historical native identity or observation time unavailable');
  return {instance_id:id,status:'errored',observed_at:at,
    historical_source:{release_run_id:priorRun.id,job_id:job.id,step:step.name},
    no_dispatch_step_id:d1[1].results[0].step_id};
}
