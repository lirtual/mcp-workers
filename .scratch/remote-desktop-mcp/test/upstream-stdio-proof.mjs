// #173: real upstream Desktop Commander 0.2.51, local stdio ONLY.
// Intentional security boundary: this test does not export upstream tools
// through the HTTP/DO bridge and runs inside an ephemeral GitHub Actions runner.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, "../node_modules/@wonderwhy-er/desktop-commander/dist/index.js");
const root = await mkdtemp(join(tmpdir(), "desktop-commander-probe-"));
const directory = join(root, "allowed");
let child, buffered = "", nextId = 1;
const pending = new Map();
const timeoutMs = 45000;
const lineLimit = 1024 * 1024;

function request(method, params = {}) {
  const id = nextId++;
  if (!child || child.exitCode !== null) return Promise.reject(new Error("upstream_not_running"));
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`upstream_timeout:${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}

try {
  await (await import("node:fs/promises")).mkdir(directory);
  await writeFile(join(directory, "proof-only.txt"), "test fixture\n");
  child = spawn(process.execPath, [bin, "--no-onboarding"], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_DATA_HOME: root,
      CI: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // no upstream diagnostics or sensitive output in Actions logs
  child.on("error", (err) => {
    for (const [, item] of pending) { clearTimeout(item.timer); item.reject(err); }
    pending.clear();
  });
  child.on("exit", (code) => {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(`upstream_exit:${code}`));
    }
    pending.clear();
  });
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    if (buffered.length > lineLimit) {
      child.kill("SIGKILL");
      return;
    }
    let end;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!Object.hasOwn(msg, "id")) continue;
      const item = pending.get(msg.id);
      if (!item) continue;
      pending.delete(msg.id);
      clearTimeout(item.timer);
      if (msg.error) item.reject(new Error(`upstream_protocol_error:${msg.error.code}`));
      else item.resolve(msg.result);
    }
  });

  const hello = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "isolated-remote-desktop-probe", version: "0.0.0" },
  });
  assert.equal(typeof hello.serverInfo?.name, "string");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listed = await request("tools/list");
  assert.equal(Array.isArray(listed.tools), true);
  assert.ok(listed.tools.some((tool) => tool.name === "list_directory"),
    "upstream_list_directory_unavailable");

  const output = await request("tools/call", {
    name: "list_directory",
    arguments: { path: directory },
  });
  assert.notEqual(output.isError, true, "upstream_list_directory_reported_error");
  const text = output.content?.filter((part) => part.type === "text")
    .map((part) => part.text).join("\n") ?? "";
  assert.ok(text.includes("proof-only.txt"), "upstream_did_not_read_fixed_test_directory");
  console.log("PASS actual Desktop Commander 0.2.51 local stdio: initialize, tool discovery, fixed-fixture read");
} finally {
  for (const [, item] of pending) {
    clearTimeout(item.timer);
    item.reject(new Error("test_cleanup"));
  }
  pending.clear();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(root, { recursive: true, force: true });
}
