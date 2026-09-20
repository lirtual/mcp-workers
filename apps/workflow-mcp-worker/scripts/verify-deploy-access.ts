/**
 * Read-only pre-deployment auth checks. No credentials, tool results or
 * bookmark data are printed. A mismatched secret stops deployment before D1.
 */
const raindropEndpoint = 'https://raindrop-mcp-worker.aiyaya.workers.dev/mcp';
const workflowEndpoint = required('WORKFLOW_MCP_URL').replace(/\/+$/, '') + '/mcp';
const bootstrap = process.env.WORKFLOW_MCP_BOOTSTRAP === 'true';

if (!bootstrap) {
  await verifyTools(workflowEndpoint, required('WORKFLOW_MCP_ACCESS_TOKEN'), 'workflow_list');
  console.log('Existing Workflow MCP access credential matches the live endpoint.');
}
await verifyTools(raindropEndpoint, required('RAINDROP_MCP_ACCESS_TOKEN'), 'list_raindrops');
console.log('Raindrop MCP credential and read-only tool access verified.');

async function verifyTools(url: string, token: string, requiredTool: string): Promise<void> {
  const result = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/list'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'predeploy-access',
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'workflow-deploy-preflight', version: '0.1.0' },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    }),
    signal: AbortSignal.timeout(20_000)
  });

  if (!result.ok) {
    // Do not reflect upstream error bodies, which may contain sensitive data.
    throw new Error(`Predeployment ${requiredTool} authentication failed (HTTP ${result.status}).`);
  }
  const response = await result.text();
  const contentType = result.headers.get('content-type') || '';
  const data = contentType.includes('text/event-stream')
    ? response.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
        .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
        .find(Boolean)
    : response;
  if (!data) throw new Error(`Predeployment ${requiredTool} returned no response envelope.`);
  const envelope = JSON.parse(data) as {
    jsonrpc?: string;
    id?: string | number | null;
    error?: unknown;
    result?: { tools?: Array<{ name?: string }> };
  };
  if (envelope.jsonrpc !== '2.0' || envelope.id !== 'predeploy-access' ||
      envelope.error || !envelope.result?.tools?.some(tool => tool.name === requiredTool)) {
    throw new Error(`Predeployment ${requiredTool} was not available at the authenticated endpoint.`);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required before predeployment verification.`);
  return value;
}
