import { createHash, randomUUID } from 'node:crypto';

const ENDPOINT = 'https://raindrop-mcp-worker.aiyaya.workers.dev/mcp';
const PROTOCOL = '2026-07-28';
const REQUIRED_INPUT_TYPES = {
  collectionId: 'number',
  page: 'number',
  perPage: 'number',
  sort: 'string',
  skipCache: 'boolean'
} as const;

export interface RaindropDiscoveryEvidence {
  endpoint: string;
  tool: 'list_raindrops';
  checkedAt: string;
  schemaSha256: string;
}

/**
 * Check the exact live schema needed by the fixed snapshot. Never return any
 * bookmark data, token, or entire upstream response in acceptance evidence.
 */
export function verifyRaindropToolSchema(raw: unknown): string {
  const tool = record(raw);
  if (tool.name !== 'list_raindrops') throw new Error('RAINDROP_CONTRACT_MISMATCH: tool name.');
  const input = record(tool.inputSchema);
  if (input.type !== 'object') throw new Error('RAINDROP_CONTRACT_MISMATCH: input object.');
  const inputProperties = record(input.properties);
  const required = stringArray(input.required);
  if (!required.includes('collectionId') ||
      required.some(name => !(name in REQUIRED_INPUT_TYPES))) {
    throw new Error('RAINDROP_CONTRACT_MISMATCH: required input fields.');
  }
  for (const [name, type] of Object.entries(REQUIRED_INPUT_TYPES)) {
    if (record(inputProperties[name]).type !== type) {
      throw new Error('RAINDROP_CONTRACT_MISMATCH: input field ' + name);
    }
  }

  const output = record(tool.outputSchema);
  if (output.type !== 'object') throw new Error('RAINDROP_CONTRACT_MISMATCH: output object.');
  const outputProperties = record(output.properties);
  const outputRequired = stringArray(output.required);
  if (!outputRequired.includes('items') || !outputRequired.includes('count') ||
      record(outputProperties.count).type !== 'number') {
    throw new Error('RAINDROP_CONTRACT_MISMATCH: output items/count.');
  }
  const items = record(outputProperties.items);
  if (items.type !== 'array') throw new Error('RAINDROP_CONTRACT_MISMATCH: items array.');
  const item = record(items.items);
  if (item.type !== 'object') throw new Error('RAINDROP_CONTRACT_MISMATCH: bookmark object.');
  const fields = record(item.properties);
  const itemRequired = stringArray(item.required);
  for (const [name, type] of Object.entries({ id: 'number', title: 'string', url: 'string', tags: 'array' })) {
    if (!itemRequired.includes(name) || record(fields[name]).type !== type) {
      throw new Error('RAINDROP_CONTRACT_MISMATCH: bookmark field ' + name);
    }
  }
  if (record(record(fields.tags).items).type !== 'string') {
    throw new Error('RAINDROP_CONTRACT_MISMATCH: tag values.');
  }
  return createHash('sha256')
    .update(JSON.stringify({ inputSchema: input, outputSchema: output }))
    .digest('hex');
}

/** Read-only live tools/list; there is no tools/call or workflow deployment. */
export async function discoverRaindropLiveContract(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<RaindropDiscoveryEvidence> {
  if (!accessToken) throw new Error('WORKFLOW_MCP_ACCESS_TOKEN is required for Raindrop discovery.');
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const requestId = randomUUID();
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
        'Mcp-Method': 'tools/list'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: requestId, method: 'tools/list',
        params: {
          ...(cursor ? { cursor } : {}),
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL,
            'io.modelcontextprotocol/clientInfo': { name: 'raindrop-contract-verifier', version: '0.1.0' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    });
    if (!response.ok) {
      throw new Error('Raindrop tools/list HTTP ' + response.status + '; stop before deployment or manual Run.');
    }
    const envelope = parseEnvelope(await response.text(), response.headers.get('content-type'), requestId);
    if (envelope.error) throw new Error('Raindrop tools/list returned a JSON-RPC error.');
    const listing = record(envelope.result);
    if (!Array.isArray(listing.tools)) throw new Error('RAINDROP_CONTRACT_MISMATCH: missing tools list.');
    const match = listing.tools.find(candidate => {
      return candidate !== null && typeof candidate === 'object' &&
        !Array.isArray(candidate) && candidate.name === 'list_raindrops';
    });
    if (match) {
      return {
        endpoint: ENDPOINT,
        tool: 'list_raindrops',
        checkedAt: new Date().toISOString(),
        schemaSha256: verifyRaindropToolSchema(match)
      };
    }
    if (typeof listing.nextCursor !== 'string' || listing.nextCursor.length === 0) break;
    cursor = listing.nextCursor;
  }
  throw new Error('RAINDROP_CONTRACT_MISMATCH: list_raindrops not found in the live tools/list.');
}

function parseEnvelope(source: string, contentType: string | null, requestId: string): Record<string, unknown> {
  if (contentType?.includes('text/event-stream')) {
    for (const event of source.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const value: unknown = JSON.parse(data);
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          (value as Record<string, unknown>).id === requestId) return record(value);
    }
    throw new Error('Raindrop tools/list SSE response contained no matching JSON-RPC reply.');
  }
  const value = record(JSON.parse(source));
  if (value.id !== requestId) throw new Error('Raindrop tools/list returned a mismatched JSON-RPC ID.');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RAINDROP_CONTRACT_MISMATCH: expected schema object.');
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('RAINDROP_CONTRACT_MISMATCH: expected required-fields array.');
  }
  return value as string[];
}
