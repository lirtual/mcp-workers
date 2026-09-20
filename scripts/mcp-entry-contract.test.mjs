import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const names = [
  'database',
  'ima',
  'instapaper',
  'openlist',
  'raindrop',
  'weread',
  'workflow'
];

function validateEntryContract(config, app) {
  assert.equal(config.name, `${app}-mcp-worker`);
  assert.ok(Array.isArray(config.secrets?.required), `${app}: missing required secret list`);
  assert.equal(config.secrets.required.filter(name => name === 'MCP_ACCESS_TOKEN').length, 1,
    `${app}: exactly one MCP_ACCESS_TOKEN must be required`);
  const aliases = config.secrets.required.filter(name =>
    /^(?:WORKFLOW_|[A-Z]+_)MCP_ACCESS_TOKEN$/.test(name)
  );
  assert.deepEqual(aliases, [], `${app}: worker-specific MCP caller aliases are forbidden`);
  assert.ok(!Object.hasOwn(config.vars ?? {}, 'MCP_ACCESS_TOKEN'),
    `${app}: MCP_ACCESS_TOKEN must never be a plaintext var`);
}

for (const app of names) {
  test(`${app} has the canonical MCP caller Secret contract`, () => {
    const path = new URL(`../apps/${app}-mcp-worker/wrangler.jsonc`, import.meta.url);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    validateEntryContract(config, app);
  });
}

test('contract catches a missing or renamed MCP Secret', () => {
  const config = { name: 'ima-mcp-worker', secrets: { required: ['API_KEY'] } };
  assert.throws(() => validateEntryContract(config, 'ima'), /MCP_ACCESS_TOKEN/);
  config.secrets.required.push('IMA_MCP_ACCESS_TOKEN');
  assert.throws(() => validateEntryContract(config, 'ima'), /MCP_ACCESS_TOKEN/);
  config.secrets.required.push('MCP_ACCESS_TOKEN');
  assert.throws(() => validateEntryContract(config, 'ima'), /aliases/);
});

test('contract rejects plaintext MCP credentials', () => {
  assert.throws(() => validateEntryContract({
    name: 'ima-mcp-worker',
    secrets: { required: ['MCP_ACCESS_TOKEN'] },
    vars: { MCP_ACCESS_TOKEN: 'not-a-real-token' }
  }, 'ima'), /plaintext/);
});
