const baseUrl = required('WORKFLOW_MCP_URL').replace(/\/+$/, '');

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) {
  throw new Error(`Workflow MCP health failed with status ${health.status}.`);
}
const healthBody = asObject(await health.json());
if (healthBody.status !== 'ok') {
  throw new Error('Workflow MCP health payload is invalid.');
}

const unauthenticated = await fetch(`${baseUrl}/mcp`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'probe', method: 'initialize', params: {} })
});
if (unauthenticated.status !== 401) {
  throw new Error(`Unauthenticated MCP probe expected 401, received ${unauthenticated.status}.`);
}
const unauthenticatedBody = asObject(await unauthenticated.json());
if (unauthenticatedBody.error !== 'unauthorized') {
  throw new Error('Unauthenticated MCP probe did not fail closed.');
}

console.log('Release probe passed: health ok, unauthenticated MCP denied.');

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object in release probe.');
  }
  return value as Record<string, unknown>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
