import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prepareWindowsUpgrade, presentWindowsUpgrade, confirmWindowsUpgrade,
  claimWindowsUpgrade, claimWindowsUpgradeDispatch, markUpgradeDispatchUncertain,
  markStaleWindowsUpgradeAttention, markWindowsUpgradeCompleted,
  readWindowsUpgrade, UPGRADE_APPROVAL_TTL_MS, UPGRADE_UNCONFIRMED_ATTENTION_MS,
  type ReviewedUpgradePin, type UpgradeApprovalPreview,
} from "../src/upgrade-approval.ts";

const DEVICE = "2a83dae6-600c-49cc-b643-ab0d5ec7e0c8";
const PIN: ReviewedUpgradePin = {
  tag: "v0.1.32-rc.1",
  commit: "8b9eb25aadeb06b7c59b102d75a749ac8fa0c54e",
  windows_asset_sha256: "7b7bb8331caed2a84a32437e700ec6f8341de9e90aae949e38f1581bf7545ad2",
};
const NOW = 1793100000000;
function fixture() {
  const rows = new Map<string, unknown>();
  rows.set("session:epoch:" + DEVICE, "signed-before-switch");
  rows.set("device:" + DEVICE, {
    device_id: DEVICE, name: "RAY-WORKSPACE", public_key: "fixed-key",
    fingerprint: "1234567890abcdef12345678", revoked: false, grant_type: "permanent",
    approved_at: NOW - 60_000,
    device_info: { os: "windows", arch: "x64", environment: "native",
      agent_version: "v0.1.31-rc.1", upgrade_protocol:"owner-one-shot-v1", hostname: "RAY-WORKSPACE", os_version: "10.0.26200" },
  });
  let tail = Promise.resolve();
  let store: Pick<DurableObjectStorage, "get" | "put" | "transaction">;
  store = {
    get: async <T>(key: string) => structuredClone(rows.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)); },
    transaction: async <T>(fn: (transaction: DurableObjectTransaction) => Promise<T>) => {
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await prior;
      try { return await fn(store as unknown as DurableObjectTransaction); } finally { release(); }
    },
  } as unknown as Pick<DurableObjectStorage, "get" | "put" | "transaction">;
  return { store, rows,
    modifyDevice: (changes: Record<string, unknown>) => {
      rows.set("device:" + DEVICE, { ...(rows.get("device:" + DEVICE) as object), ...changes });
    } };
}
async function start(f: ReturnType<typeof fixture>, id = "one-upgrade") {
  const result = await prepareWindowsUpgrade(f.store, id, DEVICE, PIN, NOW);
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") throw Error("Test fixture did not prepare upgrade");
  return result;
}
test("Issue #39 prepared upgrade is inert; GET preview is not approval; one-use POST and one-use claim", async () => {
  const f = fixture();
  const { confirmation, preview } = await start(f);
  assert.equal((await readWindowsUpgrade(f.store, preview.operation_id))?.state, "prepared");
  assert.equal(await claimWindowsUpgrade(f.store, preview, NOW + 5), false,
    "MCP admission by itself must never dispatch an upgrade");
  const presented = await presentWindowsUpgrade(f.store, preview.operation_id, confirmation, NOW + 10);
  assert.deepEqual(presented?.preview, preview);
  assert.ok(presented?.form_token);
  assert.equal((await readWindowsUpgrade(f.store, preview.operation_id))?.state, "prepared");
  assert.equal(await confirmWindowsUpgrade(f.store, preview.operation_id, confirmation,
    "0".repeat(64), NOW + 20), false);
  assert.equal(await confirmWindowsUpgrade(f.store, preview.operation_id, confirmation,
    presented!.form_token, NOW + 20), true);
  assert.equal(await confirmWindowsUpgrade(f.store, preview.operation_id, confirmation,
    presented!.form_token, NOW + 21), false, "POST replay must not reapprove");
  assert.equal(await presentWindowsUpgrade(f.store, preview.operation_id, confirmation, NOW + 22), null);
  assert.equal(await claimWindowsUpgrade(f.store, preview, NOW + 23), true);
  assert.equal(await claimWindowsUpgrade(f.store, preview, NOW + 24), false,
    "the same operation ID can never be redispatched");
  const read = await readWindowsUpgrade(f.store, preview.operation_id);
  assert.equal(read?.state, "claimed");
  assert.ok(!JSON.stringify(read).includes(confirmation));
  assert.ok(!JSON.stringify(read).includes(presented!.form_token));
  assert.equal((await prepareWindowsUpgrade(f.store, preview.operation_id, DEVICE, PIN, NOW + 50)).status, "existing");
  assert.equal((await prepareWindowsUpgrade(f.store, "different-operation", DEVICE, PIN, NOW + 50)).status, "refused",
    "a claimed unknown outcome guards the entire device");
});

test("no owner POST, expired or mismatching GET tokens and CSRF cannot approve", async () => {
  const f = fixture();
  const { preview, confirmation } = await start(f);
  const wrong = "0".repeat(64);
  assert.equal(await presentWindowsUpgrade(f.store, preview.operation_id, wrong, NOW + 1), null);
  assert.equal(await confirmWindowsUpgrade(f.store, preview.operation_id, wrong, wrong, NOW + 1), false);
  const form = await presentWindowsUpgrade(f.store, preview.operation_id, confirmation, NOW + 2);
  assert.ok(form);
  assert.equal(await claimWindowsUpgrade(f.store, preview, NOW + 3), false);
  assert.equal(await confirmWindowsUpgrade(f.store, preview.operation_id, confirmation, form!.form_token,
    NOW + UPGRADE_APPROVAL_TTL_MS), false);
  assert.equal(await claimWindowsUpgrade(f.store, preview, NOW + UPGRADE_APPROVAL_TTL_MS), false);
  assert.equal((await readWindowsUpgrade(f.store, preview.operation_id))?.state, "prepared");
  assert.equal((await prepareWindowsUpgrade(f.store, "another-after-expiry", DEVICE, PIN,
    NOW + UPGRADE_APPROVAL_TTL_MS + 1)).status, "prepared");
  assert.equal((await prepareWindowsUpgrade(f.store, preview.operation_id, DEVICE, PIN,
    NOW + UPGRADE_APPROVAL_TTL_MS + 2)).status, "existing", "old nonce must not be recreated");
});

test("same operation ID never reveals original secret; concurrent preparations never both reserve device", async () => {
  const f = fixture();
  const results = await Promise.all([
    prepareWindowsUpgrade(f.store, "race-a", DEVICE, PIN, NOW),
    prepareWindowsUpgrade(f.store, "race-b", DEVICE, PIN, NOW),
  ]);
  assert.deepEqual(results.map(x => x.status).sort(), ["prepared", "refused"]);
  const winning = results.find(x => x.status === "prepared");
  assert.ok(winning && winning.status === "prepared");
  const repeat = await prepareWindowsUpgrade(f.store, winning.preview.operation_id, DEVICE, PIN, NOW);
  assert.deepEqual(repeat, { status: "existing" });
});

test("permanent Windows only, known target only, no wrong-device or arbitrary input", async () => {
  for (const changes of [
    { grant_type: "temporary" }, { revoked: true },
    { device_info: { os: "windows", arch: "x64", environment:"native", agent_version:"v0.1.31-rc.1" } },
    { device_info: { os: "linux", arch: "x64", environment: "wsl2",
      agent_version: "v0.1.31-rc.1", upgrade_protocol: "owner-one-shot-v1" } },
    { device_info: { os: "linux", arch: "arm64", environment: "native",
      agent_version: "v0.1.31-rc.1", upgrade_protocol: "owner-one-shot-v1" } },
    { device_info: { os: "windows", arch: "arm64", environment: "native", agent_version: "v0.1.31-rc.1" } },
    { fingerprint: "wrong" },
  ]) {
    const f = fixture(); f.modifyDevice(changes);
    assert.equal((await prepareWindowsUpgrade(f.store, "blocked", DEVICE, PIN, NOW)).status, "refused");
  }
  for (const pin of [
    { ...PIN, tag: "v0.1.31-rc.1" },
    { ...PIN, tag: "v0.1.31-rc.2" }, { ...PIN, tag: "v0.1.30-rc.1" },
    { ...PIN, tag: "../evil" }, { ...PIN, tag: "v0.1.33-" + "9".repeat(10000) },
    { ...PIN, commit: "a".repeat(39) },
    { ...PIN, windows_asset_sha256: "not-a-digest" },
  ]) {
    const f = fixture();
    assert.equal((await prepareWindowsUpgrade(f.store, "blocked", DEVICE, pin, NOW)).status, "refused");
  }
  const f = fixture();
  assert.equal((await prepareWindowsUpgrade(f.store, "../unsafe", DEVICE, PIN, NOW)).status, "refused");
  assert.equal((await prepareWindowsUpgrade(f.store, "wrong-device", "bad", PIN, NOW)).status, "refused");
});

test("revoked/repaired/version-drifted device loses approval both before confirm and before claim", async () => {
  for (const changes of [
    { revoked: true },
    { fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaa" },
    { device_info: { os: "windows", arch: "x64", environment: "native", agent_version: "v0.1.32-rc.1" } },
  ]) {
    const f = fixture();
    const prepared = await start(f);
    const presented = await presentWindowsUpgrade(f.store, prepared.preview.operation_id, prepared.confirmation, NOW + 1);
    assert.ok(presented);
    f.modifyDevice(changes);
    assert.equal(await confirmWindowsUpgrade(f.store, prepared.preview.operation_id, prepared.confirmation,
      presented!.form_token, NOW + 2), false);
  }
  const f = fixture();
  const prepared = await start(f);
  const shown = await presentWindowsUpgrade(f.store, prepared.preview.operation_id, prepared.confirmation, NOW + 1);
  assert.ok(shown);
  assert.equal(await confirmWindowsUpgrade(f.store, prepared.preview.operation_id, prepared.confirmation,
    shown!.form_token, NOW + 2), true);
  f.modifyDevice({ fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(await claimWindowsUpgrade(f.store, prepared.preview, NOW + 3), false);
});

test("exact immutable target and identity remain bound across approved claim", async () => {
  const f = fixture(), p = await start(f);
  const presented = await presentWindowsUpgrade(f.store, p.preview.operation_id, p.confirmation, NOW + 1);
  assert.ok(presented);
  assert.equal(await confirmWindowsUpgrade(f.store, p.preview.operation_id, p.confirmation,
    presented!.form_token, NOW + 2), true);
  const edits: UpgradeApprovalPreview[] = [
    { ...p.preview, device_id: "11111111-1111-4111-8111-111111111111" },
    { ...p.preview, fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaa" },
    { ...p.preview, current_version: "v0.1.30-rc.1" },
    { ...p.preview, target: { ...PIN, commit: "a".repeat(40) } },
    { ...p.preview, target: { ...PIN, windows_asset_sha256: "a".repeat(64) } },
    { ...p.preview, target: { ...PIN, tag: "v0.1.33-rc.1" } },
  ];
  for (const edit of edits) assert.equal(await claimWindowsUpgrade(f.store, edit, NOW + 3), false);
  assert.equal(await claimWindowsUpgrade(f.store, p.preview, NOW + 4), true);
});

test("expired approved but never claimed operation can release reservation without replay", async () => {
  const f = fixture(), p = await start(f);
  const shown = await presentWindowsUpgrade(f.store, p.preview.operation_id, p.confirmation, NOW + 10);
  assert.ok(shown);
  assert.equal(await confirmWindowsUpgrade(f.store, p.preview.operation_id,
    p.confirmation, shown!.form_token, NOW + 20), true);
  assert.equal((await prepareWindowsUpgrade(f.store, "premature", DEVICE, PIN,
    NOW + 50)).status, "refused");
  assert.equal((await prepareWindowsUpgrade(f.store, "new-after-expiry", DEVICE, PIN,
    NOW + UPGRADE_APPROVAL_TTL_MS + 1)).status, "prepared");
  assert.equal(await claimWindowsUpgrade(f.store, p.preview,
    NOW + UPGRADE_APPROVAL_TTL_MS + 2), false);
  assert.equal((await readWindowsUpgrade(f.store, p.preview.operation_id))?.state, "approved",
    "expired old approval remains auditable and cannot claim or mutate a new operation");
});

test("confirmed owner intent dispatches exactly once with authoritative timestamp",async()=>{
  const f=fixture(), p=await start(f,"dispatch-once");
  assert.equal(await claimWindowsUpgradeDispatch(f.store,"dispatch-once",NOW+5),null,
    "preparation alone never authorizes a device command");
  const shown=await presentWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,NOW+10);
  assert.ok(shown);
  assert.equal(await confirmWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,
    shown!.form_token,NOW+20),true);
  const accepted=await claimWindowsUpgradeDispatch(f.store,p.preview.operation_id,NOW+23);
  assert.deepEqual(accepted,{...p.preview,approved_at:NOW+20});
  assert.equal(await claimWindowsUpgradeDispatch(f.store,p.preview.operation_id,NOW+24),null);
  assert.equal((await readWindowsUpgrade(f.store,p.preview.operation_id))?.state,"claimed");
  assert.equal(await markUpgradeDispatchUncertain(f.store,p.preview.operation_id),true);
  assert.equal(await markUpgradeDispatchUncertain(f.store,p.preview.operation_id),false);
  assert.equal((await readWindowsUpgrade(f.store,p.preview.operation_id))?.state,"needs_attention");
  assert.equal((await prepareWindowsUpgrade(f.store,"new-after-unknown",DEVICE,PIN,
    NOW+UPGRADE_APPROVAL_TTL_MS+50)).status,"refused");
});
test("offline claimed upgrade becomes guarded needs_attention after bounded settlement window",async()=>{
  const f=fixture(),p=await start(f,"no-reconnect-timeout");
  const shown=await presentWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,NOW+1);
  assert.ok(shown);
  assert.equal(await confirmWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,
    shown!.form_token,NOW+2),true);
  assert.ok(await claimWindowsUpgradeDispatch(f.store,p.preview.operation_id,NOW+3));
  assert.equal(await markStaleWindowsUpgradeAttention(f.store,p.preview.operation_id,
    NOW+2+UPGRADE_UNCONFIRMED_ATTENTION_MS-1),false,
    "an in-flight native stage or watchdog must not time out early");
  assert.equal((await readWindowsUpgrade(f.store,p.preview.operation_id))?.state,"claimed");
  assert.equal(await markStaleWindowsUpgradeAttention(f.store,p.preview.operation_id,
    NOW+2+UPGRADE_UNCONFIRMED_ATTENTION_MS),true);
  assert.equal((await readWindowsUpgrade(f.store,p.preview.operation_id))?.state,"needs_attention");
  assert.equal(await markStaleWindowsUpgradeAttention(f.store,p.preview.operation_id,
    NOW+3+UPGRADE_UNCONFIRMED_ATTENTION_MS),false,
    "a completed timerless reconciliation is not repeated");
  assert.equal((await prepareWindowsUpgrade(f.store,"unsafe-retry",DEVICE,PIN,
    NOW+UPGRADE_UNCONFIRMED_ATTENTION_MS+10)).status,"refused",
    "unresponsive state must retain the device lock and prevent automatic retry");
  // A genuinely completed result can still settle after the conservative
  // timeout; the timeout never becomes authorization for a second dispatch.
  const old=f.rows.get("device:"+DEVICE) as {device_info:Record<string,unknown>};
  f.modifyDevice({device_info:{...old.device_info,agent_version:PIN.tag}});
  f.rows.set("session:epoch:"+DEVICE,"signed-late-success");
  assert.equal(await markWindowsUpgradeCompleted(f.store,p.preview.operation_id,DEVICE,
    "signed-late-success"),true);
  assert.equal((await readWindowsUpgrade(f.store,p.preview.operation_id))?.state,"completed");
});

test("post-confirm key rotation/revocation/expiry forbids dispatch without consuming approval",async()=>{
  for(const change of [
    {revoked:true},{fingerprint:"aaaaaaaaaaaaaaaaaaaaaaaa"},
    {device_info:{os:"windows",arch:"x64",environment:"native",agent_version:"v0.1.33",
      upgrade_protocol:"owner-one-shot-v1"}},
  ]){
    const f=fixture(),p=await start(f);
    const shown=await presentWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,NOW+1);
    assert.ok(shown);
    assert.equal(await confirmWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,
      shown!.form_token,NOW+2),true);
    f.modifyDevice(change);
    assert.equal(await claimWindowsUpgradeDispatch(f.store,p.preview.operation_id,NOW+3),null);
    assert.equal((await readWindowsUpgrade(f.store,p.preview.operation_id))?.state,"approved");
  }
  const f=fixture(),p=await start(f);
  const shown=await presentWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,NOW+1);
  assert.ok(shown);
  assert.equal(await confirmWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,
    shown!.form_token,NOW+2),true);
  assert.equal(await claimWindowsUpgradeDispatch(f.store,p.preview.operation_id,
    NOW+UPGRADE_APPROVAL_TTL_MS),null);
});

test("only exactly reported signed new target permits terminal completion and future intents",async()=>{
  const f=fixture(),p=await start(f,"once-native-reconnect");
  const shown=await presentWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,NOW+1);
  assert.ok(shown);
  assert.equal(await confirmWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,
    shown!.form_token,NOW+2),true);
  assert.ok(await claimWindowsUpgradeDispatch(f.store,p.preview.operation_id,NOW+3));
  assert.equal(await markWindowsUpgradeCompleted(f.store,p.preview.operation_id,DEVICE,"signed-after-switch"),false,
    "an admitted operation is not an upgrade");
  const current=f.rows.get("device:"+DEVICE) as {device_info:Record<string,unknown>};
  f.modifyDevice({device_info:{...current.device_info,agent_version:PIN.tag}});
  assert.equal(await markWindowsUpgradeCompleted(f.store,p.preview.operation_id,DEVICE,"signed-after-switch"),false,
    "the original authenticated socket cannot masquerade as a new Agent incarnation");
  f.rows.set("session:epoch:" + DEVICE, "signed-another-incarnation");
  assert.equal(await markWindowsUpgradeCompleted(f.store,p.preview.operation_id,DEVICE,"signed-after-switch"),false,
    "a second reconnect after reading the receipt must not settle stale evidence");
  f.rows.set("session:epoch:" + DEVICE, "signed-after-switch");
  assert.equal(await markWindowsUpgradeCompleted(f.store,p.preview.operation_id,DEVICE,"signed-after-switch"),true,
    "signed Agent receipt validation is a separate mandatory caller gate");
  assert.equal((await readWindowsUpgrade(f.store,p.preview.operation_id))?.state,"completed");
  assert.equal(await markWindowsUpgradeCompleted(f.store,p.preview.operation_id,DEVICE,"signed-after-switch"),false,
    "terminal outcome must never be applied twice");
  assert.equal((await prepareWindowsUpgrade(f.store,"after-success",DEVICE,
    {...PIN,tag:"v0.1.33-rc.1"},NOW+UPGRADE_APPROVAL_TTL_MS+1)).status,"prepared");
});
test("terminal ledger refuses re-pair, revocation, target mismatch or missing runtime capability",async()=>{
  for(const change of [
    {revoked:true},{fingerprint:"aaaaaaaaaaaaaaaaaaaaaaaa"},
    {device_info:{os:"windows",arch:"x64",environment:"native",agent_version:PIN.tag}},
    {device_info:{os:"windows",arch:"x64",environment:"native",
      upgrade_protocol:"owner-one-shot-v1",agent_version:"v0.1.34"}},
  ]){
    const f=fixture(),p=await start(f,"not-final");
    const shown=await presentWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,NOW+1);
    assert.ok(shown);
    assert.equal(await confirmWindowsUpgrade(f.store,p.preview.operation_id,p.confirmation,
      shown!.form_token,NOW+2),true);
    assert.ok(await claimWindowsUpgradeDispatch(f.store,p.preview.operation_id,NOW+3));
    f.rows.set("session:epoch:" + DEVICE, "signed-after-switch");
    f.modifyDevice(change);
    assert.equal(await markWindowsUpgradeCompleted(f.store,p.preview.operation_id,DEVICE,"signed-after-switch"),false);
    assert.equal((await readWindowsUpgrade(f.store,p.preview.operation_id))?.state,"claimed");
  }
});


test("Linux x64/ARM64 use the existing one-use owner approval and fresh WSS epoch ledger",async()=>{
  for(const arch of ["x64","arm64"] as const){
    for(const environment of ["native","wsl2"] as const){
      const f=fixture();
      const pin:ReviewedUpgradePin={tag:"v0.1.33",commit:"a".repeat(40),
        linux_arch:arch,linux_asset_sha256:(arch==="x64"?"b":"c").repeat(64)};
      f.modifyDevice({device_info:{os:"linux",arch,environment,
        agent_version:"v0.1.22",upgrade_protocol:"owner-one-shot-v1"}});
      const id="linux-"+arch+"-"+environment;
      const prepared=await prepareWindowsUpgrade(f.store,id,DEVICE,pin,NOW);
      assert.equal(prepared.status,"prepared",id);
      if(prepared.status!=="prepared")continue;
      const preview=await presentWindowsUpgrade(f.store,id,prepared.confirmation,NOW+1);
      assert.ok(preview,id);
      assert.equal(await confirmWindowsUpgrade(f.store,id,prepared.confirmation,
        preview!.form_token,NOW+2),true,id);
      const one=await claimWindowsUpgradeDispatch(f.store,id,NOW+3);
      assert.deepEqual(one,{...prepared.preview,approved_at:NOW+2});
      assert.equal(await claimWindowsUpgradeDispatch(f.store,id,NOW+4),null,
        "replayed Linux dispatch is forbidden");
      const before=f.rows.get("device:"+DEVICE) as {device_info:Record<string,unknown>};
      f.modifyDevice({device_info:{...before.device_info,agent_version:pin.tag}});
      assert.equal(await markWindowsUpgradeCompleted(f.store,id,DEVICE,
        "signed-before-switch"),false);
      f.rows.set("session:epoch:"+DEVICE,"signed-new-linux");
      assert.equal(await markWindowsUpgradeCompleted(f.store,id,DEVICE,
        "signed-before-switch"),false);
      assert.equal(await markWindowsUpgradeCompleted(f.store,id,DEVICE,
        "signed-new-linux"),true);
      assert.equal((await readWindowsUpgrade(f.store,id))?.state,"completed");
    }
  }
});

test("Linux one-shot owner ledger rejects foreign architecture, downgrade, unsafe SHA and container",async()=>{
  const linuxPin:ReviewedUpgradePin={
    tag:"v0.1.33",commit:"a".repeat(40),
    linux_arch:"x64",linux_asset_sha256:"b".repeat(64)};
  for(const change of [
    {arch:"arm64"},{environment:"container"},{environment:"wsl1"},
    {upgrade_protocol:undefined},{agent_version:"v0.1.34"},
    {agent_version:"v0.1.33"},
  ]){
    const f=fixture();
    f.modifyDevice({device_info:{os:"linux",arch:"x64",environment:"wsl2",
      agent_version:"v0.1.22",upgrade_protocol:"owner-one-shot-v1",...change}});
    assert.equal((await prepareWindowsUpgrade(f.store,"linux-denied",DEVICE,
      linuxPin,NOW)).status,"refused",JSON.stringify(change));
  }
  for(const pin of [
    {...linuxPin,tag:"v0.1.22"},
    {...linuxPin,tag:"v0.1.33-rc.1"},
    {...linuxPin,commit:"x".repeat(40)},
    {...linuxPin,linux_asset_sha256:"b".repeat(63)},
    {...linuxPin,linux_arch:"unknown"},
    {...linuxPin,windows_asset_sha256:"f".repeat(64)},
  ]){
    const f=fixture();
    f.modifyDevice({device_info:{os:"linux",arch:"x64",environment:"native",
      agent_version:"v0.1.22",upgrade_protocol:"owner-one-shot-v1"}});
    assert.equal((await prepareWindowsUpgrade(f.store,"linux-denied",DEVICE,
      pin as ReviewedUpgradePin,NOW)).status,"refused",JSON.stringify(pin));
  }
});
