import {compilePlan, PLAN_LIMITS, SUPPORTED_STEP_USES, GITHUB_EVENT_PATTERNS} from './plan.ts';
import {PRODUCTION_PORTAL_ENDPOINT,scopedPublicMcpFetch} from './mcp-public-fetch.ts';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {toolSchemaDigest} from './plan.ts';
import {listAvailableGitHubActions,approvedActionRepositories} from './github-action-catalog.ts';
import type {Env} from './store.ts';

type PortalConfig=Pick<Env,'MCP_PORTAL_ENDPOINT'|'MCP_PORTAL_CLIENT_ID'|'MCP_PORTAL_CLIENT_SECRET'>;
type PortalTool={
 name:string;inputSchema:unknown;outputSchema?:unknown;
 annotations?:{readOnlyHint?:boolean;destructiveHint?:boolean};
};
type PortalToolContract={
 tool:string;endpoint:string;scope:'read';input_schema:unknown;
 output_schema?:unknown;schema_digest:string;arguments:{limit:number};
 availability:'discovered_not_executed';
};
type PortalDiscovery={availability:'verified_contract'|'unavailable'|'not_authorized';
 tools:PortalToolContract[];reason?:string};

/**
 * Explicitly source-reviewed operations only. An upstream readOnlyHint does
 * not grant safety or authority. This is deliberately NOT a generic filter for
 * every readOnlyHint in the Portal's mixed read/write catalog.
 */
export async function reviewedPortalTools(tools:PortalTool[]):Promise<PortalToolContract[]>{
 // Duplicate tool identities in a multiplexed Portal are ambiguous; never
 // silently select the first matching upstream or trust its annotations.
 if(tools.filter(t=>t.name==='ima_list_notebooks').length!==1)return [];
 const found:PortalToolContract[]=[];
 for(const tool of tools){
   if(tool.name!=='ima_list_notebooks'||tool.annotations?.readOnlyHint!==true||
      tool.annotations.destructiveHint===true)continue;
   const input=tool.inputSchema as {type?:unknown;properties?:unknown;required?:unknown};
   if(!input||input.type!=='object'||!input.properties||
      typeof input.properties!=='object'||Array.isArray(input.properties))continue;
   const props=input.properties as Record<string,unknown>;
   if(Object.keys(props).some(k=>!['cursor','limit'].includes(k)) ||
      (input.required!==undefined&&
       (!Array.isArray(input.required)||input.required.length>0)))continue;
   const cursor=props.cursor as {type?:unknown}|undefined;
   const limit=props.limit as {type?:unknown}|undefined;
   if((cursor&&cursor.type!=='string')||
      (limit&&limit.type!=='number'&&limit.type!=='integer')||
      !limit)continue;
   try{
     const schema_digest=await toolSchemaDigest(tool.inputSchema,tool.outputSchema);
     found.push({tool:tool.name,endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read',
       input_schema:tool.inputSchema,
       ...(tool.outputSchema?{output_schema:tool.outputSchema}:{}),
       schema_digest,arguments:{limit:1},availability:'discovered_not_executed'});
   }catch{ /* The existing compiler's bounded schema gate is authoritative. */ }
 }
 return found;
}

/** Read the actual restricted Portal catalog with the same credential/URL
 * boundary as runtime. Never call a tool during discovery, never leak errors.
 */
export async function discoverPortalTools(env:PortalConfig):Promise<PortalDiscovery>{
 if(env.MCP_PORTAL_ENDPOINT!==PRODUCTION_PORTAL_ENDPOINT ||
    !env.MCP_PORTAL_CLIENT_ID||!env.MCP_PORTAL_CLIENT_SECRET)
   return {availability:'unavailable',tools:[],reason:'portal_not_configured'};
 const client=new Client({name:'workflow-mcp-action-discovery',version:'0.1.0'});
 let authDenied=false;
 const trackedFetch:typeof fetch=async(input,init)=>{
   const result=await fetch(input,init);
   if([401,403].includes(result.status)||result.status>=300&&result.status<400)
     authDenied=true;
   return result;
 };
 const transport=new StreamableHTTPClientTransport(new URL(PRODUCTION_PORTAL_ENDPOINT),{
   fetch:scopedPublicMcpFetch(PRODUCTION_PORTAL_ENDPOINT,trackedFetch,{
     clientId:env.MCP_PORTAL_CLIENT_ID,clientSecret:env.MCP_PORTAL_CLIENT_SECRET,
   },PRODUCTION_PORTAL_ENDPOINT),
 });
 try{
   await client.connect(transport);
   const result=await client.listTools();
   const contracts=await reviewedPortalTools(result.tools);
   return {availability:contracts.length?'verified_contract':'not_authorized',
     tools:contracts,...(!contracts.length?{reason:'approved_read_tool_not_present_or_schema_changed'}:{})};
 }catch{
   return {availability:authDenied?'not_authorized':'unavailable',
     tools:[],reason:authDenied?'portal_access_denied':'portal_unreachable'};
 }finally{
   await client.close().catch(()=>{});
 }
}

// The compiler is the authority: no secondary validator, remote marketplace,
// standalone registry, or persisted capability catalogue.
const emit = {version:1,name:'Emit an input',inputs:{message:'hello'},
  steps:[{id:'out',uses:'result.emit',with:{data:{ref:'inputs.message'}}}]};
const dag = {version:1,name:'Conditional DAG',steps:[
  {id:'first',uses:'result.emit',with:{data:'ok'}},
  {id:'second',needs:['first'],uses:'result.emit',
    if:{eq:[{ref:'steps.first.status'},'succeeded']},
    with:{data:{ref:'steps.first.output'}}},
]};
const branchJoin={version:1,name:'Conditional branch and join',inputs:{choice:'left'},steps:[
  {id:'left',uses:'result.emit',if:{eq:[{ref:'inputs.choice'},'left']},with:{data:'L'}},
  {id:'right',uses:'result.emit',if:{eq:[{ref:'inputs.choice'},'right']},with:{data:'R'}},
  {id:'join',needs:['left','right'],needs_policy:'allow_skipped',uses:'result.emit',
    with:{data:{left_status:{ref:'steps.left.status'},right_status:{ref:'steps.right.status'}}}},
]};
const literalRepeat={version:1,name:'Fixed bounded repeat',inputs:{message:'hello'},
  steps:[{id:'emit_each',flow:'repeat',times:3,
    template:{uses:'result.emit',with:{data:{ref:'inputs.message'}}}}]};
const mcpRead=(tool:PortalToolContract)=>({version:1,name:'Verified Portal contract example',
  steps:[{id:'read',uses:'mcp.call',with:{
    endpoint:tool.endpoint,tool:tool.tool,scope:'read',
    input_schema:tool.input_schema,
    ...(tool.output_schema?{output_schema:tool.output_schema}:{}),
    arguments:tool.arguments,
  }}]});

export const WORKFLOW_ACTION_WITH_SCHEMAS=Object.freeze({
  'result.emit':{type:'object',additionalProperties:false,
    properties:{data:{description:'Bounded literal or safe expression; omitted data emits null at runtime.'}}},
  'mcp.call':{type:'object',additionalProperties:false,
    required:['endpoint','tool','scope','arguments','input_schema'],
    properties:{
      endpoint:{const:PRODUCTION_PORTAL_ENDPOINT},
      tool:{type:'string',pattern:'^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$'},
      scope:{const:'read'},arguments:{type:'object'},
      input_schema:{type:'object'},output_schema:{type:'object'},
    }},
  'github.run':{type:'object',additionalProperties:false,
    required:['capability','action'],properties:{
      capability:{const:'github.action'},
      action:{type:'object',additionalProperties:false,
        required:['repository','repositoryId','workflowId','workflowPath',
          'commitSha','type','contractDigest','ref','inputs'],
        properties:{
          repository:{type:'string'},repositoryId:{type:'integer',minimum:1},
          workflowId:{type:'integer',minimum:1},
          workflowPath:{type:'string',pattern:'^\\.github/workflows/.+\\.ya?ml$'},
          commitSha:{type:'string',pattern:'^[a-fA-F0-9]{40}$'},
          type:{enum:['task','session']},
          contractDigest:{type:'string',pattern:'^[a-fA-F0-9]{64}$'},
          ref:{type:'string',pattern:'^refs/tags/[A-Za-z0-9]'},
          inputs:{type:'object'},
        }},
    }},
});
export const WORKFLOW_EXPRESSION_RULES=Object.freeze({
  refs:['inputs.<name>','steps.<declared-needs-id>.status',
    'steps.<declared-needs-id>.output[.<field>]'],
  operators:['ref','eq','ne','gt','lt','and','or','not'],
  condition:'Boolean literal or safe expression that evaluates to Boolean; eq/ne/gt/lt take 2 operands, and/or take 1-16 operands.',
  needs:'Only existing Step IDs, no duplicates or cycles; reference another Step only if it appears in needs.',
  needs_policy:'Default all_succeeded; allow_skipped requires at least one succeeded dependency and all others succeeded or skipped; all skipped, failed or indeterminate dependencies block execution.',
  limits:{maxDepth:15,maxArrayElements:100,maxBooleanOperands:16},
  unsupported:['foreach','while','dynamic_repeat','child_workflow','saga'],
});

export const WORKFLOW_DEFINITION_SCHEMA = Object.freeze({
  type:'object',additionalProperties:false,
  required:['version','name','steps'],
  properties:{
    version:{const:1},
    name:{type:'string',minLength:1,maxLength:120},
    inputs:{type:'object',maxProperties:PLAN_LIMITS.maxInputs},
    triggers:{type:'array',minItems:1,maxItems:1,items:{oneOf:[
      {type:'object',additionalProperties:false,required:['type','schedule'],
       properties:{type:{const:'cron'},schedule:{type:'string',maxLength:160,
         description:'Five-field UTC Cron: numbers, *, lists, ranges, and steps; no names or Quartz/DST extensions.'}}},
      {type:'object',additionalProperties:false,required:['type','token_sha256'],
       properties:{type:{const:'webhook'},token_sha256:{type:'string',pattern:'^[a-f0-9]{64}$',
         description:'SHA-256 hex digest of an independent 32-byte random Webhook bearer secret; never put the raw credential in a Draft.'}}},
      {type:'object',additionalProperties:false,
       required:['type','repository','repository_id','event','ref','workflow_path'],
       properties:{type:{const:'github_event'},
         repository:{type:'string',pattern:GITHUB_EVENT_PATTERNS.repository.source},
         repository_id:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
         event:{const:'push'},
         ref:{type:'string',pattern:GITHUB_EVENT_PATTERNS.ref.source},
         workflow_path:{type:'string',pattern:GITHUB_EVENT_PATTERNS.workflow_path.source}}},
    ]}},
    steps:{type:'array',minItems:1,maxItems:PLAN_LIMITS.maxSteps,items:{
      type:'object',additionalProperties:false,
      required:['id'],
      oneOf:[{required:['uses','with']},{required:['flow','times','template']}],
      properties:{
        id:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]{0,63}$'},
        uses:{enum:[...SUPPORTED_STEP_USES]},
        needs:{type:'array',uniqueItems:true,items:{type:'string'}},
        flow:{const:'repeat'},
        times:{type:'integer',minimum:1,maximum:PLAN_LIMITS.maxRepeat},
        template:{type:'object',additionalProperties:false,required:['uses','with'],
          properties:{uses:{enum:[...SUPPORTED_STEP_USES]},with:{type:'object'},
            if:{anyOf:[{type:'boolean'},{type:'object'}]}},
          description:'One Action template per literal iteration; flattened before Publish to sequential stable <id>_<index> Step identities. No nested or dynamic repeats.'},
        needs_policy:{enum:['all_succeeded','allow_skipped'],description:'Default all_succeeded. allow_skipped requires nonempty needs; failed/indeterminate dependencies still block downstream effects.'},
        if:{anyOf:[{type:'boolean'},{type:'object'}],description:'Safe Boolean condition; see expression_rules and inline validation.'},
        with:{type:'object',description:'Must match the matching uses/action contract below.'},
      },
      allOf:[
        {if:{properties:{uses:{const:'result.emit'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['result.emit']}}},
        {if:{properties:{uses:{const:'mcp.call'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call']}}},
        {if:{properties:{uses:{const:'github.run'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['github.run']}}},
      ],
    }},
  },
});

const entries=[
  {id:'trigger.manual',kind:'trigger',availability:'supported',
   description:'Manually admit the current Published Version with workflow_run; supply idempotency_key to deduplicate.'},
  {id:'trigger.cron',kind:'trigger',availability:'supported',
   description:'One five-field UTC Cron trigger per Published Plan; no timezone/DST, missed-minute backfill or capacity queue. Pausing blocks new admissions.'},
  {id:'trigger.webhook',kind:'trigger',availability:'supported',
   description:'Authenticated per-Workflow Bearer Webhook with a stored token digest, optional stable event ID, and immutable Published Version admission. Never uses the owner MCP token.'},
  {id:'trigger.github_event',kind:'trigger',availability:'supported_with_relay',
   description:'GitHub Actions OIDC-signed push event from an explicitly pinned repository, ref and forwarding workflow; no GitHub webhook secret or second business orchestrator.'},
  {id:'action.result.emit',kind:'action',availability:'supported',
   description:'Emit a bounded deterministic result; with={data:expression}.'},
  {id:'action.mcp.call',kind:'action',availability:'supported_with_grant',
   description:'Call only reviewed read-scope tools on the pinned MCP Portal. Exact tool/schema grant and risk acceptance are mandatory.'},
  {id:'action.github.run',kind:'action',availability:'supported_with_grant',
   description:'Dispatch reviewed github.action Task/Session. Discover allowed repositories with workflow_action_list, then pin exact immutable commit, approved ref, contract digest and inputs.'},
  {id:'flow.static_dag',kind:'flow',availability:'supported',
   description:'Acyclic needs dependencies, bounded steps and parallel admission. Steps run under one Cloudflare Workflow instance.'},
  {id:'flow.condition',kind:'flow',availability:'supported',
   description:'Step if accepts safe ref/eq/ne/gt/lt/and/or/not expressions with compiler validation.'},
  {id:'flow.branch_join',kind:'flow',availability:'supported',
   description:'Explicit needs_policy=allow_skipped joins conditional branches only when at least one succeeded and all other dependencies succeeded or skipped; a wholly skipped branch set, failure or uncertainty blocks execution.'},
  {id:'flow.repeat',kind:'flow',availability:'supported',
   description:'Literal 1–8 repeat iterations flatten into sequential, pinned Steps before Publish. Max 32 expanded Steps; no runtime loops.'},
  {id:'flow.loop',kind:'flow',availability:'unsupported',
   description:'Dynamic repeat, while, foreach, nested steps and runtime expansion remain unsupported.'},
  {id:'flow.child',kind:'flow',availability:'unsupported',
   description:'Child workflows and durable wait are not supported in the current Published Plan schema.'},
  {id:'flow.saga',kind:'flow',availability:'unsupported',
   description:'No compensating transaction semantics are provided; cancel does not promise rollback.'},
] as const;
type Entry=typeof entries[number];
const byId=new Map<string,Entry>(entries.map(entry=>[entry.id,entry]));

async function compilingExample(definition:unknown){
  // Each published sample is checked against the exact active compiler.
  // This is compile-only: tool availability and Publish authorization are
  // separate gates, especially for the illustrative MCP tool identifier.
  const {digest}=await compilePlan(definition);
  return {definition,digest,validation:'compiler_valid_only' as const};
}

export async function workflowCapabilities(env:Pick<Env,
 'MCP_PORTAL_ENDPOINT'|'MCP_PORTAL_CLIENT_ID'|'MCP_PORTAL_CLIENT_SECRET'|
 'GITHUB_ACTION_APPROVED_REPOSITORIES'|'WORKFLOW_GITHUB_DISPATCH_TOKEN'|'GITHUB_ACTION_OIDC_AUDIENCE'>,
 id?:string,portalDiscovery:typeof discoverPortalTools=discoverPortalTools){
  const portalReady=env.MCP_PORTAL_ENDPOINT===PRODUCTION_PORTAL_ENDPOINT &&
    !!env.MCP_PORTAL_CLIENT_ID && !!env.MCP_PORTAL_CLIENT_SECRET;
  let githubReady=false;
  try {
    githubReady=approvedActionRepositories(env.GITHUB_ACTION_APPROVED_REPOSITORIES).length>0 &&
      !!env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  }catch { githubReady=false; } // invalid scope is never treated as approved
  const availability=(entry:Entry)=>
    entry.id==='action.mcp.call'&&!portalReady?'unavailable':
    entry.id==='action.github.run'&&!githubReady?'unavailable':
    entry.id==='trigger.github_event'&&!env.GITHUB_ACTION_OIDC_AUDIENCE?'unavailable':
    ['action.mcp.call','action.github.run'].includes(entry.id)?'configured_unverified':entry.availability;
  if(id===undefined)return {
    definition_schema:WORKFLOW_DEFINITION_SCHEMA,
    action_with_schemas:WORKFLOW_ACTION_WITH_SCHEMAS,
    expression_rules:WORKFLOW_EXPRESSION_RULES,
    limits:PLAN_LIMITS,
    capability_ids:entries.map(entry=>({
      id:entry.id,kind:entry.kind,availability:availability(entry),description:entry.description,
    })),
    connections:portalReady?{portal:{endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read',availability:'configured_unverified'}}:{portal:{availability:'unavailable'}},
    availability_note:'Configured means credentials exist, not verified access or publication permission.',
    github_repository_scope:githubReady?'configured':'unavailable',
    tools:{discover_actions:'workflow_action_list',validate:'workflow_validate',
      create:'workflow_create',publish:'workflow_publish',start:'workflow_run',
      status:'workflow_status',result:'workflow_result'},
    admission:'Manual, one UTC Cron, one authenticated Webhook or one signed GitHub push relay per Published Plan. GitHub Actions is ingress only, not a second business orchestrator.',
    note:'Discovery and inline validation never publish or grant execution.',
  };
  const entry=byId.get(id);
  if(!entry)return {id,availability:'unknown',reason:'unknown_capability'};
  const detail:Record<string,unknown>={...entry,availability:availability(entry),limits:PLAN_LIMITS,
    ...(id==='flow.condition'?{expression_rules:WORKFLOW_EXPRESSION_RULES}:{}),
    ...(id==='action.result.emit'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['result.emit']}:{}),
    ...(id==='action.mcp.call'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call']}:{}),
    ...(id==='action.github.run'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['github.run']}:{}),
  };
  if(id==='trigger.webhook'){
    detail.trigger_schema=WORKFLOW_DEFINITION_SCHEMA.properties.triggers;
    detail.example=await compilingExample({...emit,triggers:[{type:'webhook',token_sha256:'0'.repeat(64)}]});
    detail.authentication={method:'Bearer',credential:'Independent 32-byte random base64url token; do not reuse MCP_ACCESS_TOKEN',
      definition:'Store only SHA-256 hex of the token in triggers[0].token_sha256',
      ingress:'POST /triggers/webhook/{workflow_id}',content_type:'application/json',
      body:'JSON object with only declared Workflow input names (up to 8 KiB)',
      event_id_header:'X-Workflow-Event-Id (optional; stable ID enables deduplication)',
      semantics:'D1 admission is pinned to the current active Published Version; absent event ID has no deduplication guarantee',
      warning:'The example contains a placeholder hash, not a usable credential. Never put the raw bearer token in a Draft or log.'};
  }
  if(id==='trigger.github_event'){
    detail.trigger_schema=WORKFLOW_DEFINITION_SCHEMA.properties.triggers;
    detail.example=await compilingExample({version:1,name:'Emit signed GitHub push',
      inputs:{github:null},
      steps:[{id:'out',uses:'result.emit',with:{data:{ref:'inputs.github'}}}],
      triggers:[{type:'github_event',repository:'example/repo',repository_id:12345,
        event:'push',ref:'refs/heads/main',workflow_path:'.github/workflows/forward.yml'}]});
    detail.source={provider:'github_actions_oidc',event:'push_only',
      endpoint:'POST /triggers/github/{workflow_id}',body:'none',
      authentication:'GitHub Actions OIDC ID token with configured audience; never MCP owner token or arbitrary bearer',
      identity:'signed repository, repository_id, event_name, ref, workflow_ref and run_id',
      input:'inputs.github is populated solely from signed JWT claims',
      admission:'idempotency by GitHub run_id, reruns replay; no delivery backfill',
      setup:'Forwarder .github/workflows/forward.yml must be configured explicitly in the named GitHub repository',
      scope:'Pin source repository, repository ID, branch and workflow path in the Published Plan',
      warning:'This is not a direct GitHub webhook or automatic subscription. The GitHub Actions job forwards a signed event; all business steps still run in Cloudflare.'};
  }
  if(id==='trigger.cron'){
    detail.trigger_schema=WORKFLOW_DEFINITION_SCHEMA.properties.triggers;
    detail.example=await compilingExample({...emit,triggers:[{type:'cron',schedule:'0 * * * *'}]});
    detail.schedule_policy={timezone:'UTC',tick:'every minute',missed_ticks:'not_backfilled',
      capacity_exhaustion:'skipped_without_queue',publication:'active_published_version_only',
      manual_run:'still_supported'};
  }
  if(id==='action.result.emit'||id==='trigger.manual')
    detail.example=await compilingExample(emit);
  if(id==='flow.static_dag'||id==='flow.condition')
    detail.example=await compilingExample(dag);
  if(id==='flow.branch_join')
    detail.example=await compilingExample(branchJoin);
  if(id==='flow.repeat')
    detail.example=await compilingExample(literalRepeat);
  if(id==='action.mcp.call'){
    const discovered=await portalDiscovery(env);
    detail.availability=discovered.availability;
    detail.discovered_tools=discovered.tools;
    if(discovered.reason)detail.reason=discovered.reason;
    if(discovered.tools.length){
      detail.example=await compilingExample(mcpRead(discovered.tools[0]));
      detail.example_validation='compiler_valid_and_live_contract_discovered; tools/call not performed';
    }
    detail.grant={scope:'read',...(portalReady?{pinnedEndpoint:PRODUCTION_PORTAL_ENDPOINT}:{}),
      required:['approved_operations','accept_target_risks'],
      warning:'Only source-reviewed, live-advertised read tools; exact schema is rechecked at execution. Discovery is not an execution or permission grant.'};
  }
  if(id==='action.github.run'){
    const approved=githubReady?await listAvailableGitHubActions(env):{actions:[]};
    detail.discovered_actions=approved.actions;
    if(githubReady)detail.availability=approved.actions.some(x=>x.can_publish)?
      'publishable_after_owner_approval':'no_verified_published_action';
    detail.grant={required:['approved_actions','approve_heavy_execution'],
      note:'Discovery is not approval; review exact SHA, immutable tag/ref, workflow and contract digest before Publish.'};
  }
  return detail;
}
