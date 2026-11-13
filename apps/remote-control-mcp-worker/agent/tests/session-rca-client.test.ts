import test from 'node:test';
import assert from 'node:assert/strict';
import {newSessionDeviceIdentity} from '../src/session-device-identity.ts';
import {registerSessionRcaDevice,sessionTransportEnvironment} from '../src/session-rca-client.ts';
const attempt={attempt_id:'123e4567-e89b-42d3-a456-426614174004',github_run_id:123,
  github_run_attempt:2,workflow_name:'ubuntu' as const};
const fakeJwt='header.body.signature0123456789abcdefghijklmnop';

test('Session client sends only signed physical Attempt to fixed RCA URL, never in logs',async()=>{
 const identity=newSessionDeviceIdentity(attempt);
 let calls=0;
 const result=await registerSessionRcaDevice(identity,fakeJwt,async request=>{
  calls++;
  assert.equal(request.url,'https://rca.lirtual.dpdns.org/agent/pair/start');
  assert.equal(request.method,'POST');
  assert.equal(request.redirect,'manual');
  assert.equal(request.headers.get('content-type'),'application/json');
  const body=await request.json() as Record<string,unknown>;
  assert.equal(body.attempt_id,attempt.attempt_id);
  assert.equal(body.public_key,identity.public_key);
  assert.equal(body.oidc_jwt,fakeJwt);
  assert.equal(typeof body.proof,'string');
  assert.equal(typeof body.nonce,'string');
  return Response.json({device_id:'123e4567-e89b-42d3-a456-426614174001',
    expires_at:Date.now()+60000,status:'registered'},{status:201});
 });
 assert.equal(result.device_id,'123e4567-e89b-42d3-a456-426614174001');
 assert.equal(calls,1);
});

test('no OIDC and forged response never yield apparent Session device authority',async()=>{
 const identity=newSessionDeviceIdentity(attempt);
 await assert.rejects(registerSessionRcaDevice(identity,'',async()=>{throw Error('should not send')}));
 for(const response of [Response.json({error:'denied'},{status:403}),
   Response.json({device_id:'bad',expires_at:Date.now()+60000,status:'registered'},{status:201}),
   Response.json({device_id:'123e4567-e89b-42d3-a456-426614174001',
     expires_at:Date.now()-1,status:'registered'},{status:201})]){
   await assert.rejects(registerSessionRcaDevice(identity,fakeJwt,async()=>response));
 }
});

test('Session transport subprocess inherits only job tracking and safe runtime context',async()=>{
 const {sessionTransportEnvironment}=await import('../src/session-rca-client.ts');
 const environment=sessionTransportEnvironment({
   PATH:'/usr/bin',HOME:'/home/runner',RUNNER_TEMP:'/tmp/runner',
   RUNNER_TRACKING_ID:'run-tracking',GITHUB_ACTIONS:'true',
   GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW:'ubuntu',
   ATTEMPT_ID:'123e4567-e89b-42d3-a456-426614174004',
   ACTIONS_ID_TOKEN_REQUEST_TOKEN:'SENSITIVE_GITHUB_OIDC_REQUEST',
   ACTIONS_ID_TOKEN_REQUEST_URL:'https://oidc.example/token',
   WORKFLOW_ACTION_OIDC_AUDIENCE:'sensitive-audience',
   SESSION_SYSTEM_PASSWORD:'SENSITIVE_SESSION_PASSWORD',
   GH_TOKEN:'SENSITIVE_GH_TOKEN',TS_OAUTH_CLIENT_SECRET:'SENSITIVE_TAILNET',
   NODE_OPTIONS:'--require-unreviewed',
 });
 assert.equal(environment.RUNNER_TRACKING_ID,'run-tracking');
 assert.equal(environment.RUNNER_TEMP,'/tmp/runner');
 assert.equal(environment.GITHUB_RUN_ID,'123');
 assert.equal(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,undefined);
 assert.equal(environment.ACTIONS_ID_TOKEN_REQUEST_URL,undefined);
 assert.equal(environment.WORKFLOW_ACTION_OIDC_AUDIENCE,undefined);
 assert.equal(environment.SESSION_SYSTEM_PASSWORD,undefined);
 assert.equal(environment.GH_TOKEN,undefined);
 assert.equal(environment.TS_OAUTH_CLIENT_SECRET,undefined);
 assert.equal(environment.NODE_OPTIONS,undefined);
 assert.equal(Object.values(environment).some(v=>v?.includes('SENSITIVE_')),false);
});

test('Ubuntu Session RCA loader paths cross the sanitized transport boundary without secrets',()=>{
 const base={
   GITHUB_ACTIONS:'true',GITHUB_WORKFLOW:'ubuntu',
   GITHUB_REPOSITORY:'autoactions/github-actions',
   SESSION_ACTION_RCA:'1',HOME:'/home/runner',RUNNER_TEMP:'/tmp/runner',
   PATH:'/home/runner/.local/bin:/usr/bin',
   BASH_ENV:'/home/runner/.config/session-actions/rca-env.bash',
   GH_TOKEN:'SENSITIVE_GH_TOKEN',CLOUDFLARE_API_TOKEN:'SENSITIVE_CLOUDFLARE_TOKEN',
   ACTIONS_ID_TOKEN_REQUEST_TOKEN:'SENSITIVE_GITHUB_OIDC_REQUEST',
 };
 const reviewed=sessionTransportEnvironment(base);
 assert.equal(reviewed.SESSION_ACTION_RCA,'1');
 assert.equal(reviewed.BASH_ENV,base.BASH_ENV);
 assert.equal(reviewed.PATH,base.PATH);
 assert.equal(reviewed.GH_TOKEN,undefined);
 assert.equal(reviewed.CLOUDFLARE_API_TOKEN,undefined);
 assert.equal(reviewed.ACTIONS_ID_TOKEN_REQUEST_TOKEN,undefined);
 assert.equal(Object.values(reviewed).some(v=>v?.includes('SENSITIVE_')),false);
 for(const override of [
   {GITHUB_WORKFLOW:'windows'}, {GITHUB_REPOSITORY:'lirtual/github-actions'},
   {SESSION_ACTION_RCA:'0'}, {BASH_ENV:'/tmp/arbitrary-file'},
   {HOME:'relative/home'},
 ]) {
   const denied=sessionTransportEnvironment({...base,...override});
   assert.equal(denied.SESSION_ACTION_RCA,undefined);
   assert.equal(denied.BASH_ENV,undefined);
 }
});
