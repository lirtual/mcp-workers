import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedActionRepositories, listAvailableGitHubActions } from '../src/github-action-catalog.ts';

const approved = {repository:'lirtual/session-actions',repositoryId:123,commitSha:'a'.repeat(40)};
test('no approved repositories means zero actions, without requiring a token', async () => {
  assert.deepEqual(await listAvailableGitHubActions({}), {actions:[]});
});
test('explicit allowlist accepts only pinned, unique repository identities', () => {
  assert.deepEqual(approvedActionRepositories(JSON.stringify([approved])), [approved]);
  for (const entries of [
    [{...approved,repository:'another/repo/invalid'}],
    [{...approved,commitSha:'main'}],
    [{...approved,repositoryId:0}],
    [approved,approved],
    [{...approved,token:'not-allowed'}],
  ]) assert.throws(() => approvedActionRepositories(JSON.stringify(entries)), /catalog_invalid/);
  assert.throws(() => approvedActionRepositories('{broken'), /catalog_invalid/);
});
test('approved discovery requires a server-owned credential', async () => {
  await assert.rejects(listAvailableGitHubActions({
    GITHUB_ACTION_APPROVED_REPOSITORIES:JSON.stringify([approved]),
  }), /token_missing/);
});
