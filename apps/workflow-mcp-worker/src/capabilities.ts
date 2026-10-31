import {compilePlan, PLAN_LIMITS, SUPPORTED_STEP_USES, GITHUB_EVENT_PATTERNS} from './plan.ts';
import {cloudflareActionManifest} from './cloudflare-action-contract.ts';
import {portalAuthorization} from './portal-authorization.ts';
import {httpAuthorization} from './http-authorization.ts';
import {PRODUCTION_PORTAL_ENDPOINT,scopedPublicMcpFetch} from './mcp-public-fetch.ts';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {toolSchemaDigest} from './plan.ts';
import {REVIEWED_WRITE_TOOL,REVIEWED_APPEND_TOOL,REVIEWED_WRITE_TOOLS,reviewedWriteTool} from './mcp-write-contract.ts';
import {listAvailableGitHubActions,approvedActionRepositories} from './github-action-catalog.ts';
import type {Env} from './store.ts';

type PortalConfig=Pick<Env,'MCP_PORTAL_ENDPOINT'|'MCP_PORTAL_CLIENT_ID'|'MCP_PORTAL_CLIENT_SECRET'>;
type PortalTool={
 name:string;inputSchema:unknown;outputSchema?:unknown;
 annotations?:{readOnlyHint?:boolean;destructiveHint?:boolean};
};
type PortalToolContract={
 tool:string;endpoint:string;scope:'read'|'write';input_schema:unknown;
 output_schema?:unknown;schema_digest:string;arguments:{limit:number}|{content:string}|{note_id:string;content:string};
 availability:'discovered_not_executed';
};
type PortalDiscovery={availability:'verified_contract'|'unavailable'|'not_authorized';
 tools:PortalToolContract[];write_tools?:PortalToolContract[];reason?:string};

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
export async function reviewedPortalWriteTools(tools:PortalTool[]):Promise<PortalToolContract[]>{
  const found:PortalToolContract[]=[];
  for(const name of REVIEWED_WRITE_TOOLS){
    if(tools.filter(x=>x.name===name).length!==1)continue;
    const tool=tools.find(x=>x.name===name)!;
    if(!reviewedWriteTool(tool))continue;
    try{
      found.push({tool:name,endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'write',
        input_schema:tool.inputSchema,
        ...(tool.outputSchema?{output_schema:tool.outputSchema}:{}),
        schema_digest:await toolSchemaDigest(tool.inputSchema,tool.outputSchema),
        arguments:name===REVIEWED_APPEND_TOOL?
          {note_id:'0000000000000000',content:'Owner-reviewed append content'}:
          {content:'Owner-reviewed note content'},
        availability:'discovered_not_executed'});
    }catch{ /* Fail closed for this exact reviewed tool's schema. */ }
  }
  return found;
}

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
   const write_tools=await reviewedPortalWriteTools(result.tools);
   return {availability:contracts.length?'verified_contract':'not_authorized',
     tools:contracts,write_tools,
     ...(!contracts.length?{reason:'approved_read_tool_not_present_or_schema_changed'}:{})};
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
const awaitedChildExample={version:1,name:'Pinned awaited child (illustrative)',steps:[
  {id:'call',flow:'child',workflow_id:'11111111-1111-4111-8111-111111111111',
   version_id:'22222222-2222-4222-8222-222222222222',inputs:{}},
  {id:'forward',needs:['call'],uses:'result.emit',with:{data:{ref:'steps.call.output'}}},
]};
// Both UUIDs above are illustrative only. Actual workflow_validate checks a real
// active child/version and workflow_publish requires exact approved_children.
const boundedWait={version:1,name:'Bounded durable delay',steps:[
  {id:'hold',flow:'wait',duration_seconds:2},
  {id:'done',uses:'result.emit',needs:['hold'],with:{data:'resumed'}},
]};
const eventWait={version:1,name:'Event wait (illustrative credential)',steps:[
  {id:'signal',flow:'wait_event',timeout_seconds:60,token_sha256:'0'.repeat(64)},
  {id:'done',needs:['signal'],uses:'result.emit',with:{data:{ref:'steps.signal.output'}}},
]};
// Supply a 32-byte random external-event secret and publish only its digest.
const boundedLoop={version:1,name:'Bounded dynamic until',steps:[
  {id:'loop',flow:'until',max_iterations:4,
    condition:{eq:[{ref:'item.value'},2]},
    template:{uses:'result.emit',with:{data:{ref:'item.index'}}}},
  {id:'done',needs:['loop'],uses:'result.emit',with:{data:{ref:'steps.loop.output'}}},
]};
const literalRepeat={version:1,name:'Fixed bounded repeat',inputs:{message:'hello'},
  steps:[{id:'emit_each',flow:'repeat',times:3,
    template:{uses:'result.emit',with:{data:{ref:'inputs.message'}}}}]};
const foreachEmit={version:1,name:'Snapshot bounded array',inputs:{items:['A','B']},steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:4,
    template:{steps:[{id:'emit',uses:'result.emit',with:{
      data:{value:{ref:'item.value'},index:{ref:'item.index'}},
    }}]}},
  {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}},
]};
const foreachMultiEmit={version:1,name:'Bounded per-item emit pipeline',inputs:{items:['A','B']},
  steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:4,
    template:{steps:[
      {id:'prepare',uses:'result.emit',with:{data:{value:{ref:'item.value'},index:{ref:'item.index'}}}},
      {id:'finish',uses:'result.emit',
        if:{eq:[{ref:'steps.prepare.status'},'succeeded']},
        with:{data:{ref:'steps.prepare.output.value'}}},
    ]}},
    {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}}]};
const foreachMultiMcpRead=(tool:PortalToolContract)=>({version:1,
  name:'Bounded sequential MCP read pipeline',inputs:{items:[1,1]},
  steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
    template:{steps:[
      {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
      {id:'read',uses:'mcp.call',with:{
        endpoint:tool.endpoint,tool:tool.tool,scope:'read',
        input_schema:tool.input_schema,
        ...(tool.output_schema?{output_schema:tool.output_schema}:{}),
        arguments:tool.arguments,
      }},
    ]}},
    {id:'done',needs:['each'],uses:'result.emit',
      with:{data:{ref:'steps.each.output'}}}]});
const foreachMcpRead=(tool:PortalToolContract)=>({version:1,name:'Bounded approved MCP reads',
  inputs:{items:['A','B']},
  steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
    template:{steps:[{id:'read',uses:'mcp.call',with:{
      endpoint:tool.endpoint,tool:tool.tool,scope:'read',
      input_schema:tool.input_schema,
      ...(tool.output_schema?{output_schema:tool.output_schema}:{}),
      arguments:tool.arguments,
    }}]}}],
});
const foreachGithubTask=(action:{
 repository:string;repositoryId:number;workflowId:number;workflowPath:string;commitSha:string;
 type:'task'|'session';contractDigest:string;ref:string;inputs:Record<string,{default?:string|boolean|number;required:boolean}>;
})=>({version:1,name:'Bounded reviewed GitHub Task',inputs:{items:['first','second']},
 steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
  template:{steps:[{id:'task',uses:'github.run',with:{capability:'github.action',
   action:{repository:action.repository,repositoryId:action.repositoryId,
    workflowId:action.workflowId,workflowPath:action.workflowPath,commitSha:action.commitSha,
    type:'task',contractDigest:action.contractDigest,ref:action.ref,
    inputs:Object.fromEntries(Object.entries(action.inputs).filter(([,field])=>field.default!==undefined)
      .map(([name,field])=>[name,field.default])),
   }}}]}}],
});
const foreachEmitTaskEmit=(action:Parameters<typeof foreachGithubTask>[0])=>{
  const example=foreachGithubTask(action);
  return {...example,name:'Bounded emit Task emit',
    steps:[{...example.steps[0],template:{steps:[
      {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
      {...example.steps[0].template.steps[0],id:'verify'},
      {id:'finish',uses:'result.emit',with:{data:{ref:'steps.verify.output'}}},
    ]}},
    {id:'done',uses:'result.emit',needs:['each'],with:{data:{ref:'steps.each.output'}}}]};
};
const foreachMixedMcpTask=(action:Parameters<typeof foreachGithubTask>[0],tool:PortalToolContract)=>{
  const base=foreachEmitTaskEmit(action);
  const head=base.steps[0]!;
  const mcp=foreachMcpRead(tool).steps[0]!;
  if(!('template' in head)||!('template' in mcp))throw Error('invalid_foreach_example');
  const read=mcp.template.steps[0]!;
  return {...base,name:'Approved read + Task per item',
    steps:[{...head,template:{steps:[
      head.template.steps[0]!,
      {...read,id:'read'},
      ...head.template.steps.slice(1),
    ]}},...base.steps.slice(1)]};
};
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
  'http.request':{type:'object',additionalProperties:false,required:['url','method'],
    properties:{url:{type:'string',format:'uri',description:'Literal, canonical public HTTPS target without query, fragment or credentials'},
      method:{enum:['GET','HEAD','POST']},body:{description:'Bounded immutable JSON literal for POST only; runtime refs and expressions are not authorized'}}},
  'mcp.call':{type:'object',additionalProperties:false,
    required:['endpoint','tool','scope','arguments','input_schema'],
    properties:{
      endpoint:{const:PRODUCTION_PORTAL_ENDPOINT},
      tool:{type:'string',pattern:'^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$'},
      scope:{enum:['read','write']},arguments:{type:'object'},
      input_schema:{type:'object'},output_schema:{type:'object'},
    }},
  'action.run':{oneOf:[
    {type:'object',additionalProperties:false,required:['executor','capability','action'],
     properties:{executor:{const:'github'},capability:{const:'github.action'},action:{type:'object'}}},
    {type:'object',additionalProperties:false,
     required:['executor','provider','action','contract_digest','input'],properties:{
       executor:{const:'cloudflare'},provider:{enum:['weixin','bark']},action:{enum:['weixin.send_text','weixin.notify_download','bark.send_notification']},
       contract_digest:{type:'string',pattern:'^[a-f0-9]{64}$'},
       input:{oneOf:[
        {type:'object',additionalProperties:false,required:['download_step_id'],
         properties:{download_step_id:{type:'string'}}},
        {type:'object',additionalProperties:false,required:['text'],
         properties:{text:{type:'string',minLength:1,maxLength:2048},session_step_id:{type:'string'}}},
        {type:'object',additionalProperties:false,required:['notification'],
         properties:{notification:{type:'object'}}}]},
     }},
  ]},
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
// Nested dynamic loops and Foreach can only expose the compiler-reviewed operations.
// Top-level MCP writes and Cloudflare Actions keep their independent contracts.
const REVIEWED_READ_MCP_WITH_SCHEMA=Object.freeze({
  ...WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call'],
  properties:{...WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call'].properties,scope:{const:'read'}},
});
const FOREACH_TASK_WITH_SCHEMA=Object.freeze({
  ...WORKFLOW_ACTION_WITH_SCHEMAS['github.run'],
  properties:{...WORKFLOW_ACTION_WITH_SCHEMAS['github.run'].properties,
    action:{...WORKFLOW_ACTION_WITH_SCHEMAS['github.run'].properties.action,
      properties:{...WORKFLOW_ACTION_WITH_SCHEMAS['github.run'].properties.action.properties,
        type:{const:'task'}}}},
});
const FOREACH_TASK_ACTION_RUN_WITH_SCHEMA=Object.freeze({
  ...WORKFLOW_ACTION_WITH_SCHEMAS['action.run'].oneOf[0],
  properties:{...WORKFLOW_ACTION_WITH_SCHEMAS['action.run'].oneOf[0].properties,
    action:FOREACH_TASK_WITH_SCHEMA.properties.action},
});

export const WORKFLOW_EXPRESSION_RULES=Object.freeze({
  refs:['inputs.<name>','steps.<declared-needs-id>.status',
    'steps.<declared-needs-id>.output[.<field>]'],
  operators:['ref','eq','ne','gt','lt','and','or','not'],
  condition:'Boolean literal or safe expression that evaluates to Boolean; eq/ne/gt/lt take 2 operands, and/or take 1-16 operands.',
  needs:'Only existing Step IDs, no duplicates or cycles; reference another Step only if it appears in needs.',
  needs_policy:'Default all_succeeded; allow_skipped requires at least one succeeded dependency and all others succeeded or skipped; all skipped, failed or indeterminate dependencies block execution.',
  limits:{maxDepth:15,maxArrayElements:100,maxBooleanOperands:16},
  foreach_item_refs:['item.value[.<field>]','item.index'],
  loop_item_refs:['item.index','item.value[.<field>]'],
  supported_loop:'flow: while checks condition before each result.emit or granted read-only mcp.call; flow: until checks after each iteration. item.index is zero-based; item.value is previous (while) or current (until) output, initially null. max_iterations 1–8; exhaustion fails closed. No nesting or unreviewed effects.',
  foreach_local_refs:['steps.<earlier-template-child-id>.status','steps.<earlier-template-child-id>.output[.<field>]'],
  session_duration_binding:'For reviewed GitHub Session Actions only: Plan inputs.duration_minutes=300, Action inputs.duration_minutes={ref: inputs.duration_minutes}, Action inputs.duration_mode=explicit; workflow_run.inputs.duration_minutes is optional whole minutes 1–300. This does not authorize arbitrary Action input references; old literal Session Plans require one-time republish.',
  supported_wait:'Use flow: wait with literal duration_seconds 1–300 and optional needs. All wait Steps together are limited to 300 seconds per Plan. Sleep uses Cloudflare-native checkpoints; this is not an externally signaled event wait.',
  supported_wait_event:'Use flow: wait_event with a SHA-256 digest of an independent 32-byte secret and timeout_seconds 1–3600. One per Plan; events address one existing Run/Step with a stable event ID and never create a Run.',
  supported_child:'Use flow: child with the active child workflow_id and immutable version_id, exact required_children/approved_children grant; awaited by default or mode: detached for an independent child Run. The legacy child_workflow field is not accepted.',
  unsupported:['foreach_github_sessions','foreach_external_multi_github','nested_foreach','nested_loop','dynamic_repeat'],
});

export const WORKFLOW_DEFINITION_SCHEMA = Object.freeze({
  type:'object',additionalProperties:false,
  required:['version','name','steps'],
  properties:{
    version:{const:1},
    name:{type:'string',minLength:1,maxLength:120},
    inputs:{type:'object',maxProperties:PLAN_LIMITS.maxInputs},
    saga:{type:'object',additionalProperties:false,required:['on'],
      properties:{on:{type:'array',minItems:1,maxItems:2,uniqueItems:true,
        items:{enum:['failure','cancel']}}}},
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
      oneOf:[
        {required:['uses','with'],not:{anyOf:[
          {required:['flow']},{required:['times']},{required:['template']},
        ]}},
        {required:['flow','times','template'],properties:{flow:{const:'repeat'},
          template:{type:'object',required:['uses','with'],not:{required:['steps']}}},not:{anyOf:[
          {required:['uses']},{required:['with']},{required:['if']},{required:['needs_policy']},
          {required:['items']},{required:['max_items']},
        ]}},
        {required:['flow','condition','max_iterations','template'],
          properties:{flow:{enum:['while','until']},
            template:{type:'object',additionalProperties:false,required:['uses','with'],
              properties:{uses:{enum:['result.emit','mcp.call']},with:{type:'object'}},
              oneOf:[
                {properties:{uses:{const:'result.emit'},with:WORKFLOW_ACTION_WITH_SCHEMAS['result.emit']}},
                {properties:{uses:{const:'mcp.call'},with:REVIEWED_READ_MCP_WITH_SCHEMA}},
              ]}},
          not:{anyOf:[{required:['uses']},{required:['with']},{required:['if']},
            {required:['needs_policy']},{required:['times']},{required:['items']},{required:['max_items']}]}},
        {required:['flow','duration_seconds'],properties:{flow:{const:'wait'}},
          not:{anyOf:[
            {required:['uses']},{required:['with']},{required:['if']},{required:['needs_policy']},
            {required:['times']},{required:['items']},{required:['max_items']},{required:['template']},
          ]}},
        {required:['flow','token_sha256','timeout_seconds'],properties:{flow:{const:'wait_event'}},
          not:{anyOf:[{required:['uses']},{required:['with']},{required:['if']},{required:['needs_policy']},
            {required:['times']},{required:['items']},{required:['max_items']},{required:['template']}] }},
        {required:['flow','workflow_id','version_id','inputs'],properties:{flow:{const:'child'},mode:{const:'detached'}},not:{anyOf:[
          {required:['uses']},{required:['with']},{required:['if']},{required:['times']},
          {required:['items']},{required:['max_items']},{required:['template']},
        ]}},
        {required:['flow','items','max_items','template'],properties:{flow:{const:'foreach'},
          template:{type:'object',required:['steps'],not:{required:['uses']}}},not:{anyOf:[
          {required:['uses']},{required:['with']},{required:['if']},{required:['needs_policy']},
          {required:['times']},
        ]}},
      ],
      properties:{
        id:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]{0,63}$'},
        uses:{enum:[...SUPPORTED_STEP_USES]},
        compensate:{type:'object',additionalProperties:false,required:['kind'],
          properties:{kind:{const:'github.session.cancel',
            description:'Only an explicitly approved temporary lirtual/session-actions Ubuntu Session; cancellation ACK is not terminal proof'}}},
        needs:{type:'array',uniqueItems:true,items:{type:'string'}},
        flow:{enum:['repeat','foreach','child','wait','wait_event','while','until']},
        max_iterations:{type:'integer',minimum:1,maximum:PLAN_LIMITS.maxRepeat},
        condition:{anyOf:[{type:'boolean'},{type:'object'}]},
        duration_seconds:{type:'integer',minimum:1,maximum:PLAN_LIMITS.maxWaitSeconds},
        timeout_seconds:{type:'integer',minimum:1,maximum:PLAN_LIMITS.maxEventWaitSeconds},
        token_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
        mode:{const:'detached'},
        workflow_id:{type:'string',format:'uuid'},
        version_id:{type:'string',format:'uuid'},
        inputs:{type:'object',maxProperties:PLAN_LIMITS.maxInputs},
        items:{type:'object',additionalProperties:false,required:['ref'],properties:{ref:{type:'string'}}},
        max_items:{type:'integer',minimum:1,maximum:PLAN_LIMITS.maxForeachItems},
        times:{type:'integer',minimum:1,maximum:PLAN_LIMITS.maxRepeat},
        template:{oneOf:[
          {type:'object',additionalProperties:false,required:['uses','with'],
            properties:{uses:{enum:SUPPORTED_STEP_USES.filter(x=>x!=='http.request')},with:{type:'object'},
              if:{anyOf:[{type:'boolean'},{type:'object'}]}}},
          {type:'object',additionalProperties:false,required:['steps'],
            properties:{steps:{type:'array',minItems:1,maxItems:PLAN_LIMITS.maxForeachTemplateSteps,
               description:'One reviewed Action per item, or 2-4 ordered emit/read-only MCP children with at most one owner-approved literal-input GitHub Task. Only earlier children in the same item can be referenced.',items:{
              type:'object',additionalProperties:false,required:['id','uses','with'],
              properties:{id:{type:'string'},uses:{enum:['result.emit','mcp.call','github.run','action.run']},
                with:{type:'object'},
                if:{anyOf:[{type:'boolean'},{type:'object'}]}},
              allOf:[
                {if:{required:['uses'],properties:{uses:{const:'result.emit'}}},
                  then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['result.emit']}}},
                {if:{required:['uses'],properties:{uses:{const:'mcp.call'}}},
                  then:{properties:{with:REVIEWED_READ_MCP_WITH_SCHEMA}}},
                {if:{required:['uses'],properties:{uses:{const:'github.run'}}},
                  then:{properties:{with:FOREACH_TASK_WITH_SCHEMA}}},
                {if:{required:['uses'],properties:{uses:{const:'action.run'}}},
                  then:{properties:{with:FOREACH_TASK_ACTION_RUN_WITH_SCHEMA}}},
              ]},allOf:[{if:{minItems:2},then:{anyOf:[
                {items:{type:'object',properties:{uses:{enum:['result.emit','mcp.call']}}}},
                {contains:{type:'object',required:['uses'],
                  properties:{uses:{enum:['github.run','action.run']}}},minContains:1,maxContains:1},
              ]}}]}}},
        ],description:'Literal repeat uses one Action. Bounded foreach permits one reviewed Action, or 2-4 ordered emit/read-only MCP children with at most one reviewed literal-input GitHub Task; Sessions, multiple Tasks and nesting are unsupported.'},
        approval:{type:'object',additionalProperties:false,required:['required'],
          properties:{required:{const:true}},
          description:'Optional only on a top-level reviewed GitHub Task/Session, max one gate per Plan. Independent one-use decision is required before dispatch.'},
        needs_policy:{enum:['all_succeeded','allow_skipped'],description:'Default all_succeeded. allow_skipped requires nonempty needs; failed/indeterminate dependencies still block downstream effects.'},
        if:{anyOf:[{type:'boolean'},{type:'object'}],description:'Safe Boolean condition; see expression_rules and inline validation.'},
        with:{type:'object',description:'Must match the matching uses/action contract below.'},
      },
      allOf:[
        {if:{properties:{uses:{const:'result.emit'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['result.emit']}}},
        {if:{properties:{uses:{const:'mcp.call'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call']}}},
        {if:{properties:{uses:{const:'http.request'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['http.request']}}},
        {if:{properties:{uses:{const:'github.run'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['github.run']}}},
        {if:{properties:{uses:{const:'action.run'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['action.run']}}},
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
  {id:'action.mcp.write',kind:'action',availability:'supported_with_grant',
   description:'Only the source-reviewed IMA `ima_create_note` or `ima_append_note` tool, with bounded literal content and a fixed numeric note ID for append. One write per Plan; exact operation/schema, explicit write approval and risk acceptance; no dynamic targets, folders, foreach or retry.'},
  {id:'action.http',kind:'action',availability:'supported_with_grant',
   description:'Bounded literal public HTTPS GET/HEAD/POST (JSON) using an exact owner-approved URL/method; no caller headers, query, credentials, redirects or automatic retries. Unknown effects remain indeterminate.'},
  {id:'action.run.github',kind:'action',availability:'supported_with_grant',
   description:'New reviewed GitHub Action source spelling: uses=action.run, with.executor=github; existing exact-source Publish grants and OIDC/Session rules remain mandatory. Cloudflare has a separate explicit Provider/Deployment grant and Session Ready verification gate; discovery never grants either executor.'},
  {id:'action.run.cloudflare',kind:'action',availability:'supported_with_grant',
   description:'One explicitly approved, version-pinned Weixin OpenList Session Ready, verified download completion, or Bark encrypted Owner notification per Plan. Exact contract and Worker deployment grants at Publish; no arbitrary URL/recipient or automatic send retry.'},
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
  {id:'flow.foreach_emit',kind:'flow',availability:'supported',
   description:'Dynamic array of at most 8 elements; one result.emit template with native snapshot checkpoints. Pure multi-step templates have a separate capability; external Actions need their own grant and replay constraints.'},
  {id:'flow.foreach_multi_emit',kind:'flow',availability:'supported',
    description:'2-4 ordered result.emit children per bounded item, referencing earlier children of the same item. Native checkpoints and D1 timeline; maximum 32 reserved Steps. No external Actions or nested loops.'},
  {id:'flow.foreach_multi_mcp_read',kind:'flow',availability:'supported_with_grant',
    description:'2-4 ordered emit and reviewed read-only MCP children per item, with item-local result refs, native arguments snapshots, D1 one-shot dispatch fences and fail-closed uncertainty; no writes, GitHub Tasks or nesting.'},
  {id:'flow.foreach_mcp_read',kind:'flow',availability:'supported_with_grant',
   description:'One reviewed read-only mcp.call per bounded item; all arguments and conditions are frozen before dispatch. Every child uses a durable D1 one-shot dispatch fence; an ambiguous response stays indeterminate, not retried.'},
  {id:'flow.foreach_emit_task_emit',kind:'flow',availability:'supported_with_grant',
    description:'Strict emit → one source-reviewed literal-input GitHub Task → emit per item. Durable Task Attempt, signed OIDC receipt and GitHub physical terminal proof; following emit receives completed item-local output.'},
  {id:'flow.foreach_mixed_task',kind:'flow',availability:'supported_with_grant',
    description:'2-4 ordered emit/read-only MCP steps with at most one source-reviewed literal-input GitHub Task. Each earlier child must succeed before downstream effects; reuse pinned grants, one-shot fences and physical Task proof.'},
  {id:'flow.foreach_github_task',kind:'flow',availability:'supported_with_grant',
   description:'Bounded reviewed GitHub Task per item; literal or exact current-item input refs with pinned provider types, complete native snapshot and D1 input SHA-256 proof before unique Attempt + OIDC Claim. Sessions and nested templates remain unsupported.'},
  {id:'flow.wait',kind:'flow',availability:'supported',
    description:'Durable relative time delay using Cloudflare step.sleep, 1–300 literal seconds per Step and at most 300 seconds total per Published Plan. Wait retains a Run capacity slot; downstream effects require completion. No external event receiver or Approval Gate.'},
  {id:'flow.approval_gate',kind:'flow',availability:'supported_with_grant',
   description:'Optional one-use owner API decision before a reviewed top-level GitHub Task/Session. Runs wait up to 600 seconds. Decision must match Run, Step, and Published Version; approval never substitutes for Publish grants.'},
  {id:'flow.wait_event',kind:'flow',availability:'supported',
    description:'One authenticated signal per existing Run/Step, independent per-Step bearer digest and stable event ID; native waitForEvent with a 1–3600 second timeout, existing Run quota and D1 one-shot receipt. No Approval Gate or new Run admission.'},
  {id:'flow.loop',kind:'flow',availability:'supported',
   description:'Bounded dynamic while/until, 1–8 iterations, with one pure result.emit body or separately granted read-only mcp.call. Nested loops and other external Action bodies remain unsupported.'},
  {id:'flow.loop_mcp_read',kind:'flow',availability:'supported_with_grant',
   description:'One owner-reviewed read-only MCP Action per bounded iteration. Native argument snapshot, D1 one-shot child fence and Portal generation-scoped approval; unknown effects stop the loop.'},
  {id:'flow.child',kind:'flow',availability:'supported_with_grant',
   description:'At most one pinned non-recursive child per parent (flow: child, not child_workflow). Default mode awaits completion and reserves two of eight Run units. Explicit mode: detached instead reserves an independent child slot and returns a child Run reference after confirmed native creation. Both modes require exact required_children/approved_children grants; no inherited child credentials or false external cancellation guarantees.'},
  {id:'flow.child.detached',kind:'flow',availability:'supported_with_grant',
   description:'Explicit mode: detached on one pinned flow: child; exact approved_children required. Child consumes its own 1-of-8 slot and starts under its own immutable Plan. Parent returns a child Run reference after confirmed native creation without waiting; parent completion does not stop it. An uncertain native start is never blindly retried.'},
  {id:'flow.saga',kind:'flow',availability:'supported_with_grant',
   description:'Native Cloudflare rollback for explicitly approved temporary Ubuntu GitHub Sessions only. Serial deterministic DAG; rollback sends one physical cancellation request and reports pending until verified terminal. Other effects cannot declare compensation; no ACID rollback.'},
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
 'GITHUB_ACTION_APPROVED_REPOSITORIES'|'WORKFLOW_GITHUB_DISPATCH_TOKEN'|'GITHUB_ACTION_OIDC_AUDIENCE'|'WEIXIN_ACTION_DEPLOYMENT_ID'|'WEIXIN_ACTION_PROVIDER'|'BARK_ACTION_DEPLOYMENT_ID'|'BARK_ACTION_PROVIDER'> & {DB?:Env['DB']},
 id?:string,portalDiscovery:typeof discoverPortalTools=discoverPortalTools){
  const portalReady=env.MCP_PORTAL_ENDPOINT===PRODUCTION_PORTAL_ENDPOINT &&
    !!env.MCP_PORTAL_CLIENT_ID && !!env.MCP_PORTAL_CLIENT_SECRET;
  // Discover runtime state without broadening the reviewed Portal target.
  // Missing/unreadable D1 fails closed in production; compiler-only fixtures
  // that intentionally omit DB continue to show configured_unverified.
  const portalState=env.DB?await portalAuthorization(env.DB):null;
  const portalRevoked=portalState?.state==='revoked';
  const httpState=env.DB?await httpAuthorization(env.DB):null;
  let githubReady=false;
  try {
    githubReady=approvedActionRepositories(env.GITHUB_ACTION_APPROVED_REPOSITORIES).length>0 &&
      !!env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  }catch { githubReady=false; } // invalid scope is never treated as approved
  const cloudflareReady=(!!env.WEIXIN_ACTION_PROVIDER&&!!env.WEIXIN_ACTION_DEPLOYMENT_ID&&githubReady)||
    (!!env.BARK_ACTION_PROVIDER&&!!env.BARK_ACTION_DEPLOYMENT_ID);
  const availability=(entry:Entry)=>
    entry.id==='action.http'&&httpState?.state==='revoked'?'revoked':
    (['action.mcp.call','action.mcp.write','flow.foreach_mcp_read','flow.foreach_multi_mcp_read','flow.loop_mcp_read'].includes(entry.id))&&portalRevoked?'revoked':
    (['action.mcp.call','action.mcp.write','flow.foreach_mcp_read','flow.foreach_multi_mcp_read','flow.loop_mcp_read'].includes(entry.id))&&!portalReady?'unavailable':
    (entry.id==='action.run.github'||entry.id==='action.github.run'||entry.id==='flow.foreach_github_task'||entry.id==='flow.foreach_emit_task_emit'||entry.id==='flow.foreach_mixed_task')&&!githubReady?'unavailable':
    entry.id==='action.run.cloudflare'&&!cloudflareReady?'unavailable':
    entry.id==='flow.foreach_mixed_task'&&portalRevoked?'revoked':
    entry.id==='flow.foreach_mixed_task'&&!portalReady?'unavailable':
    entry.id==='trigger.github_event'&&!env.GITHUB_ACTION_OIDC_AUDIENCE?'unavailable':
    ['action.run.cloudflare','action.mcp.call','action.mcp.write','action.run.github','action.github.run','flow.foreach_mcp_read','flow.foreach_multi_mcp_read','flow.loop_mcp_read','flow.foreach_github_task','flow.foreach_emit_task_emit','flow.foreach_mixed_task'].includes(entry.id)?'configured_unverified':entry.availability;
  if(id===undefined)return {
    definition_schema:WORKFLOW_DEFINITION_SCHEMA,
    action_with_schemas:WORKFLOW_ACTION_WITH_SCHEMAS,
    expression_rules:WORKFLOW_EXPRESSION_RULES,
    limits:PLAN_LIMITS,
    capability_ids:entries.map(entry=>({
      id:entry.id,kind:entry.kind,availability:availability(entry),description:entry.description,
    })),
    connections:{portal:portalReady?{endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read',
      availability:portalRevoked?'revoked':'configured_unverified',
      ...(portalState?{generation:portalState.generation}:{})}:{availability:'unavailable'},
      http:{availability:httpState?.state??'not_checked',
        generation:httpState?.generation??null,
        reenable_requires_new_published_plan:true}},
    availability_note:'Configured means credentials exist, not verified access or publication permission.',
    github_repository_scope:githubReady?'configured':'unavailable',
    tools:{discover_actions:'workflow_action_list',validate:'workflow_validate',
      create:'workflow_create',publish:'workflow_publish',start:'workflow_run',
      connection_status:'workflow_connection_status',connection_revoke:'workflow_connection_revoke',connection_enable:'workflow_connection_enable',
      status:'workflow_status',result:'workflow_result',approval:'workflow_approval'},
    admission:'Manual, one UTC Cron, one authenticated Webhook or one signed GitHub push relay per Published Plan. GitHub Actions is ingress only, not a second business orchestrator.',
    note:'Discovery and inline validation never publish or grant execution.',
  };
  const entry=byId.get(id);
  if(!entry)return {id,availability:'unknown',reason:'unknown_capability'};
  const detail:Record<string,unknown>={...entry,availability:availability(entry),limits:PLAN_LIMITS,
    ...(id==='flow.condition'?{expression_rules:WORKFLOW_EXPRESSION_RULES}:{}),
    ...(id==='action.result.emit'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['result.emit']}:{}),
    ...(id==='action.mcp.call'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call']}:{}),
    ...(id==='action.http'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['http.request']}:{}),
    ...(id==='action.github.run'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['github.run']}:{}),
    ...(id==='action.run.github'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['action.run']}:{}),
    ...(id==='action.run.cloudflare'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['action.run'],
      reviewed_manifest:await cloudflareActionManifest(),
      reviewed_manifests:[await cloudflareActionManifest(),await cloudflareActionManifest('download'),await cloudflareActionManifest('bark')],
      deployment_id:env.WEIXIN_ACTION_DEPLOYMENT_ID??null,
      bark_deployment_id:env.BARK_ACTION_DEPLOYMENT_ID??null}:{}),
  };
  // Design-only contracts make unsupported features discoverable without
  // advertising a second compiler or presenting a publishable DSL example.
  if(id==='flow.loop'){
    detail.example=await compilingExample(boundedLoop);
    detail.loop_policy={modes:['while','until'],max_iterations:PLAN_LIMITS.maxRepeat,
      body:'single result.emit or approved read-only mcp.call',nested:false,external_actions:'reviewed mcp.call only',
      refs:['item.index','item.value'],native_checkpoint:'step.do per condition and iteration (reserved identity)',
      budget:'Maximum iterations reserved in the same 32-step Plan budget',
      exhaustion:'failed:loop_budget_exceeded',replay:'fixed checkpoint identity per iteration'};
  }
  if(id==='flow.child.detached'){
    detail.example=await compilingExample({...awaitedChildExample,
      name:'Pinned detached child (illustrative)',
      steps:awaitedChildExample.steps.map(s=>('flow' in s&&s.flow==='child'?{...s,mode:'detached'}:s))});
    detail.grant={required:['approved_children'],version:'active_immutable_child_version',
      note:'Illustrative UUIDs must be replaced with the real active child and immutable Version. Validate and approve the exact required_children before publication.',
      limits:'One non-recursive child per parent; parent and child independently consume 1 of 8 Run slots'};
    detail.detached_policy={ownership:'Independent child Published Plan and grants',
      completion:'Parent returns pinned child Run reference after confirmed native creation',
      cancellation:'Parent completion or cancellation does not cancel the detached child',
      replay:'Stable child identity; unknown native creation is never blindly retried'};
  }
  if(id==='flow.saga'){
    detail.design_contract={executable:true,source_schema:'saga.on and step.compensate',
      authorization:'Exact pinned GitHub Session grant plus approve_saga_compensation at Publish',
      ordering:'Saga executions are serialized in canonical DAG order; native rollback reverses step start order',
      trigger:'Only saga.on failure/cancel; compensate only confirmed successful temporary Ubuntu Sessions',
      revocation:'Check exact Published grant and current GitHub executor credential before cancellation; no independent GitHub Connection revoke exists',
      replay:'One durable attempt per compensation effect, with indeterminate outcome on unknown dispatch',
      result:'Expose requested, indeterminate and verified terminal separately; never claim ACID rollback'};
  }
  if(id==='action.http'){
    detail.example=await compilingExample({version:1,name:'Approved public HTTPS request',
      steps:[{id:'fetch',uses:'http.request',with:{url:'https://example.com/',method:'GET'}}]});
    detail.connection_auth={state:httpState?.state??'not_checked',
      generation:httpState?.generation??null,revocation_fence:'durable_effect_reservation'};
    detail.grant={required:['approved_http_operations','approve_http_execution','accept_target_risks'],
      target:'literal HTTPS URL, no query, no credentials',methods:['GET','HEAD','POST'],
      response_limit_bytes:8192,one_shot:'durable Run/Step fence; ambiguous outcomes never retried',
      unsupported:['credentials','custom_headers','redirects','dynamic_url','foreach_http']};
  }
  if(id==='action.mcp.write'){
    const discovered=portalRevoked?{availability:'revoked' as const,write_tools:[]}:await portalDiscovery(env);
    const writeTools=discovered.write_tools??[];
    detail.availability=portalRevoked?'revoked':writeTools.length?'verified_contract':
      discovered.availability==='unavailable'?'unavailable':'not_authorized';
    detail.discovered_tools=writeTools;
    if(writeTools.length){
      detail.example=await compilingExample({version:1,name:'One reviewed IMA note',steps:[
        {id:'note',uses:'mcp.call',with:{endpoint:writeTools[0].endpoint,tool:writeTools[0].tool,
          scope:'write',input_schema:writeTools[0].input_schema,
          ...(writeTools[0].output_schema?{output_schema:writeTools[0].output_schema}:{}),
          arguments:writeTools[0].arguments}}]});
    }
    detail.connection_auth={state:portalState?.state??'not_checked',generation:portalState?.generation??null,
      reenable_requires_new_published_plan:true,revocation_fence:'durable_effect_reservation'};
    detail.grant={scope:'write',tools:[...REVIEWED_WRITE_TOOLS],
      required:['approved_operations','approve_mcp_write_execution','accept_target_risks'],
      constraints:'One reviewed IMA note write per Plan. Create needs literal content (1–2048 chars); append needs literal existing numeric note_id (8–24 digits) plus content (1–2048 chars). No folder target, dynamic refs, foreach or automatic retries. Unknown effects remain indeterminate.'};
  }
  if(id==='flow.approval_gate'){
    detail.approval_gate={when:'before_dispatch',binding:['run_id','step_id','published_version_id'],
      high_impact:'reviewed_github_task_or_session',max_per_plan:1,timeout_seconds:600,
      shape:{approval:{required:true}},decision_tool:'workflow_approval',
      effect:'once',human_presence:'not_independently_verified',
      denial_or_timeout:'no_dispatch',additional_publish_authority:false};
  }
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
  if(id==='flow.wait'){
    detail.example=await compilingExample(boundedWait);
    detail.wait_policy={duration_seconds:{min:1,max:PLAN_LIMITS.maxWaitSeconds,literal_only:true},
      total_budget_seconds:PLAN_LIMITS.maxWaitSeconds,
      native_checkpoint:'step.sleep',run_capacity:'held while waiting',
      signal_events:'unsupported',cancellation:'native instance termination is separately observed'};
  }
  if(id==='flow.wait_event'){
    detail.example=await compilingExample(eventWait);
    detail.event_policy={native_checkpoint:'step.waitForEvent',delivery:'POST /events/{run_id}/{step_id}',
      credential:'Independent 32-byte base64url Bearer; Plan stores token_sha256 only',
      event_id:'X-Workflow-Event-Id required; replay requires same ID and body',
      timeout_seconds:{min:1,max:PLAN_LIMITS.maxEventWaitSeconds},max_per_plan:1,
      semantics:'Run and Step must be pinned and active; an ACK is not proof of resumed execution',
      example_credentials:'Illustrative digest only; replace before publishing'};
  }
  if(id==='flow.child'){
    detail.example=await compilingExample(awaitedChildExample);
    detail.grant={required:['approved_children'],version:'active_immutable_child_version',
      note:'Example UUIDs are illustrative, not deployed Workflows. First publish a real child, replace both identifiers with its real workflow_id and published_version_id, call workflow_validate for required_children and approve that exact list before workflow_publish. Compilation alone is not publication authority.',
      limits:'One non-recursive child per parent; awaited reserves 2 of 8 Run units, detached consumes two independent 1-of-8 slots'};
  }
  if(id==='flow.foreach_multi_emit'){
    detail.example=await compilingExample(foreachMultiEmit);
    detail.template_policy={allowed_action:'result.emit',min_steps:2,
      max_steps:PLAN_LIMITS.maxForeachTemplateSteps,
      max_items:PLAN_LIMITS.maxForeachItems,maximum_flattened_steps:PLAN_LIMITS.maxSteps,
      references:'Only earlier template steps in the same item, plus declared outer needs',
      snapshot:'native item array snapshot, then unique per-child checkpoints',
      external_actions:'unsupported',nested:'unsupported'};
  }
  if(id==='flow.foreach_emit'){
    detail.example=await compilingExample(foreachEmit);
    detail.template_policy={allowed_action:'result.emit',max_items:PLAN_LIMITS.maxForeachItems,
      maximum_flattened_steps:PLAN_LIMITS.maxSteps,snapshot:'native step.do before first child',
      empty_array:'skipped',external_actions:'unsupported'};
  }
  if(id==='flow.foreach_emit_task_emit'){
    const discovered=githubReady?await listAvailableGitHubActions(env):{actions:[]};
    const task=discovered.actions.find(a=>a.can_publish&&a.type==='task'&&
      'ref' in a&&typeof a.ref==='string'&&Object.values(a.inputs).every(x=>!x.required||x.default!==undefined));
    detail.availability=task?'publishable_after_owner_approval':'no_verified_published_task';
    if(task&&'ref' in task&&typeof task.ref==='string')
      detail.example=await compilingExample(foreachEmitTaskEmit({...task,ref:task.ref}));
    detail.template_policy={stages:['result.emit','github.run','result.emit'],
      github_task_count:1,github_inputs:'literal_only',task_type:'task',
      max_items:PLAN_LIMITS.maxForeachItems,maximum_flattened_steps:PLAN_LIMITS.maxSteps,
      required_publish_grants:['approved_actions','approve_heavy_execution'],
      outcome:'Next stage only after signed receipt and independently verified physical Task success',
      replay:'Native Task checkpoints plus UNIQUE D1 Attempt; no blind dispatch retries',
      unsupported:['session','multiple_github_tasks','dynamic_task_inputs','nesting']};
  }
  if(id==='flow.foreach_mixed_task'){
    const [discovered,portal]=await Promise.all([
      githubReady?listAvailableGitHubActions(env):Promise.resolve({actions:[]}),
      portalRevoked?Promise.resolve({availability:'revoked' as const,tools:[],reason:'portal_connection_revoked'}):portalDiscovery(env),
    ]);
    const task=discovered.actions.find(a=>a.can_publish&&a.type==='task'&&
      'ref' in a&&typeof a.ref==='string'&&Object.values(a.inputs).every(x=>!x.required||x.default!==undefined));
    detail.availability=portalRevoked?'revoked':task&&portal.tools.length?'publishable_after_owner_approval':
      !task?'no_verified_published_task':portal.availability;
    if(task&&'ref' in task&&typeof task.ref==='string'&&portal.tools.length)
      detail.example=await compilingExample(foreachMixedMcpTask({...task,ref:task.ref},portal.tools[0]!));
    detail.template_policy={allowed_actions:['result.emit','mcp.call','github.run'],
      github_task_count:1,github_inputs:'literal_only',task_type:'task',mcp_scope:'read',
      min_steps:2,max_steps:PLAN_LIMITS.maxForeachTemplateSteps,
      max_items:PLAN_LIMITS.maxForeachItems,maximum_flattened_steps:PLAN_LIMITS.maxSteps,
      required_publish_grants:['approved_operations','accept_target_risks','approved_actions','approve_heavy_execution'],
      dependency:'Each earlier child must succeed before subsequent stages execute',
      replay:'Native snapshots, D1 MCP fence and UNIQUE GitHub Attempt; unknown effects stop the pipeline',
      unsupported:['session','multiple_github_tasks','dynamic_task_inputs','write-scope_tools','nesting']};
  }
  if(id==='flow.foreach_github_task'){
    const discovered=githubReady?await listAvailableGitHubActions(env):{actions:[]};
    const task=discovered.actions.find(a=>a.can_publish&&a.type==='task'&&
      'ref' in a&&typeof a.ref==='string'&&Object.values(a.inputs).every(x=>!x.required||x.default!==undefined));
    detail.availability=task?'publishable_after_owner_approval':'no_verified_published_task';
    if(task&&'ref' in task&&typeof task.ref==='string'){
      const sample=foreachGithubTask({...task,ref:task.ref});
      detail.example=await compilingExample(sample);
      // A second compiler-checked example demonstrates the exact syntax,
      // selected from an actual verified input rather than inventing a field.
      const candidate=Object.entries(task.inputs).find(([,field])=>field.default!==undefined);
      if(candidate){
        const [input,field]=candidate;
        const dynamic=structuredClone(sample) as unknown as {
          inputs:{items:unknown[]};
          steps:Array<{template:{steps:Array<{with:{action:{inputs:Record<string,unknown>}}}>}}>;
        };
        dynamic.inputs.items=[field.default,field.default];
        dynamic.steps[0]!.template.steps[0]!.with.action.inputs[input]={ref:'item.value'};
        detail.dynamic_example=await compilingExample(dynamic);
      }
    }
    detail.template_policy={allowed_action:'github.run',type:'task',
      inputs:'literal or exact {ref:"item.value[.<field>]"} / {ref:"item.index"} only; typed by reviewed Action',
      input_snapshot:'All selected values validated against pinned provider types and choices before first dispatch; each input map SHA-256 pinned to D1 before Attempt',
      max_items:PLAN_LIMITS.maxForeachItems,maximum_flattened_steps:PLAN_LIMITS.maxSteps,
      replay:'D1 UNIQUE(run_id,step_id) Attempt before single GitHub POST; no blind retries',
      physical_state:'verified GitHub terminal plus signed OIDC Claim/receipt',
      requires:['approved_actions','approve_heavy_execution'],
      unsupported:['session','arbitrary dynamic input expressions','nested templates']};
  }
  if(id==='flow.foreach_multi_mcp_read'){
    const discovered=portalRevoked?{availability:'revoked' as const,tools:[],reason:'portal_connection_revoked'}:
      await portalDiscovery(env);
    detail.availability=discovered.availability;
    detail.discovered_tools=discovered.tools;
    if(discovered.reason)detail.reason=discovered.reason;
    if(discovered.tools.length)
      detail.example=await compilingExample(foreachMultiMcpRead(discovered.tools[0]));
    detail.template_policy={allowed_actions:['result.emit','mcp.call'],scope:'read',
      min_steps:2,max_steps:PLAN_LIMITS.maxForeachTemplateSteps,
      max_items:PLAN_LIMITS.maxForeachItems,maximum_flattened_steps:PLAN_LIMITS.maxSteps,
      args_snapshot:'Native checkpoint for each child, with references to earlier child outputs in the same item',
      replay:'D1 child dispatch fence before tools/call; lost checkpoints stay indeterminate, never re-dispatched',
      required_publish_grants:['approved_operations','accept_target_risks'],
      unsupported:['github.run','nested templates','write-scope tools']};
  }
  if(id==='flow.loop_mcp_read'){
    const discovered=portalRevoked?{availability:'revoked' as const,tools:[],reason:'portal_connection_revoked'}:
      await portalDiscovery(env);
    detail.availability=discovered.availability;
    detail.discovered_tools=discovered.tools;
    if(discovered.reason)detail.reason=discovered.reason;
    if(discovered.tools.length){
      const tool=discovered.tools[0]!;
      detail.example=await compilingExample({version:1,name:'Bounded read-only MCP until',
        steps:[{id:'loop',flow:'until',max_iterations:2,
          condition:{eq:[{ref:'item.index'},0]},
          template:{uses:'mcp.call',with:{endpoint:tool.endpoint,tool:tool.tool,
            scope:'read',input_schema:tool.input_schema,
            ...(tool.output_schema?{output_schema:tool.output_schema}:{}),
            arguments:tool.arguments}}}]});
    }
    detail.template_policy={allowed_action:'mcp.call',scope:'read',
      max_iterations:PLAN_LIMITS.maxRepeat,maximum_flattened_steps:PLAN_LIMITS.maxSteps,
      args_snapshot:'Native per-iteration argument checkpoint before external dispatch',
      replay:'D1 one-shot child dispatch fence and Portal generation binding; no blind retry',
      required_publish_grants:['approved_operations','accept_target_risks'],
      unsupported:['nested loops','write-scope tools','GitHub/HTTP/Cloudflare Actions']};
  }
  if(id==='flow.foreach_mcp_read'){
    const discovered=portalRevoked?{availability:'revoked' as const,tools:[],reason:'portal_connection_revoked'}:
      await portalDiscovery(env);
    detail.availability=discovered.availability;
    detail.discovered_tools=discovered.tools;
    if(discovered.reason)detail.reason=discovered.reason;
    if(discovered.tools.length)
      detail.example=await compilingExample(foreachMcpRead(discovered.tools[0]));
    detail.template_policy={allowed_action:'mcp.call',scope:'read',
      max_items:PLAN_LIMITS.maxForeachItems,maximum_flattened_steps:PLAN_LIMITS.maxSteps,
      replay:'D1 child dispatch fence, no blind retries; ambiguous results are indeterminate',
      required_publish_grants:['approved_operations','accept_target_risks'],
      unsupported:['github.run','nested templates','write-scope tools']};
  }
  if(id==='action.mcp.call'){
    const discovered=portalRevoked?{availability:'revoked' as const,tools:[],reason:'portal_connection_revoked'}:
      await portalDiscovery(env);
    detail.availability=discovered.availability;
    detail.discovered_tools=discovered.tools;
    if(discovered.reason)detail.reason=discovered.reason;
    if(discovered.tools.length){
      detail.example=await compilingExample(mcpRead(discovered.tools[0]));
      detail.example_validation='compiler_valid_and_live_contract_discovered; tools/call not performed';
    }
    detail.connection_auth={state:portalState?.state??'not_checked',generation:portalState?.generation??null,
      reenable_requires_new_published_plan:true,revocation_fence:'durable_effect_reservation'};
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
