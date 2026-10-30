import { PublicError } from '../errors.js';
import type {Env} from '../types.js';
import {getRegistryConnection,listRegistryConnections} from './store.js';
import { ConfirmedReadFailure } from '../db/completion.js';

/** A persisted counter is conservative: unknown executions keep a positive
 * count, rather than claiming a globally empty set. It never times out or
 * self-expires. Do not infer quiescence until all deployed/rollback versions
 * use this fence and disabled probes can no longer start. */
async function releaseClaim(env:Env,id:string):Promise<void>{
 if(!env.DB)throw new PublicError('CONFIGURATION_UNAVAILABLE','Registry unavailable.');
 let release;
 try{
  release=await env.DB.prepare(`UPDATE database_connections SET in_flight_count=in_flight_count-1
    WHERE id=? AND transport='hyperdrive' AND in_flight_count>0`).bind(id).run();
 }catch{throw new PublicError('CONFIGURATION_UNAVAILABLE','Execution completion could not be confirmed.');}
 if(release.meta.changes!==1)throw new PublicError('CONFIGURATION_UNAVAILABLE','Execution completion could not be confirmed.');
}

async function fenced<T>(env:Env,id:string,revision:number,status:'active'|'disabled',execute:()=>Promise<T>):Promise<T>{
 if(!env.DB)throw new PublicError('CONFIGURATION_UNAVAILABLE','Registry unavailable.');
 let claimed;
 try{
  claimed=await env.DB.prepare(`UPDATE database_connections
    SET in_flight_count=in_flight_count+1
    WHERE id=? AND revision=? AND transport='hyperdrive' AND status=?`)
    .bind(id,revision,status).run();
 }catch{throw new PublicError('CONFIGURATION_UNAVAILABLE','Execution admission could not be confirmed.');}
 if(claimed.meta.changes!==1)throw new PublicError('CONNECTION_DISABLED','Connection state changed before admission.');
 // If UPDATE committed but its response was lost, the count stays positive.
 // Failed, timed-out or cancelled executions also retain their count, because
 // remote database work may outlive the initiating Cloudflare request.
 // Only a confirmed backend ROLLBACK can settle a failed read. Unknown
 // outcomes still retain the claim indefinitely, without a timer reset.
 let value:T;
 try { value=await execute(); }
 catch(error){
  if(!(error instanceof ConfirmedReadFailure)) throw error;
  await releaseClaim(env,id);
  throw error.publicError;
 }
 await releaseClaim(env,id);
 return value;
}

/** Central MCP tool entrypoint: no SQL may start after a disabled revision.
 * Direct connections remain unchanged; invalid/implicit multi-connection IDs
 * are still rejected by the existing admission guard. */
export async function withHyperdriveExecutionFence<T>(env:Env,requestedId:string|undefined,execute:()=>Promise<T>):Promise<T>{
 if(!env.DB)throw new PublicError('CONFIGURATION_UNAVAILABLE','Registry unavailable.');
 let id=requestedId;
 if(id===undefined){
  const list=await listRegistryConnections(env.DB);
  if(list.length!==1)return execute();
  id=list[0]!.id;
 }
 const row=await getRegistryConnection(env.DB,id);
 if(!row||row.transport!=='hyperdrive')return execute();
 if(row.status!=='active')throw new PublicError('CONNECTION_DISABLED','The requested connection is disabled.');
 return fenced(env,row.id,row.revision,'active',execute);
}

/** Protected internal Owner health probe also counts while D1 is disabled. */
export async function withDisabledHyperdriveProbeFence<T>(env:Env,id:string,revision:number,execute:()=>Promise<T>):Promise<T>{
 if(!env.DB)throw new PublicError('CONFIGURATION_UNAVAILABLE','Registry unavailable.');
 const row=await getRegistryConnection(env.DB,id);
 if(!row||row.transport!=='hyperdrive'||row.status!=='disabled'||row.revision!==revision)
  throw new PublicError('CONNECTION_DISABLED','Connection is not a disabled probe candidate.');
 return fenced(env,id,revision,'disabled',execute);
}
