import type {Env} from './store.ts';

type DB=Env['DB'];
type State={state:'enabled'|'revoked';generation:number};
export async function httpAuthorization(db:DB):Promise<State>{
 const row=await db.prepare("SELECT state,generation FROM http_connection_auth WHERE id='http'").first<State>();
 if(!row||!['enabled','revoked'].includes(row.state)||
    !Number.isSafeInteger(row.generation)||row.generation<0)
   throw Error('http_authorization_unavailable');
 return {state:row.state,generation:row.generation};
}
export async function changeHttpAuthorization(db:DB,action:'revoke'|'enable'){
 if(action==='revoke'){
  await db.prepare("UPDATE http_connection_auth SET state='revoked',generation=generation+1,updated_at=? WHERE id='http' AND state='enabled'")
   .bind(Date.now()).run();
 }else{
  await db.prepare("UPDATE http_connection_auth SET state='enabled',updated_at=? WHERE id='http' AND state='revoked'")
   .bind(Date.now()).run();
 }
 return httpAuthorization(db);
}
