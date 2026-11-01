// Exact #176 first live MCP write acceptance: never dispatched (zero D1 fence).
// Importing this module is pure; the CLI reads only existing D1 and native logs.
import {readFileSync,appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

export const EIGHTH_MCP_RUN_ID='391e075f-3d5c-449e-ad88-fa13c6d4eb6d';
const WORKFLOW_ID='1e070f56-b5a4-43e6-8671-670d120740b4';
const VERSION_ID='30a01b13-8a94-48d8-b349-dba2ec4dced4';
const WORKFLOW='workflow-mcp-orchestrator';
const requireProof=(condition,message)=>{if(!condition)throw Error('MCP no-dispatch release blocked: '+message);};

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
  return EIGHTH_MCP_RUN_ID;
}

async function main(){
  const d1=JSON.parse(readFileSync(0,'utf8'));
  requireProof(process.env.CLOUDFLARE_API_TOKEN&&process.env.CLOUDFLARE_ACCOUNT_ID,
    'Cloudflare read credentials unavailable');
  const url='https://api.cloudflare.com/client/v4/accounts/'+process.env.CLOUDFLARE_ACCOUNT_ID+
    '/workflows/'+WORKFLOW+'/instances/'+EIGHTH_MCP_RUN_ID;
  const response=await fetch(url,{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,
    Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  requireProof(response.ok,'native instance unavailable (HTTP '+response.status+')');
  const parsed=await response.json();
  requireProof(parsed.success===true,'native instance readback rejected');
  const id=verifyMcpNoDispatchEvidence(d1,parsed.result);
  requireProof(process.env.GITHUB_OUTPUT,'GitHub receipt path unavailable');
  appendFileSync(process.env.GITHUB_OUTPUT,'eighth_terminal_run_id='+id+'\n');
  console.log('Verified exact MCP no-dispatch native terminal Run; historical outcome preserved');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
