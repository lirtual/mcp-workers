import {PRODUCTION_PORTAL_ENDPOINT,scopedPublicMcpFetch} from './mcp-public-fetch.ts';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {toolSchemaDigest} from './plan.ts';
import {REVIEWED_APPEND_TOOL,REVIEWED_WRITE_TOOLS,reviewedWriteTool} from './mcp-write-contract.ts';
import type {Env} from './store.ts';

type PortalConfig=Pick<Env,'WORKFLOW_MCP_PORTAL_ENDPOINT'|'WORKFLOW_MCP_PORTAL_CLIENT_ID'|'WORKFLOW_MCP_PORTAL_CLIENT_SECRET'>;
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
 if(env.WORKFLOW_MCP_PORTAL_ENDPOINT!==PRODUCTION_PORTAL_ENDPOINT ||
    !env.WORKFLOW_MCP_PORTAL_CLIENT_ID||!env.WORKFLOW_MCP_PORTAL_CLIENT_SECRET)
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
     clientId:env.WORKFLOW_MCP_PORTAL_CLIENT_ID,clientSecret:env.WORKFLOW_MCP_PORTAL_CLIENT_SECRET,
   },PRODUCTION_PORTAL_ENDPOINT),
 });
 try{
   await client.connect(transport);
   const result=await client.listTools();
   const contracts=await reviewedPortalTools(result.tools);
   const write_tools=await reviewedPortalWriteTools(result.tools);
   return {availability:contracts.length||write_tools.length?'verified_contract':'not_authorized',
     tools:contracts,write_tools,
     ...(!contracts.length&&!write_tools.length?{reason:'approved_portal_tool_not_present_or_schema_changed'}:{})};
 }catch{
   return {availability:authDenied?'not_authorized':'unavailable',
     tools:[],reason:authDenied?'portal_access_denied':'portal_unreachable'};
 }finally{
   await client.close().catch(()=>{});
 }
}
