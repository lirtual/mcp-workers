// Fixed public interaction contract, shared by MCP ingress and durable admission.
export const interactionActions = ["click","fill","keypress","scroll","select"] as const;
export type InteractionAction = typeof interactionActions[number];
export type Interaction = {
  endpoint_id:string;intent_key:string;action:InteractionAction;tab_id:number;
  document_id:string;element_id:string;text?:string;key?:string;delta_y?:number;value?:string;
};
export const interactionExtra = {click:[],fill:["text"],keypress:["key"],scroll:["delta_y"],select:["value"]} as const;
export function isInteraction(action:unknown):action is InteractionAction {
  return interactionActions.includes(action as InteractionAction);
}
export function validInteraction(c:Record<string,unknown>):boolean {
  if(!isInteraction(c.action))return false;
  const keys=["endpoint_id","intent_key","action","tab_id","document_id","element_id",...interactionExtra[c.action]];
  if(Object.keys(c).length!==keys.length || keys.some(k=>!Object.hasOwn(c,k)))return false;
  if(typeof c.endpoint_id!=="string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.endpoint_id) ||
     typeof c.intent_key!=="string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(c.intent_key) ||
     !Number.isSafeInteger(c.tab_id)||(c.tab_id as number)<0 ||
     typeof c.document_id!=="string"||c.document_id.length<1||c.document_id.length>200 ||
     typeof c.element_id!=="string"||!/^e-[a-f0-9-]{36}$/.test(c.element_id))return false;
  if(c.action==="fill")return typeof c.text==="string"&&c.text.length<=2000;
  if(c.action==="select")return typeof c.value==="string"&&c.value.length<=200;
  if(c.action==="keypress")return ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","Escape"].includes(c.key as string);
  if(c.action==="scroll")return Number.isSafeInteger(c.delta_y)&&Math.abs(c.delta_y as number)<=1000&&c.delta_y!==0;
  return true;
}
