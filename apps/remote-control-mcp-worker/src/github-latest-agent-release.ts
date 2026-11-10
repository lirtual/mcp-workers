/**
 * One latest stable Agent Release from lirtual/mcp-workers.
 * Linux /install.sh, macOS /install-macos.sh, and Windows install.ps1 all use
 * this acceptance rule. None fall back to another repository or tag.
 *
 * A stable tag has no prerelease suffix. Drafts and non-immutable releases
 * are rejected. All five platform assets are required. Extra non-platform
 * assets may exist and do not replace a platform asset. html_url, when
 * present, must be this repository. 404, 403, and 429 fail closed.
 * The Worker only selects the Release. Device takeover stays in the agent package.
 * Windows install.ps1 still applies its own 100 KiB–100 MiB download bound.
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

const TARGET_ARCH = {
  "linux-x64-glibc": "x64",
  "linux-arm64-glibc": "arm64",
  "windows-x64": "x64",
  "darwin-arm64": "arm64",
  "darwin-x64": "x64",
} as const satisfies Record<AgentReleaseTarget, "x64" | "arm64">;

const RELEASE_MIN_ASSET_BYTES = 1;
const RELEASE_MAX_ASSET_BYTES = 180_000_000;

const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
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
): { ok: true; tag: string; assets: Record<AgentReleaseTarget, SelectedAgentAsset> } | { ok: false; code: ParseFailure } {
  if (!isRecord(body)) return { ok: false, code: "untrusted" };
  const tag = body.tag_name;
  if (typeof tag !== "string" || !TAG.test(tag) ||
      body.draft !== false || body.prerelease !== false || body.immutable !== true ||
      (body.html_url !== undefined && body.html_url !== releaseHtmlUrl(tag))) {
    return { ok: false, code: "untrusted" };
  }
  if (!Array.isArray(body.assets)) return { ok: false, code: "incomplete" };
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
  const parsed = parseRelease(lookup.body, { min: RELEASE_MIN_ASSET_BYTES, max: RELEASE_MAX_ASSET_BYTES });
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

/** One latest Release decision for Linux, macOS, and the Windows installer rule. */
export function selectLatestAgentRelease(lookup: ReleaseLookup): LatestReleaseDecision {
  return decideLatest(lookup);
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
