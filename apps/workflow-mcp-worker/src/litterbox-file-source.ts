/**
 * Memory-only, fail-closed file download boundary for a future manually
 * approved Litterbox Action. NOT wired to an executable MCP tool.
 * The ChatGPT file ID is not authentication; allowlist the ephemeral URL
 * origin and never store it or fetch redirects.
 */
export const LITTERBOX_MAX_BYTES=10*1024*1024;
export type ChatGptFile={download_url:string;file_id:string;file_name?:string;mime_type?:string};
const FILE_ID=/^file_[A-Za-z0-9_-]{1,128}$/;
export function approvedAttachmentUrl(file:unknown):URL|null {
 if(!file||typeof file!=='object'||Array.isArray(file))return null;
 const f=file as Record<string,unknown>;
 if(Object.keys(f).some(k=>!['file_id','download_url','file_name','mime_type'].includes(k))||
  typeof f.file_id!=='string'||!FILE_ID.test(f.file_id)||
  typeof f.download_url!=='string'||f.download_url.length>4096)return null;
 try{
  const url=new URL(f.download_url);
  // This exact upstream file domain is a conservative source gate; the
  // provider never receives download_url or file_id.
  if(url.protocol!=='https:'||url.hostname!=='files.oaiusercontent.com'||
    !!url.port||!!url.username||!!url.password||!!url.hash||url.pathname==='/'||
    url.href!==f.download_url)return null;
  return url;
 }catch{return null;}
}
// Read-only privacy-preserving rejection diagnostics. Never expose URL,
// hostname, file ID, path, query or token; no fetch, logging or D1 access.
// An origin-family label is NOT authorization to extend the fixed allowlist.
export function classifyAttachmentSource(file:unknown):{
 failure_code:'none'|'file_object_invalid'|'file_id_invalid'|
  'download_url_invalid'|'download_url_not_https'|'download_url_unsafe'|
  'download_host_not_allowlisted';
 origin_family:'expected_file_origin'|'oaiusercontent_other'|
  'chatgpt'|'openai_other'|'other'|'invalid';
}{
 const denied=(failure_code:ReturnType<typeof classifyAttachmentSource>['failure_code'],
  origin_family:ReturnType<typeof classifyAttachmentSource>['origin_family']='invalid')=>
  ({failure_code,origin_family});
 if(!file||typeof file!=='object'||Array.isArray(file))
  return denied('file_object_invalid');
 const f=file as Record<string,unknown>;
 if(Object.keys(f).some(k=>!['download_url','file_id','mime_type','file_name'].includes(k)))
  return denied('file_object_invalid');
 if(typeof f.file_id!=='string'||!FILE_ID.test(f.file_id))
  return denied('file_id_invalid');
 if(typeof f.download_url!=='string'||f.download_url.length===0||
    f.download_url.length>4096)return denied('download_url_invalid');
 let u:URL;
 try{u=new URL(f.download_url);}
 catch{return denied('download_url_invalid');}
 const host=u.hostname;
 const family:ReturnType<typeof classifyAttachmentSource>['origin_family']=
  host==='files.oaiusercontent.com'?'expected_file_origin':
  host==='oaiusercontent.com'||host.endsWith('.oaiusercontent.com')?'oaiusercontent_other':
  host==='chatgpt.com'||host.endsWith('.chatgpt.com')?'chatgpt':
  host==='openai.com'||host.endsWith('.openai.com')?'openai_other':'other';
 if(u.protocol!=='https:')return denied('download_url_not_https',family);
 if(u.port||u.username||u.password||u.hash||u.pathname==='/'||
    u.href!==f.download_url)return denied('download_url_unsafe',family);
 if(host!=='files.oaiusercontent.com')
  return denied('download_host_not_allowlisted',family);
 return denied('none',family);
}
export class AttachmentReadError extends Error{
 code:string;
 constructor(code:string){super(code);this.code=code;}
}
export async function readBoundedAttachment(file:ChatGptFile,fetcher:typeof fetch=fetch):Promise<{
 bytes:Uint8Array;size_bytes:number;sha256:string;
}>{
 const url=approvedAttachmentUrl(file);
 if(!url)throw new AttachmentReadError('file_source_unverified');
 let response:Response;
 try{
  response=await fetcher(url.href,{method:'GET',redirect:'manual',
   credentials:'omit',signal:AbortSignal.timeout(15000)});
 }catch{throw new AttachmentReadError('file_read_unknown');}
 if(response.status!==200||!response.body)throw new AttachmentReadError('file_read_unavailable');
 const size=response.headers.get('content-length');
 if(size!==null&&(!/^\d+$/.test(size)||Number(size)>LITTERBOX_MAX_BYTES))
   throw new AttachmentReadError('file_size_limit');
 const reader=response.body.getReader();
 const chunks:Uint8Array[]=[];
 let total=0;
 try{
  while(true){
   const {value,done}=await reader.read();
   if(done)break;
   if(!(value instanceof Uint8Array))throw new AttachmentReadError('invalid_file_chunk');
   total+=value.byteLength;
   if(total>LITTERBOX_MAX_BYTES)throw new AttachmentReadError('file_size_limit');
   chunks.push(value);
  }
 }catch(e){
  try{await reader.cancel();}catch{}
  if(e instanceof AttachmentReadError)throw e;
  throw new AttachmentReadError('file_read_unknown');
 }finally{reader.releaseLock();}
 if(total===0)throw new AttachmentReadError('empty_file_not_supported');
 const bytes=new Uint8Array(total);
 let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
 const sha256=Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
 return {bytes,size_bytes:total,sha256};
}
