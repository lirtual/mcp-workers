import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeSecureInputProvider, parseAgentSecureInputTarget, prepareSecureInputProvider } from "../src/secure-input.ts";

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function writeShim(file, body) {
  await writeFile(file, "#!/bin/sh\nset -eu\n" + body, { mode: 0o700 });
}

test("GitHub and Cloudflare Provider adapters pass synthetic values only through child stdin", {
  skip: process.platform === "win32",
}, async () => {
  // Fake provider CLIs verify the Agent child-process boundary, not real provider behavior.
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-secure-provider-"));
  const bin = path.join(root, "bin");
  const oldPath = process.env.PATH;
  const oldTmp = process.env.TMPDIR;
  const marker = "synthetic-secure-input-DO-NOT-LOG-7fb2";
  const accountId = "0123456789abcdef0123456789abcdef";
  const capture = provider => ({
    args: path.join(root, provider + ".argv"),
    env: path.join(root, provider + ".env"),
    stdin: path.join(root, provider + ".stdin"),
  });
  const recordInvocation = paths =>
    `printf '%s\\n' "$*" > ${shellQuote(paths.args)}\nenv > ${shellQuote(paths.env)}\ncat > ${shellQuote(paths.stdin)}\n`;
  try {
    await mkdir(bin);
    const gh = capture("gh");
    await writeShim(path.join(bin, "gh"), `
if [ "$1" = api ] && [ "$2" = user ]; then
  printf '%s' '{"login":"fixture-owner"}'
elif [ "$1" = api ] && [ "$2" = repos/acme/secure-input-test ]; then
  printf '%s' '{"full_name":"acme/secure-input-test","permissions":{"admin":true}}'
elif [ "$1" = api ] && [ "$2" = repos/acme/secure-input-test/environments/integration ]; then
  printf '%s' '{"name":"integration"}'
else
  ${recordInvocation(gh)}
fi
`);
    const wrangler = capture("wrangler");
    await writeShim(path.join(bin, "wrangler"), `
[ "$1" = --config ]
[ "$2" = "$PWD/wrangler.json" ]
[ "$(cat "$2")" = '{"account_id":"${accountId}"}' ]
shift 2
if [ "$1" = whoami ]; then
  printf '%s' '{"user":{"email":"fixture@example.test"},"accounts":[{"id":"${accountId}","name":"Disposable test account"}]}'
elif [ "$1" = deployments ] && [ "$2" = list ]; then
  [ "$*" = 'deployments list --name secure-input-test-preview --json' ]
  printf '%s' '[{"id":"fixture-deployment"}]'
else
  ${recordInvocation(wrangler)}
fi
`);
    process.env.PATH = bin + path.delimiter + (oldPath ?? "");
    process.env.TMPDIR = root;

    const githubTarget = parseAgentSecureInputTarget({
      kind: "github_environment_secret", repository: "acme/secure-input-test",
      environment: "integration", name: "SYNTHETIC_INPUT_TEST",
    });
    assert.ok(githubTarget);
    const githubPrincipal = await prepareSecureInputProvider(githubTarget, new AbortController().signal);
    assert.equal(typeof githubPrincipal, "object");
    for (const ending of ["\r", "\n", "\r\n"]) {
      assert.deepEqual(await executeSecureInputProvider(githubTarget, githubPrincipal, marker + ending, new AbortController().signal), { status: "failed", error_code: "input_rejected" });
    }
    assert.ok(!(await readdir(root)).includes("gh.stdin"));
    const github = await executeSecureInputProvider(
      githubTarget, githubPrincipal, marker, new AbortController().signal,
    );
    assert.deepEqual(github, { status: "succeeded" });
    assert.equal(await readFile(gh.args, "utf8"), "secret set SYNTHETIC_INPUT_TEST --repo acme/secure-input-test --env integration\n");
    assert.equal(await readFile(gh.stdin, "utf8"), marker);
    assert.doesNotMatch(await readFile(gh.args, "utf8"), /synthetic-secure-input/);
    assert.doesNotMatch(await readFile(gh.env, "utf8"), /synthetic-secure-input/);

    const cloudflareTarget = parseAgentSecureInputTarget({
      kind: "cloudflare_worker_secret", account_id: accountId, worker_name: "secure-input-test",
      environment: "preview", mode: "version", name: "SYNTHETIC_INPUT_TEST",
    });
    assert.ok(cloudflareTarget);
    const cloudflarePrincipal = await prepareSecureInputProvider(cloudflareTarget, new AbortController().signal);
    assert.equal(typeof cloudflarePrincipal, "object");
    assert.deepEqual(await executeSecureInputProvider(cloudflareTarget, cloudflarePrincipal, marker + " ", new AbortController().signal), { status: "failed", error_code: "input_rejected" });
    const cloudflare = await executeSecureInputProvider(
      cloudflareTarget, cloudflarePrincipal, marker, new AbortController().signal,
    );
    assert.deepEqual(cloudflare, { status: "succeeded" });
    assert.equal(await readFile(wrangler.args, "utf8"), "versions secret put SYNTHETIC_INPUT_TEST --name secure-input-test-preview\n");
    assert.equal(await readFile(wrangler.stdin, "utf8"), marker);
    assert.doesNotMatch(await readFile(wrangler.args, "utf8"), /synthetic-secure-input/);
    assert.doesNotMatch(await readFile(wrangler.env, "utf8"), /synthetic-secure-input/);
    assert.ok(!(await readdir(root)).some(name => name.startsWith("rca-provider-")));
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
