/**
 * Test-only wrapper around the real product Worker entry.
 * No diagnostic endpoint is added to production src/index.ts.
 */
import worker from '../../src/index.ts';
import type { Env } from '../../src/store.ts';
export { WorkflowRunner } from '../../src/runner.ts';

type TestEnv=Env&{GITHUB_TEST_EXPECTED_TOKEN_SHA256:string};
const expected=/^workflow-github-plan-[a-f0-9]{10}$/;
export default{
  async fetch(request:Request,env:TestEnv):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname!=='/__test/github-identity')
      return worker.fetch(request,env);
    if(request.method!=='GET' ||
       !expected.test(env.GITHUB_TEST_WORKER_NAME??'') ||
       url.hostname!==env.GITHUB_TEST_WORKER_NAME+'.aiyaya.workers.dev' ||
       request.headers.get('authorization')!=='Bearer '+env.MCP_ACCESS_TOKEN)
      return new Response(null,{status:404});
    if(!env.WORKFLOW_EXECUTOR_TOKEN ||
       !/^[a-f0-9]{64}$/.test(env.GITHUB_TEST_EXPECTED_TOKEN_SHA256))
      return Response.json({tokenMatches:false,readStatus:null,invalidDispatchStatus:null},
        {headers:{'cache-control':'no-store'}});
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256',new TextEncoder().encode(env.WORKFLOW_EXECUTOR_TOKEN))))
      .map(n=>n.toString(16).padStart(2,'0')).join('');
    if(hash!==env.GITHUB_TEST_EXPECTED_TOKEN_SHA256)
      return Response.json({tokenMatches:false,readStatus:null,invalidDispatchStatus:null},
        {headers:{'cache-control':'no-store'}});
    const urlGithub='https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/ci.yml';
    const headers={
      'accept':'application/vnd.github+json',
      'authorization':'Bearer '+env.WORKFLOW_EXECUTOR_TOKEN,
      'content-type':'application/json',
      'x-github-api-version':'2026-03-10',
      'user-agent':'mcp-workers-github-isolated-proof',
    };
    const read=await fetch(urlGithub,{headers,redirect:'manual'});
    // This random branch does NOT exist. Only an authorized 422 counts as
    // evidence; no real workflow can be created by this malformed ref.
    const invalidRef='github-proof-never-execute-'+env.GITHUB_TEST_WORKER_NAME;
    const invalid=await fetch(urlGithub+'/dispatches',{
      method:'POST',headers,redirect:'manual',
      body:JSON.stringify({ref:invalidRef,return_run_details:true,
        inputs:{worker:'workflow-mcp-worker',github_executor_worker:'true'}}),
    });
    return Response.json({tokenMatches:true,readStatus:read.status,
      invalidDispatchStatus:invalid.status},
      {headers:{'cache-control':'no-store'}});
  },
};
