import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { selectAffectedApps } from '../../../scripts/select-affected-apps.mjs';
import { BOOTSTRAP_SECRETS } from '../../../scripts/bootstrap-worker-secrets.mjs';
import { collectWorkerVars } from '../../../scripts/worker-release-variables.mjs';
import { verifyBindings } from '../../../scripts/manual-worker-release.mjs';

test('only changed OpenList files select new app; shared changes include it', () => {
  assert.deepEqual(selectAffectedApps(['apps/openlist-mcp-worker/src/index.ts']), ['openlist-mcp-worker']);
  assert.equal(selectAffectedApps(['pnpm-lock.yaml']).includes('openlist-mcp-worker'), true);
});
test('release Secret list must include upstream and ingress credentials', () => {
  assert.deepEqual(BOOTSTRAP_SECRETS['openlist-mcp-worker'],
    ['MCP_ACCESS_TOKEN', 'OPENLIST_API_TOKEN']);
});
test('release roots are mandatory canonical non-root JSON and never silently omitted', () => {
  for (const value of ['', '[]', '["/"]', '["/ok/../escape"]', '["/ok/%2f"]']) {
    assert.throws(() => collectWorkerVars('openlist-mcp-worker', { OPENLIST_ALLOWED_ROOTS: value }));
  }
  assert.deepEqual(collectWorkerVars('openlist-mcp-worker', { OPENLIST_ALLOWED_ROOTS: '["/Koofr/test"]' }),
    ['OPENLIST_ALLOWED_ROOTS:["/Koofr/test"]']);
});
test('release binding is pinned to existing OpenList Worker', () => {
  const bindings = [
    { name: 'MCP_ACCESS_TOKEN', type: 'secret_text' },
    { name: 'OPENLIST_API_TOKEN', type: 'secret_text' },
    { name: 'OPENLIST_ALLOWED_ROOTS', type: 'plain_text', text: '["/Koofr/test"]' },
    { name: 'OPENLIST', type: 'service', service: 'openlist-tsworkers' },
  ];
  const settings = { bindings, observability: { enabled: true, logs: { invocation_logs: true } } };
  assert.doesNotThrow(() => verifyBindings('openlist-mcp-worker', settings,
    [{ name: 'MCP_ACCESS_TOKEN' }, { name: 'OPENLIST_API_TOKEN' }], { mode: 'readback' }));
  assert.throws(() => verifyBindings('openlist-mcp-worker',
    { ...settings, bindings: bindings.slice(0, 3) },
    [{ name: 'MCP_ACCESS_TOKEN' }, { name: 'OPENLIST_API_TOKEN' }], { mode: 'readback' }));
});
