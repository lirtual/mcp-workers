// Read-only live OpenList Service Binding acceptance after a separately authorized release.
// Do not log paths, entries, response bodies, credentials or request headers.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectWorkerVars } from './worker-release-variables.mjs';

export const OPENLIST_MCP_URL = 'https://openlist-mcp-worker.aiyaya.workers.dev/mcp';
const MAX_RPC_BYTES = 64 * 1024;

function fail(code) {
  throw new Error('openlist_smoke_' + code);
}

async function boundedText(response) {
  const size = response.headers.get('content-length');
  if (size !== null && (!/^[0-9]+$/.test(size) || Number(size) > MAX_RPC_BYTES))
    fail('response_too_large');
  const reader = response.body?.getReader();
  if (!reader) fail('response_missing_body');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RPC_BYTES) fail('response_too_large');
      chunks.push(value);
    }
  } catch {
    fail('response_unavailable');
  } finally {
    // Do not await cancellation: a tee/cloned response can hold the other branch.
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { fail('invalid_encoding'); }
}

function parseRpc(response, text) {
  const type = response.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/event-stream')
    fail('invalid_content_type');
  let value;
  try {
    if (type === 'application/json') value = JSON.parse(text);
    else {
      const matches = [...text.matchAll(/^data:\s*(\{.*\})\s*$/gm)];
      if (matches.length !== 1) fail('invalid_sse');
      value = JSON.parse(matches[0][1]);
    }
  } catch { fail('invalid_rpc_json'); }
  if (!value || value.jsonrpc !== '2.0' || value.id !== 1 || value.error ||
      !value.result || value.result.isError === true ||
      !Array.isArray(value.result.content) || value.result.content.length !== 1 ||
      value.result.content[0]?.type !== 'text' ||
      typeof value.result.content[0].text !== 'string')
    fail('rpc_failed');
  let body;
  try { body = JSON.parse(value.result.content[0].text); }
  catch { fail('invalid_tool_json'); }
  return body;
}

export async function runOpenListProductionReadSmoke(env, transport = fetch) {
  const token = env.MCP_ACCESS_TOKEN;
  if (typeof token !== 'string' || token.trim() !== token || !token ||
      /[\r\n]/.test(token)) fail('missing_token');

  // Reuse the guarded release's root parser rather than maintaining a second
  // interpretation of OPENLIST_ALLOWED_ROOTS.
  try { collectWorkerVars('openlist-mcp-worker', env); }
  catch { fail('invalid_roots'); }
  let roots;
  try { roots = JSON.parse(env.OPENLIST_ALLOWED_ROOTS); }
  catch { fail('invalid_roots'); }
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 16)
    fail('invalid_roots');

  for (const root of roots) {
    // Each configured logical root is checked, including empty directories.
    const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'openlist_list_files',arguments:{path:root,page:1,per_page:1}}});
    let response;
    try {
      response = await transport(new Request(OPENLIST_MCP_URL,{
        method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),
        headers:{authorization:'Bearer '+token,'content-type':'application/json',
          accept:'application/json, text/event-stream'},
        body,
      }));
    } catch { fail('upstream_unreachable'); }
    if (response.status !== 200 || response.redirected ||
        response.headers.has('location')) fail('transport_denied');
    const result = parseRpc(response, await boundedText(response));
    if (!result || result.operation !== 'openlist_list_files' ||
        result.status !== 'succeeded' || result.code !== 'OK' ||
        result.target !== root ||
        !result.observed_state || !Array.isArray(result.observed_state.entries) ||
        result.observed_state.entries.length > 1 ||
        !Number.isSafeInteger(result.observed_state.total) ||
        result.observed_state.total < result.observed_state.entries.length ||
        result.observed_state.page !== 1)
      fail('binding_or_root_unverified');
  }
  return roots.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOpenListProductionReadSmoke(process.env)
    .then(count => console.log('OPENLIST_PRODUCTION_READ_OK verified_roots='+count))
    .catch(error => {
      const code = typeof error?.message === 'string' &&
        /^openlist_smoke_[a-z0-9_]+$/.test(error.message) ?
        error.message : 'openlist_smoke_unknown';
      console.error('OPENLIST_PRODUCTION_READ_FAILED '+code);
      process.exitCode = 1;
    });
}
