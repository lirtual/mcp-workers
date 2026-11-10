/** One public latest-stable Agent Release snapshot. Not a tag/commit pin table. */

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

export type SelectedAgentAsset = Readonly<{
  target: AgentReleaseTarget;
  name: string;
  size: number;
  sha256: string;
  downloadUrl: string;
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

const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PLATFORM_ASSET = /^remote-control-agent-v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?-(?:linux-x64-glibc|linux-arm64-glibc|windows-x64|darwin-arm64|darwin-x64)\.(?:tar\.gz|zip)$/;
const MAX_ASSET_BYTES = 180_000_000;

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

/**
 * Select the five native assets from one GitHub latest response.
 * A non-stable, mutable, partial, foreign, or old-repository payload does not resolve.
 */
export function selectLatestAgentRelease(lookup: {
  status: number;
  body?: unknown;
  retryAfter?: string | null;
}): LatestReleaseDecision {
  if (lookup.status === 404) return stop("not_found");
  if (lookup.status === 403) return stop("forbidden", lookup.retryAfter);
  if (lookup.status === 429) return stop("rate_limited", lookup.retryAfter);
  if (lookup.status !== 200 || !isRecord(lookup.body)) return stop("rejected");
  const body = lookup.body;
  const tag = body.tag_name;
  if (typeof tag !== "string" || !TAG.test(tag) ||
      body.draft !== false || body.prerelease !== false || body.immutable !== true ||
      body.html_url !== releaseHtmlUrl(tag) || !Array.isArray(body.assets)) {
    return stop("rejected");
  }
  const expected = new Map(AGENT_RELEASE_TARGETS.map(target => [agentAssetName(tag, target), target]));
  const selected = new Map<AgentReleaseTarget, SelectedAgentAsset>();
  for (const asset of body.assets) {
    if (!isRecord(asset) || typeof asset.name !== "string") return stop("rejected");
    const target = expected.get(asset.name);
    if (!target) {
      if (PLATFORM_ASSET.test(asset.name)) return stop("rejected");
      continue;
    }
    if (selected.has(target)) return stop("rejected");
    const downloadUrl = assetDownloadUrl(tag, asset.name);
    if (asset.state !== "uploaded" ||
        typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) ||
        asset.size < 1 || asset.size > MAX_ASSET_BYTES ||
        typeof asset.digest !== "string" || !asset.digest.startsWith("sha256:") ||
        !SHA256.test(asset.digest.slice("sha256:".length)) ||
        asset.browser_download_url !== downloadUrl) {
      return stop("rejected");
    }
    selected.set(target, Object.freeze({
      target,
      name: asset.name,
      size: asset.size,
      sha256: asset.digest.slice("sha256:".length),
      downloadUrl,
    }));
  }
  if (selected.size !== AGENT_RELEASE_TARGETS.length) return stop("rejected");
  const assets = {} as Record<AgentReleaseTarget, SelectedAgentAsset>;
  for (const target of AGENT_RELEASE_TARGETS) {
    const asset = selected.get(target);
    if (!asset) return stop("rejected");
    assets[target] = asset;
  }
  return {
    ok: true,
    release: Object.freeze({
      repository: "lirtual/mcp-workers",
      tag,
      htmlUrl: releaseHtmlUrl(tag),
      immutable: true,
      assets: Object.freeze(assets),
    }),
  };
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
