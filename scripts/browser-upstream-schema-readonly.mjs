// Temporary, single-use diagnostic. Remove after the authorized production read.
// Never log the token, response body, tool descriptions or error text.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BROWSER_TOOLS, BROWSER_UUIDV7_PATTERN } from './register-browser-portal.mjs';

const INTENT_TOOLS = [
  'browser_click','browser_fill','browser_keypress','browser_scroll','browser_select',
  'browser_tab_open','browser_tab_navigate','browser_tab_close','browser_operation_status',
];
const ENDPOINT = 'https://browser.lirtual.dpdns.org/mcp';
const MAX_BYTES = 131072;

export function summarizeSchemaDiscovery(payload) {
  if (payload?.jsonrpc !== '2.0' || payload?.id !== 1 ||
      !Array.isArray(payload?.result?.tools)) throw Error('invalid_discovery');
  const tools = payload.result.tools;
  const byName = new Map(tools.map(t => [t.name, t]));
  const completeInventory = byName.size === BROWSER_TOOLS.length &&
    tools.length === BROWSER_TOOLS.length &&
    BROWSER_TOOLS.every(name => byName.has(name));
  const uuidv7 = INTENT_TOOLS.every(name =>
    byName.get(name)?.inputSchema?.properties?.intent_key?.pattern === BROWSER_UUIDV7_PATTERN);
  const receipt = byName.get('browser_operation_status')?.inputSchema;
  const receiptOk = !!receipt && !Object.hasOwn(receipt, 'oneOf') &&
    receipt.additionalProperties === false &&
    JSON.stringify(receipt.required) === '["endpoint_id"]' &&
    Object.keys(receipt.properties ?? {}).sort().join(',') === 'endpoint_id,intent_key,operation_id';
  return {tool_count: tools.length, uuidv7_pattern: uuidv7 && completeInventory,
    operation_status_schema: receiptOk && completeInventory};
}

async function readBounded(response) {
  if (!response.body) throw Error('empty_discovery');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw Error('discovery_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {buffer.set(chunk, offset); offset += chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(buffer));
}

async function main() {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token?.trim()) throw Error('missing_runner_token');
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    redirect: 'manual',
    headers: {'Content-Type':'application/json',
      'Accept':'application/json, text/event-stream',
      'Authorization':'Bearer ' + token},
    body: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list'}),
    signal: AbortSignal.timeout(12000),
  });
  if (response.status !== 200) throw Error('upstream_not_available');
  const result = summarizeSchemaDiscovery(await readBounded(response));
  console.log('BROWSER_UPSTREAM_SCHEMA tools=' + result.tool_count +
    ' uuidv7_pattern=' + (result.uuidv7_pattern ? 'PASS' : 'FAIL') +
    ' operation_status_schema=' + (result.operation_status_schema ? 'PASS' : 'FAIL'));
  if (!result.uuidv7_pattern || !result.operation_status_schema) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('BROWSER_UPSTREAM_SCHEMA probe_failed');
    process.exitCode = 1;
  });
}
