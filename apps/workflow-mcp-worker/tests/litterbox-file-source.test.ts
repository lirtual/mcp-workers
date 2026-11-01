import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedAttachmentUrl,readBoundedAttachment,AttachmentReadError,
 LITTERBOX_MAX_BYTES} from '../src/litterbox-file-source.ts';
const file={file_id:'file_00000001',download_url:'https://files.oaiusercontent.com/test-fixture?token=disposable',
 mime_type:'text/plain',file_name:'fixture.txt'};
test('only exact OpenAI HTTPS file host and valid file ID can be fetched',()=>{
 assert.equal(approvedAttachmentUrl(file)?.hostname,'files.oaiusercontent.com');
 for(const u of [
  'https://evil.test/x','http://files.oaiusercontent.com/x',
  'https://files.oaiusercontent.com.evil.test/x',
  'https://evil.test@files.oaiusercontent.com/x',
  'https://files.oaiusercontent.com:444/x',
  'https://files.oaiusercontent.com/x#frag',
  'https://files.oaiusercontent.com/',
 ]){
  assert.equal(approvedAttachmentUrl({...file,download_url:u}),null);
 }
 assert.ok(approvedAttachmentUrl({...file,file_id:'other'}));
 assert.ok(approvedAttachmentUrl({...file,file_id:'file-opaque:live-reference'}));
 for(const bad of ['', '   ', '\n', 'a'.repeat(513)]){
  assert.equal(approvedAttachmentUrl({...file,file_id:bad}),null);
 }
 assert.equal(approvedAttachmentUrl({...file,extra:'thing'}),null);
});
test('fetches the one file with no credentials or redirect, hashes bounded bytes in memory',async()=>{
 let count=0;
 const text='test fixture no secrets';
 const reply=await readBoundedAttachment(file,async(url,opts)=>{
  count++;assert.equal(url,file.download_url);
  assert.equal(opts?.redirect,'manual');assert.equal(opts?.credentials,'omit');
  assert.equal(opts?.method,'GET');assert.equal(opts?.headers,undefined);
  return new Response(text);
 });
 assert.equal(count,1);assert.equal(new TextDecoder().decode(reply.bytes),text);
 assert.equal(reply.size_bytes,new TextEncoder().encode(text).length);
 assert.match(reply.sha256,/^[a-f0-9]{64}$/);
 assert.equal('download_url' in reply,false);
 assert.equal('file_id' in reply,false);
});
test('rejects redirects, content-length overflow, streamed overflow, empty and unreadable bytes',async()=>{
 for(const response of [
  new Response(null,{status:302,headers:{location:'https://evil.test/'}}),
  new Response('x',{headers:{'content-length':String(LITTERBOX_MAX_BYTES+1)}}),
  new Response(null,{status:404}),new Response(''),
  new Response(new Uint8Array(LITTERBOX_MAX_BYTES+1)),
 ]){
  await assert.rejects(()=>readBoundedAttachment(file,async()=>response),AttachmentReadError);
 }
 let fetches=0;
 await assert.rejects(()=>readBoundedAttachment({...file,download_url:'https://127.0.0.1/'},
  async()=>{fetches++;return new Response('x');}),/file_source_unverified/);
 assert.equal(fetches,0);
});
test('exactly 10 MiB accepted and 10 MiB plus one denied',async()=>{
 const ok=await readBoundedAttachment(file,async()=>new Response(new Uint8Array(LITTERBOX_MAX_BYTES)));
 assert.equal(ok.size_bytes,LITTERBOX_MAX_BYTES);
 await assert.rejects(()=>readBoundedAttachment(file,async()=>new Response(
  new Uint8Array(LITTERBOX_MAX_BYTES+1))),/file_size_limit/);
});

const azure={...file,download_url:
 'https://selectedblob123.blob.core.windows.net/uploads/fixture.txt?sv=2024-11-04&se=2026-11-01T22%3A00%3A00Z&sr=b&sp=r&sig=SYNTHETIC_SECRET'};
test('exact signed Azure Blob URL allows bounded, memory-only GET',async()=>{
 assert.equal(approvedAttachmentUrl(azure)?.hostname,'selectedblob123.blob.core.windows.net');
 let fetched=0;
 const result=await readBoundedAttachment(azure,async(url,init)=>{
  fetched++;assert.equal(url,azure.download_url);
  assert.equal(init?.method,'GET');
  assert.equal(init?.redirect,'manual');
  assert.equal(init?.credentials,'omit');
  assert.equal(init?.headers,undefined);
  return new Response('synthetic file');
 });
 assert.equal(fetched,1);
 assert.equal(new TextDecoder().decode(result.bytes),'synthetic file');
 assert.match(result.sha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'),false);
});
test('Azure malformed, unauthorized, and non-Blob URLs fail before any fetch',async()=>{
 const signed='?sig=abc&sv=2024-11-04&se=2026-11-01T22%3A00%3A00Z&sr=b&sp=r';
 const endpoint='https://selectedblob123.blob.core.windows.net';
 const invalid=[
 endpoint+'/uploads/fixture.txt',
 endpoint+'/uploads/fixture.txt?sig=a&sv=x',
 endpoint+'/uploads/fixture.txt?sig=a&sv=x&se=invalid',
 endpoint+'/uploads/fixture.txt'+signed+'&sig=second',
 endpoint+'/uploads/fixture.txt'+signed+'&sp=rw',
 endpoint+'/uploads/fixture.txt?sig=abc&sv=x&se=2026-11-01T22%3A00%3A00Z&sp=rw',
 endpoint+'/uploads/fixture.txt?sig=abc&sv=x&se=2026-11-01T22%3A00%3A00Z&sr=c',
 endpoint+'/uploads/'+signed,
 endpoint+'/'+signed,
 'https://a.blob.core.windows.net/uploads/fixture.txt'+signed,
 'https://abc-def.blob.core.windows.net/uploads/fixture.txt'+signed,
 'https://selectedblob123.file.core.windows.net/uploads/fixture.txt'+signed,
 'https://selectedblob123.blob.core.windows.net.attacker.test/uploads/fixture.txt'+signed,
 'http://selectedblob123.blob.core.windows.net/uploads/fixture.txt'+signed,
 'https://selectedblob123.blob.core.windows.net:444/uploads/fixture.txt'+signed,
 'https://user:pass@selectedblob123.blob.core.windows.net/uploads/fixture.txt'+signed,
 endpoint+'/uploads/fixture.txt'+signed+'#frag',
 'https://127.0.0.1/uploads/fixture.txt'+signed,
 ];
 let fetched=0;
 for(const url of invalid){
  const selected={...azure,download_url:url};
  assert.equal(approvedAttachmentUrl(selected),null,url);
  await assert.rejects(()=>readBoundedAttachment(selected,async()=>{
   fetched++;return new Response('forbidden');
  }),/file_source_unverified/);
 }
 assert.equal(fetched,0);
});

test('Azure Blob signed source inherits redirect and byte-limit safety',async()=>{
 const redirect=new Response(null,{status:307,
  headers:{location:'https://evil.test/redirect'}});
 await assert.rejects(()=>readBoundedAttachment(azure,async()=>redirect),/file_read_unavailable/);
 const tooLarge=new Response('x',{headers:{'content-length':String(LITTERBOX_MAX_BYTES+1)}});
 await assert.rejects(()=>readBoundedAttachment(azure,async()=>tooLarge),/file_size_limit/);
});
