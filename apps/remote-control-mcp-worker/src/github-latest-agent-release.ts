/**
 * One-shot selection of the repository's latest stable Agent Release.
 * Windows install.ps1 enforces the same decision on the device; this module
 * is the shared client. It never falls back to another repository or tag.
 */

const LATEST_URL = "https://api.github.com/repos/lirtual/mcp-workers/releases/latest";
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const DEVICE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MIN_ASSET_BYTES = 100_000;
const MAX_ASSET_BYTES = 100_000_000;

const PLATFORMS = [
  ["linux-x64-glibc", "tar.gz", "x64"],
  ["linux-arm64-glibc", "tar.gz", "arm64"],
  ["windows-x64", "zip", "x64"],
  ["darwin-arm64", "tar.gz", "arm64"],
  ["darwin-x64", "tar.gz", "x64"],
] as const;

export type AgentPlatform = (typeof PLATFORMS)[number][0];

export type AgentReleaseAsset = {
  target: AgentPlatform;
  name: string;
  sha256: string;
  size: number;
  url: string;
  architecture: "x64" | "arm64";
};

export type LatestAgentReleaseSnapshot = {
  repository: "lirtual/mcp-workers";
  tag: string;
  draft: false;
  prerelease: false;
  immutable: true;
  identity: "remote-control-agent";
  maxRedirects: 3;
  allowedRedirectHosts: readonly ["release-assets.githubusercontent.com", "objects.githubusercontent.com"];
  sizeBounds: { readonly min: typeof MIN_ASSET_BYTES; readonly max: typeof MAX_ASSET_BYTES };
  assets: readonly AgentReleaseAsset[];
  windows: AgentReleaseAsset;
};

export type LatestAgentReleaseCode =
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "incomplete"
  | "wrong_platform"
  | "untrusted"
  | "corrupt";

export class LatestAgentReleaseError extends Error {
  readonly code: LatestAgentReleaseCode;
  constructor(code: LatestAgentReleaseCode, message: string) {
    super(message);
    this.name = "LatestAgentReleaseError";
    this.code = code;
  }
}

const EXTRACT_DIR = /^(?:bin|apps|apps\/remote-control-agent|apps\/remote-control-agent\/src|apps\/remote-control-agent\/scripts)\/$/;
const EXTRACT_FILE = /^(?:bin\/(?:node\.exe|rca-background\.exe)|rca\.cmd|bundle\.json|apps\/remote-control-agent\/(?:package\.json|src\/[a-z0-9-]+\.js|scripts\/(?:(?:windows-private-store|windows-session-private-store|windows-user-task|windows-stage-install|windows-upgrade-once)\.ps1|verify-windows-preview\.mjs)))$/;

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

function fail(code: LatestAgentReleaseCode, message: string): never {
  throw new LatestAgentReleaseError(code, message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assetName(tag: string, target: string, ext: string): string {
  return `remote-control-agent-${tag}-${target}.${ext}`;
}

function readAsset(tag: string, target: AgentPlatform, ext: string, architecture: "x64" | "arm64", raw: unknown): AgentReleaseAsset {
  const record = asRecord(raw);
  if (!record) fail("untrusted", "Latest Agent Release asset is not an object");
  const name = assetName(tag, target, ext);
  const digest = record.digest;
  const url = record.browser_download_url;
  const size = record.size;
  const expectedUrl = `https://github.com/lirtual/mcp-workers/releases/download/${tag}/${name}`;
  if (record.name !== name || record.state !== "uploaded" || url !== expectedUrl) {
    fail("untrusted", "Untrusted GitHub Release asset digest/URL");
  }
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    fail("corrupt", "Latest Agent Release is missing an official SHA-256");
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < MIN_ASSET_BYTES || size > MAX_ASSET_BYTES) {
    fail("untrusted", "Untrusted GitHub Release asset size");
  }
  return { target, name, sha256: digest.slice("sha256:".length), size, url: expectedUrl, architecture };
}

export async function selectLatestAgentRelease(input: { fetch: typeof fetch }): Promise<LatestAgentReleaseSnapshot> {
  const response = await input.fetch(LATEST_URL, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "rca-windows-latest-installer",
    },
  });
  const status = response.status;
  if (status === 404) fail("not_found", "No stable Agent Release is published");
  if (status === 403) fail("forbidden", "GitHub rate limit reached; installation stopped");
  if (status === 429) fail("rate_limited", "GitHub rate limit reached; installation stopped");
  if (status >= 300 && status < 400) fail("untrusted", "Unexpected GitHub latest redirect");
  if (status !== 200) fail("untrusted", "GitHub latest Release lookup failed");
  let body: unknown;
  try { body = await response.json(); }
  catch { fail("untrusted", "GitHub latest Release lookup failed"); }
  const release = asRecord(body);
  if (!release) fail("untrusted", "GitHub latest Release lookup failed");
  if (release.draft !== false || release.prerelease !== false || release.immutable !== true ||
      typeof release.tag_name !== "string" || !TAG.test(release.tag_name)) {
    fail("untrusted", "Latest Agent Release is not a stable immutable Agent Release");
  }
  const tag = release.tag_name;
  const rawAssets: unknown = release.assets;
  if (!Array.isArray(rawAssets)) fail("incomplete", "Latest Agent Release is missing a platform asset");
  const listed: readonly unknown[] = rawAssets;
  const windowsName = assetName(tag, "windows-x64", "zip");
  const windowsCount = listed.filter((item) => asRecord(item)?.name === windowsName).length;
  if (windowsCount === 0) fail("wrong_platform", "Windows x64 Agent asset is missing");
  if (windowsCount > 1) fail("untrusted", "Latest Agent Release is not a five-platform Agent Release");
  if (listed.length !== PLATFORMS.length) {
    fail(listed.length > PLATFORMS.length ? "untrusted" : "incomplete",
      "Latest Agent Release is missing a platform asset");
  }
  const assets = PLATFORMS.map(([target, ext, architecture]) => {
    const name = assetName(tag, target, ext);
    const matched = listed.filter((item) => asRecord(item)?.name === name);
    if (matched.length !== 1) fail("incomplete", "Latest Agent Release is missing a platform asset");
    return readAsset(tag, target, ext, architecture, matched[0]);
  });
  const windows = assets[2];
  if (!windows || windows.target !== "windows-x64") fail("wrong_platform", "Windows x64 Agent asset is missing");
  return {
    repository: "lirtual/mcp-workers",
    tag,
    draft: false,
    prerelease: false,
    immutable: true,
    identity: "remote-control-agent",
    maxRedirects: 3,
    allowedRedirectHosts: ["release-assets.githubusercontent.com", "objects.githubusercontent.com"],
    sizeBounds: { min: MIN_ASSET_BYTES, max: MAX_ASSET_BYTES },
    assets,
    windows,
  };
}
