import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import worker from "../src/worker.ts";

const origin = "https://rca.lirtual.dpdns.org";
const latestUrl = "https://api.github.com/repos/lirtual/mcp-workers/releases/latest";
const tag = "v1.4.0";
const digests = {
  "linux-x64-glibc": "11".repeat(32),
  "linux-arm64-glibc": "22".repeat(32),
  "windows-x64": "33".repeat(32),
  "darwin-arm64": "44".repeat(32),
  "darwin-x64": "55".repeat(32),
} as const;
const sizes = {
  "linux-x64-glibc": 1111,
  "linux-arm64-glibc": 2222,
  "windows-x64": 3333,
  "darwin-arm64": 4444,
  "darwin-x64": 5555,
} as const;
const targets = [
  ["linux-x64-glibc", ".tar.gz"],
  ["linux-arm64-glibc", ".tar.gz"],
  ["windows-x64", ".zip"],
  ["darwin-arm64", ".tar.gz"],
  ["darwin-x64", ".tar.gz"],
] as const;

function asset(target: typeof targets[number][0], ext: string, id: number, releaseTag = tag) {
  const name = "remote-control-agent-" + releaseTag + "-" + target + ext;
  return {
    id, name, state: "uploaded",
    size: sizes[target],
    digest: "sha256:" + digests[target],
    browser_download_url: "https://github.com/lirtual/mcp-workers/releases/download/" + releaseTag + "/" + name,
  };
}

function releaseBody(patch: Record<string, unknown> = {}, releaseTag = tag) {
  return {
    id: 900, tag_name: releaseTag, draft: false, prerelease: false, immutable: true,
    assets: targets.map(([target, ext], index) => asset(target, ext, 11 + index, releaseTag)),
    ...patch,
  };
}

function envFor(fetchImpl: typeof fetch): Env {
  return {
    MCP_ACCESS_TOKEN: "owner-only",
    REMOTE_CONTROL_INSTALL_ORIGIN: origin,
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({}) },
    AGENT_RELEASE_FETCH: fetchImpl,
  } as unknown as Env;
}

async function serve(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length > 1) throw new Error("latest lookup retried");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  const response = await worker.fetch(new Request(origin + "/install.sh"), envFor(fetchImpl));
  return { response, text: await response.text(), calls };
}

test("Linux install.sh resolves one stable five-asset Release and no old repository", async () => {
  const seen = await serve(200, releaseBody());
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.calls[0]?.url, latestUrl);
  assert.equal(seen.calls[0]?.init?.method, "GET");
  assert.equal(seen.calls[0]?.init?.redirect, "manual");
  assert.equal(seen.response.status, 200);
  assert.match(seen.response.headers.get("content-type") ?? "", /text\/x-shellscript/);
  assert.match(seen.response.headers.get("cache-control") ?? "", /no-store/);
  const shell = seen.text;
  assert.match(shell, /^#!\/bin\/sh\n/);
  assert.match(shell, /tag='v1\.4\.0'/);
  assert.match(shell, /x64_url='https:\/\/github\.com\/lirtual\/mcp-workers\/releases\/download\/v1\.4\.0\/remote-control-agent-v1\.4\.0-linux-x64-glibc\.tar\.gz'/);
  assert.match(shell, /arm64_url='https:\/\/github\.com\/lirtual\/mcp-workers\/releases\/download\/v1\.4\.0\/remote-control-agent-v1\.4\.0-linux-arm64-glibc\.tar\.gz'/);
  assert.match(shell, new RegExp("x64_sha256='" + digests["linux-x64-glibc"] + "'"));
  assert.match(shell, new RegExp("arm64_sha256='" + digests["linux-arm64-glibc"] + "'"));
  assert.match(shell, /x64_size='1111'/);
  assert.match(shell, /arm64_size='2222'/);
  assert.match(shell, /--endpoint "https:\/\/rca\.lirtual\.dpdns\.org\/"/);
  assert.match(shell, /1\) \[ "\$1" = "--upgrade"/);
  assert.doesNotMatch(shell, /--commit /);
  assert.doesNotMatch(shell, /lirtual\/remote-control-agent/);
  assert.doesNotMatch(shell, /windows-x64|darwin-/);
  assert.doesNotMatch(shell, /v0\.1\.51|03a14fd/);
  const sizeCheck = shell.indexOf('wc -c < "$archive"');
  const digestCheck = shell.indexOf("sha256sum -c -");
  const unpack = shell.indexOf('tar -xOzf "$archive" bin/node');
  const bootstrap = shell.indexOf("bootstrap-node.mjs >");
  const launch = shell.indexOf('"$stage/node" "$stage/bootstrap-node.mjs"');
  assert.ok(shell.indexOf("effective=$(curl") < shell.indexOf('case "$effective" in'));
  assert.ok(shell.indexOf('case "$effective" in') < sizeCheck);
  assert.ok(sizeCheck < digestCheck && digestCheck < unpack && unpack < bootstrap && bootstrap < launch);
  assert.match(shell, /https:\/\/release-assets\.githubusercontent\.com\/\*/);
  assert.match(shell, /https:\/\/objects\.githubusercontent\.com\/\*/);
  assert.match(shell, /Unexpected GitHub Release asset redirect/);
  assert.doesNotMatch(shell, /tar -xzf/);
  assert.equal(spawnSync("sh", ["-n"], { input: shell, encoding: "utf8", timeout: 3000 }).status, 0);
  assert.ok(Buffer.byteLength(shell) < 16384);
});

test("a second latest response cannot mix into the same Linux install", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls += 1;
    assert.equal(String(url), latestUrl);
    assert.equal(init?.redirect, "manual");
    const body = calls === 1 ? releaseBody() : releaseBody({}, "v9.9.9");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const response = await worker.fetch(new Request(origin + "/install.sh"), envFor(fetchImpl));
  const shell = await response.text();
  assert.equal(calls, 1);
  assert.match(shell, /tag='v1\.4\.0'/);
  assert.doesNotMatch(shell, /v9\.9\.9/);
});

test("Linux install.sh fails closed when GitHub has no stable latest release", async () => {
  const seen = await serve(404, { message: "Not Found" });
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.response.status, 503);
  assert.match(seen.text, /No stable Agent Release is published/);
  assert.doesNotMatch(seen.text, /^#!\/bin\/sh/);
  assert.doesNotMatch(seen.text, /lirtual\/remote-control-agent|curl /);
});

test("GitHub 403 and 429 stop Linux install without a retry or a script", async () => {
  const forbidden = await serve(403, { message: "forbidden" }, { "retry-after": "12" });
  assert.equal(forbidden.calls.length, 1);
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.response.headers.get("retry-after"), "12");
  assert.match(forbidden.text, /GitHub refused the Agent Release lookup/);
  assert.doesNotMatch(forbidden.text, /Retry-After:/);
  assert.doesNotMatch(forbidden.text, /^#!/);

  const limited = await serve(429, { message: "slow down" }, { "retry-after": "30" });
  assert.equal(limited.calls.length, 1);
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "30");
  assert.match(limited.text, /GitHub rate limit blocked the Agent Release lookup/);
  assert.doesNotMatch(limited.text, /Retry-After:/);
  assert.doesNotMatch(limited.text, /^#!/);

  const prose = await serve(429, { message: "slow down" }, { "retry-after": "30 seconds" });
  assert.equal(prose.response.status, 429);
  assert.equal(prose.response.headers.get("retry-after"), null);
  assert.doesNotMatch(prose.text, /30 seconds/);
});

test("redirected, wrong, draft, prerelease and incomplete latest releases are not installed", async () => {
  const redirected = await serve(302, "", { location: "https://evil.example/releases/latest" });
  assert.equal(redirected.calls.length, 1);
  assert.equal(redirected.calls[0]?.init?.redirect, "manual");
  assert.equal(redirected.response.status, 503);
  assert.match(redirected.text, /not a stable five-platform immutable Release/);
  assert.doesNotMatch(redirected.text, /evil\.example/);
  assert.doesNotMatch(redirected.text, /^#!/);

  const broken = releaseBody();
  const cases: Array<[string, unknown]> = [
    ["wrong product", { ...broken, assets: [{ id: 1, name: "browser-extension-v1.4.0.zip", state: "uploaded", size: 2000, digest: "sha256:" + "ab".repeat(32), browser_download_url: "https://github.com/lirtual/mcp-workers/releases/download/v1.4.0/browser-extension-v1.4.0.zip" }] }],
    ["draft", releaseBody({ draft: true })],
    ["prerelease", releaseBody({ prerelease: true })],
    ["mutable", releaseBody({ immutable: false })],
    ["missing immutable", (() => { const body = releaseBody(); delete (body as { immutable?: boolean }).immutable; return body; })()],
    ["prerelease tag", releaseBody({}, "v1.4.0-rc.1")],
    ["incomplete", releaseBody({ assets: releaseBody().assets.slice(0, 4) })],
    ["duplicate", (() => {
      const assets = releaseBody().assets;
      const repeated = assets[0];
      if (!repeated) throw new Error("missing fixture asset");
      return releaseBody({ assets: assets.concat([repeated]) });
    })()],
    ["bad digest", releaseBody({ assets: releaseBody().assets.map((item, index) => index === 0 ? { ...item, digest: "sha256:abcd" } : item) })],
    ["bad size", releaseBody({ assets: releaseBody().assets.map((item, index) => index === 0 ? { ...item, size: 12 } : item) })],
    ["mixed tag", releaseBody({ assets: releaseBody().assets.map((item, index) => index === 0 ? { ...item, name: item.name.replace("v1.4.0", "v0.9.0"), browser_download_url: item.browser_download_url.replaceAll("v1.4.0", "v0.9.0") } : item) })],
    ["old repository url", releaseBody({ assets: releaseBody().assets.map((item, index) => index === 0 ? { ...item, browser_download_url: item.browser_download_url.replace("lirtual/mcp-workers", "lirtual/remote-control-agent") } : item) })],
  ];
  for (const [name, body] of cases) {
    const seen = await serve(200, body);
    assert.equal(seen.response.status, 503, name);
    assert.equal(seen.calls.length, 1, name);
    assert.match(seen.text, /not a stable five-platform immutable Release/, name);
    assert.doesNotMatch(seen.text, /^#!\/bin\/sh/, name);
    assert.doesNotMatch(seen.text, /lirtual\/remote-control-agent/, name);
  }
});

test("the install home and a rejected host do not look up latest", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new Error("latest must not be queried");
  };
  const env = envFor(fetchImpl);
  const home = await worker.fetch(new Request(origin + "/"), env);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /curl -fsSL https:\/\/rca\.lirtual\.dpdns\.org\/install\.sh \| sh/);
  const rejected = await worker.fetch(new Request("https://unauthorized.test/install.sh"), env);
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);
});
