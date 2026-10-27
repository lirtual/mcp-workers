import assert from "node:assert/strict";
import {test} from "node:test";
import {inspectReviewedLinuxUpgradeAsset,reviewedLinuxUpgradeTarget,
  REVIEWED_LINUX_UPGRADE_PIN,type ReviewedLinuxUpgradePin}
  from "../src/linux-upgrade-pin.ts";
import type {V2Device} from "../src/v2-session.ts";

const DEVICE:V2Device={
  device_id:"af666663-b30c-4b3d-ad85-c8047dc3516b",
  name:"fixture",public_key:"public-only",
  fingerprint:"0123456789abcdef01234567",
  revoked:false,grant_type:"permanent",approved_at:1793000000000,
  device_info:{os:"linux",arch:"x64",environment:"wsl2",
    hostname:"fixture",os_version:"kernel",agent_version:"v0.1.22",
    upgrade_protocol:"owner-one-shot-v1"},
};
const FAKE_PIN:ReviewedLinuxUpgradePin={
  tag:"v0.1.33",commit:"a".repeat(40),
  linux_x64_asset_sha256:"b".repeat(64),
  linux_arm64_asset_sha256:"c".repeat(64),
  protocol:"owner-one-shot-v1",
};
test("production Linux one-shot target uses only the verified immutable Release",()=>{
  assert.deepEqual(REVIEWED_LINUX_UPGRADE_PIN,{
    tag:"v0.1.33",
    commit:"43a1a423a08be0379f5f8c6899d86a053248112e",
    linux_x64_asset_sha256:"dad51aab391f4ac10097a798531b398368433e4d2490c63ca22ba79281af7666",
    linux_arm64_asset_sha256:"89549d7daf1bd399e5c9dafbcc69765a34daafe2cc385c1c69aa80e462369095",
    protocol:"owner-one-shot-v1",
  });
  for(const [arch,sha] of [
    ["x64","dad51aab391f4ac10097a798531b398368433e4d2490c63ca22ba79281af7666"],
    ["arm64","89549d7daf1bd399e5c9dafbcc69765a34daafe2cc385c1c69aa80e462369095"],
  ] as const){
    const device:V2Device={...DEVICE,device_info:{...DEVICE.device_info!,arch}};
    assert.deepEqual(reviewedLinuxUpgradeTarget(device),{
      tag:"v0.1.33",commit:"43a1a423a08be0379f5f8c6899d86a053248112e",arch,
      asset_name:"remote-control-agent-v0.1.33-linux-"+arch+"-glibc.tar.gz",
      asset_sha256:sha,
      release_url:"https://github.com/lirtual/remote-control-agent/releases/download/v0.1.33/remote-control-agent-v0.1.33-linux-"+arch+"-glibc.tar.gz",
    });
  }
  assert.equal(reviewedLinuxUpgradeTarget(undefined),null);
  assert.equal(reviewedLinuxUpgradeTarget({...DEVICE,grant_type:"temporary"}),null);
});
test("isolated simulated immutable Linux x64/ARM64 pins select exact official assets",()=>{
  for(const [arch,sha] of [["x64","b"],["arm64","c"]] as const){
    for(const environment of ["native","wsl2"] as const){
      const device:V2Device={...DEVICE,device_info:{...DEVICE.device_info!,
        arch,environment}};
      const choice=inspectReviewedLinuxUpgradeAsset(device,FAKE_PIN);
      assert.deepEqual(choice,{
        tag:"v0.1.33",commit:"a".repeat(40),arch,
        asset_name:"remote-control-agent-v0.1.33-linux-"+arch+"-glibc.tar.gz",
        asset_sha256:sha.repeat(64),
        release_url:"https://github.com/lirtual/remote-control-agent/releases/download/v0.1.33/remote-control-agent-v0.1.33-linux-"+arch+"-glibc.tar.gz",
      });
    }
  }
});
test("owner one-shot target cannot derive from signed metadata without independently reviewed artifact pin",()=>{
  for(const changes of [
    {revoked:true},{grant_type:"temporary" as const},
    {fingerprint:"bad"},{device_info:{...DEVICE.device_info!,os:"darwin" as const}},
    {device_info:{...DEVICE.device_info!,arch:"ia32"}},
    {device_info:{...DEVICE.device_info!,environment:"container" as const}},
    {device_info:{...DEVICE.device_info!,agent_version:"v0.1.33"}},
    {device_info:{...DEVICE.device_info!,agent_version:"v0.1.34"}},
    {device_info:{...DEVICE.device_info!,agent_version:"v0.1.22-rc.1"}},
    {device_info:{...DEVICE.device_info!,upgrade_protocol:undefined}},
  ]){
    assert.equal(inspectReviewedLinuxUpgradeAsset({...DEVICE,...changes} as V2Device,FAKE_PIN),
      null,"bad signed OS/grant/identity/version is never authorization");
  }
  assert.equal(inspectReviewedLinuxUpgradeAsset(DEVICE,null),null);
  assert.equal(inspectReviewedLinuxUpgradeAsset(undefined,FAKE_PIN),null);
});
test("Linux immutable review requires both architecture SHA256, exact commit and safe stable version",()=>{
  for(const pin of [
    {...FAKE_PIN,tag:"../evil"},
    {...FAKE_PIN,tag:"v0.1.22"},
    {...FAKE_PIN,tag:"v0.1.20"},
    {...FAKE_PIN,tag:"v0.1.33-rc.1"},
    {...FAKE_PIN,tag:"v99999999999999999999999999999999999.1.2"},
    {...FAKE_PIN,commit:"a".repeat(39)},
    {...FAKE_PIN,linux_x64_asset_sha256:"b".repeat(63)},
    {...FAKE_PIN,linux_arm64_asset_sha256:"c".repeat(65)},
    {...FAKE_PIN,linux_x64_asset_sha256:"B".repeat(64)},
    {...FAKE_PIN,protocol:"unknown"},
  ]){
    assert.equal(inspectReviewedLinuxUpgradeAsset(DEVICE,
      pin as ReviewedLinuxUpgradePin),null,"no unreviewed immutable target or caller version");
  }
});
