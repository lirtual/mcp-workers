/**
 * One GitHub /releases/latest snapshot for the nested Remote Control Agent.
 * Windows and macOS installers import this selector; they do not retarget here.
 * Callers must pass redirect-manual fetch. This module never retries and never
 * reads the retired lirtual/remote-control-agent repository.
 */

export const AGENT_RELEASE_REPOSITORY = "lirtual/mcp-workers";
export const LATEST_AGENT_RELEASE_URL =
  "https://api.github.com/repos/lirtual/mcp-workers/releases/latest";

export const AGENT_RELEASE_TARGETS = [
  "linux-x64-glibc",
  "linux-arm64-glibc",
  "windows-x64",
  "darwin-arm64",
  "darwin-x64",
] as const;

export type AgentReleaseTarget = (typeof AGENT_RELEASE_TARGETS)[number];

export type SelectedAgentAsset = {
  readonly target: AgentReleaseTarget;
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly downloadUrl: string;
};

export type SelectedAgentRelease = {
  readonly repository: typeof AGENT_RELEASE_REPOSITORY;
  readonly id: number;
  readonly tag: string;
  readonly immutable: true;
  readonly assets: Readonly<Record<AgentReleaseTarget, SelectedAgentAsset>>;
};

export type AgentReleaseSelectionCode =
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "rejected"
  | "unavailable";

export class AgentReleaseSelectionError extends Error {
  readonly code: AgentReleaseSelectionCode;
  readonly retryAfter: string | null;
  constructor(code: AgentReleaseSelectionCode, message: string, retryAfter: string | null = null) {
    super(message);
    this.name = "AgentReleaseSelectionError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const MAX_METADATA = 1024 * 1024;
const MAX_ASSET = 180_000_000;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{64}$/;
const TARGET_SUFFIX: Readonly<Record<AgentReleaseTarget, string>> = {
  "linux-x64-glibc": ".tar.gz",
  "linux-arm64-glibc": ".tar.gz",
  "windows-x64": ".zip",
  "darwin-arm64": ".tar.gz",
  "darwin-x64": ".tar.gz",
};

function fail(code: AgentReleaseSelectionCode, message: string, retryAfter: string | null = null): never {
  throw new AgentReleaseSelectionError(code, message, retryAfter);
}

function retryAfterValue(header: string | null): string | null {
  return header !== null && /^[1-9][0-9]{0,4}$/.test(header) ? header : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assetName(tag: string, target: AgentReleaseTarget): string {
  return "remote-control-agent-" + tag + "-" + target + TARGET_SUFFIX[target];
}

function downloadUrl(tag: string, target: AgentReleaseTarget): string {
  return "https://github.com/lirtual/mcp-workers/releases/download/" + tag + "/" + assetName(tag, target);
}

function selectedAsset(tag: string, target: AgentReleaseTarget, value: unknown): SelectedAgentAsset {
  if (!isRecord(value)) fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
  const name = assetName(tag, target);
  const url = downloadUrl(tag, target);
  const size = value.size;
  const digest = value.digest;
  if (value.name !== name || value.state !== "uploaded" ||
      value.browser_download_url !== url ||
      !Number.isSafeInteger(value.id) || (value.id as number) < 1 ||
      !Number.isSafeInteger(size) || (size as number) < 1024 || (size as number) > MAX_ASSET ||
      typeof digest !== "string" || !digest.startsWith("sha256:") || !SHA.test(digest.slice(7))) {
    fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
  }
  return Object.freeze({
    target,
    id: value.id as number,
    name,
    size: size as number,
    sha256: digest.slice(7),
    downloadUrl: url,
  });
}

/** Pure snapshot check. `payload` is one GitHub release object, not a list. */
export function selectAgentReleaseSnapshot(payload: unknown): SelectedAgentRelease {
  if (!isRecord(payload) || !Array.isArray(payload.assets)) {
    fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
  }
  const tag = payload.tag_name;
  if (payload.draft !== false || payload.prerelease !== false || payload.immutable !== true ||
      typeof tag !== "string" || !TAG.test(tag) ||
      !Number.isSafeInteger(payload.id) || (payload.id as number) < 1) {
    fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
  }
  const byName = new Map<string, unknown>();
  for (const asset of payload.assets) {
    if (!isRecord(asset) || typeof asset.name !== "string" || byName.has(asset.name)) {
      fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
    }
    byName.set(asset.name, asset);
  }
  const expected = new Set(AGENT_RELEASE_TARGETS.map((target) => assetName(tag, target)));
  for (const name of byName.keys()) {
    if (!expected.has(name) && name !== "SHA256SUMS.txt") {
      fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
    }
  }
  if (byName.size !== expected.size &&
      !(byName.size === expected.size + 1 && byName.has("SHA256SUMS.txt"))) {
    fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
  }
  const sums = byName.get("SHA256SUMS.txt");
  if (sums !== undefined) {
    if (!isRecord(sums) || sums.state !== "uploaded" ||
        !Number.isSafeInteger(sums.size) || (sums.size as number) < 1 || (sums.size as number) > 1_000_000) {
      fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
    }
  }
  const assets = {} as Record<AgentReleaseTarget, SelectedAgentAsset>;
  const ids = new Set<number>();
  for (const target of AGENT_RELEASE_TARGETS) {
    const asset = selectedAsset(tag, target, byName.get(assetName(tag, target)));
    if (ids.has(asset.id)) fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
    ids.add(asset.id);
    assets[target] = asset;
  }
  return Object.freeze({
    repository: AGENT_RELEASE_REPOSITORY,
    id: payload.id as number,
    tag,
    immutable: true as const,
    assets: Object.freeze(assets),
  });
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/**
 * Resolve the repository's current stable Release exactly once.
 * HTTP 404/403/429 and any unusable body fail closed. No second request.
 */
export async function selectLatestAgentRelease(
  options: { fetch?: typeof fetch } = {},
): Promise<SelectedAgentRelease> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(LATEST_AGENT_RELEASE_URL, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "mcp-workers-remote-control-agent-installer",
        "x-github-api-version": "2026-03-10",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("unavailable", "Agent Release lookup failed.");
  }
  const retryAfter = retryAfterValue(response.headers.get("retry-after"));
  if (response.status === 301 || response.status === 302 || response.status === 303 ||
      response.status === 307 || response.status === 308) {
    await cancel(response);
    fail("rejected", "Agent Release metadata redirected.");
  }
  if (response.status === 404) {
    await cancel(response);
    fail("not_found", "No stable Agent Release is published.");
  }
  if (response.status === 403) {
    await cancel(response);
    fail("forbidden", "GitHub refused the Agent Release lookup." +
      (retryAfter ? "\nRetry-After: " + retryAfter : ""));
  }
  if (response.status === 429) {
    await cancel(response);
    fail("rate_limited", "GitHub rate limit blocked the Agent Release lookup." +
      (retryAfter ? "\nRetry-After: " + retryAfter : ""), retryAfter);
  }
  if (response.status !== 200) {
    await cancel(response);
    fail("unavailable", "Agent Release lookup failed.");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_METADATA)) {
    await cancel(response);
    fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
  }
  const text = await response.text();
  if (text.length > MAX_METADATA) {
    fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    fail("rejected", "Agent Release is not a stable five-platform immutable Release.");
  }
  return selectAgentReleaseSnapshot(payload);
}
