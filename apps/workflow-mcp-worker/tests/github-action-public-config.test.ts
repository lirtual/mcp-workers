import test from 'node:test';
import assert from 'node:assert/strict';
import {handleGithubActionPublicConfig} from '../src/github-action-public-config.ts';
import type {Env} from '../src/store.ts';
const url='https://workflow.example.org/github/action/config';
const env={WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE:'workflow-github-action'} as Env;
test('discovery returns only the configured, non-secret audience without caching',()=>{
 const response=handleGithubActionPublicConfig(new Request(url),env);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');
 return response.json().then(value=>assert.deepEqual(value,{audience:'workflow-github-action'}));
});
test('discovery refuses invalid configuration and unexpected methods',async()=>{
 for(const invalid of [undefined,'','invalid','workflow-github-x\nforged']){
  const response=handleGithubActionPublicConfig(new Request(url),{
   ...env,WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE:invalid,
  } as Env);
  assert.equal(response.status,503);
  assert.equal(response.headers.get('cache-control'),'no-store');
 }
 for(const method of ['POST','PUT','DELETE']){
  const response=handleGithubActionPublicConfig(new Request(url,{method}),env);
  assert.equal(response.status,405);
 }
});
