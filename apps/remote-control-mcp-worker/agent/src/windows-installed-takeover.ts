/**
 * Device-side Windows archive and installed-agent decisions.
 * The Worker selects one Release; it does not plan the device takeover.
 */

export class LatestAgentReleaseError extends Error {
  readonly code: "corrupt";
  constructor(code: "corrupt", message: string) {
    super(message);
    this.name = "LatestAgentReleaseError";
    this.code = code;
  }
}

const EXTRACT_DIR = /^(?:bin|apps|apps\/remote-control-agent|apps\/remote-control-agent\/src|apps\/remote-control-agent\/scripts)\/$/;
const EXTRACT_FILE = /^(?:bin\/(?:node\.exe|rca-background\.exe)|rca\.cmd|bundle\.json|apps\/remote-control-agent\/(?:package\.json|src\/[a-z0-9-]+\.js|scripts\/(?:(?:windows-private-store|windows-session-private-store|windows-user-task|windows-stage-install|windows-upgrade-once)\.ps1|verify-windows-preview\.mjs)))$/;
const DEVICE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Constrained Windows archive member. Directories keep the trailing slash. */
export function windowsExtractPathAllowed(entryName: string): boolean {
  if (entryName.includes("\\") || entryName.includes(":") || entryName.startsWith("/") ||
      entryName.includes("//") || /(^|\/)\.{1,2}(\/|$)/.test(entryName) ||
      /[^\x20-\x7e]/.test(entryName)) {
    return false;
  }
  return entryName.endsWith("/") ? EXTRACT_DIR.test(entryName) : EXTRACT_FILE.test(entryName);
}

export async function verifyDownloadedWindowsAsset(
  asset: { sha256: string; size: number },
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength !== asset.size) {
    throw new LatestAgentReleaseError("corrupt", "Release asset size mismatch");
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== asset.sha256) {
    throw new LatestAgentReleaseError("corrupt", "Release asset SHA-256 mismatch");
  }
}

type TakeoverGrant = "permanent" | "temporary" | "absent";

export type InstalledWindowsState = {
  version: string;
  deviceId: string;
  privateKeyPresent: boolean;
  grant: TakeoverGrant;
  ownerStopped: boolean;
  unknownOperationId: string | null;
  upgradeResult?: "ready" | "partial" | "unknown";
};

export type WindowsTakeoverPlan = {
  action: "upgrade" | "isolate" | "refuse";
  deviceId: string;
  grant: TakeoverGrant;
  ownerStopped: boolean;
  privateKeyPreserved: true;
  startAgent: boolean;
  rePair: false;
  replayUnknownOperationId: null;
};

function versionCore(version: string): [number, number, number] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-[a-z0-9.-]+)?$/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return null;
  return [major, minor, patch];
}

function isStrictlyNewer(releaseTag: string, installed: string): boolean {
  const next = versionCore(releaseTag);
  const current = versionCore(installed);
  if (!next || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = next[index];
    const right = current[index];
    if (left === undefined || right === undefined) return false;
    if (left !== right) return left > right;
  }
  return false;
}

/** Owner-authorized switch from an installed Agent, including v0.1.51, onto one selected tag. */
export function planInstalledWindowsTakeover(
  installed: InstalledWindowsState,
  releaseTag: string,
): WindowsTakeoverPlan {
  const preserved: WindowsTakeoverPlan = {
    action: "refuse",
    deviceId: installed.deviceId,
    grant: installed.grant,
    ownerStopped: installed.ownerStopped,
    privateKeyPreserved: true,
    startAgent: false,
    rePair: false,
    replayUnknownOperationId: null,
  };
  if (installed.upgradeResult === "partial" || installed.upgradeResult === "unknown") {
    return { ...preserved, action: "isolate" };
  }
  const identityOk = DEVICE_ID.test(installed.deviceId) && installed.privateKeyPresent &&
    installed.grant === "permanent" && isStrictlyNewer(releaseTag, installed.version);
  if (!identityOk) return preserved;
  return {
    ...preserved,
    action: "upgrade",
    grant: "permanent",
    startAgent: !installed.ownerStopped,
  };
}
