import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOwnerDispatch, classifyGithubResponse } from './probe-database-github-dispatch.mjs';

const token = 'github_pat_synthetic_owner_test_token';
test('Owner PAT probe dispatches exactly one no-deploy no-approval workflow', async () => {
  let calls = 0;
  const request = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/release.yml/dispatches');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    assert.equal(init.headers['User-Agent'], 'lirtual-database-mcp-worker');
    assert.deepEqual(JSON.parse(init.body), {
      ref: 'main',
      return_run_details: true,
      inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false' }
    });
    return Response.json({ workflow_run_id: 40850012345 }, { status: 200 });
  };
  assert.deepEqual(await checkOwnerDispatch(token, request), { acknowledged: true, runId: 40850012345 });
  assert.equal(calls, 1);
});
test('legacy 204 accepted without claiming a run id', async () => {
  assert.deepEqual(await checkOwnerDispatch(token, async () => new Response(null, { status: 204 })),
    { acknowledged: true });
});
test('invalid secrets fail before network', async () => {
  let calls = 0;
  const request = async () => { calls++; throw Error('must not send'); };
  for (const value of ['', 'short', 'x'.repeat(513), 'foo\nbar token']) {
    await assert.rejects(checkOwnerDispatch(value, request), /token_missing_or_invalid/);
  }
  assert.equal(calls, 0);
});
test('403 classes reveal only fixed safe categories, never upstream response', async () => {
  assert.equal(classifyGithubResponse(403, { message: 'Resource not accessible by personal access token' }),
    'token_missing_actions_write_or_repo_scope');
  assert.equal(classifyGithubResponse(403, { message: 'IP allow list failed' }), 'token_ip_policy_rejected');
  assert.equal(classifyGithubResponse(403, { message: 'SAML SSO required' }), 'token_sso_authorization_required');
  assert.equal(classifyGithubResponse(403, { message: 'very-private-value' }), 'github_forbidden_unclassified');
  const req = async () => Response.json({ message: 'secret-must-not-leak' }, { status: 403 });
  await assert.rejects(checkOwnerDispatch(token, req), error => {
    assert.match(String(error), /database_actions_github_forbidden_unclassified/);
    assert.doesNotMatch(String(error), /secret-must-not-leak/);
    return true;
  });
});
test('3xx does not follow redirect and dispatch is never retried on error', async () => {
  let calls = 0;
  const req = async (_u, init) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://attacker.example.net' } });
  };
  await assert.rejects(checkOwnerDispatch(token, req), /github_redirect_rejected/);
  assert.equal(calls, 1);
  await assert.rejects(checkOwnerDispatch(token, async () => { throw Error('secret-must-not-leak'); }),
    /dispatch_outcome_unknown/);
});
