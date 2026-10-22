/** Disposable, read-only GitHub authorization comparison only.
 * No durable resources or product code. A deliberately nonexistent branch
 * ensures the diagnostic dispatch can never create a GitHub Action Run.
 */
type Env={
  GITHUB_AUTH_TOKEN:string; EXPECTED_TOKEN_SHA256:string;
  PROBE_ACCESS_TOKEN:string; PROBE_BRANCH:string; EXPECTED_TOKEN_LENGTH:string;
};
const githubUrl='https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/ci.yml';
function summary(response:Response){
  const accepted=response.headers.get('x-accepted-github-permissions')||'';
  const contentType=response.headers.get('content-type')||'';
  return {status:response.status,
    githubResponse:!!response.headers.get('x-github-request-id'),
    acceptedActionsWrite:accepted.includes('actions=write'),
    contentIsJson:contentType.toLowerCase().includes('json'),
    rateLimited:response.headers.get('x-ratelimit-remaining')==='0',
  };
}
export default{
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(request.method!=='GET'||url.pathname!=='/proof')return new Response(null,{status:404});
    if(request.headers.get('authorization')!=='Bearer '+env.PROBE_ACCESS_TOKEN)
      return new Response(null,{status:401});
    const bytes=new TextEncoder().encode(env.GITHUB_AUTH_TOKEN);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
      .map(n=>n.toString(16).padStart(2,'0')).join('');
    const tokenUnchanged=digest===env.EXPECTED_TOKEN_SHA256;
    async function matches(value:string){
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(value))))
        .map(n=>n.toString(16).padStart(2,'0')).join('');
      return hash===env.EXPECTED_TOKEN_SHA256;
    }
    const normalization={
      trimEnd:await matches(env.GITHUB_AUTH_TOKEN.trimEnd()),
      trimBoth:await matches(env.GITHUB_AUTH_TOKEN.trim()),
      lengthDelta:env.GITHUB_AUTH_TOKEN.length-Number(env.EXPECTED_TOKEN_LENGTH),
      hasTrailingNewline:env.GITHUB_AUTH_TOKEN.endsWith('\n'),
      hasTrailingCarriageReturn:env.GITHUB_AUTH_TOKEN.endsWith('\r'),
    };
    const common={
      'accept':'application/vnd.github+json',
      'authorization':'Bearer '+env.GITHUB_AUTH_TOKEN,
      'content-type':'application/json',
      'x-github-api-version':'2026-03-10',
      'user-agent':'mcp-workers-github-isolated-auth-test',
    };
    const get=await fetch(githubUrl,{method:'GET',headers:common,redirect:'manual'});
    const post=await fetch(githubUrl+'/dispatches',{
      method:'POST',headers:common,redirect:'manual',
      body:JSON.stringify({ref:env.PROBE_BRANCH,return_run_details:true,
        inputs:{worker:'workflow-mcp-worker',github_executor_worker:'true'}}),
    });
    return Response.json({tokenUnchanged,normalization,read:summary(get),invalidDispatch:summary(post)},
      {headers:{'cache-control':'no-store'}});
  },
};
