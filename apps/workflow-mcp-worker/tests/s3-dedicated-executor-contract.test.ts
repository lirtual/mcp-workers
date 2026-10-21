import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { selectedS3Executor } from '../src/s3-github-dispatch.ts';

// A release-time static contract: code and dedicated GitHub workflow cannot
// quietly diverge while the workflow is still waiting for registration on
// the default branch. This does not claim live dedicated-executor acceptance.
const workflow=YAML.parse(readFileSync(
  new URL('../../../.github/workflows/workflow-s3-executor.yml',import.meta.url),'utf8',
)) as Record<string,any>;

test('S3 dedicated job has only fixed registered echo inputs, no user command or dynamic endpoint',()=>{
  assert.equal(workflow.name,'S3 Registered Echo Executor');
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
    'node apps/workflow-mcp-worker/tests/s3-registered-executor.mjs');
  assert.deepEqual(Object.keys(job.env).sort(),[
    'S3_ATTEMPT_ID','S3_CALLBACK_ORIGIN','S3_CAPABILITY',
    'S3_DISPATCH_ID','S3_GITHUB_AUDIENCE',
  ]);
  assert.equal(job.env.S3_CALLBACK_ORIGIN,'${{ vars.S3_CALLBACK_ORIGIN }}');
  assert.equal(job.env.S3_GITHUB_AUDIENCE,'${{ vars.S3_GITHUB_AUDIENCE }}');
  assert.equal(selectedS3Executor({S3_GITHUB_REPOSITORY:'lirtual/mcp-workers',
    S3_GITHUB_REF:'refs/heads/main'}).workflow,'workflow-s3-executor.yml');
});

test('dedicated S3 workflow has no automatic push/schedule or broad write permissions',()=>{
  assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
  assert.equal(workflow.permissions.actions,undefined);
  const serialized=JSON.stringify(workflow);
  for(const forbidden of [
    'secrets.CLOUDFLARE_API_TOKEN','secrets.S3_GITHUB_TOKEN','secrets.GH_TOKEN',
    'S3_TEST_WORKER_NAME','inputs.command','inputs.repository','inputs.callback_url',
    'pull_request_target','repository_dispatch',
  ])assert.equal(serialized.includes(forbidden),false,forbidden);
});
