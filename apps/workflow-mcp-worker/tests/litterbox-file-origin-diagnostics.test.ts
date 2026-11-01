import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedAttachmentUrl,classifyAttachmentSource,attachmentOriginSuffixHint} from '../src/litterbox-file-source.ts';

const base={file_id:'file_ABC123',download_url:
 'https://files.oaiusercontent.com/file.txt?token=PRIVATE_DO_NOT_ECHO',
 file_name:'very-private-filename.txt',mime_type:'text/plain'};

test('approved source is unchanged and produces generic safe classification',()=>{
 assert.ok(approvedAttachmentUrl(base));
 assert.deepEqual(classifyAttachmentSource(base),{
  failure_code:'none',origin_family:'expected_file_origin',
 });
});
test('opaque IDs without a file_ prefix are accepted, not treated as authentication',()=>{
 for(const id of ['file-opaque:live-reference','reference-without-prefix',
  '123e4567-e89b-42d3-a456-426614174000']){
  const f={...base,file_id:id};
  assert.ok(approvedAttachmentUrl(f));
  assert.deepEqual(classifyAttachmentSource(f),{
   failure_code:'none',origin_family:'expected_file_origin'});
 }
});
test('read-only diagnostic identifies the violated invariant without leaking identifiers',()=>{
 const examples=[
  [{...base,file_id:''},'file_id_invalid','invalid'],
  [{...base,file_id:'\n'},'file_id_invalid','invalid'],
  [{...base,file_id:'x'.repeat(513)},'file_id_invalid','invalid'],
  [{...base,download_url:'not-a-url'},'download_url_invalid','invalid'],
  [{...base,download_url:'http://files.oaiusercontent.com/x'},'download_url_not_https','expected_file_origin'],
  [{...base,download_url:'https://other.oaiusercontent.com/x'},'download_host_not_allowlisted','oaiusercontent_other'],
  [{...base,download_url:'https://chatgpt.com/backend-api/file?token=PRIVATE_DO_NOT_ECHO'},'download_host_not_allowlisted','chatgpt'],
  [{...base,download_url:'https://static.openai.com/x'},'download_host_not_allowlisted','openai_other'],
  [{...base,download_url:'https://evil.test/x'},'download_host_not_allowlisted','other'],
  [{...base,download_url:'https://files.oaiusercontent.com/x#private'},'download_url_unsafe','expected_file_origin'],
  [{...base,download_url:'https://me:secret@files.oaiusercontent.com/x'},'download_url_unsafe','expected_file_origin'],
  [{...base,download_url:'https://files.oaiusercontent.com:9999/x'},'download_url_unsafe','expected_file_origin'],
  [{...base,extra:'untrusted'},'file_object_invalid','invalid'],
 ] as const;
 for(const [input,code,family] of examples){
  const out=classifyAttachmentSource(input);
  assert.equal(out.failure_code,code);
  assert.equal(out.origin_family,family);
  assert.equal(approvedAttachmentUrl(input),null);
  const disclosure=JSON.stringify(out);
  for(const secret of ['PRIVATE_DO_NOT_ECHO','very-private-filename','file_ABC123',
   'chatgpt.com','other.oaiusercontent.com','evil.test']){
   assert.equal(disclosure.includes(secret),false,'diagnostic disclosed file source');
  }
 }
});


test('origin hint exposes no source URL, full hostname or file token',()=>{
 const input={...base, download_url:
  'https://private-fixture-bucket.assets.provider-example.dev/x?signature=PRIVATE_DO_NOT_ECHO'};
 const out=classifyAttachmentSource(input);
 assert.equal(out.failure_code,'download_host_not_allowlisted');
 assert.equal(out.origin_family,'other');
 assert.equal(approvedAttachmentUrl(input),null);
 assert.equal(attachmentOriginSuffixHint(input),'provider-example.dev');
 for(const bad of ['PRIVATE_DO_NOT_ECHO','private-fixture-bucket',
  'private-fixture-bucket.assets.provider-example.dev','file_ABC123']){
  assert.equal(String(attachmentOriginSuffixHint(input)).includes(bad),false);
 }
 assert.equal(attachmentOriginSuffixHint({...base,download_url:'https://evil.test/x'}),null);
 assert.equal(attachmentOriginSuffixHint({...base,download_url:'http://f.cdn.example.com/x'}),null);
 assert.equal(attachmentOriginSuffixHint({...base,download_url:'https://f.cdn.example.com/x#secret'}),null);
 assert.equal(attachmentOriginSuffixHint({...base,download_url:'https://files.oaiusercontent.com/x'}),null);
 assert.equal(attachmentOriginSuffixHint({...base,file_id:''}),null);
});
