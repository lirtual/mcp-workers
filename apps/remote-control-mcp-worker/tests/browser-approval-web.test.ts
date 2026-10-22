import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from "jose";
import {verifyAccessApprovalOwner,validBrowserApprovalRequest,validBrowserApprovalForm,browserApprovalPage}
  from "../src/browser-approval-web.ts";
import {prepareBrowserIntent,consumeBrowserApproval,type BrowserApprovalIntent}
  from "../src/browser-approval.ts";
import worker,{V2OwnerCoordinator} from "../src/worker.ts";

const issuer="https://spec152-test.cloudflareaccess.com";
const audience="a".repeat(64);
const config={BROWSER_APPROVAL_ENABLED:"true",
  BROWSER_APPROVAL_ACCESS_ISSUER:issuer,BROWSER_APPROVAL_ACCESS_AUD:audience,
  BROWSER_APPROVAL_ALLOWED_EMAIL:"owner@example.net"};

function fakeStorage(){
  const records=new Map<string,unknown>();
  let serial=Promise.resolve();
  const tx={
    get:async<T>(key:string)=>records.get(key) as T|undefined,
    put:async(key:string,value:unknown)=>{records.set(key,value);},
    delete:async(key:string)=>{records.delete(key);},
    list:async<T>(o:{prefix:string;limit:number})=>new Map([...records]
      .filter(([key])=>key.startsWith(o.prefix)).slice(0,o.limit)) as Map<string,T>,
  };
  return{records,
    transaction:async<T>(task:(context:typeof tx)=>Promise<T>)=>{
      let unlock!:()=>void;
      const next=new Promise<void>(resolve=>{unlock=resolve;});
      const prev=serial;serial=next;await prev;
      try{return await task(tx);}finally{unlock();}
    },
  } as unknown as DurableObjectStorage;
}

function intent():BrowserApprovalIntent{
  return{device_id:randomUUID(),epoch:randomUUID(),session_id:randomUUID(),tab_id:"tab-2",
    operation_id:"browser-action-"+randomUUID(),tool:"browser_click",
    snapshot_version:3,origin:"https://example.com",
    page_path:"/review",page_digest:"c".repeat(64),parameters_digest:"b".repeat(64),display:'Confirm <transfer> & "submit"'};
}

test("Access identity requires signature, exact app audience/issuer, allowed email and app type",async()=>{
  const {publicKey,privateKey}=await generateKeyPair("RS256");
  const jwk={...await exportJWK(publicKey),kid:"current-key",alg:"RS256",use:"sig"};
  const JWKS=createLocalJWKSet({keys:[jwk]});
  async function token(email:string,overrides:Record<string,unknown>={}){
    return new SignJWT({email,type:"app",...overrides})
      .setProtectedHeader({alg:"RS256",kid:"current-key",typ:"JWT"})
      .setIssuer(issuer).setAudience(audience).setSubject("user-"+randomUUID())
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  }
  async function check(jwt:string,options=config){
    return verifyAccessApprovalOwner(new Request("https://worker.example/browser-approve/"+randomUUID(),
      {headers:{"cf-access-jwt-assertion":jwt}}),options,JWKS);
  }
  assert.match(String(await check(await token("owner@example.net"))),/^user-/);
  assert.equal(await check(await token("other@example.net")),null);
  assert.equal(await check(await token("owner@example.net",{type:"org"})),null);
  assert.equal(await check("invalid.jwt.string"),null);
  assert.equal(await check(await token("owner@example.net"),{...config,BROWSER_APPROVAL_ENABLED:"false"}),null);
  assert.equal(await check(await token("owner@example.net"),{...config,BROWSER_APPROVAL_ACCESS_AUD:"c".repeat(64)}),null);
  const mismatchedIssuer=await new SignJWT({email:"owner@example.net",type:"app"})
    .setProtectedHeader({alg:"RS256",kid:"current-key"})
    .setIssuer("https://foreign.cloudflareaccess.com")
    .setAudience(audience).setSubject("owner")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  assert.equal(await check(mismatchedIssuer),null);
});

test("HTTP owner confirmation entry denies model tokens, forged Origins, missing config, and escapes page content",async()=>{
  const s=fakeStorage();
  const target=intent(),record=await prepareBrowserIntent(s,target);
  assert.equal(record.status,"pending");
  if(record.status!=="pending")throw Error("no pending intent");
  const url="https://rca.example/browser-approve/"+record.approval_id;
  assert.equal(validBrowserApprovalRequest(new Request(url),record.approval_id),true);
  const post=(origin:string,body="decision=approve")=>
    new Request(url,{method:"POST",headers:{"origin":origin,
      "content-type":"application/x-www-form-urlencoded"},body});
  assert.equal(validBrowserApprovalRequest(post("https://attacker.example"),record.approval_id),false);
  assert.equal(validBrowserApprovalRequest(post("https://rca.example"),record.approval_id),true);
  assert.equal(validBrowserApprovalRequest(new Request(url+"?access_return=1"),record.approval_id),true);
  assert.equal(validBrowserApprovalRequest(new Request(url+"?approved=true"),record.approval_id),true);
  assert.equal(validBrowserApprovalRequest(new Request(url+"?approved=true",{method:"POST",
    headers:{origin:"https://rca.example",
      "content-type":"application/x-www-form-urlencoded"},
    body:"decision=approve"}),record.approval_id),false);
  const page=browserApprovalPage(record.approval_id,{
    status:"pending",intent:target,expires_at:record.expires_at});
  const html=await page.text();
  assert.equal(page.status,200);
  assert.ok(html.includes("&lt;transfer&gt; &amp; &quot;submit&quot;"));
  assert.ok(!html.includes("<transfer>"));
  assert.match(String(page.headers.get("content-security-policy")),/frame-ancestors 'none'/);
  const hidden=/name="csrf" value="([a-f0-9-]{36})"/.exec(html)?.[1];
  const cookie=page.headers.get("set-cookie")?.split(";")[0];
  assert.ok(hidden);
  assert.ok(cookie);
  assert.ok(cookie.startsWith("__Host-rca-approval-csrf="));
  assert.match(String(page.headers.get("set-cookie")),/SameSite=Strict/);
  const form=new URLSearchParams({decision:"approve",csrf:hidden}).toString();
  assert.equal(validBrowserApprovalForm(new Request(url,{headers:{cookie}}),form),true);
  assert.equal(validBrowserApprovalForm(new Request(url),form),false);
  assert.equal(validBrowserApprovalForm(new Request(url,{headers:{cookie}}),
    new URLSearchParams({decision:"approve",csrf:randomUUID()}).toString()),false);
  assert.equal(validBrowserApprovalForm(new Request(url,{headers:{cookie}}),
    form+"&decision=approve"),false);
  assert.equal(validBrowserApprovalRequest(new Request(url,{method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},body:form}),
    record.approval_id),true);

  let doCalls=0;
  const stub={idFromName:()=>({}),get:()=>({fetch:()=>{doCalls++;throw Error("Should not be reached");}})};
  const env={...config,MCP_ACCESS_TOKEN:"owner-mcp-token",DEVICE_COORDINATOR:stub} as unknown as Env;
  const disabled=await worker.fetch(new Request(url),{
    ...env,BROWSER_APPROVAL_ENABLED:"false"} as Env);
  assert.equal(disabled.status,404);
  const forged=await worker.fetch(new Request(url,{headers:{
    authorization:"Bearer owner-mcp-token","cf-access-jwt-assertion":"false.jwt",
  }}),env);
  assert.equal(forged.status,403);
  assert.equal(doCalls,0);
  const crossSite=await worker.fetch(post("https://attacker.example"),env);
  assert.equal(crossSite.status,404);
  assert.equal(doCalls,0);
});

test("actual Worker Access route accepts a signed user on GET+POST and DO state consumes once",async()=>{
  const s=fakeStorage();
  const wanted=intent();
  const prepared=await prepareBrowserIntent(s,wanted);
  if(prepared.status!=="pending")throw Error("prepare failed");
  const owner=new V2OwnerCoordinator({
    storage:s,
    getWebSockets:()=>[],
  } as unknown as DurableObjectState);
  const env={...config,MCP_ACCESS_TOKEN:"different-mcp-token",
    DEVICE_COORDINATOR:{idFromName:()=>({}),get:()=>({fetch:(url:string,init:RequestInit)=>
      owner.fetch(new Request(url,init))})}} as unknown as Env;
  const {publicKey,privateKey}=await generateKeyPair("RS256");
  const jwk={...await exportJWK(publicKey),kid:"test-owner-key",alg:"RS256",use:"sig"};
  const jwt=await new SignJWT({email:"owner@example.net",type:"app"})
    .setProtectedHeader({alg:"RS256",kid:"test-owner-key"})
    .setIssuer(issuer).setAudience(audience).setSubject("trusted-owner")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const url="https://rca.example/browser-approve/"+prepared.approval_id;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).includes("/cdn-cgi/access/certs"))
      return Response.json({keys:[jwk]});
    return originalFetch(input,init);
  };
  try {
    const signed={"cf-access-jwt-assertion":jwt};
    // Access may append a transient query parameter after browser login.
    // Query values are ignored for authenticated GET, not approvals.
    const page=await worker.fetch(new Request(url+"?access_callback=1",{headers:signed}),env);
    assert.equal(page.status,200);
    const pageHtml=await page.text();
    assert.match(pageHtml,/Confirm one browser action/);
    const csrf=/name="csrf" value="([a-f0-9-]{36})"/.exec(pageHtml)?.[1];
    const cookie=page.headers.get("set-cookie")?.split(";")[0];
    assert.ok(csrf && cookie);
    const validForm=new URLSearchParams({decision:"approve",csrf}).toString();
    const forged=await worker.fetch(new Request(url,{method:"POST",
      headers:{...signed,origin:"https://attacker.example",cookie,
        "content-type":"application/x-www-form-urlencoded"},body:validForm}),env);
    assert.equal(forged.status,404);
    assert.equal(await consumeBrowserApproval(s,wanted),false);
    // A mobile browser is allowed to omit Origin if the signed Access
    // session and unguessable same-origin form+cookie pair are both valid.
    const noCookie=await worker.fetch(new Request(url,{method:"POST",
      headers:{...signed,"content-type":"application/x-www-form-urlencoded"},
      body:validForm}),env);
    assert.equal(noCookie.status,400);
    assert.equal(await consumeBrowserApproval(s,wanted),false);
    const badToken=await worker.fetch(new Request(url,{method:"POST",
      headers:{...signed,cookie,"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({decision:"approve",csrf:randomUUID()}).toString()}),env);
    assert.equal(badToken.status,400);
    assert.equal(await consumeBrowserApproval(s,wanted),false);
    const crossSite=await worker.fetch(new Request(url,{method:"POST",
      headers:{...signed,cookie,"sec-fetch-site":"cross-site",
        "content-type":"application/x-www-form-urlencoded"},body:validForm}),env);
    assert.equal(crossSite.status,404);
    const approval=await worker.fetch(new Request(url,{method:"POST",
      headers:{...signed,cookie,
        "content-type":"application/x-www-form-urlencoded"},body:validForm}),env);
    assert.equal(approval.status,200,await approval.text());
    assert.equal(await consumeBrowserApproval(s,{...wanted,tab_id:"tab-7"}),false);
    assert.equal(await consumeBrowserApproval(s,wanted),true);
    assert.equal(await consumeBrowserApproval(s,wanted),false);
    const replay=await worker.fetch(new Request(url,{method:"POST",
      headers:{...signed,cookie,
        "content-type":"application/x-www-form-urlencoded"},body:validForm}),env);
    assert.equal(replay.status,403);
  }finally{
    globalThis.fetch=originalFetch;
  }
});
