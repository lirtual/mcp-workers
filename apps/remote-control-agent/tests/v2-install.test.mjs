import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MARKER, UNIT, parseInstallArgs, renderV2Service, trustedEndpoint } from "../scripts/install-v2.mjs";

const example = {
  node: "/opt/node24/bin/node",
  home: "/home/agent",
  repoRoot: "/home/agent/mcp-workers",
  endpoint: "https://rc.example.org/",
  keyPath: "/home/agent/.local/share/mcp-workers/remote-control/v2-identity.pem",
};

test("minimal Linux v2 CLI supports install, explicit paired-key resume, upgrade, and safe uninstall", () => {
  assert.deepEqual(parseInstallArgs(["--endpoint", "https://rc.example.org", "--name", "office"]), {
    action: "install", endpoint: "https://rc.example.org", name: "office",
  });
  assert.equal(parseInstallArgs(["--resume", "--endpoint", "https://rc.example.org"]).action, "resume");
  assert.equal(parseInstallArgs(["--upgrade", "--endpoint", "https://rc.example.org"]).action, "upgrade");
  assert.equal(parseInstallArgs(["--uninstall"]).action, "uninstall");
  for (const args of [
    [], ["--upgrade"], ["--uninstall", "--name", "x"], ["--uninstall", "--endpoint", "https://host.test"],
    ["--upgrade", "--uninstall", "--endpoint", "https://host.test"], ["--unknown"],
    ["--endpoint", "https://host.test", "--name", "malicious\nhost"],
  ]) {
    assert.throws(() => parseInstallArgs(args));
  }
});

test("installer accepts only a clean trusted HTTPS origin without credentials", () => {
  assert.equal(trustedEndpoint("https://v2.example.org/"), "https://v2.example.org/");
  assert.equal(trustedEndpoint("https://v2.example.org:8443"), "https://v2.example.org:8443/");
  for (const endpoint of [
    "http://v2.example.org/", "https://user:password@v2.example.org/",
    "https://v2.example.org/x", "https://v2.example.org/?secret=abc",
    "https://v2.example.org/#frag", "https://[::1]/", "file:///etc/passwd",
  ]) assert.throws(() => trustedEndpoint(endpoint));
});

test("separate v2 systemd unit never references v1 credentials, tunnel or write/Shell authorization", () => {
  assert.equal(UNIT, "remote-control-v2-agent.service");
  const unit = renderV2Service(example);
  assert.ok(unit.startsWith(MARKER));
  assert.match(unit, /ExecStart=\/opt\/node24\/bin\/node --experimental-strip-types \/home\/agent\/mcp-workers\/apps\/remote-control-agent\/src\/v2-main\.ts/);
  assert.match(unit, /Environment=REMOTE_CONTROL_V2_ENDPOINT=https:\/\/rc\.example\.org\//);
  assert.match(unit, /ExecStartPre=\/usr\/bin\/test -r .*v2-identity\.pem\.device-id/);
  assert.match(unit, /ExecStartPre=\/usr\/bin\/test -x .*session-supervisor/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /UMask=0077/);
  assert.ok(!unit.includes("remote-control-agent.service\n"));
  assert.ok(!unit.includes("REMOTE_CONTROL_DEVICE_TOKEN"));
  assert.ok(!unit.includes("MCP_ACCESS_TOKEN"));
  assert.ok(!unit.includes("cloudflared"));
  assert.ok(!unit.includes("writeFile"));
  assert.ok(!unit.includes("shell=true"));
  for (const unsafe of [
    { ...example, repoRoot: "/opt/with space" }, { ...example, node: "/usr/bin/node\nExecStart=/bin/sh" },
    { ...example, repoRoot: "/tmp/%h" }, { ...example, keyPath: "/tmp/a\\b" },
    { ...example, endpoint: "https://user:pass@rc.example.org" },
  ]) assert.throws(() => renderV2Service(unsafe));
});

test("v2 startup opts into read-only but explicitly keeps file write/Shell off", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const entry = await readFile(path.join(testDir, "..", "src", "v2-main.ts"), "utf8");
  assert.match(entry, /maintainAuthenticatedDeviceSession/);
  assert.match(entry, /readOnly: true/);
  assert.match(entry, /writeFile: false/);
  assert.match(entry, /shell: false/);
  assert.ok(!entry.includes("REMOTE_CONTROL_DEVICE_TOKEN"));
  assert.ok(!entry.includes("MCP_ACCESS_TOKEN"));
});
