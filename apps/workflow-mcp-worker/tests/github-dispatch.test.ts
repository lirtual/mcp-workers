import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchGithubAttempt, matchCandidateIdentity, selectedGithubExecutor } from '../src/github-dispatch.ts';

const config={
  repository:'lirtual/test-executor',workflow:'workflow-github-executor.yml',
  ref:'refs/heads/main',dispatchToken:'test-token-not-real',
};
const attempt={
  attemptId:'b6835141-0b3a-4fcb-a9ae-b4b75bfae93c',
  dispatchId:'d9b3439b-b7ed-4812-9064-75c925f93c6a',
  capabilityId:'heavy.github.echo' as const,
};
test('registered GitHub dispatch uses exact repo/ref and only opaque inputs',async()=>{
  let calls=0;
  const outcome=await dispatchGithubAttempt(config,attempt,async(req:Request)=>{
    calls++;
    assert.equal(req.url,'https://api.github.com/repos/lirtual/test-executor/actions/workflows/workflow-github-executor.yml/dispatches');
    assert.equal(req.method,'POST');
    assert.equal(req.headers.get('authorization'),'Bearer test-token-not-real');
    assert.equal(req.headers.get('x-github-api-version'),'2026-03-10');
    assert.equal(req.headers.get('user-agent'),'mcp-workers-workflow-s3');
    assert.deepEqual(await req.json(),{
      ref:'main',return_run_details:true,
      inputs:{attempt_id:attempt.attemptId,dispatch_id:attempt.dispatchId,capability_id:attempt.capabilityId},
    });
    return Response.json({workflow_run_id:39410780231},{status:200});
  });
  assert.deepEqual(outcome,{status:'confirmed',runId:39410780231,runAttempt:1});
  assert.equal(calls,1);
});

test('ambiguous response never causes a second dispatch',async()=>{
  for(const mode of ['network','invalid-success','server-error']){
    let requests=0;
    const result=await dispatchGithubAttempt(config,attempt,async()=>{
      requests++;
      if(mode==='network')throw Error('socket reset');
      if(mode==='invalid-success')return Response.json({ok:true},{status:200});
      return new Response(null,{status:503});
    });
    assert.deepEqual(result,{status:'dispatch_unknown'});
    assert.equal(requests,1);
  }
});

test('known GitHub rejection is not a dispatched Run',async()=>{
  let count=0;
  const result=await dispatchGithubAttempt(config,attempt,async()=>{
    count++;
    return new Response(null,{status:403});
  });
  assert.deepEqual(result,{status:'rejected',httpStatus:403,reason:'unknown'});
  assert.equal(count,1);
});

test('unregistered capabilities and invalid execution configuration fail before network',async()=>{
  let network=0;
  const fetcher=async()=>{network++;return Response.json({workflow_run_id:1});};
  for(const [cfg,candidate] of [
    [config,{...attempt,capabilityId:'shell.run'}],
    [config,{...attempt,dispatchId:'anything'}],
    [{...config,workflow:'../admin.yml'},attempt],
    [{...config,repository:'lirtual/test-executor/../../admin'},attempt],
    [{...config,ref:'refs/pull/123/merge'},attempt],
    [{...config,dispatchToken:''},attempt],
  ] as [any,any][]) {
    await assert.rejects(()=>dispatchGithubAttempt(cfg,candidate,fetcher),/github_executor_/);
  }
  assert.equal(network,0);
});

test('verified job claims must exactly match confirmed physical Run and attempt',()=>{
  const candidate={
    repository:'lirtual/test-executor',workflowRef:'lirtual/test-executor/.github/workflows/workflow-github-executor.yml@refs/heads/main',
    ref:'refs/heads/main',runId:39410780231,runAttempt:1,
  };
  const claims={
    repository:candidate.repository,workflow_ref:candidate.workflowRef,
    ref:candidate.ref,run_id:'39410780231',run_attempt:'1',
    event_name:'workflow_dispatch',
  };
  assert.equal(matchCandidateIdentity(claims,candidate),true);
  for(const mutated of [
    {...claims,repository:'lirtual/other'},
    {...claims,workflow_ref:'lirtual/test-executor/.github/workflows/other.yml@refs/heads/main'},
    {...claims,ref:'refs/heads/not-main'},
    {...claims,run_id:'39410780232'},
    {...claims,run_attempt:'2'},
    {...claims,event_name:'push'},
  ]) assert.equal(matchCandidateIdentity(mutated,candidate),false);
});


test('isolation CI registration must be exact and never permits an arbitrary worker host',async()=>{
  const isolation={...config,repository:'lirtual/mcp-workers',workflow:'ci.yml',
    ref:'refs/heads/wip/workflow-github-executor',workerName:'workflow-github-oidc-aabbccddee'};
  let calls=0;
  const result=await dispatchGithubAttempt(isolation,attempt,async request=>{
    calls++;
    assert.equal(request.url,'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/ci.yml/dispatches');
    const body=await request.json() as {ref:string;return_run_details:boolean;inputs:Record<string,string>};
    assert.equal(body.ref,'wip/workflow-github-executor');
    assert.equal(body.return_run_details,true);
    assert.deepEqual(body.inputs,{
      attempt_id:attempt.attemptId,dispatch_id:attempt.dispatchId,
      capability_id:'heavy.github.echo',worker_name:'workflow-github-oidc-aabbccddee',
      worker:'workflow-mcp-worker',github_executor_worker:'true',
    });
    return Response.json({workflow_run_id:39410780231,run_url:'https://api.github.com/test',
      html_url:'https://github.com/test'},{status:200});
  });
  assert.equal(calls,1);
  assert.deepEqual(result,{status:'confirmed',runId:39410780231,runAttempt:1});
  for(const cfg of [
    {...isolation,workerName:'https://evil.example'},
    {...isolation,workerName:'workflow-github-oidc-../aaa'},
    {...isolation,repository:'lirtual/other'},
    {...isolation,ref:'refs/heads/main'},
    {...isolation,workflow:'other.yml'},
  ]){
    await assert.rejects(()=>dispatchGithubAttempt(cfg,attempt,async()=>{
      throw Error('network must not be contacted');
    }),/github_executor_/);
  }
});


test('production executor remains dedicated; only exact disposable GitHub environment may reuse ci.yml',()=>{
  assert.deepEqual(selectedGithubExecutor({GITHUB_EXECUTOR_REPOSITORY:'lirtual/mcp-workers',
    GITHUB_EXECUTOR_REF:'refs/heads/main'}),{workflow:'workflow-github-executor.yml'});
  const fixture={GITHUB_EXECUTOR_REPOSITORY:'lirtual/mcp-workers',
    GITHUB_EXECUTOR_REF:'refs/heads/wip/workflow-github-executor',
    GITHUB_TEST_WORKER_NAME:'workflow-github-oidc-aabbccddee'};
  assert.deepEqual(selectedGithubExecutor(fixture),{
    workflow:'ci.yml',workerName:'workflow-github-oidc-aabbccddee',
  });
  assert.deepEqual(selectedGithubExecutor({...fixture,GITHUB_TEST_WORKER_NAME:'workflow-github-plan-aabbccddee'}),{
    workflow:'ci.yml',workerName:'workflow-github-plan-aabbccddee',
  });
  for(const mutation of [
    {...fixture,GITHUB_EXECUTOR_REPOSITORY:'lirtual/other'},
    {...fixture,GITHUB_EXECUTOR_REF:'refs/heads/main'},
    {...fixture,GITHUB_TEST_WORKER_NAME:'workflow-github-oidc-../../bad'},
  ])assert.throws(()=>selectedGithubExecutor(mutation),/github_executor_test_environment_invalid/);
});


test('registered dedicated GitHub acceptance is gated to the exact Draft ref and disposable host',()=>{
  const env={GITHUB_EXECUTOR_REPOSITORY:'lirtual/mcp-workers',
    GITHUB_EXECUTOR_REF:'refs/heads/wip/workflow-github-executor',
    GITHUB_TEST_WORKER_NAME:'workflow-github-plan-abcdef0123',
    GITHUB_TEST_DEDICATED_EXECUTOR:'true'};
  assert.deepEqual(selectedGithubExecutor(env),{workflow:'workflow-github-executor.yml'});
  for(const changed of [
    {...env,GITHUB_EXECUTOR_REF:'refs/heads/main'},
    {...env,GITHUB_EXECUTOR_REPOSITORY:'other/repo'},
    {...env,GITHUB_TEST_WORKER_NAME:'workflow-github-plan/evil'},
    {...env,GITHUB_TEST_WORKER_NAME:undefined},
  ])assert.throws(()=>selectedGithubExecutor(changed),/github_executor_test_environment_invalid/);
});
