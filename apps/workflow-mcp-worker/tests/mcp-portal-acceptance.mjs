/**
 * Manual Workflow-only Portal authentication and read-only listing probe from
 * the trusted GitHub Environment. Never log credentials, headers or tool data.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scopedPublicMcpFetch, PRODUCTION_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';

const endpoint=PRODUCTION_PORTAL_ENDPOINT;
console.log('PORTAL_PROBE_TARGET production');
const clientId=process.env.WORKFLOW_MCP_PORTAL_CLIENT_ID;
const clientSecret=process.env.WORKFLOW_MCP_PORTAL_CLIENT_SECRET;
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
const client=new Client({name:'workflow-mcp-portal-acceptance',version:'0.1.0'});
const transport=new StreamableHTTPClientTransport(new URL(endpoint),{fetch:guardedFetch});
try {
  await client.connect(transport);
  console.log('MCP_INITIALIZE_OK');
  const listing=await client.listTools();
  console.log('MCP_TOOLS_LIST_OK',listing.tools.length);
  // Workflow-only: do not access unrelated Portal tools or business data.
  // Verify client → production Portal → Workflow read-only path; no D1 writes.
  const workflow=listing.tools.find(t=>
    /(^|[._-])workflow_list$/.test(t.name)&&
    t.annotations?.readOnlyHint===true&&
    t.annotations?.destructiveHint!==true);
  if(!workflow) throw new Error('workflow_readonly_tool_unavailable');
  console.log('WORKFLOW_PORTAL_READONLY_TOOL_DISCOVERED',workflow.name);
  const result=await client.callTool({name:workflow.name,arguments:{}});
  if(result.isError) throw new Error('workflow_readonly_tool_error');
  console.log('WORKFLOW_PORTAL_READONLY_CALL_OK');
} catch(error) {
  // Intentionally do not print exception strings, HTTP bodies or headers.
  console.error('PORTAL_ACCEPTANCE_FAIL',error instanceof Error?error.name:'unknown','HTTP',lastHttpStatus);
  process.exitCode=1;
} finally {
  // Portal HTTP sessions can remain open after every read-only assertion passes.
  // Bound cleanup and terminate this one-shot CLI; no writes or remote jobs exist.
  const closed = await Promise.race([
    client.close().then(() => true, () => true),
    new Promise(resolve => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!closed) console.warn('PORTAL_ACCEPTANCE_CLOSE_TIMEOUT');
  process.exit(process.exitCode ?? 0);
}
