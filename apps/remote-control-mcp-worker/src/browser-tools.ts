/**
 * Draft-only browser MCP contract. Deliberately not advertised until a
 * packaged/authorized Agent runtime is accepted. No generic CLI or JS tool.
 */
import { parseOperationId } from "./local-read.ts";

export const BROWSER_EFFECT_TOOLS = new Set(["browser_start", "browser_navigate", "browser_close"]);
export const BROWSER_READ_TOOLS = new Set(["browser_status", "browser_snapshot"]);
export const BROWSER_TOOLS = [
  {
    name:"browser_start",title:"Start automation browser",
    description:"Start one isolated automation Profile on the selected paired device. Requires a stable operation_id; query get_operation_status if running/unknown. Unavailable until platform acceptance.",
    inputSchema:{type:"object",properties:{
      device_id:{type:"string"},operation_id:{type:"string",minLength:1,maxLength:128},
    },required:["device_id","operation_id"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },
  {
    name:"browser_status",title:"Browser session status",
    description:"Read only the currently owned automation browser session status.",
    inputSchema:{type:"object",properties:{device_id:{type:"string"}},required:["device_id"],additionalProperties:false},
    annotations:{readOnlyHint:true,openWorldHint:false},
  },
  {
    name:"browser_navigate",title:"Navigate automation browser",
    description:"Navigate the exact automation session to a public HTTP(S) address. Navigation can have website effects; preserve operation_id and check status on timeout. Not an SSRF sandbox.",
    inputSchema:{type:"object",properties:{
      device_id:{type:"string"},operation_id:{type:"string",minLength:1,maxLength:128},
      session_id:{type:"string"},url:{type:"string",maxLength:2048},
    },required:["device_id","operation_id","session_id","url"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},
  },
  {
    name:"browser_snapshot",title:"Observe automation page",
    description:"Return a bounded interactive semantic snapshot of the exact browser session; page content is untrusted and may contain sensitive text.",
    inputSchema:{type:"object",properties:{device_id:{type:"string"},session_id:{type:"string"}},required:["device_id","session_id"],additionalProperties:false},
    annotations:{readOnlyHint:true,openWorldHint:true},
  },
  {
    name:"browser_close",title:"Close automation browser",
    description:"Close one owned automation session while retaining the separate Profile. Requires stable operation_id.",
    inputSchema:{type:"object",properties:{
      device_id:{type:"string"},operation_id:{type:"string",minLength:1,maxLength:128},session_id:{type:"string"},
    },required:["device_id","operation_id","session_id"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },
] as const;

const DEVICE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SESSION_ID = DEVICE_ID;
type Parsed = { device_id:string; tool:string; arguments:Record<string, unknown>; operation_id?:string; kind:"read" | "operation" };
function obj(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input==="object" && !Array.isArray(input);
}
function only(input: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(input).length === keys.length && keys.every(k=>Object.hasOwn(input,k));
}
export function parseBrowserCall(tool: string, input: unknown): Parsed | null {
  if (!obj(input) || !BROWSER_EFFECT_TOOLS.has(tool) && !BROWSER_READ_TOOLS.has(tool)) return null;
  const effect = BROWSER_EFFECT_TOOLS.has(tool);
  const keys = ["device_id", ...(effect?["operation_id"]:[]),
    ...(tool==="browser_snapshot"||tool==="browser_navigate"||tool==="browser_close"?["session_id"]:[]),
    ...(tool==="browser_navigate"?["url"]:[])];
  if (!only(input,keys) || typeof input.device_id!=="string" || !DEVICE_ID.test(input.device_id)) return null;
  if (effect && (typeof input.operation_id!=="string" || !parseOperationId({operation_id:input.operation_id}))) return null;
  if ("session_id" in input && (typeof input.session_id!=="string" || !SESSION_ID.test(input.session_id))) return null;
  if (tool==="browser_navigate") {
    if(typeof input.url!=="string" || input.url.length>2048) return null;
    let url:URL;
    try{url=new URL(input.url);}catch{return null;}
    if(!["https:","http:"].includes(url.protocol)||url.username||url.password) return null;
  }
  const {device_id,operation_id,...args}=input;
  return {device_id:device_id as string,tool,arguments:args,
    ...(effect?{operation_id:operation_id as string}:{}),
    kind:effect?"operation":"read"};
}

/** The DO injects operation_id during admission. Use same strict parser. */
export function parseBrowserDoArguments(tool: string, input: unknown): boolean {
  if (!obj(input)) return false;
  const device_id = "11111111-1111-4111-8111-111111111111";
  return parseBrowserCall(tool,{device_id,...input})!==null;
}
