/**
 * Manual, non-deploying S2 candidate acceptance from the trusted GitHub
 * Environment. Never log a bearer, service token, request headers or tool data.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scopedPublicMcpFetch, TRUSTED_PORTAL_ENDPOINT, PRODUCTION_PORTAL_ENDPOINT } from '../src/s2-public-fetch.ts';
import { toolSchemaDigest } from '../src/plan.ts';

const target=process.env.S2_PORTAL_TARGET || 'test';
if(target!=='test'&&target!=='production')throw Error('invalid_portal_probe_target');
const endpoint=target==='production'?PRODUCTION_PORTAL_ENDPOINT:TRUSTED_PORTAL_ENDPOINT;
console.log('PORTAL_PROBE_TARGET',target);
const clientId=process.env.S2_PORTAL_CLIENT_ID;
const clientSecret=process.env.S2_PORTAL_CLIENT_SECRET;
if(!clientId||!clientSecret) {
  console.error('PORTAL_ACCEPTANCE_FAIL: secret_missing');
  process.exit(1);
}
let lastHttpStatus=0;
const guardedFetch=scopedPublicMcpFetch(endpoint, async request => {
  const response=await fetch(request);
  lastHttpStatus=response.status;
  return response;
}, {clientId,clientSecret}, endpoint);
const client=new Client({name:'workflow-s2-portal-acceptance',version:'0.1.0'});
const transport=new StreamableHTTPClientTransport(new URL(endpoint),{fetch:guardedFetch});
try {
  await client.connect(transport);
  console.log('MCP_INITIALIZE_OK');
  const listing=await client.listTools();
  console.log('MCP_TOOLS_LIST_OK',listing.tools.length);
  // Only tool names and read-only flags are printed; never the tool outputs.
  console.log('AVAILABLE_TOOLS',JSON.stringify(listing.tools.map(t=>({
    name:t.name,readOnly:t.annotations?.readOnlyHint===true,
  }))));
  const candidate=listing.tools.find(t=>
    /(^|[._-])list_notebooks$/.test(t.name)&&
    t.annotations?.readOnlyHint===true&&
    t.annotations?.destructiveHint!==true);
  if(!candidate) throw new Error('ima_readonly_tool_unavailable');
  console.log('APPROVABLE_IMA_TOOL',candidate.name);
  console.log('TOOL_SCHEMA_SHA256',await toolSchemaDigest(candidate.inputSchema,candidate.outputSchema));
  const output=await client.callTool({name:candidate.name,arguments:{limit:1}});
  if(output.isError) throw new Error('ima_readonly_tool_error');
  console.log('IMA_READONLY_CALL_OK');
  // On production One-MCP (not the isolated test Portal), verify the actual
  // end-to-end client → Portal → Workflow read-only tool path. No D1 writes.
  if(target==='production'){
    const workflow=listing.tools.find(t=>
      /(^|[._-])workflow_list$/.test(t.name)&&
      t.annotations?.readOnlyHint===true&&
      t.annotations?.destructiveHint!==true);
    if(!workflow) throw new Error('workflow_readonly_tool_unavailable');
    console.log('WORKFLOW_PORTAL_READONLY_TOOL_DISCOVERED',workflow.name);
    const result=await client.callTool({name:workflow.name,arguments:{}});
    if(result.isError) throw new Error('workflow_readonly_tool_error');
    console.log('WORKFLOW_PORTAL_READONLY_CALL_OK');
  }
} catch(error) {
  // Intentionally do not print exception strings, HTTP bodies or headers.
  console.error('PORTAL_ACCEPTANCE_FAIL',error instanceof Error?error.name:'unknown','HTTP',lastHttpStatus);
  process.exitCode=1;
} finally {
  await client.close().catch(()=>{});
}
