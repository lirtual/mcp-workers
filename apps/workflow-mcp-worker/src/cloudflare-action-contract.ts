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
// Version 2 is text-first. Version 1 remains for immutable published Plans.
export const GENERIC_WEIXIN_CLOUDFLARE_ACTION=Object.freeze({
 executor:'cloudflare',provider:'weixin',action:'weixin.send_text',version:2,
 source_repository:'lirtual/cloudflare-actions',service:'weixin-mcp-worker',
 entrypoint:'WeixinActionProvider',side_effect:'send_to_verified_owner_only',
 input_schema:{type:'object',additionalProperties:false,required:['text'],
  properties:{text:{type:'string',minLength:1,maxLength:2048},
   session_step_id:{type:'string'}}},
 output_schema:{type:'object',additionalProperties:false,required:['status'],
  properties:{status:{enum:['accepted','rejected','unknown']}}},
});
// v2 remains the immutable legacy Worker contract for already-published Plans.
// v3 is the same Action ID, now published exclusively on the unified Worker.
export const UNIFIED_GENERIC_WEIXIN_ACTION=Object.freeze({
 ...GENERIC_WEIXIN_CLOUDFLARE_ACTION,version:3,
 service:'cloudflare-actions',entrypoint:'ActionsEntrypoint',
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
export const DUB_CLOUDFLARE_ACTION=Object.freeze({
 executor:'cloudflare',provider:'dub',action:'dub.shorten_url',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',
 entrypoint:'ActionsEntrypoint',side_effect:'create_public_short_link_at_dub',
 input_schema:{type:'object',additionalProperties:false,required:['url'],
  properties:{url:{type:'string',maxLength:2048},public_stats:{type:'boolean'}}},
 output_schema:{type:'object',additionalProperties:false,required:['status'],
  properties:{status:{enum:['accepted','rejected','unknown']},short_link:{type:'string'}}},
});
export const ENVSHARE_CLOUDFLARE_ACTION=Object.freeze({
 executor:'cloudflare',provider:'envshare',action:'envshare.share_text',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',
 entrypoint:'ActionsEntrypoint',side_effect:'store_encrypted_text_at_envshare',
 input_schema:{type:'object',additionalProperties:false,
  required:['encrypted','iv','ttl','reads'],properties:{
   encrypted:{type:'string',maxLength:30000},iv:{type:'string',maxLength:32},
   ttl:{type:'integer'},reads:{type:'integer'}}},
 output_schema:{type:'object',additionalProperties:false,
  required:['status'],properties:{status:{enum:['accepted','rejected','unknown']},share_id:{type:'string'}}},
});
export function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(
  Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>[k,canonical(v)]));
 return value;
}
export async function cloudflareActionManifest(provider:'weixin'|'bark'|'download'|'generic'|'unified-generic'|'dub'|'envshare'='weixin'){
 const item=provider==='envshare'?ENVSHARE_CLOUDFLARE_ACTION:provider==='dub'?DUB_CLOUDFLARE_ACTION:provider==='bark'?BARK_CLOUDFLARE_ACTION:
  provider==='download'?DOWNLOAD_CLOUDFLARE_ACTION:provider==='generic'?GENERIC_WEIXIN_CLOUDFLARE_ACTION:provider==='unified-generic'?UNIFIED_GENERIC_WEIXIN_ACTION:WEIXIN_CLOUDFLARE_ACTION;
 const bytes=new TextEncoder().encode(JSON.stringify(canonical(item)));
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
 return {...item,contract_digest:Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('')};
}
