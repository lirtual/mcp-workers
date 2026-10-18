import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newEnrollment, saveNewPrivateKey } from "../../remote-control-agent/src/v2-enrollment.ts";
import { assertRemoteRevocation } from "../../remote-control-agent/src/v2-repair.ts";
import { beginDeviceEnrollment, PendingIdentityConflictError } from "../../remote-control-agent/src/pair-device.ts";
import { recoverDeviceId } from "../../remote-control-agent/src/v2-session-client.ts";
// @ts-expect-error JS installer intentionally exports a test helper without a TS declaration
import { promoteRevokedIdentity } from "../../remote-control-agent/scripts/install-v2.mjs";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";

interface StorageFixture {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; limit: number }): Promise<Map<string, T>>;
  transaction<T>(fn: (store: StorageFixture) => Promise<T>): Promise<T>;
}

function setup() {
  const rows = new Map<string, unknown>();
  const storage: StorageFixture = {
    async get<T>(key: string) { return rows.get(key) as T | undefined; },
    async put(key: string, value: unknown) { rows.set(key, value); },
    async delete(key: string) { return rows.delete(key); },
    async list<T>(opts: { prefix: string; limit: number }) {
      return new Map([...rows].filter(([k]) => k.startsWith(opts.prefix)).slice(0, opts.limit)) as Map<string, T>;
    },
    async transaction<T>(fn: (store: StorageFixture) => Promise<T>) { return fn(storage); },
  };
  const owner = new V2OwnerCoordinator({ storage } as unknown as DurableObjectState);
  const V2_OWNER = {
    idFromName() { return "owner"; },
    get() { return { fetch: (url: RequestInfo | URL, init?: RequestInit) =>
      owner.fetch(url instanceof Request ? url : new Request(url, init)) }; },
  } as unknown as DurableObjectNamespace;
  const env = {
    MCP_ACCESS_TOKEN: "portal-test-only",
    REMOTE_CONTROL_DEVICE_TOKEN: "legacy-v1-test",
    V2_OWNER,
  } as Env & { V2_OWNER: DurableObjectNamespace };
  const site = "https://pairing.test/";
  const send: typeof fetch = async (input, init) =>
    worker.fetch(input instanceof Request ? input : new Request(input, init), env);
  const rpc = async (name: string, args: object, token = "portal-test-only") => {
    const response = await send(site + "mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args } }),
    });
    return { response, data: await response.json() as {
      result?: { content: Array<{ text: string }> };
    } };
  };
  const value = (result: Awaited<ReturnType<typeof rpc>>) =>
    JSON.parse(result.data.result?.content[0]?.text ?? "{}") as Record<string, unknown>;
  return { rows, env, site, send, rpc, value, storage };
}

test("#97 old pairing_prepare and public /agent/pair/complete cannot approve a device",async()=>{
  const {rows,site,send,rpc,value}=setup();
  const pending=newEnrollment("no-legacy-fallback");
  assert.equal((await send(site+"agent/pair/start",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(pending.request),
  })).status,202);
  const looked=value(await rpc("pairing_lookup",{code:pending.code}));
  assert.match(String(looked.pairing_id),/^[a-f0-9-]{36}$/);
  for(const name of ["pairing_prepare","pairing_confirm","approve_device"]){
    const result=await rpc(name,{pairing_id:looked.pairing_id,
      expected_fingerprint:looked.fingerprint,expected_grant_type:"permanent"});
    assert.equal(result.data.result?.content[0]?.text.includes("unavailable")||
      result.data.result?.content[0]?.text.includes("rejected"),true,name);
  }
  const old=await send(site+"agent/pair/complete",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({verifier:pending.request.code_verifier,challenge:"A".repeat(12),proof:"bogus"}),
  });
  assert.equal(old.status,404);
  assert.equal([...rows.keys()].filter(k=>k.startsWith("device:")).length,0);
  assert.equal([...rows.keys()].filter(k=>k.startsWith("pending:")).length,1);
});

test("#97 revoked ID can only be replaced after distinct explicit MCP approval and new-key proof",async()=>{
  const {rows,site,send,rpc,value}=setup();
  const dir=await mkdtemp(path.join(os.tmpdir(),"v2-single-repair-"));
  const oldKey=path.join(dir,"v2-identity.pem");
  const stage=oldKey+".re-pair-new";
  const approve=async(code:string)=>{
    const pending=value(await rpc("pairing_lookup",{code}));
    const approved=value(await rpc("pairing_approve",{
      pairing_id:pending.pairing_id,expected_fingerprint:pending.fingerprint,
      expected_grant_type:pending.grant_type,
    }));
    assert.equal(approved.status,"approved");
    return String(approved.device_id);
  };
  try {
    const first=await beginDeviceEnrollment("office-linux",site,oldKey,send);
    const oldGrant=await approve(first.code);
    assert.equal(await recoverDeviceId(site,oldKey,send),oldGrant);
    await assert.rejects(assertRemoteRevocation(site,oldKey,oldGrant,send),
      /Revocation cannot be verified/);
    assert.equal(value(await rpc("revoke_device",{device_id:oldGrant})).status,"revoked");
    await assertRemoteRevocation(site,oldKey,oldGrant,send);
    assert.equal(rows.has("device:"+oldGrant),false);
    const stale=await beginDeviceEnrollment("office-linux",site,oldKey,send,true);
    assert.match(stale.code,/^[A-Z2-7]{10}$/);
    assert.equal(rows.has("device:"+oldGrant),false);
    // New key goes into a staging file; uncertain response must not rotate it.
    const original=await beginDeviceEnrollment("office-linux",site,stage,send);
    const stagedPem=await readFile(stage,"utf8");
    const retry=await beginDeviceEnrollment("office-linux",site,stage,send,true);
    assert.notEqual(retry.code,original.code);
    assert.equal(await readFile(stage,"utf8"),stagedPem);
    assert.match((await rpc("pairing_lookup",{code:original.code})).data.result?.content[0]?.text??"",
      /not found/i);
    const newGrant=await approve(retry.code);
    let dropped=false;
    const unreliable:typeof fetch=async(input,init)=>{
      const result=await send(input,init);
      if(!dropped && new URL(input instanceof Request ? input.url : String(input)).pathname===
          "/agent/session/recover" && result.status===200){
        dropped=true;
        throw new Error("simulated lost signed recovery response");
      }
      return result;
    };
    await assert.rejects(recoverDeviceId(site,stage,unreliable),/simulated lost/);
    await assert.rejects(readFile(stage+".device-id","utf8"),{code:"ENOENT"});
    assert.equal((await readFile(oldKey+".device-id","utf8")).trim(),oldGrant);
    assert.equal(await recoverDeviceId(site,stage,send),newGrant);
    assert.notEqual(newGrant,oldGrant);
    const archive=await promoteRevokedIdentity(oldKey,oldGrant);
    assert.equal((await readFile(oldKey+".device-id","utf8")).trim(),newGrant);
    assert.equal(await readFile(oldKey,"utf8"),stagedPem);
    assert.equal((await readFile(path.join(archive,"identity.pem.device-id"),"utf8")).trim(),oldGrant);
    assert.equal(rows.has("device:"+oldGrant),false);
    assert.equal([...rows.keys()].filter(k=>k.startsWith("device:")).length,1);
    await assert.rejects(assertRemoteRevocation(site,oldKey,newGrant,send),
      /Revocation cannot be verified/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("#97 pairing lookup and approval cannot bypass Portal Bearer or Origin checks",async()=>{
  const {rows,site,send,rpc,value}=setup();
  const material=newEnrollment("one-code-auth");
  assert.equal((await send(site+"agent/pair/start",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(material.request),
  })).status,202);
  const identity=value(await rpc("pairing_lookup",{code:material.code}));
  const lookupArgs={code:material.code};
  const approveArgs={pairing_id:identity.pairing_id,
    expected_fingerprint:identity.fingerprint,expected_grant_type:"permanent"};
  const unauthorized=[
    {label:"missing",headers:{},status:401},
    {label:"wrong scheme",headers:{authorization:"Basic portal-test-only"},status:401},
    {label:"wrong bearer",headers:{authorization:"Bearer wrong-token"},status:401},
    {label:"cross origin",headers:{authorization:"Bearer portal-test-only",origin:"https://evil.invalid"},status:403},
  ] as const;
  for(const attempt of unauthorized){
    for(const [method,params] of [
      ["tools/list",undefined],
      ["tools/call",{name:"pairing_lookup",arguments:lookupArgs}],
      ["tools/call",{name:"pairing_approve",arguments:approveArgs}],
    ] as const){
      const response=await send(site+"mcp",{
        method:"POST",headers:{"content-type":"application/json",...attempt.headers},
        body:JSON.stringify({jsonrpc:"2.0",id:5,method,params}),
      });
      assert.equal(response.status,attempt.status,attempt.label+" / "+method);
      assert.equal([...rows.keys()].filter(k=>k.startsWith("device:")).length,0);
    }
  }
  const approved=value(await rpc("pairing_approve",approveArgs));
  assert.equal(approved.status,"approved");
});
