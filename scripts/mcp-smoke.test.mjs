import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "mcp-smoke.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 5_000,
  });
}

test("help documents explicit safe tool selection and environment-only token", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--tool <name>/);
  assert.match(result.stdout, /--token-env <name>/);
  assert.match(result.stdout, /never chooses tools from readOnlyHint/);
});

test("pnpm-style argument separator is accepted", () => {
  const result = run(["--", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("raw token command-line option is rejected", () => {
  const result = run(["--token", "secret"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option: --token/);
  assert.doesNotMatch(result.stdout + result.stderr, /secret/);
});

test("missing token environment variable fails before network access", () => {
  const envName = "MCP_SMOKE_TEST_TOKEN_MISSING";
  const result = run([
    "--url",
    "https://example.invalid/mcp",
    "--tool",
    "safe_read_tool",
    "--token-env",
    envName,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(envName));
});

test("tool arguments must be a JSON object", () => {
  const result = run([
    "--url",
    "https://example.invalid/mcp",
    "--tool",
    "safe_read_tool",
    "--args-json",
    "[]",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must decode to a JSON object/);
});
