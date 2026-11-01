import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';

/** Public, read-only release invariant. An old unlimited-grant Worker is never a safe rollback. */
export function checkRcaIdlePolicy(policy){
 const now=1_800_000_000_000;
 const base={device_id:'00000000-0000-4000-8000-000000000001',name:'offline',
  grant_type:'permanent',public_key:'x',fingerprint:'x',approved_at:now-32*86_400_000,revoked:false};
 const expired={...base,idle_expires_at:now};
 const offline={...base,last_verified_online_at:now-14*86_400_000,idle_window_ms:14*86_400_000};
 const stopped={...base,last_verified_online_at:now-60_000,idle_window_ms:14*86_400_000,owner_stopped:true};
 assert.equal(policy.PERMANENT_IDLE_MS,14*86_400_000,'idle release policy missing');
 assert.equal(policy.deviceStillGranted?.(expired,now),false,'old Worker would revive expired grant');
 assert.equal(policy.deviceIsAuthorized?.(offline,now),false,'old Worker would revive uncleaned offline grant');
 assert.equal(policy.deviceStillGranted?.(stopped,now),true,'stopped slot not retained');
 assert.equal(policy.deviceIsAuthorized?.(stopped,now),false,'old Worker would ignore owner OFF');
 const before={...base,last_verified_online_at:now-60_000,idle_window_ms:14*86_400_000};
 assert.equal(policy.deviceIsAuthorized?.(before,now),true,'healthy permanent grant unexpectedly revoked');
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))){
 const module=await import(pathToFileURL(path.resolve('apps/remote-control-mcp-worker/src/v2-session.ts')).href);
 checkRcaIdlePolicy(module);
 console.log('RCA indefinite-authorization rollback fence verified against selected Worker source.');
}
