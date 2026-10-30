/** Static, source-reviewed Cloudflare Provider catalog. Discovery is not authority. */
export const WEIXIN_CLOUDFLARE_ACTION=Object.freeze({
 executor:'cloudflare',provider:'weixin',action:'weixin.send_text',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',
 entrypoint:'ActionsEntrypoint',side_effect:'send_to_verified_owner_only',
 input_schema:{type:'object',additionalProperties:false,
  required:['session_step_id'],properties:{session_step_id:{type:'string',
   description:'A dependency on a signed, physically verified OpenList Session in this Run'}}},
 output_schema:{type:'object',additionalProperties:false,
  required:['status'],properties:{status:{enum:['accepted','rejected','unknown']}}},
});
export const DOWNLOAD_CLOUDFLARE_ACTION=Object.freeze({
 executor:'cloudflare',provider:'weixin',action:'weixin.notify_download',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',
 entrypoint:'ActionsEntrypoint',side_effect:'send_to_verified_owner_only',
 input_schema:{type:'object',additionalProperties:false,
  required:['download_step_id'],properties:{download_step_id:{type:'string',
   description:'A verified single-item GitHub download Task foreach in this Run'}}},
 output_schema:{type:'object',additionalProperties:false,
  required:['status'],properties:{status:{enum:['accepted','rejected','unknown']}}},
});
export const BARK_CLOUDFLARE_ACTION=Object.freeze({
 executor:'cloudflare',provider:'bark',action:'bark.send_notification',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',
 entrypoint:'ActionsEntrypoint',side_effect:'send_to_configured_owner_only',
 input_schema:{type:'object',additionalProperties:false,required:['body'],
  properties:{body:{type:'string'},title:{type:'string'},subtitle:{type:'string'},
  markdown:{type:'string'},group:{type:'string'},level:{type:'string'},sound:{type:'string'},
  volume:{type:'integer'},call:{type:'boolean'},copy:{type:'string'},autoCopy:{type:'boolean'},
  icon:{type:'string'},image:{type:'string'},url:{type:'string'},action:{type:'string'},
  isArchive:{type:'boolean'},ttl:{type:'integer'},badge:{type:'integer'},id:{type:'string'}}},
 output_schema:{type:'object',additionalProperties:false,required:['status'],
  properties:{status:{enum:['accepted','rejected','unknown']}}},
});
export function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(
  Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>[k,canonical(v)]));
 return value;
}
export async function cloudflareActionManifest(provider:'weixin'|'bark'|'download'='weixin'){
 const item=provider==='bark'?BARK_CLOUDFLARE_ACTION:
  provider==='download'?DOWNLOAD_CLOUDFLARE_ACTION:WEIXIN_CLOUDFLARE_ACTION;
 const bytes=new TextEncoder().encode(JSON.stringify(canonical(item)));
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
 return {...item,contract_digest:Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('')};
}
