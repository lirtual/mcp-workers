import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBrokerReadOnlyToolCall as allowed } from '../src/broker-scope.ts';

const call = (name: string, args: Record<string, unknown> = {}) =>
  ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('G5 default broker scope admits benign metadata and specific exec/sftp reads', () => {
  for (const name of ['list_hosts', 'get_host', 'get_operation_status']) assert.equal(allowed(call(name)), true);
  for (const command of ['pwd', 'printf G5_SSH_OK']) assert.equal(allowed(call('ssh_exec', { command })), true);
  assert.equal(allowed(call('sftp_list', { path: '/etc' })), true);
  assert.equal(allowed(call('sftp_read_text', { path: '/etc/hostname' })), true);
});
test('denies shell arbitrary execution, PTY, file writes/deletes, batch RPC and malformed inputs', () => {
  for (const command of ['whoami', 'pwd; id', 'echo hello', 'printf G5_SSH_OK; touch /tmp/x']) {
    assert.equal(allowed(call('ssh_exec', { command })), false);
  }
  for (const name of ['ssh_session_start', 'ssh_session_input', 'sftp_write_text', 'sftp_mkdir',
    'sftp_rename', 'sftp_delete', 'unknown_tool']) assert.equal(allowed(call(name)), false);
  assert.equal(allowed(call('sftp_list', { path: '/' })), false);
  assert.equal(allowed(call('sftp_read_text', { path: '/etc/shadow' })), false);
  assert.equal(allowed([call('ssh_exec', { command: 'pwd' })]), false);
  assert.equal(allowed(null), false);
  assert.equal(allowed({ method: 'tools/call', params: { name: 'ssh_exec' } }), false);
  assert.equal(allowed({ method: 'initialize' }), true);
});
