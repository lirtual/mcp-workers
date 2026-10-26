import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpServer, folderId } from '../src/tools.ts';
import worker from '../src/index.ts';
const expected = [
  'account_list', 'capabilities_get', 'mail_search', 'mail_get',
  'folder_list', 'attachment_get', 'draft_create', 'mail_send',
  'mail_reply', 'mail_forward', 'mail_mark', 'mail_move', 'mail_trash',
];
test('tool inventory is exact and account administration is never MCP-exposed', () => {
  const registry = (buildMcpServer({} as any) as any)._registeredTools;
  assert.deepEqual(Object.keys(registry), expected);
  assert(!Object.keys(registry).some(x => /account_add|account_remove|reauthorize/.test(x)));
});
test('alternate-host setup and unknown paths are fail-closed', async () => {
  const env = { MCP_ACCESS_TOKEN: 'test-portal-token' } as any;
  for (const url of [
    'https://email-mcp-worker.aiyaya.workers.dev/setup',
    'https://email-mcp-worker.aiyaya.workers.dev/oauth/callback',
    'https://email.lirtual.dpdns.org/mcp',
    'https://email.lirtual.dpdns.org/oauth/callback',
  ]) {
    const response = await worker.fetch(new Request(url), env);
    assert.equal(response.status, 404, url);
  }
});
test('MCP requires Portal bearer and removes direct untrusted requests', async () => {
  const response = await worker.fetch(new Request('https://email-mcp-worker.aiyaya.workers.dev/mcp'), {
    MCP_ACCESS_TOKEN: 'protected-token',
  } as any);
  assert.equal(response.status, 401);
});
test('authenticated stateless MCP tools/list advertises the entire intended inventory', async () => {
  const req = new Request('https://email-mcp-worker.aiyaya.workers.dev/mcp', {
    method: 'POST', headers: {
      authorization: 'Bearer expected-token', 'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const response = await worker.fetch(req, {
    MCP_ACCESS_TOKEN: 'expected-token', DB: {}, MAIL_ENCRYPTION_KEY: 'test',
  } as any);
  assert.equal(response.status, 200);
  const message = (await response.text()).match(/^data: (.+)$/m)?.[1];
  assert.ok(message);
  const payload = JSON.parse(message);
  assert.deepEqual(payload.result.tools.map((tool: any) => tool.name), expected);
  const reply = payload.result.tools.find((tool: any) => tool.name === 'mail_reply');
  assert.ok(reply.inputSchema.required?.includes('to'), 'reply recipient confirmation must be mandatory');
});

test('mail_move accepts native Unicode and spaced folder IDs, but not unsafe paths', () => {
  const valid = ['已删除邮件', '团队 文件夹', 'Archive 2026', 'Boîte de réception'];
  for (const path of valid) assert.equal(folderId.safeParse(path).success, true, path);
  for (const path of ['', 'folder\\r\\nBcc:evil', 'folder\\u0000name',
    'folder\\u007f', 'x'.repeat(256)]) {
    const actual = path.replaceAll('\\r', '\\r').replaceAll('\\n', '\\n')
      .replaceAll('\\u0000', '\\u0000').replaceAll('\\u007f', '\\u007f');
    assert.equal(folderId.safeParse(actual).success, false);
  }

  // Validate the actual MCP tool registration, not just the schema helper.
  const registered = (buildMcpServer({} as any) as any)._registeredTools.mail_move;
  assert.equal(registered.inputSchema.shape.folder_id, folderId);
  const base = { account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    message_id: 'opaque-id' };
  assert.equal(registered.inputSchema.safeParse({
    ...base, folder_id: '已删除邮件',
  }).success, true);
  assert.equal(registered.inputSchema.safeParse({
    ...base, folder_id: 'Archive 2026',
  }).success, true);
  assert.equal(registered.inputSchema.safeParse({
    ...base, folder_id: 'bad\\nfolder',
  }).success, false);
});
