import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleAdmin} from '../src/admin.ts';
import {acquireLease,releaseLease} from '../src/lease.ts';
import worker from '../src/index.ts';
import type {Env} from '../src/types.ts';

const HOST='weixin-owner.example.org';
const TEAM='account.cloudflareaccess.com';
const AUD='audience-test-346';
const OWNER='owner@example.org';
function b64url(value:Uint8Array|Buffer){
  return Buffer.from(value).toString('base64url');
}
async function issuer(){
  const keys=await crypto.subtle.generateKey(
    {name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
      publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const publicKey=await crypto.subtle.exportKey('jwk',keys.publicKey);
  const certs=async(input:RequestInfo|URL)=>{
    assert.equal(String(input),'https://'+TEAM+'/cdn-cgi/access/certs');
    return Response.json({keys:[{...publicKey,kid:'test-kid',alg:'RS256'}]});
  };
  async function jwt(overrides:Record<string,unknown>={}){
    const payload={iss:'https://'+TEAM,aud:AUD,exp:Math.floor(Date.now()/1000)+600,
      sub:'user-1',email:OWNER,...overrides};
    const head=b64url(Buffer.from(JSON.stringify({alg:'RS256',kid:'test-kid'})));
    const body=b64url(Buffer.from(JSON.stringify(payload)));
    const signed=head+'.'+body;
    const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(signed));
    return signed+'.'+b64url(new Uint8Array(sig));
  }
  return {jwt,certs:certs as typeof fetch};
}
function database(){
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_owner.sql',import.meta.url),'utf8'));
  const prepare=(query:string)=>{
    const stmt=sql.prepare(query);
    const prepared=(args:unknown[])=>({
      run:async()=>({meta:{changes:Number(stmt.run(...args as []).changes)}}),
      first:async<T>()=>(stmt.get(...args as [])??null) as T|null,
    });
    return {...prepared([]),bind:(...args:unknown[])=>prepared(args)};
  };
  return {sql,prepare};
}
function setup(){
  const db=database();
  const env={DB:db as unknown as D1Database,MCP_HOST:'weixin-mcp.example.org',
    ADMIN_HOST:HOST,ACCESS_TEAM_DOMAIN:TEAM,ACCESS_AUD:AUD,OWNER_EMAIL:OWNER,
    MCP_ACCESS_TOKEN:'portal-secret',WEIXIN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')} as Env;
  return {env,db};
}
const ownerUrl='https://'+HOST+'/setup';
function request(url:string,jwt:string,options:RequestInit={}){
  return new Request(url,{...options,headers:{
    'cf-access-jwt-assertion':jwt,...(options.headers as Record<string,string>??{}),
  }});
}
test('Access owner management rejects unsigned, wrong-audience, wrong-email and wrong host',async()=>{
  const {env}=setup();
  const {jwt,certs}=await issuer();
  for(const token of ['invalid',await jwt({aud:'another'}),
    await jwt({email:'intruder@example.org'}),await jwt({exp:1})]){
    const r=await handleAdmin(request(ownerUrl,token),env,certs);
    assert.equal(r.status,403);
  }
  assert.equal((await handleAdmin(request('https://different.example.org/setup',await jwt()),env,certs)).status,404);
  assert.equal((await handleAdmin(request(ownerUrl+'/qr',await jwt()),env,certs)).status,404);
  assert.equal((await handleAdmin(request(ownerUrl,await jwt()),{...env,OWNER_EMAIL:''},certs)).status,503);
  const noJwt=await worker.fetch(new Request(ownerUrl),env);
  assert.equal(noJwt.status,403);
  assert.equal((await worker.fetch(new Request(ownerUrl),{...env,ADMIN_HOST:env.MCP_HOST})).status,503);
});
test('valid signed Access identity sees sanitized state; CSRF and explicit confirmation gate local unbind',async()=>{
  const {env,db}=setup();
  const {jwt,certs}=await issuer();
  const token=await jwt();
  const get=await handleAdmin(request(ownerUrl,token),env,certs);
  assert.equal(get.status,200);
  const page=await get.text();
  assert.match(page,/Current state.*unbound/);
  assert.match(page,/QR pairing is not yet enabled/);
  assert.doesNotMatch(page,/portal-secret|super-secret-token|OWNER_EMAIL/);
  assert.equal(get.headers.get('cache-control'),'no-store');
  assert.match(get.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
  const cookie=get.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie??'',/^weixin_setup_csrf=[A-Za-z0-9_-]{40,64}$/);
  const csrf=cookie!.split('=')[1];
  const submit=(params:Record<string,string>,origin='https://'+HOST,cookieValue=cookie!)=>
    request('https://'+HOST+'/setup/unbind',token,{method:'POST',headers:{
      origin,cookie:cookieValue,'content-type':'application/x-www-form-urlencoded',
    },body:new URLSearchParams(params).toString()});
  for(const [params,origin] of [
    [{csrf,confirm:'local_unbind'},'https://malicious.example.org'],
    [{csrf:'wrong',confirm:'local_unbind'},'https://'+HOST],
    [{csrf},'https://'+HOST],
  ] as const){
    const response=await handleAdmin(submit(params,origin),env,certs);
    assert.equal(response.status,400);
  }
  assert.equal(db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,0);
  const done=await handleAdmin(submit({csrf,confirm:'local_unbind'}),env,certs);
  assert.equal(done.status,200);
  assert.equal(db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,1);
});
test('owner management unbind cannot invalidate an in-flight leased operation',async()=>{
  const {env,db}=setup();
  const {jwt,certs}=await issuer();
  db.sql.prepare('UPDATE weixin_binding SET state=?,generation=?').run('ready',3);
  const lease=await acquireLease(env,3,['ready']);
  const token=await jwt();
  const first=await handleAdmin(request(ownerUrl,token),env,certs);
  const cookie=first.headers.get('set-cookie')!.split(';')[0]!;
  const csrf=cookie.split('=')[1]!;
  const req=()=>request(ownerUrl+'/unbind',token,{method:'POST',headers:{
    cookie,origin:'https://'+HOST,'content-type':'application/x-www-form-urlencoded',
  },body:new URLSearchParams({csrf,confirm:'local_unbind'}).toString()});
  assert.equal((await handleAdmin(req(),env,certs)).status,409);
  assert.equal(db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,3);
  await releaseLease(env,lease);
  assert.equal((await handleAdmin(req(),env,certs)).status,200);
  assert.equal(db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,4);
});

test('admin rejects oversized streamed POST body even if Content-Length is missing',async()=>{
  const {env,db}=setup();
  const {jwt,certs}=await issuer();
  const token=await jwt();
  const page=await handleAdmin(request(ownerUrl,token),env,certs);
  const cookie=page.headers.get('set-cookie')!.split(';')[0]!;
  const csrf=cookie.split('=')[1]!;
  const input=new URLSearchParams({csrf,confirm:'local_unbind',
    padding:'X'.repeat(5000)}).toString();
  const res=await handleAdmin(request(ownerUrl+'/unbind',token,{
    method:'POST',headers:{origin:'https://'+HOST,cookie,
      'content-type':'application/x-www-form-urlencoded'},
    body:input,
  }),env,certs);
  assert.equal(res.status,400);
  assert.match(await res.text(),/request_too_large/);
  assert.equal(db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,0);
});
