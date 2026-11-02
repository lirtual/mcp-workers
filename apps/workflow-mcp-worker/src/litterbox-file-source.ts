/**
 * Fail-closed, memory-only retrieval for a separately approved Litterbox
 * upload. The ChatGPT fileParams descriptor is user-selected, not a
 * cryptographic provenance attestation. The signed URL never enters D1,
 * the Provider or tool responses, and redirects are never followed.
 */
export const LITTERBOX_MAX_BYTES=10*1024*1024;
export type ChatGptFile={download_url:string;file_id:string;file_name?:string;mime_type?:string};
// OpenAI fileParams declares file_id as an opaque string; there is no
// guaranteed prefix, UUID shape or character alphabet. This is NOT proof
// of file provenance and is never sent to the Litterbox Provider.
const validFileId=(value:unknown):value is string=>
 typeof value==='string'&&value.length>0&&value.length<=512&&
 value.trim().length>0&&!/[\u0000-\u001f\u007f]/.test(value);
// Exact Azure Blob public endpoint shape, not an Azure wildcard or proof of
// OpenAI ownership. The ChatGPT-selected temporary URL is an external GET.
// SAS is validated by Azure; here only the bounded URI shape is validated.
const approvedAzureBlobSas=(u:URL):boolean=>{
 if(!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(u.hostname))return false;
 const path=u.pathname.split('/');
 if(path.length<3||!path[1]||!path[2])return false;
 const q=u.searchParams;
 const one=(key:string)=>{const v=q.getAll(key);return v.length===1&&v[0]?v[0]:null;};
 const sig=one('sig'),expiry=one('se'),version=one('sv');
 if(!sig||!expiry||!version||!Number.isFinite(Date.parse(expiry)))return false;
 if(q.getAll('sp').length>1||(q.has('sp')&&one('sp')!=='r'))return false;
 if(q.getAll('sr').length>1||
  (q.has('sr')&&!['b','bv','bs'].includes(one('sr')??'')))return false;
 return true;
};
export function approvedAttachmentUrl(file:unknown):URL|null {
 if(!file||typeof file!=='object'||Array.isArray(file))return null;
 const f=file as Record<string,unknown>;
 if(Object.keys(f).some(k=>!['file_id','download_url','file_name','mime_type'].includes(k))||
  !validFileId(f.file_id)||
  typeof f.download_url!=='string'||f.download_url.length>4096)return null;
 try{
  const url=new URL(f.download_url);
  // Provider and D1 never receive this URL, its SAS signature, or file_id.
  if(url.protocol!=='https:'||url.port||url.username||url.password||
    url.hash||url.pathname==='/'||url.href!==f.download_url)return null;
  if(url.hostname!=='files.oaiusercontent.com'&&!approvedAzureBlobSas(url))
    return null;
  return url;
 }catch{return null;}
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
