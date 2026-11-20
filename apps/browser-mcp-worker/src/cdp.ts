// Spec #917: bounded public CDP shapes. No raw command/result is persisted.
export type CdpStep={method:string;params?:Record<string,unknown>;delay_ms?:number};
export type CdpCommand={
  endpoint_id:string;intent_key:string;action:"cdp";tab_id:number;
  session_id?:string;commands:CdpStep[];
};
export type CdpEventsRequest={
  endpoint_id:string;tab_id:number;action:"subscribe"|"read"|"unsubscribe";
  events?:string[];cursor?:number;limit?:number;
};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const v7=/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const eventName=/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const fields=(v:Record<string,unknown>,names:readonly string[],required:readonly string[])=>
  Object.keys(v).every(key=>names.includes(key))&&required.every(key=>Object.hasOwn(v,key));
const tab=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
const session=(v:unknown)=>typeof v==="string"&&v.length>0&&v.length<=128&&!/[\x00-\x1f\x7f]/.test(v);
const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).byteLength;

export function validCdp(value:unknown):value is CdpCommand {
  if(!object(value)||!fields(value,["endpoint_id","intent_key","action","tab_id","session_id","commands"],
    ["endpoint_id","intent_key","action","tab_id","commands"])||
    !uuid.test(value.endpoint_id as string)||!v7.test(value.intent_key as string)||
    value.action!=="cdp"||!tab(value.tab_id)||
    value.session_id!==undefined&&!session(value.session_id)||
    !Array.isArray(value.commands)||value.commands.length<1||value.commands.length>16)return false;
  let delays=0;
  for(const step of value.commands){
    if(!object(step)||!fields(step,["method","params","delay_ms"],["method"])||
      typeof step.method!=="string"||!eventName.test(step.method)||
      step.params!==undefined&&!object(step.params)||
      step.delay_ms!==undefined&&(typeof step.delay_ms!=="number"||!Number.isSafeInteger(step.delay_ms)||step.delay_ms<0||step.delay_ms>100))
      return false;
    delays+=(step.delay_ms as number|undefined)??0;
  }
  try{return delays<=800&&bytes(value)<=28672;}catch{return false;}
}
export function validCdpEvents(value:unknown):value is CdpEventsRequest {
  if(!object(value)||!fields(value,["endpoint_id","tab_id","action","events","cursor","limit"],
    ["endpoint_id","tab_id","action"])||!uuid.test(value.endpoint_id as string)||!tab(value.tab_id)||
    !["subscribe","read","unsubscribe"].includes(value.action as string))return false;
  if(value.events!==undefined&&(!Array.isArray(value.events)||value.action!=="subscribe"||
    value.events.length<1||value.events.length>16||
    value.events.some(e=>typeof e!=="string"||!eventName.test(e))))return false;
  if(value.action==="subscribe"&&value.events===undefined)return false;
  if(value.cursor!==undefined&&(value.action!=="read"||typeof value.cursor!=="number"||!Number.isSafeInteger(value.cursor)||value.cursor<0))return false;
  if(value.limit!==undefined&&(value.action!=="read"||typeof value.limit!=="number"||!Number.isSafeInteger(value.limit)||value.limit<1||value.limit>64))return false;
  try{return bytes(value)<=4096;}catch{return false;}
}
