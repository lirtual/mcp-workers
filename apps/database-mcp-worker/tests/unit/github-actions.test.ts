import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dispatchHyperdriveAction, verifyGithubPrCapability, verifyGithubActionsDispatch } from '../../src/setup/github-actions.js';
import type { Env } from '../../src/types.js';

const token = 'github_pat_synthetic_test_token_never_real';
function env(secret: string | undefined = token): Env {
  return { RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...(secret ? { DATABASE_GITHUB_ACTIONS_TOKEN: secret } : {}) };
}

test('Owner dispatch uses exactly one pinned GitHub workflow with bounded enable inputs', async () => {
  let seen = 0;
  const mocked = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen++;
    assert.equal(String(input), 'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/release.yml/dispatches');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer ' + token);
    assert.equal(headers.get('user-agent'), 'lirtual-database-mcp-worker');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ref: 'main',
      return_run_details: true,
      inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false',
        database_hyperdrive_enable_approved: 'true',
        database_hyperdrive_id: 'openlist',
        database_hyperdrive_revision: '3' }
    });
    return new Response(null, { status: 204 });
  };
  await dispatchHyperdriveAction(env(), 'enable', 'openlist', 3, mocked as typeof fetch);
  assert.equal(seen, 1);
});

test('retirement dispatch does not request deployment or ever include credentials', async () => {
  let payload: unknown;
  const mocked = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    payload = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  };
  await dispatchHyperdriveAction(env(), 'retire', 'retired_id', 2, mocked as typeof fetch);
  assert.deepEqual(payload, { ref: 'main', return_run_details: true,
    inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false',
      database_hyperdrive_retire_approved: 'true', database_hyperdrive_id: 'retired_id',
      database_hyperdrive_revision: '2' } });
});

test('invalid input or absent scoped secret rejects without a network call', async () => {
  let calls = 0;
  const mocked = async (): Promise<Response> => {
    calls++;
    throw Error('should not be called');
  };
  await assert.rejects(dispatchHyperdriveAction(env(''), 'enable', 'safe', 1, mocked as typeof fetch), /not configured/);
  await assert.rejects(dispatchHyperdriveAction(env(), 'enable', '../unsafe', 1, mocked as typeof fetch));
  await assert.rejects(dispatchHyperdriveAction(env(), 'enable', 'safe', 0, mocked as typeof fetch));
  assert.equal(calls, 0);
});

test('non-204 or network error does not expose provider response body', async () => {
  const secret = 'do-not-print-this-upstream-body';
  const bad = async () => new Response(secret, { status: 403 });
  await assert.rejects(dispatchHyperdriveAction(env(), 'enable', 'safe', 1, bad as typeof fetch),
    err => { assert.doesNotMatch(String(err), /do-not-print/); return true; });
  const lost = async () => { throw Error(secret); };
  await assert.rejects(dispatchHyperdriveAction(env(), 'retire', 'safe', 1, lost as typeof fetch),
    err => { assert.doesNotMatch(String(err), /do-not-print/); return true; });
});

test('verification-only dispatch sets no release, activation, retirement, or fixture flags', async () => {
  let calls = 0;
  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    assert.equal(String(input), 'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/release.yml/dispatches');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ref: 'main',
      return_run_details: true,
      inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false' }
    });
    return new Response(null, { status: 204 });
  };
  await verifyGithubActionsDispatch(env(), request as typeof fetch);
  assert.equal(calls, 1);
});

test('verification-only dispatch rejects missing token or GitHub error without leaks', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return new Response('protected secret must never appear', { status: 403 });
  };
  await assert.rejects(verifyGithubActionsDispatch(env(''), request as typeof fetch), /not configured/);
  assert.equal(calls, 0);
  await assert.rejects(verifyGithubActionsDispatch(env(), request as typeof fetch), error => {
    assert.doesNotMatch(String(error), /protected secret/);
    return true;
  });
  assert.equal(calls, 1);
});

test('GitHub HTTP 200 with validated run ID is accepted for both smoke and enable', async () => {
  const mocked = async () => Response.json({ workflow_run_id: 40850012345,
    run_url: 'https://api.github.com/repos/lirtual/mcp-workers/actions/runs/40850012345',
    html_url: 'https://github.com/lirtual/mcp-workers/actions/runs/40850012345' }, { status: 200 });
  assert.deepEqual(await verifyGithubActionsDispatch(env(), mocked as typeof fetch), { runId: 40850012345 });
  assert.deepEqual(await dispatchHyperdriveAction(env(), 'enable', 'safe', 1, mocked as typeof fetch),
    { runId: 40850012345 });
});

test('GitHub HTTP 204 remains accepted without claiming a run ID', async () => {
  const mocked = async () => new Response(null, { status: 204 });
  assert.deepEqual(await verifyGithubActionsDispatch(env(), mocked as typeof fetch), {});
});

test('invalid HTTP 200 run receipt fails closed without provider details', async () => {
  for (const value of [null, {}, { workflow_run_id: '40850012345' },
    { workflow_run_id: 0 }, { workflow_run_id: -1 }]) {
    const request = async () => Response.json(value, { status: 200 });
    await assert.rejects(verifyGithubActionsDispatch(env(), request as typeof fetch),
      /receipt unavailable/);
  }
});

test('GitHub error status classes are fixed, and provider body is never exposed', async () => {
  const cases: Array<[number,string]> = [[401,'unauthorized'],[403,'forbidden'],[404,'workflow unavailable'],
    [422,'inputs rejected'],[429,'rate limited'],[500,'upstream unavailable'],[418,'HTTP rejected']];
  for (const [status, expected] of cases) {
    const request = async () => new Response('secret-upstream-response', { status });
    await assert.rejects(verifyGithubActionsDispatch(env(), request as typeof fetch), error => {
      assert.match(String(error), new RegExp(expected));
      assert.doesNotMatch(String(error), /secret-upstream-response/);
      return true;
    });
  }
});

test('Cloudflare Workers fetch contract: unsupported redirect error never reaches GitHub', async () => {
  // The real workerd runtime throws TypeError for redirect: 'error'.
  // Preserve this narrow runtime behavior in the existing unit suite.
  let calls = 0;
  const workerdLikeFetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    if (init?.redirect === 'error') throw new TypeError('Unsupported redirect mode: error');
    assert.equal(init?.redirect, 'manual');
    return Response.json({ workflow_run_id: 40850012345 }, { status: 200 });
  };
  assert.deepEqual(await verifyGithubActionsDispatch(env(), workerdLikeFetch as typeof fetch),
    { runId: 40850012345 });
  assert.equal(calls, 1);
});

test('GitHub redirects are rejected without following authorization header', async () => {
  let calls = 0;
  const mocked = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, {
      status: 302,
      headers: { location: 'https://untrusted.example.org/steal-pat' }
    });
  };
  await assert.rejects(verifyGithubActionsDispatch(env(), mocked as typeof fetch), /redirect rejected/);
  assert.equal(calls, 1);
});

test('workerd GitHub REST contract includes mandatory User-Agent on every action', async () => {
  let accepted = 0;
  const strictGithub = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.get('user-agent')) return new Response('GitHub API requires User-Agent', { status: 403 });
    assert.equal(headers.get('user-agent'), 'lirtual-database-mcp-worker');
    accepted++;
    return Response.json({ workflow_run_id: 40850012345 }, { status: 200 });
  };
  assert.deepEqual(await verifyGithubActionsDispatch(env(), strictGithub as typeof fetch),
    { runId: 40850012345 });
  assert.deepEqual(await dispatchHyperdriveAction(env(), 'enable', 'openlist', 1, strictGithub as typeof fetch),
    { runId: 40850012345 });
  assert.equal(accepted, 2);
});


test('missing required-check evidence blocks even when Actions PR creation is enabled',async()=>{
  for(const status of [403,500]) {
    const calls:string[]=[];
    const request:typeof fetch=async(url,init)=>{
      calls.push(String(url));
      assert.equal(init?.method,'GET');
      assert.equal(init?.redirect,'manual');
      return String(url).endsWith('/actions/permissions/workflow')
        ? Response.json({can_approve_pull_request_reviews:true})
        : new Response(null,{status});
    };
    await assert.rejects(verifyGithubPrCapability(env(),request),/required PR checks could not be verified/);
    assert.equal(calls.length,2);
  }
});

test('unprotected main requires both explicit classic-protection 404 and an empty inherited ruleset inventory', async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    if (String(url).endsWith('/actions/permissions/workflow'))
      return Response.json({can_approve_pull_request_reviews: true});
    if (String(url).endsWith('/branches/main/protection'))
      return new Response(null, {status: 404});
    if (String(url).includes('/rulesets?'))
      return Response.json([]);
    throw Error('unexpected GitHub API call');
  };
  await verifyGithubPrCapability(env(), request);
  assert.equal(calls.length, 3);
  for (const rulesets of [[{id: 123, enforcement:'active'}], null, {error:'unauthorized'}]) {
    const guarded: typeof fetch = async (url) => {
      if (String(url).endsWith('/actions/permissions/workflow'))
        return Response.json({can_approve_pull_request_reviews: true});
      if (String(url).endsWith('/branches/main/protection'))
        return new Response(null, {status: 404});
      return Response.json(rulesets);
    };
    await assert.rejects(verifyGithubPrCapability(env(),guarded),
      /required PR checks could not be verified/);
  }
});

test('Owner unbinding status is read-only and scoped to a single logical ID', async () => {
  const { readHyperdriveUnbindStatus } = await import('../../src/setup/github-actions.js');
  const seen: string[] = [];
  const request = async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer '+token);
    if(String(url).includes('/pulls?'))return Response.json([{number:73}]);
    if(String(url).endsWith('/pulls/73'))return Response.json({number:73,state:'open',draft:true,
      merged_at:null,changed_files:2,head:{ref:'db476-unbind-'+seen[0]!.match(/head=lirtual%3Adb476-unbind-([^&]+)/)?.[1],repo:{full_name:'lirtual/mcp-workers'}},
      base:{ref:'main',repo:{full_name:'lirtual/mcp-workers'}}});
    if(String(url).endsWith('/pulls/73/files?per_page=100'))return Response.json([
      {filename:'apps/database-mcp-worker/wrangler.jsonc',status:'modified'},
      {filename:'apps/database-mcp-worker/hyperdrive-bindings.json',status:'modified'}]);
    throw Error('unexpected request');
  };
  assert.deepEqual(await readHyperdriveUnbindStatus(env(),'isolated',request as typeof fetch),
    {phase:'draft_review',prNumber:73});
  assert.equal(seen.length,3);
  assert.match(seen[0]!,/head=lirtual%3Adb476-unbind-2feafc847b535bc95017b1ee/);
  assert.ok(seen.every(x=>x.startsWith('https://api.github.com/repos/lirtual/mcp-workers/')));
});
test('Owner status fails closed for a duplicate or unexpected PR diff without writes', async () => {
  const {readHyperdriveUnbindStatus}=await import('../../src/setup/github-actions.js');
  for (const kind of ['duplicate','bad-files']){
    let calls=0;
    const request=async (url:RequestInfo|URL,init?:RequestInit)=>{
      calls++;assert.equal(init?.method,'GET');
      if(String(url).includes('/pulls?'))return Response.json(kind==='duplicate'?[{number:73},{number:74}]:[{number:73}]);
      if(String(url).endsWith('/pulls/73'))return Response.json({number:73,state:'open',draft:true,
        head:{ref:decodeURIComponent(String(url).split('unused:')[1]??'unused'),repo:{full_name:'other/repo'}},base:{ref:'main'}});
      return Response.json([{filename:'unexpected',status:'modified'}]);
    };
    await assert.rejects(readHyperdriveUnbindStatus(env(),'isolated',request as typeof fetch),
      /unbinding status could not be verified/i);
    assert.ok(calls<=3);
  }
});

test('unbinding PR status distinguishes no PR, merge from publication, and closed-unmerged',async()=>{
  const {readHyperdriveUnbindStatus}=await import('../../src/setup/github-actions.js');
  for(const [state,merged,expected] of [
    ['open',null,'review_available'],['closed','2026-10-29T12:00:00Z','merged_unpublished'],
    ['closed',null,'closed_unmerged']
  ] as const){
    let branch='';
    const request=async(url:RequestInfo|URL,init?:RequestInit)=>{
      assert.equal(init?.method,'GET');
      if(String(url).includes('/pulls?')){branch=String(url).match(/head=lirtual%3A([^&]+)/)?.[1]??'';
        return Response.json([{number:105}]);}
      if(String(url).endsWith('/pulls/105'))return Response.json({number:105,state,draft:false,merged_at:merged,
        changed_files:2,head:{ref:branch,repo:{full_name:'lirtual/mcp-workers'}},
        base:{ref:'main',repo:{full_name:'lirtual/mcp-workers'}}});
      if(String(url).endsWith('/pulls/105/files?per_page=100'))return Response.json([
        {filename:'apps/database-mcp-worker/wrangler.jsonc',status:'modified'},
        {filename:'apps/database-mcp-worker/hyperdrive-bindings.json',status:'modified'}]);
      throw Error('unexpected');
    };
    assert.deepEqual(await readHyperdriveUnbindStatus(env(),'isolated',request as typeof fetch),
      {phase:expected,prNumber:105});
  }
  const missing=async(url:RequestInfo|URL)=>{
    assert.ok(String(url).includes('/pulls?'));
    return Response.json([]);
  };
  assert.deepEqual(await readHyperdriveUnbindStatus(env(),'isolated',missing as typeof fetch),
    {phase:'not_staged'});
});

test('read-only status does not leak GitHub response errors or query without scoped token',async()=>{
  const {readHyperdriveUnbindStatus}=await import('../../src/setup/github-actions.js');
  let called=0;
  const upstream=async()=>{called++;return new Response('do-not-leak-upstream', {status:403});};
  await assert.rejects(readHyperdriveUnbindStatus(env(''),'isolated',upstream as typeof fetch));
  await assert.rejects(readHyperdriveUnbindStatus(env(),'../unsafe',upstream as typeof fetch));
  assert.equal(called,0);
  await assert.rejects(readHyperdriveUnbindStatus(env(),'isolated',upstream as typeof fetch),error=>{
    assert.doesNotMatch(String(error),/do-not-leak-upstream/);
    assert.match(String(error),/status could not be verified/);
    return true;
  });
  assert.equal(called,1);
});
