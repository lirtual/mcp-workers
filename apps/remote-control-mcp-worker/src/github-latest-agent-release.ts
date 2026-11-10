/**
 * One latest stable Agent Release from lirtual/mcp-workers.
 * Windows install.ps1, Linux /install.sh, and macOS /install-macos.sh all use
 * selectLatestAgentRelease. None fall back to another repository or tag.
 *
 * Windows snapshot bounds match install.ps1 (100 KiB–100 MiB). Linux and macOS
 * use the wider window (1 byte–180 MiB); the Linux shell then refuses an asset
 * below 1 KiB. A stable tag has no prerelease suffix. html_url, when present,
 * must be this repository. 404, 403, and 429 fail closed.
 */

export const LATEST_AGENT_RELEASE_URL =
  "https://api.github.com/repos/lirtual/mcp-workers/releases/latest";

export const AGENT_RELEASE_TARGETS = [
  "linux-x64-glibc",
  "linux-arm64-glibc",
  "windows-x64",
  "darwin-arm64",
  "darwin-x64",
] as const;

export type AgentReleaseTarget = typeof AGENT_RELEASE_TARGETS[number];
export type AgentPlatform = AgentReleaseTarget;

const TARGET_ARCH = {
  "linux-x64-glibc": "x64",
  "linux-arm64-glibc": "arm64",
  "windows-x64": "x64",
  "darwin-arm64": "arm64",
  "darwin-x64": "x64",
} as const satisfies Record<AgentReleaseTarget, "x64" | "arm64">;

const WINDOWS_MIN_ASSET_BYTES = 100_000;
const WINDOWS_MAX_ASSET_BYTES = 100_000_000;
const RELEASE_MIN_ASSET_BYTES = 1;
const RELEASE_MAX_ASSET_BYTES = 180_000_000;

const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEVICE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PLATFORM_ASSET = /^remote-control-agent-v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?-(?:linux-x64-glibc|linux-arm64-glibc|windows-x64|darwin-arm64|darwin-x64)\.(?:tar\.gz|zip)$/;

export type SelectedAgentAsset = Readonly<{
  target: AgentReleaseTarget;
  name: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  architecture: "x64" | "arm64";
}>;

export type SelectedAgentRelease = Readonly<{
  repository: "lirtual/mcp-workers";
  tag: string;
  htmlUrl: string;
  immutable: true;
  assets: Readonly<Record<AgentReleaseTarget, SelectedAgentAsset>>;
}>;

export type LatestReleaseStop =
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "rejected"
  | "unavailable";

export type LatestReleaseDecision =
  | { ok: true; release: SelectedAgentRelease }
  | { ok: false; stop: LatestReleaseStop; retryAfter?: string };

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
  sizeBounds: { readonly min: typeof WINDOWS_MIN_ASSET_BYTES; readonly max: typeof WINDOWS_MAX_ASSET_BYTES };
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

type ReleaseLookup = {
  status: number;
  body?: unknown;
  retryAfter?: string | null;
};

type ParseFailure = "untrusted" | "incomplete" | "wrong_platform" | "corrupt";

export function agentAssetName(tag: string, target: AgentReleaseTarget): string {
  const ext = target === "windows-x64" ? "zip" : "tar.gz";
  return `remote-control-agent-${tag}-${target}.${ext}`;
}

function assetDownloadUrl(tag: string, name: string): string {
  return `https://github.com/lirtual/mcp-workers/releases/download/${tag}/${name}`;
}

function releaseHtmlUrl(tag: string): string {
  return `https://github.com/lirtual/mcp-workers/releases/tag/${tag}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pass through only a bounded Retry-After a later owner attempt may display. */
export function sanitizeRetryAfter(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^[0-9]{1,6}$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9, :+-]{1,40}$/.test(trimmed) && Number.isFinite(Date.parse(trimmed))) return trimmed;
  return undefined;
}

function stop(kind: LatestReleaseStop, retryAfter?: string | null): LatestReleaseDecision {
  const safe = sanitizeRetryAfter(retryAfter);
  return safe ? { ok: false, stop: kind, retryAfter: safe } : { ok: false, stop: kind };
}

function readPlatformAsset(
  tag: string,
  target: AgentReleaseTarget,
  raw: Record<string, unknown>,
  bounds: { min: number; max: number },
): { ok: true; asset: SelectedAgentAsset } | { ok: false; code: "untrusted" | "corrupt" } {
  const name = agentAssetName(tag, target);
  const downloadUrl = assetDownloadUrl(tag, name);
  if (raw.name !== name || raw.state !== "uploaded" || raw.browser_download_url !== downloadUrl) {
    return { ok: false, code: "untrusted" };
  }
  const digest = raw.digest;
  if (typeof digest !== "string" || !digest.startsWith("sha256:") || !SHA256.test(digest.slice("sha256:".length))) {
    return { ok: false, code: "corrupt" };
  }
  const size = raw.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < bounds.min || size > bounds.max) {
    return { ok: false, code: "untrusted" };
  }
  return {
    ok: true,
    asset: Object.freeze({
      target,
      name,
      size,
      sha256: digest.slice("sha256:".length),
      downloadUrl,
      architecture: TARGET_ARCH[target],
    }),
  };
}

/** Shared acceptance: stable identity, five platform assets, digest, size, arch, this repo only. */
function parseRelease(
  body: unknown,
  bounds: { min: number; max: number },
  exactAssetCount: boolean,
): { ok: true; tag: string; assets: Record<AgentReleaseTarget, SelectedAgentAsset> } | { ok: false; code: ParseFailure } {
  if (!isRecord(body)) return { ok: false, code: "untrusted" };
  const tag = body.tag_name;
  if (typeof tag !== "string" || !TAG.test(tag) ||
      body.draft !== false || body.prerelease !== false || body.immutable !== true ||
      (body.html_url !== undefined && body.html_url !== releaseHtmlUrl(tag))) {
    return { ok: false, code: "untrusted" };
  }
  if (!Array.isArray(body.assets)) return { ok: false, code: "incomplete" };
  const assetCount = body.assets.length;
  const expected = new Map(AGENT_RELEASE_TARGETS.map((target) => [agentAssetName(tag, target), target]));
  const selected = new Map<AgentReleaseTarget, SelectedAgentAsset>();
  for (const asset of body.assets) {
    if (!isRecord(asset) || typeof asset.name !== "string") return { ok: false, code: "untrusted" };
    const target = expected.get(asset.name);
    if (!target) {
      if (PLATFORM_ASSET.test(asset.name)) return { ok: false, code: "untrusted" };
      continue;
    }
    if (selected.has(target)) return { ok: false, code: "untrusted" };
    const parsed = readPlatformAsset(tag, target, asset, bounds);
    if (!parsed.ok) return parsed;
    selected.set(target, parsed.asset);
  }
  if (!selected.has("windows-x64")) return { ok: false, code: "wrong_platform" };
  if (exactAssetCount && assetCount !== AGENT_RELEASE_TARGETS.length) {
    return { ok: false, code: assetCount > AGENT_RELEASE_TARGETS.length ? "untrusted" : "incomplete" };
  }
  if (selected.size !== AGENT_RELEASE_TARGETS.length) return { ok: false, code: "incomplete" };
  const assets = {} as Record<AgentReleaseTarget, SelectedAgentAsset>;
  for (const target of AGENT_RELEASE_TARGETS) {
    const asset = selected.get(target);
    if (!asset) return { ok: false, code: "incomplete" };
    assets[target] = asset;
  }
  return { ok: true, tag, assets: Object.freeze(assets) };
}

function decideLatest(lookup: ReleaseLookup): LatestReleaseDecision {
  if (lookup.status === 404) return stop("not_found");
  if (lookup.status === 403) return stop("forbidden", lookup.retryAfter);
  if (lookup.status === 429) return stop("rate_limited", lookup.retryAfter);
  if (lookup.status !== 200) return stop("rejected");
  const parsed = parseRelease(lookup.body, { min: RELEASE_MIN_ASSET_BYTES, max: RELEASE_MAX_ASSET_BYTES }, false);
  if (!parsed.ok) return stop("rejected");
  return {
    ok: true,
    release: Object.freeze({
      repository: "lirtual/mcp-workers",
      tag: parsed.tag,
      htmlUrl: releaseHtmlUrl(parsed.tag),
      immutable: true,
      assets: parsed.assets,
    }),
  };
}

function fail(code: LatestAgentReleaseCode, message: string): never {
  throw new LatestAgentReleaseError(code, message);
}

async function readWindowsSnapshot(doFetch: typeof fetch): Promise<LatestAgentReleaseSnapshot> {
  const response = await doFetch(LATEST_AGENT_RELEASE_URL, {
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
  const parsed = parseRelease(body, { min: WINDOWS_MIN_ASSET_BYTES, max: WINDOWS_MAX_ASSET_BYTES }, true);
  if (!parsed.ok) {
    const message = parsed.code === "corrupt"
      ? "Latest Agent Release is missing an official SHA-256"
      : parsed.code === "wrong_platform"
        ? "Windows x64 Agent asset is missing"
        : parsed.code === "incomplete"
          ? "Latest Agent Release is missing a platform asset"
          : "Latest Agent Release is not a stable immutable Agent Release";
    fail(parsed.code, message);
  }
  const assets: AgentReleaseAsset[] = AGENT_RELEASE_TARGETS.map((target) => {
    const asset = parsed.assets[target];
    return {
      target: asset.target,
      name: asset.name,
      sha256: asset.sha256,
      size: asset.size,
      url: asset.downloadUrl,
      architecture: asset.architecture,
    };
  });
  const windows = assets[2];
  if (!windows || windows.target !== "windows-x64") fail("wrong_platform", "Windows x64 Agent asset is missing");
  return {
    repository: "lirtual/mcp-workers",
    tag: parsed.tag,
    draft: false,
    prerelease: false,
    immutable: true,
    identity: "remote-control-agent",
    maxRedirects: 3,
    allowedRedirectHosts: ["release-assets.githubusercontent.com", "objects.githubusercontent.com"],
    sizeBounds: { min: WINDOWS_MIN_ASSET_BYTES, max: WINDOWS_MAX_ASSET_BYTES },
    assets,
    windows,
  };
}

/**
 * Select one latest Release. A status lookup returns a macOS decision.
 * A fetch lookup returns the Windows snapshot and throws instead of falling open.
 */
export function selectLatestAgentRelease(lookup: ReleaseLookup): LatestReleaseDecision;
export function selectLatestAgentRelease(input: { fetch: typeof fetch }): Promise<LatestAgentReleaseSnapshot>;
export function selectLatestAgentRelease(
  input: ReleaseLookup | { fetch: typeof fetch },
): LatestReleaseDecision | Promise<LatestAgentReleaseSnapshot> {
  if ("fetch" in input) return readWindowsSnapshot(input.fetch);
  return decideLatest(input);
}

/** One latest lookup. Redirects and transport failures stop; they are not a second chance. */
export async function readLatestAgentRelease(doFetch: typeof fetch): Promise<LatestReleaseDecision> {
  let response: Response;
  try {
    response = await doFetch(LATEST_AGENT_RELEASE_URL, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "mcp-workers-remote-control",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    return { ok: false, stop: "unavailable" };
  }
  if (response.status >= 300 && response.status < 400) return { ok: false, stop: "rejected" };
  let body: unknown;
  if (response.status === 200) {
    const text = await response.text();
    if (text.length > 1_048_576) return { ok: false, stop: "rejected" };
    try { body = JSON.parse(text); }
    catch { return { ok: false, stop: "rejected" }; }
  }
  return selectLatestAgentRelease({
    status: response.status,
    body,
    retryAfter: response.headers.get("retry-after"),
  });
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
