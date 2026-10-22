import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { selectedGithubExecutor } from '../src/github-dispatch.ts';

// A release-time static contract: code and dedicated GitHub workflow cannot
// quietly diverge while the workflow is still waiting for registration on
// the default branch. This does not claim live dedicated-executor acceptance.
const workflow=YAML.parse(readFileSync(
  new URL('../../../.github/workflows/workflow-github-executor.yml',import.meta.url),'utf8',
)) as Record<string,any>;

test('GitHub dedicated job has only fixed registered echo inputs, no user command or dynamic endpoint',()=>{
  assert.equal(workflow.name,'GitHub Registered Echo Executor');
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(),
    ['attempt_id','capability_id','dispatch_id']);
  assert.deepEqual(Object.keys(workflow.jobs),['registered-echo']);
  const job=workflow.jobs['registered-echo'];
  assert.equal(job['runs-on'],'ubuntu-latest');
  assert.equal(job['timeout-minutes'],3);
  assert.equal(job.environment,'workflow-mcp-worker');
  assert.equal(job.permissions.contents,'read');
  assert.equal(job.permissions['id-token'],'write');
  assert.equal(workflow.permissions.contents,'read');
  assert.match(job.if,/inputs\.capability_id == 'heavy\.github\.echo'/);
  assert.equal(job.concurrency['cancel-in-progress'],false);
  assert.equal(job.steps.at(-1).run,
    'node apps/workflow-mcp-worker/tests/github-registered-executor.mjs');
  assert.deepEqual(Object.keys(job.env).sort(),[
    'WORKFLOW_ATTEMPT_ID','WORKFLOW_CALLBACK_ORIGIN','WORKFLOW_CAPABILITY',
    'WORKFLOW_DISPATCH_ID','WORKFLOW_EXECUTOR_AUDIENCE',
  ]);
  assert.equal(job.env.WORKFLOW_CALLBACK_ORIGIN,'https://workflow.lirtual.dpdns.org');
  assert.equal(job.env.WORKFLOW_EXECUTOR_AUDIENCE,'workflow-github-claim:production');
  assert.equal(selectedGithubExecutor({GITHUB_EXECUTOR_REPOSITORY:'lirtual/mcp-workers',
    GITHUB_EXECUTOR_REF:'refs/heads/main'}).workflow,'workflow-github-executor.yml');
});

test('dedicated GitHub workflow has no automatic push/schedule or broad write permissions',()=>{
  assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
  assert.equal(workflow.permissions.actions,undefined);
  const serialized=JSON.stringify(workflow);
  for(const forbidden of [
    'secrets.CLOUDFLARE_API_TOKEN','secrets.WORKFLOW_EXECUTOR_GITHUB_TOKEN','secrets.GH_TOKEN',
    'GITHUB_TEST_WORKER_NAME','inputs.command','inputs.repository','inputs.callback_url',
    'pull_request_target','repository_dispatch',
  ])assert.equal(serialized.includes(forbidden),false,forbidden);
});
