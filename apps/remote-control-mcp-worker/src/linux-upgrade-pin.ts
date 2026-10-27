/**
 * Issue #39: immutable, independently reviewed Linux owner-one-shot-v1 Release.
 *
 * A supported signed Linux device does not itself authorize an upgrade.
 * Only the verified, server-owned dual-architecture release is eligible.
 * Never accept a release pin from MCP arguments.
 */
import {deviceIsAuthorized,type V2Device} from "./v2-session.ts";

export type ReviewedLinuxUpgradePin=Readonly<{
  tag:string;commit:string;
  linux_x64_asset_sha256:string;linux_arm64_asset_sha256:string;
  protocol:"owner-one-shot-v1";
}>;
export type LinuxUpgradeAsset=Readonly<{
  tag:string;commit:string;arch:"x64"|"arm64";asset_name:string;
  asset_sha256:string;release_url:string;
}>;

/** Reviewed v0.1.33 immutable native release, distinct from the public installer pin. */
export const REVIEWED_LINUX_UPGRADE_PIN:ReviewedLinuxUpgradePin|null=Object.freeze({
  tag:"v0.1.33",
  commit:"43a1a423a08be0379f5f8c6899d86a053248112e",
  linux_x64_asset_sha256:"dad51aab391f4ac10097a798531b398368433e4d2490c63ca22ba79281af7666",
  linux_arm64_asset_sha256:"89549d7daf1bd399e5c9dafbcc69765a34daafe2cc385c1c69aa80e462369095",
  protocol:"owner-one-shot-v1",
});

const TAG=/^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const COMMIT=/^[a-f0-9]{40}$/;
const SHA=/^[a-f0-9]{64}$/;
const FINGERPRINT=/^[a-f0-9]{24}$/;
function newer(target:string,current:string):boolean {
  const a=TAG.exec(target),b=TAG.exec(current);
  if(!a||!b||target.length>48||current.length>48)return false;
  for(let i=1;i<=3;i++){
    const x=BigInt(a[i]!),y=BigInt(b[i]!);
    if(x!==y)return x>y;
  }
  return false;
}
/** Pure internal test seam. Only the server-owned constant can activate it. */
export function inspectReviewedLinuxUpgradeAsset(
  device:V2Device|undefined,pin:ReviewedLinuxUpgradePin|null,
):LinuxUpgradeAsset|null{
  if(!pin||pin.protocol!=="owner-one-shot-v1"||!COMMIT.test(pin.commit)||
     !SHA.test(pin.linux_x64_asset_sha256)||
     !SHA.test(pin.linux_arm64_asset_sha256)||
     !deviceIsAuthorized(device)||device.grant_type==="temporary"||
     !FINGERPRINT.test(device.fingerprint)||device.device_info?.os!=="linux"||
     device.device_info.upgrade_protocol!=="owner-one-shot-v1"||
     !["native","wsl2"].includes(device.device_info.environment)||
     !["x64","arm64"].includes(device.device_info.arch)||
     typeof device.device_info.agent_version!=="string"||
     !newer(pin.tag,device.device_info.agent_version))return null;
  const arch=device.device_info.arch as "x64"|"arm64";
  const assetName="remote-control-agent-"+pin.tag+"-linux-"+arch+"-glibc.tar.gz";
  return Object.freeze({
    tag:pin.tag,commit:pin.commit,arch,asset_name:assetName,
    asset_sha256:arch==="x64"?pin.linux_x64_asset_sha256:pin.linux_arm64_asset_sha256,
    release_url:"https://github.com/lirtual/remote-control-agent/releases/download/"+pin.tag+"/"+assetName,
  });
}
/** The ONLY selector to be used by the future production owner DO. */
export function reviewedLinuxUpgradeTarget(device:V2Device|undefined):LinuxUpgradeAsset|null{
  return inspectReviewedLinuxUpgradeAsset(device,REVIEWED_LINUX_UPGRADE_PIN);
}
