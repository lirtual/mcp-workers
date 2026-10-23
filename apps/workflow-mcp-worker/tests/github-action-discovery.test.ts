import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverGitHubActions } from '../src/github-action-discovery.ts';

const sha = 'a'.repeat(40);
const yaml = `name: Short Linux build
on:
  workflow_dispatch:
    inputs:
      duration:
        type: number
        default: 5
env:
  WORKFLOW_ACTION_TYPE: session
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
const grant = { repository: 'lirtual/session-actions', repositoryId: 123, commitSha: sha, token: 'test-token' };
function server(paths: string[], wrongIdentity = false) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    paths.push(url.pathname + url.search);
    assert.equal(url.host, 'api.github.com');
    assert.equal(req.redirect, 'manual');
    if (url.pathname.endsWith('/commits/' + sha)) return Response.json({ sha });
    if (url.pathname.endsWith('/actions/workflows'))
      return Response.json({ workflows: [{ id: 5, path: '.github/workflows/linux.yml' }, { id: 7, path: '.github/workflows/ci.yml' }] });
    if (url.pathname.endsWith('/linux.yml'))
      return Response.json({ path: '.github/workflows/linux.yml', encoding: 'base64', content: btoa(yaml) });
    if (url.pathname.endsWith('/ci.yml'))
      return Response.json({ path: '.github/workflows/ci.yml', encoding: 'base64', content: btoa('name: CI\non: push\njobs: {}') });
    return Response.json({ id: wrongIdentity ? 456 : 123, full_name: grant.repository });
  };
}
test('discovers native Action at approved commit and skips regular CI', async () => {
  const paths: string[] = [];
  const actions = await discoverGitHubActions(grant, server(paths));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].contract.type, 'session');
  assert.equal(actions[0].commitSha, sha);
  assert(paths.some(x => x.endsWith('?ref=' + sha)));
});
test('rejects unapproved repository identity before reading workflow definitions', async () => {
  const paths: string[] = [];
  await assert.rejects(discoverGitHubActions(grant, server(paths, true)), /repository_mismatch/);
  assert.equal(paths.length, 1);
});
test('rejects bad grant without outbound traffic', async () => {
  const paths: string[] = [];
  await assert.rejects(discoverGitHubActions({ ...grant, repository: 'invalid/repo/extra' }, server(paths)), /invalid_grant/);
  assert.equal(paths.length, 0);
});
