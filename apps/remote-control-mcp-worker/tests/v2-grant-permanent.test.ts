import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {exportJWK,generateKeyPair,SignJWT} from "jose";
import worker, {V2OwnerCoordinator} from "../src/worker.ts";
import {validPermanentGrantForm} from "../src/browser-approval-web.ts";
import {deviceIsAuthorized,issueSessionChallenge,TEMPORARY_GRANT_MS,type V2Device} from "../src/v2-session.ts";

const issuer="https://rca-owner-test.cloudflareaccess.com";
const audience="a".repeat(64);
const config={
  BROWSER_APPROVAL_ACCESS_ISSUER:issuer,
  BROWSER_APPROVAL_ACCESS_AUD:audience,
  BROWSER_APPROVAL_ALLOWED_EMAIL:"owner@example.net",
  BROWSER_APPROVAL_PUBLIC_ORIGIN:"https://rca.example",
};
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function fixture(){
  const temporary=randomUUID(),unrelated=randomUUID(),permanent=randomUUID(),revoked=randomUUID();
  const fingerprint="d".repeat(24);
  const approvedAt=Date.now()-60_000,expiresAt=approvedAt+TEMPORARY_GRANT_MS;
  const rows=new Map<string,unknown>();
  const record=(id:string,type:"temporary"|"permanent",fp="c".repeat(24)):V2Device=>({
    device_id:id,name:id===temporary?"Windows Test":"Unrelated",public_key:"pub-"+id,
    fingerprint:fp,approved_at:approvedAt,revoked:false,grant_type:type,
    ...(type==="temporary"?{expires_at:expiresAt}:{}),
  });
  rows.set("device:"+temporary,record(temporary,"temporary",fingerprint));
  rows.set("device:"+unrelated,record(unrelated,"temporary"));
  rows.set("device:"+permanent,record(permanent,"permanent"));
  rows.set("device:"+revoked,{...record(revoked,"temporary"),revoked:true});
  rows.set("session:epoch:"+temporary,"original-epoch");
  const nonce={nonce:"n".repeat(24),expires_at:Date.now()+30_000};
  rows.set("session:nonce:"+temporary,nonce);
  type Storage={
    get<T>(key:string):Promise<T|undefined>;
    put(key:string,value:unknown):Promise<void>;
    delete(key:string):Promise<boolean>;
    list<T>(args:{prefix:string;limit:number}):Promise<Map<string,T>>;
    transaction<T>(fn:(txn:Storage)=>Promise<T>):Promise<T>;
  };
  let tail:Promise<void>=Promise.resolve();
  const storage:Storage={
    async get<T>(key:string){return rows.get(key) as T|undefined;},
    async put(key:string,value:unknown){rows.set(key,value);},
    async delete(key:string){return rows.delete(key);},
    async list<T>({prefix,limit}:{prefix:string;limit:number}){
      return new Map([...rows].filter(([key])=>key.startsWith(prefix)).slice(0,limit)) as Map<string,T>;
    },
    async transaction<T>(fn:(txn:Storage)=>Promise<T>){
      const previous=tail;let release!:()=>void;
      tail=new Promise<void>(resolve=>{release=resolve;});
      await previous;try{return await fn(storage);}finally{release();}
    },
  };
  const owner=new V2OwnerCoordinator({storage,getWebSockets:()=>[]} as unknown as DurableObjectState);
  let doCalls=0;
  const env={...config,MCP_ACCESS_TOKEN:"mcp-bearer-only",
    DEVICE_COORDINATOR:{idFromName:()=>({}),get:()=>({
      fetch:(input:RequestInfo|URL,init?:RequestInit)=>{
        doCalls++;
        return owner.fetch(input instanceof Request?input:new Request(input,init));
      },
    })},
  } as unknown as Env;
  const url="https://rca.example/browser-approve/grant/"+temporary;
  const http=(path:string,init?:RequestInit)=>worker.fetch(new Request(path,init),env);
  const rpc=(name:string,args:unknown,token="mcp-bearer-only")=>
    http("https://rca.example/mcp",{method:"POST",
      headers:{"content-type":"application/json",authorization:"Bearer "+token},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:name==="tools/list"?"tools/list":"tools/call",
        ...(name==="tools/list"?{}:{params:{name,arguments:args}})}),
    });
  return {temporary,unrelated,permanent,revoked,fingerprint,expiresAt,
    rows,storage,owner,env,http,rpc,url,get doCalls(){return doCalls;}};
}

async function withAccess<T>(fn:(jwt:string)=>Promise<T>,email="owner@example.net"):Promise<T>{
  const {publicKey,privateKey}=await generateKeyPair("RS256");
  const jwk={...await exportJWK(publicKey),kid:"owner-key",alg:"RS256",use:"sig"};
  const jwt=await new SignJWT({email,type:"app"}).setProtectedHeader({alg:"RS256",kid:"owner-key"})
    .setIssuer(issuer).setAudience(audience).setSubject("trusted-owner")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const realFetch=globalThis.fetch;
  globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).includes("/cdn-cgi/access/certs"))return Response.json({keys:[jwk]});
    return realFetch(input,init);
  };
  try{return await fn(jwt);}finally{globalThis.fetch=realFetch;}
}

function formFromPage(page:Response){
  const cookie=page.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return page.text().then(html=>{
    const read=(name:string)=>new RegExp('name="'+name+'" value="([^"]+)"').exec(html)?.[1];
    const csrf=read("csrf"),fingerprint=read("fingerprint"),expires_at=read("expires_at");
    assert.ok(csrf&&fingerprint&&expires_at);
    return {cookie,html,form:new URLSearchParams({
      csrf,fingerprint,expires_at,decision:"make_permanent",
    }).toString()};
  });
}
function post(f:ReturnType<typeof fixture>,jwt:string,cookie:string,body:string){
  return f.http(f.url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",
    cookie,"cf-access-jwt-assertion":jwt},body});
}

test("MCP no longer advertises or dispatches permanent grants, even with Portal bearer",async()=>{
  const f=fixture();
  const listing=await f.rpc("tools/list",{});
  assert.equal(listing.status,200);
  const json=await listing.json() as {result:{tools:Array<{name:string}>}};
  assert.equal(json.result.tools.some(t=>t.name==="device_make_permanent"),false);
  const rejected=await f.rpc("device_make_permanent",{
    device_id:f.temporary,expected_fingerprint:f.fingerprint,
    expected_expires_at:f.expiresAt,confirmation:"make_permanent",
  });
  assert.equal((await rejected.json() as {result:{isError:boolean}}).result.isError,true);
  assert.equal(f.doCalls,0);
  assert.equal((f.rows.get("device:"+f.temporary) as V2Device).grant_type,"temporary");
});

test("Access page requires verified owner JWT; Portal bearer alone cannot grant",async()=>{
  const f=fixture();
  assert.equal((await f.http(f.url)).status,403);
  assert.equal((await f.http(f.url,{headers:{authorization:"Bearer mcp-bearer-only"}})).status,403);
  assert.equal(f.doCalls,0);
  await withAccess(async(jwt)=>{
    const response=await f.http(f.url,{headers:{"cf-access-jwt-assertion":jwt}});
    assert.equal(response.status,200);
    const data=await formFromPage(response);
    assert.match(data.html,/permanently authorized/);
    assert.match(data.html,new RegExp(f.temporary));
    assert.match(data.html,new RegExp(f.fingerprint));
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.match(response.headers.get("content-security-policy")||"",/frame-ancestors 'none'/);
    assert.equal((await post(f,jwt,"",data.form)).status,400,"CSRF cookie is required");
    assert.equal((await post(f,jwt,data.cookie,"decision=make_permanent")).status,400);
    assert.equal((f.rows.get("device:"+f.temporary) as V2Device).grant_type,"temporary");
  },"owner@example.net");
  await withAccess(async(jwt)=>{
    assert.equal((await f.http(f.url,{headers:{"cf-access-jwt-assertion":jwt}})).status,403);
  },"not-owner@example.net");
});

test("owner page atomically promotes exact live grant without changing ID, key, epoch or other device",async()=>{
  const f=fixture();
  const original=structuredClone(f.rows.get("device:"+f.temporary)) as V2Device;
  const other=structuredClone(f.rows.get("device:"+f.unrelated));
  const nonce=structuredClone(f.rows.get("session:nonce:"+f.temporary));
  await withAccess(async(jwt)=>{
    const page=await f.http(f.url,{headers:{"cf-access-jwt-assertion":jwt}});
    assert.equal(page.status,200);
    const data=await formFromPage(page);
    const current=validPermanentGrantForm(new Request(f.url,{headers:{
      "content-type":"application/x-www-form-urlencoded",cookie:data.cookie,
    }}),data.form);
    assert.deepEqual(current,{fingerprint:f.fingerprint,expires_at:f.expiresAt});
    const approved=await post(f,jwt,data.cookie,data.form);
    assert.equal(approved.status,200,await approved.text());
    assert.equal((await post(f,jwt,data.cookie,data.form)).status,409,"not repeatable");
    assert.equal((await f.http(f.url,{headers:{"cf-access-jwt-assertion":jwt}})).status,404,
      "no promotion page for permanent device");
  });
  const saved=f.rows.get("device:"+f.temporary) as V2Device;
  const expected={...original,grant_type:"permanent"};
  delete expected.expires_at;
  assert.deepEqual(saved,expected);
  assert.deepEqual(f.rows.get("device:"+f.unrelated),other);
  assert.deepEqual(f.rows.get("session:nonce:"+f.temporary),nonce);
  assert.equal(f.rows.get("session:epoch:"+f.temporary),"original-epoch");
  assert.ok(idPattern.test(saved.device_id));
  assert.equal(deviceIsAuthorized(saved,f.expiresAt+7*TEMPORARY_GRANT_MS),true);
  assert.equal((await issueSessionChallenge(f.storage as never,{device_id:f.temporary})).status,200);
});

test("stale fingerprint, expiry or expired grant cannot be promoted by a previously rendered page",async()=>{
  const f=fixture();
  await withAccess(async(jwt)=>{
    const page=await f.http(f.url,{headers:{"cf-access-jwt-assertion":jwt}});
    const data=await formFromPage(page);
    const changed=f.rows.get("device:"+f.temporary) as V2Device;
    changed.approved_at+=1000;
    changed.expires_at!+=1000;
    assert.equal((await post(f,jwt,data.cookie,data.form)).status,409);
    assert.equal(changed.grant_type,"temporary");
    changed.approved_at=Date.now()-TEMPORARY_GRANT_MS-1000;
    changed.expires_at=changed.approved_at+TEMPORARY_GRANT_MS;
    assert.equal((await post(f,jwt,data.cookie,data.form)).status,409);
    assert.equal(changed.grant_type,"temporary");
    assert.equal((await issueSessionChallenge(f.storage as never,{device_id:f.temporary})).status,404);
  });
});

test("revoke and permanent devices have no temporary promotion page",async()=>{
  const f=fixture();
  await withAccess(async(jwt)=>{
    for(const id of [f.revoked,f.permanent]){
      const url="https://rca.example/browser-approve/grant/"+id;
      assert.equal((await f.http(url,{headers:{"cf-access-jwt-assertion":jwt}})).status,404);
    }
    for(const bad of ["bogus","..%2F..%2Fmcp"]){
      assert.equal((await f.http("https://rca.example/browser-approve/grant/"+bad,
        {headers:{"cf-access-jwt-assertion":jwt}})).status,404);
    }
  });
});
