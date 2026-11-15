import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,publicEncrypt,randomBytes,constants,generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {isDropClaimCallback,openDropClaim,expireDropClaimReceipts} from '../src/drop-claim-receipt.ts';

const attempt='11111111-2222-4333-8444-555555555555';
const preview='https://temporary-sample.workers.dev';
const claim='https://dash.cloudflare.com/claim-preview?claimToken='+('X'.repeat(48));
const at=1800000000000,expires=at+2700000;
const rsa=generateKeyPairSync('rsa',{modulusLength:2048,
 publicKeyEncoding:{format:'pem',type:'spki'},
 privateKeyEncoding:{format:'pem',type:'pkcs8'}});
function sealed(){
 const aes=randomBytes(32),nonce=randomBytes(12);
 const encrypt=createCipheriv('aes-256-gcm',aes,nonce);
 encrypt.setAAD(Buffer.from('drop-receipt-v1\n'+attempt+'\n'+preview+'\n'+expires));
 const payload=Buffer.concat([encrypt.update(JSON.stringify({
  claimUrl:claim,attemptId:attempt,previewUrl:preview,expiresAt:expires}),'utf8'),
  encrypt.final(),encrypt.getAuthTag()]);
 const wrap=publicEncrypt({key:rsa.publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash:'sha256'},aes);
 return {drop_claim_v:1 as const,preview_url:preview,expires_at:expires,
  sealed_claim:Buffer.from(JSON.stringify({v:1,
   wrapped_key:Buffer.from(wrap).toString('base64url'),nonce:Buffer.from(nonce).toString('base64url'),
   ciphertext:payload.toString('base64url')})).toString('base64url')};
}
test('Worker AES-GCM receipt opens only the matching Attempt, preview and expiry',async()=>{
 const value=sealed();
 assert.equal(isDropClaimCallback(value,at),true);
 assert.ok(!JSON.stringify(value).includes('claimToken'));
 assert.equal(await openDropClaim(value,attempt,rsa.privateKey,at),claim);
 for(const bad of [
  {...value,preview_url:'https://other.workers.dev'},
  {...value,expires_at:expires-1},
  {...value,sealed_claim:value.sealed_claim.slice(0,-1)+'x'},
 ]){
  await assert.rejects(openDropClaim(bad,attempt,rsa.privateKey,at),/drop_claim_unavailable/);
 }
 await assert.rejects(openDropClaim(value,'22222222-2222-4222-8222-222222222222',
  rsa.privateKey,at),/drop_claim_unavailable/);
 await assert.rejects(openDropClaim(value,attempt,rsa.privateKey,expires),/drop_claim_unavailable/);
 const other=generateKeyPairSync('rsa',{modulusLength:2048,
  publicKeyEncoding:{format:'pem',type:'spki'},
  privateKeyEncoding:{format:'pem',type:'pkcs8'}});
 await assert.rejects(openDropClaim(value,attempt,other.privateKey,at),/drop_claim_unavailable/);
});
test('Dedicated table is the only sealed copy; existing Cron cleanup deletes expired ciphertext',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE step_attempts(attempt_id TEXT PRIMARY KEY)');
  db.exec(readFileSync(new URL('../migrations/0022_drop_claim_receipts.sql',import.meta.url),'utf8'));
  const value=sealed();
  db.prepare('INSERT INTO step_attempts(attempt_id) VALUES(?)').run(attempt);
  db.prepare('INSERT INTO drop_claim_receipts(attempt_id,sealed_claim,preview_url,expires_at,created_at) VALUES(?,?,?,?,?)')
   .run(attempt,value.sealed_claim,preview,expires,at);
  const adapter={prepare:(sql:string)=>({bind:(...args:unknown[])=>({
   run:async()=>({meta:{changes:db.prepare(sql).run(...args as []).changes}}),
  })})} as unknown as D1Database;
  assert.equal(await expireDropClaimReceipts(adapter,expires-1),0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drop_claim_receipts').get()?.n,1);
  assert.equal(await expireDropClaimReceipts(adapter,expires),1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drop_claim_receipts').get()?.n,0);
 }finally{db.close();}
});
test('Worker receiver denies raw URL, invalid preview and expired ciphertext',()=>{
 const value=sealed();
 for(const x of [
  {...value,claimUrl:claim},
  {...value,preview_url:'https://evil.invalid'},
  {...value,expires_at:at-1},
  {...value,sealed_claim:claim},
  {...value,drop_claim_v:2},
 ])assert.equal(isDropClaimCallback(x,at),false);
});
