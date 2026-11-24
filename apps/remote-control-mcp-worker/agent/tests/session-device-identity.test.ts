import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { newSessionDeviceIdentity, signSessionEnrollmentNonce, validateSessionDeviceIdentity,
  type SessionPhysicalAttempt } from '../src/session-device-identity.ts';

const attempt:SessionPhysicalAttempt={attempt_id:'123e4567-e89b-42d3-a456-426614174004',
  github_run_id:1234,github_run_attempt:2,workflow_name:'ubuntu'};

test('fresh identity and nonce proof are scoped to exact physical Attempt',()=>{
  const one=newSessionDeviceIdentity(attempt);
  const two=newSessionDeviceIdentity({...attempt,github_run_attempt:3});
  assert.notEqual(one.public_key,two.public_key);
  validateSessionDeviceIdentity(one,attempt);
  assert.throws(()=>validateSessionDeviceIdentity(one,{...attempt,github_run_attempt:3}));
  assert.throws(()=>validateSessionDeviceIdentity({...one,public_key:two.public_key},attempt));
  assert.throws(()=>newSessionDeviceIdentity({...attempt,github_run_id:0}));
  const nonce='dummy_nonce_AAAAAAAAAAAAAAAAAA';
  const signature=Buffer.from(signSessionEnrollmentNonce(one,nonce),'base64');
  const signed=['remote-control:github-session-enrollment:v1:',
    [attempt.attempt_id,attempt.github_run_id,attempt.github_run_attempt,
      attempt.workflow_name,one.public_key,nonce].join(':')].join('');
  const key=createPublicKey({key:Buffer.from(one.public_key,'base64'),type:'spki',format:'der'});
  assert.equal(verify(null,Buffer.from(signed),key,signature),true);
  assert.equal(verify(null,Buffer.from(signed+'changed'),key,signature),false);
  assert.throws(()=>signSessionEnrollmentNonce(one,'bad'));
});
