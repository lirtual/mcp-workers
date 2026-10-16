import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = [
  path.join(root, "scripts/remote-control-v2-receipt-lab-accept.mjs"),
  path.join(root, "apps/remote-control-agent/scripts/v2-receipt-lab-foreground.mjs"),
];

test("isolated Receipt Lab helper scripts pass Node 24 syntax check", () => {
  for (const file of scripts) {
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
test("lab foreground script remains user-scoped, short-lived and never touches production", () => {
  const code = readFileSync(scripts[1], "utf8");
  assert.match(code, /writeFile: true/);
  assert.match(code, /shell: true/);
  assert.match(code, /MAX_RUNTIME_MS = 12 \* 60_000/);
  assert.match(code, /LAB_DISTRO = "rc-v2-receipt-lab"/);
  assert.match(code, /LAB_USER = "rcagent"/);
  assert.match(code, /LAB_ENDPOINT = "https:\/\/remote-control-v2-receipt-lab\.aiyaya\.workers\.dev\/"/);
  assert.doesNotMatch(code, /remote-control-v2-preview\.aiyaya\.workers\.dev/);
});
test("acceptance runner is scoped to single lab and rejects blind mutation replay", () => {
  const code = readFileSync(scripts[0], "utf8");
  assert.match(code, /"probe", "receipt"/);
  assert.match(code, /LAB_DEVICE_ID/);
  assert.match(code, /readFileSync\(secretPath/);
  assert.match(code, /do not retry|no retry|no write retry/i);
  assert.doesNotMatch(code, /remote-control-v2-preview\.aiyaya\.workers\.dev/);
});
