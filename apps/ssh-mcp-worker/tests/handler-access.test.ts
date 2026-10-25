import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler from '../src/handler.ts';
import type { Env } from '../src/types.ts';

// No live infrastructure: a deliberately unavailable DO refuses any SSH dispatch.
const token = 'isolated-handler-access-regression-token';
const host = 'fb8965b6-37bd-45b4-8b2e-49c593938441';
const operation = '4cf52086-b6d0-4f72-ab72-61dab79f2461';
const env = {
  MCP_ACCESS_TOKEN: token,
  EDGE_SSH_DB: {},
  SSH_OPERATIONS: {
    getByName() { throw new Error('disposable test: no real SSH or writes'); },
  },
} as unknown as Env;

function request(tool: string, args: Record<string, unknown>, bearer = token) {
  return new Request('https://ssh.example.test/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + bearer,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
}

test('MCP token validation remains mandatory before tool dispatch', async () => {
  const response = await handler.fetch(request('file_list', { host_id: host, path: '/root' }, 'wrong'), env);
  assert.equal(response.status, 401);
});

test('authenticated tools are not intercepted by the obsolete G5 scope', async () => {
  const formerlyDenied = [
    ['ssh_exec', { host_id: host, operation_id: operation, command: 'id -un' }],
    ['file_list', { host_id: host, path: '/root' }],
    ['file_read_text', { host_id: host, path: '/etc/os-release' }],
    ['file_write_text', { host_id: host, operation_id: operation, path: '/tmp/test', text: 'test', overwrite: false }],
    ['file_move', { host_id: host, operation_id: operation, old_path: '/tmp/old', new_path: '/tmp/new', overwrite: false }],
    ['file_delete', { host_id: host, operation_id: operation, path: '/tmp/test', kind: 'file', confirm: true }],
    ['file_mkdir', { host_id: host, operation_id: operation, path: '/tmp/test' }],
    ['ssh_session_start', { host_id: host, operation_id: operation }],
    ['ssh_session_send', { session_id: host, operation_id: operation, input: 'pwd\n' }],
    ['ssh_session_stop', { session_id: host, operation_id: operation }],
    ['ssh_session_read', { session_id: host }],
    ['ssh_session_status', { session_id: host }],
  ] as const;
  for (const [tool, args] of formerlyDenied) {
    const response = await handler.fetch(request(tool, args), env);
    const body = await response.text();
    assert.notEqual(response.status, 403, tool + ': unexpected HTTP 403 / ' + body.slice(0, 150));
    assert.equal(body.includes('broker_readonly'), false, tool + ': obsolete broker restriction');
  }
});
