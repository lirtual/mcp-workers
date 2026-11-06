import { getRuntimeLimits, getMaxWriteAffectedRows } from './config.js';
import { PublicError } from './errors.js';
import {configuredCatalog} from './catalog.js';
import type { EffectiveConnection, EffectiveWriteConnection, Env } from './types.js';
import { resolveHyperdriveConnection } from './db/hyperdrive.js';
import {validatePublicEndpoint} from './public-endpoint.js';
export async function catalogMetadata(env:Env) {
  return configuredCatalog(env).map(({id,dialect,transport})=>({id,dialect,transport,status:'active'}));
}
export async function admitConnection(env:Env, requestedId?:string):Promise<EffectiveConnection> {
  const entries=configuredCatalog(env);
  if (requestedId===undefined && entries.length!==1) {
    if (!entries.length) throw new PublicError('CONNECTION_NOT_FOUND','No database connections are configured.');
    throw new PublicError('INVALID_INPUT','A connection id is required when multiple connections are configured.');
  }
  const entry=requestedId===undefined?entries[0]:entries.find(item=>item.id===requestedId);
  if (!entry) throw new PublicError('CONNECTION_NOT_FOUND','The requested logical connection does not exist.');
  if (entry.transport==='hyperdrive') return resolveHyperdriveConnection(env,entry.id,entry.bindingName!);
  const parsed=await validatePublicEndpoint(entry.url!,entry.id);
  return {config:{id:entry.id,transport:'direct',url:entry.url!},transport:'direct',...parsed,limits:getRuntimeLimits(env)};
}
export async function admitWriteConnection(env:Env,id?:string):Promise<EffectiveWriteConnection> {
  return {...await admitConnection(env,id),maxAffectedRows:getMaxWriteAffectedRows(env)};
}
