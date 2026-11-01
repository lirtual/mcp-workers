import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRcaIdlePolicy} from './check-rca-idle-release.mjs';
import {PERMANENT_IDLE_MS,deviceStillGranted,deviceIsAuthorized} from '../apps/remote-control-mcp-worker/src/v2-session.ts';
test('RCA release policy denies stale offline and owner-stop grants without physical deletion',()=>{
 assert.doesNotThrow(()=>checkRcaIdlePolicy({PERMANENT_IDLE_MS,deviceStillGranted,deviceIsAuthorized}));
});
test('old unlimited-grant Worker and incomplete implementation fail the release fence',()=>{
 assert.throws(()=>checkRcaIdlePolicy({PERMANENT_IDLE_MS,deviceStillGranted:()=>true,deviceIsAuthorized:()=>true}),/old Worker/);
 assert.throws(()=>checkRcaIdlePolicy({PERMANENT_IDLE_MS}),/old Worker/);
});
