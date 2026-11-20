import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { assertRootOptIn, assertRootUserManager, parseInstallArgs } from "../scripts/install-v2.mjs";

const privateStat = () => ({
  isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o40700,
});
const root = {
  uid: 0, allowRoot: true, home: "/root", accountHome: "/root",
  env: { HOME: "/root" }, stdin: { isTTY: true }, stdout: { isTTY: true },
  inspect: privateStat,
};

test("root opt-in is explicit, unique, and cannot silently apply to ordinary users", () => {
  const opts = parseInstallArgs(["--endpoint", "https://rc.example.org/", "--allow-root"]);
  assert.equal(opts.allowRoot, true);
  assert.throws(() => parseInstallArgs([
    "--endpoint", "https://rc.example.org/", "--allow-root", "--allow-root",
  ]), /Duplicate root option/);
  assert.equal(assertRootOptIn({ ...root, uid: 1001, allowRoot: false }), false);
  assert.throws(() => assertRootOptIn({ ...root, uid: 1001 }), /only valid under UID 0/);
  assert.throws(() => assertRootOptIn({ ...root, allowRoot: false }), /--allow-root/);
  assert.equal(assertRootOptIn(root), true);
});

test("root opt-in rejects non-TTY and inherited or unsafe identities", () => {
  for (const overrides of [
    { stdin: { isTTY: false } },
    { stdout: { isTTY: false } },
    { env: { HOME: "/home/runner" } },
    { home: "/home/runner" },
    { env: { HOME: "/root", XDG_RUNTIME_DIR: "/run/user/1001" } },
    { env: { HOME: "/root", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus" } },
    { inspect: () => ({ ...privateStat(), isSymbolicLink: () => true }) },
    { inspect: () => ({ ...privateStat(), uid: 1001 }) },
    { inspect: () => ({ ...privateStat(), mode: 0o40777 }) },
    { inspect: current => current === "/" ? { ...privateStat(), mode: 0o40777 } : privateStat() },
  ]) assert.throws(() => assertRootOptIn({ ...root, ...overrides }));
});

test("permanent root service requires private UID0 runtime and verified linger", () => {
  const ready = {
    uid: 0, foreground: false, env: { XDG_RUNTIME_DIR: "/run/user/0" },
    inspect: privateStat, invoke: () => ({ status: 0, stdout: "yes\n" }),
  };
  assert.doesNotThrow(() => assertRootUserManager(ready));
  assert.doesNotThrow(() => assertRootUserManager({ ...ready, foreground: true,
    env: {}, invoke: () => { throw Error("foreground must not inspect linger"); } }));
  assert.throws(() => assertRootUserManager({ ...ready, env: {} }), /XDG_RUNTIME_DIR/);
  assert.throws(() => assertRootUserManager({ ...ready, inspect: () => ({
    ...privateStat(), uid: 1001,
  }) }), /not private/);
  assert.throws(() => assertRootUserManager({ ...ready, invoke: () => ({
    status: 0, stdout: "no\n",
  }) }), /linger is unavailable/);
  assert.throws(() => assertRootUserManager({ ...ready, invoke: () => ({
    status: 1, stdout: "",
  }) }), /linger is unavailable/);
});

test("non-root CLI refuses --allow-root before creating an installer lock", () => {
  const installer = fileURLToPath(new URL("../scripts/install-v2.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [installer, "--allow-root", "--uninstall"],
    { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Agent operation failed/);
});

test("Python bootstrap root preflight enforces flag, TTY and OS account HOME", () => {
  const bootstrap = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    "../scripts/bootstrap-v2.py");
  const source = String.raw`import importlib.util, os, sys, types, unittest.mock as mock
spec = importlib.util.spec_from_file_location("bootstrap", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tty = types.SimpleNamespace(isatty=lambda: True)
with mock.patch.object(mod.os, "getuid", return_value=0), \
     mock.patch.object(mod.sys, "stdin", tty), mock.patch.object(mod.sys, "stdout", tty), \
     mock.patch.dict(os.environ, {"HOME": mod.pwd.getpwuid(0).pw_dir}, clear=True):
    mod.root_opt_in(True)
    for flag, stage in [(False, False), (True, True)]:
        try: mod.root_opt_in(flag, stage)
        except ValueError: pass
        else: raise AssertionError("root gate bypass")
    with mock.patch.dict(os.environ, {"HOME": "/home/runner"}):
        try: mod.root_opt_in(True)
        except ValueError: pass
        else: raise AssertionError("inherited HOME bypass")
    with mock.patch.dict(os.environ, {"DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1001/bus"}):
        try: mod.root_opt_in(True)
        except ValueError: pass
        else: raise AssertionError("inherited session bus bypass")
print("PY_BOOTSTRAP_ROOT_GATE_OK")
`;
  const result = spawnSync("python3", ["-B", "-c", source, bootstrap],
    { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PY_BOOTSTRAP_ROOT_GATE_OK/);
});
