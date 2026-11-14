import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseGatewayResource,
  authorizeGatewayMessage,
  filterGatewayToolList,
} from '../src/gateway-core.ts';

const origin = 'https://gateway.example.test';

test('only a canonical, fixed-host MCP resource can select an upstream', () => {
  assert.equal(parseGatewayResource(origin + '/mcp/sentry', origin), 'sentry');
  for (const url of [
    origin + '/mcp/portal', origin + '/mcp/Sentry',
    origin + '/mcp/sentry_extra', origin + '/mcp/sentry?codemode=search_and_execute',
    origin + '/mcp/sentry/', origin + '/mcp/sentry%2Fother',
    'https://evil.example.test/mcp/sentry',
    origin + '/mcp/a'.padEnd(60, 'a'),
  ]) assert.equal(parseGatewayResource(url, origin), null, url);
});

test('only safe MCP tool calls for the selected server can be forwarded', () => {
  const msg = (name) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
  assert.deepEqual(authorizeGatewayMessage(msg('sentry_issue_list'), 'sentry', new Headers()),
    { ok: true, method: 'tools/call' });
  for (const name of ['raindrop_collection_list', 'portal_toggle_single_server',
    'portal_codemode_execute', 'sentry', 'sentry_other']) {
    if (name === 'sentry_other') continue; // a valid tool name for the current namespace
    assert.equal(authorizeGatewayMessage(msg(name), 'sentry', new Headers()).ok, false, name);
  }
  assert.equal(authorizeGatewayMessage(msg('sentry_other'), 'sentry', new Headers()).ok, true);
});

test('rejects unsupported execution surfaces, arrays and misleading MCP method headers', () => {
  const good = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sentry_issue_list' } };
  for (const payload of [
    [good], { ...good, method: 'resources/read' },
    { ...good, method: 'prompts/get' },
    { ...good, method: 'sampling/createMessage' },
    { ...good, method: 'unknown/method' },
    { ...good, params: { name: 'portal_codemode_execute' } },
    { ...good, params: { name: 'sentry_issue_list', arguments: {}, target: 'other' } },
  ]) {
    assert.equal(authorizeGatewayMessage(payload, 'sentry', new Headers()).ok, false);
  }
  assert.equal(authorizeGatewayMessage(good, 'sentry', new Headers({ 'Mcp-Method': 'tools/list' })).ok, false);
  assert.equal(authorizeGatewayMessage(good, 'sentry', new Headers({ 'Mcp-Name': 'raindrop_other' })).ok, false);
  assert.equal(authorizeGatewayMessage(good, 'sentry', new Headers({ 'Mcp-Name': 'sentry_issue_list', 'Mcp-Method': 'tools/call' })).ok, true);
});

test('permits protocol initialization and tool discovery but not Portal administration', () => {
  for (const method of ['initialize', 'ping', 'tools/list']) {
    assert.equal(authorizeGatewayMessage({ jsonrpc: '2.0', id: 1, method }, 'sentry', new Headers()).ok, true);
  }
  assert.equal(authorizeGatewayMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'sentry', new Headers()).ok, true);
  assert.equal(authorizeGatewayMessage({ jsonrpc: '2.0', method: 'portal/list' }, 'sentry', new Headers()).ok, false);
});

test('tool discovery omits every other server and Portal tools without duplicating an allowlist', () => {
  const response = {
    jsonrpc: '2.0', id: 1,
    result: { tools: [
      { name: 'sentry_issue_list', description: 'Sentry issues' },
      { name: 'raindrop_collection_list', description: 'Raindrop collections' },
      { name: 'portal_toggle_single_server', description: 'switch servers' },
      { name: 'portal_codemode_execute', description: 'execute arbitrary tools' },
      { name: 'sentry_issue_get', description: 'Sentry issue details' },
    ], nextCursor: 'cursor-2', other: 'should not be copied' },
  };
  assert.deepEqual(filterGatewayToolList(response, 'sentry'), {
    jsonrpc: '2.0', id: 1,
    result: { tools: [
      { name: 'sentry_issue_list', description: 'Sentry issues' },
      { name: 'sentry_issue_get', description: 'Sentry issue details' },
    ], nextCursor: 'cursor-2' },
  });
  assert.equal(filterGatewayToolList({ jsonrpc: '2.0', result: { tools: 'bad' } }, 'sentry'), null);
});

test('disallows execution notifications, unsupported top-level routing, and method-specific parameter overrides', () => {
  const call = { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'sentry_issue_list', arguments: {} } };
  const cases = [
    { ...call, id: undefined },
    { ...call, id: null },
    { ...call, id: { retry: true } },
    { ...call, server_id: 'raindrop' },
    { jsonrpc: '2.0', method: 'tools/list', params: { server_id: 'raindrop' }, id: 1 },
    { jsonrpc: '2.0', method: 'notifications/initialized', id: 1 },
  ];
  for (const payload of cases) {
    assert.equal(authorizeGatewayMessage(payload, 'sentry', new Headers()).ok, false, JSON.stringify(payload));
  }
  assert.equal(authorizeGatewayMessage({ jsonrpc: '2.0', method: 'tools/list', id: 1, params: { cursor: 'page-two' } }, 'sentry', new Headers()).ok, true);
});
