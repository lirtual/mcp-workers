/** Static, source-reviewed Cloudflare Provider catalog. Discovery is not authority. */
export const WEIXIN_CLOUDFLARE_ACTION = Object.freeze({
 executor:'cloudflare',provider:'weixin',action:'weixin.send_text',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'weixin-mcp-worker',
 entrypoint:'WeixinActionProvider',
 side_effect:'send_to_verified_owner_only',
 input_schema:{type:'object',additionalProperties:false,
  required:['session_step_id'],properties:{session_step_id:{type:'string',
   description:'A dependency on a signed, physically verified OpenList Session in this Run'}}},
 output_schema:{type:'object',additionalProperties:false,
  required:['status'],properties:{status:{enum:['accepted','rejected','unknown']}}},
});
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(
  Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>[k,canonical(v)]));
 return value;
}
export async function cloudflareActionManifest(){
 const bytes=new TextEncoder().encode(JSON.stringify(canonical(WEIXIN_CLOUDFLARE_ACTION)));
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
 return {...WEIXIN_CLOUDFLARE_ACTION,
  contract_digest:Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('')};
}
