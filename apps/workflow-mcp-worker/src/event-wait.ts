import {canonicalJsonString} from './plan.ts';

export const EVENT_WAIT_ID=/^[A-Za-z0-9_.:-]{1,96}$/;
export const EVENT_WAIT_BEARER=/^[A-Za-z0-9_-]{43}$/;
export const EVENT_WAIT_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function eventTypeForStep(stepId:string):string {
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(stepId))throw Error('invalid_event_step');
  return 'wfe_'+stepId;
}
export async function sha256(value:string):Promise<string>{
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function constantTimeDigestEqual(left:string,right:string):boolean{
  if(!/^[a-f0-9]{64}$/.test(left)||!/^[a-f0-9]{64}$/.test(right))return false;
  let difference=0;
  for(let i=0;i<64;i++)difference|=left.charCodeAt(i)^right.charCodeAt(i);
  return difference===0;
}
export async function payloadDigest(value:unknown):Promise<string>{
  return sha256(canonicalJsonString(value));
}
