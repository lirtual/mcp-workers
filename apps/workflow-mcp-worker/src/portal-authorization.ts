import type {Env} from './store.ts';

type DB=Env['DB'];
type State={state:'enabled'|'revoked';generation:number};
const now=()=>Date.now();
const valid=(row:State|null):row is State=>
 !!row && (row.state==='enabled'||row.state==='revoked') &&
 Number.isSafeInteger(row.generation)&&row.generation>=0;

/** A single fixed Portal connection; never grant an arbitrary URL or tool name. */
export async function portalAuthorization(db:DB):Promise<State>{
 const row=await db.prepare("SELECT state,generation FROM portal_connection_auth WHERE id='portal'").first<State>();
 if(!valid(row))throw Error('portal_authorization_unavailable');
 return {state:row.state,generation:row.generation};
}

/** Increment on first revoke. Enabling does not undo the generation change. */
export async function changePortalAuthorization(db:DB,action:'revoke'|'enable'){
 if(action==='revoke'){
  await db.prepare("UPDATE portal_connection_auth SET state='revoked',generation=generation+1,updated_at=? WHERE id='portal' AND state='enabled'")
   .bind(now()).run();
 }else{
  await db.prepare("UPDATE portal_connection_auth SET state='enabled',updated_at=? WHERE id='portal' AND state='revoked'")
   .bind(now()).run();
 }
 return portalAuthorization(db);
}

/** One transactional D1 statement orders a protected tools/call vs revocation.
 * Old Published Plans carry implicit generation 0 until explicitly republished.
 * A reservation that wins may still complete after revoke; it is not retried.
 */
export async function reservePortalCall(
 db:DB,runId:string,stepId:string,generation:number,
):Promise<'reserved'|'revoked'|'already_reserved'>{
 if(!Number.isSafeInteger(generation)||generation<0)throw Error('portal_generation_invalid');
 const written=await db.prepare(`INSERT INTO mcp_dispatch_fences(run_id,step_id,generation,created_at)
  SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM portal_connection_auth
     WHERE id='portal' AND state='enabled' AND generation=?)
   AND EXISTS (SELECT 1 FROM runs WHERE id=? AND outcome='running')
  ON CONFLICT(run_id,step_id) DO NOTHING`)
  .bind(runId,stepId,generation,now(),generation,runId).run();
 if(written.meta.changes===1)return 'reserved';
 const previous=await db.prepare('SELECT 1 AS present FROM mcp_dispatch_fences WHERE run_id=? AND step_id=?')
  .bind(runId,stepId).first<{present:number}>();
 return previous?'already_reserved':'revoked';
}
