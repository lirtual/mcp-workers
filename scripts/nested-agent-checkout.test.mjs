import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

test('one checkout contains the nested Agent and does not fetch a pinned public source', () => {
  const workspace = read('pnpm-workspace.yaml');
  assert.match(workspace, /^ {2}- "apps\/remote-control-mcp-worker\/agent"$/m);
  assert.doesNotMatch(workspace, /^ {2}- "apps\/\*\/agent"$/m);

  const pkg = JSON.parse(read('apps/remote-control-mcp-worker/agent/package.json'));
  assert.equal(pkg.name, 'remote-control-agent');
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/src/v2-main.ts')), true);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/scripts/build-v2-release.mjs')), true);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/scripts/validate-local-archive.py')), true);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/install.ps1')), true);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/uninstall-windows.ps1')), true);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/pnpm-lock.yaml')), false);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/pnpm-workspace.yaml')), false);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/.pinned-public-source')), false);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-agent')), false);
  assert.equal(existsSync(path.join(root, 'scripts/stage-public-remote-control-agent.sh')), false);
  const lock = read('pnpm-lock.yaml');
  assert.match(lock, /^  apps\/remote-control-mcp-worker\/agent:/m);
  assert.doesNotMatch(lock, /^  apps\/remote-control-agent:/m);

  for (const relative of ['.github/workflows/ci.yml', '.github/workflows/release.yml', 'scripts/select-affected-apps.mjs']) {
    const text = read(relative);
    assert.doesNotMatch(text, /stage-public-remote-control-agent/, relative);
    assert.doesNotMatch(text, /0bcc22fcd84ab000d57c3978ffe93c14314b6f9e/, relative);
    assert.doesNotMatch(text, /lirtual\/remote-control-agent\.git/, relative);
    assert.doesNotMatch(text, /\.pinned-public-source/, relative);
  }
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /macos-15-intel|windows-2025|ubuntu-24\.04-arm/);
  assert.doesNotMatch(read('.github/workflows/release.yml'), /publish-agent-release|release-pins/);

  const worker = read('apps/remote-control-mcp-worker/src/worker.ts');
  assert.doesNotMatch(worker, /agent\/install\.ps1/);
  assert.doesNotMatch(worker, /03a14fd4138ca8d77fa8aced78f7a53ccc51724e/);
  assert.doesNotMatch(worker, /lirtual\/remote-control-agent\/releases\/download/);
  assert.doesNotMatch(read('apps/remote-control-mcp-worker/src/install-bootstrap.ts'), /function renderAgentInstallShell/);
  assert.match(read('CONTEXT-MAP.md'), /apps\/remote-control-mcp-worker\/agent/);
  assert.doesNotMatch(read('CONTEXT-MAP.md'), /apps\/remote-control-agent/);

  const testsDir = path.join(root, 'apps/remote-control-mcp-worker/tests');
  const specifiers = [];
  for (const name of readdirSync(testsDir)) {
    if (!/\.(?:ts|mjs)$/.test(name)) continue;
    const text = readFileSync(path.join(testsDir, name), 'utf8');
    for (const match of text.matchAll(/from\s+['"](\.\.\/[^'"]+)['"]/g)) {
      if (match[1] === '../agent' || match[1].startsWith('../agent/') || match[1].includes('remote-control-agent')) {
        specifiers.push({ name, spec: match[1] });
      }
    }
  }
  assert.ok(specifiers.length >= 10, 'Worker compatibility tests import Agent modules');
  for (const { name, spec } of specifiers) {
    assert.match(spec, /^\.\.\/agent\//, `${name} imports ${spec}`);
    assert.equal(existsSync(path.join(testsDir, spec)), true, `${name} -> ${spec}`);
  }
});
