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
 assert.equal(approvedAttachmentUrl({...file,file_id:'other'}),null);
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
