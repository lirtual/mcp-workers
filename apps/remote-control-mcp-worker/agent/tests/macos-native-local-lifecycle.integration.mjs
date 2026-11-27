// Two unpublished native-only packages, synthetic STOP state, real launchctl.
// No pairing, network activation or real crash is claimed.
import assert from "node:assert/strict";
import {createHash, generateKeyPairSync, randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const baseline = process.env.RCA_MACOS_NATIVE_BASELINE_ARCHIVE;
const candidate = process.env.RCA_MACOS_NATIVE_CANDIDATE_ROOT;
const candidateArchive = process.env.RCA_MACOS_NATIVE_CANDIDATE_ARCHIVE;
if (process.platform !== "darwin" || !baseline || !candidate || !candidateArchive)
  throw Error("Requires two native-only packages on a disposable macOS runner.");
const label = "org.mcp-workers.remote-control-agent";
const endpoint = "https://127.0.0.1/";
const entry = "apps/remote-control-agent/.build/rca-standard-darwin-candidate";
const run = (file, args, options = {}) =>
  spawnSync(file, args, {encoding: "utf8", timeout: 15000, ...options});
const ok = r => {
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
};
const absent = () => {
  const r = run("/bin/launchctl", ["print", "gui/" + process.getuid() + "/" + label]);
  assert.equal(r.status, 113);
  assert.match(r.stderr, /Could not find service/);
};
// Exact existing installed-config format; fixture only, not a manager.
function plist(exe, gen) {
  assert.doesNotMatch(exe, /[&<>"']/);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n<key>Label</key><string>' + label + '</string>\n' +
    '<key>ProgramArguments</key><array>' +
    [exe, "--service", "--endpoint", endpoint, "--generation", gen].map(x=>"<string>"+x+"</string>").join("") +
    '</array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n';
}
function launcher(exe) {
  assert.doesNotMatch(exe, /['\n]/);
  return '#!/bin/sh\nset -eu\ncase "' + '$' + '{1:-}" in\n' +
    'status|doctor) [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && [ "$2" = --json ]; } || exit 2 ;;\n' +
    '"") [ "$#" -eq 0 ] || exit 2 ;;\n' +
    'logs|stop|start|restart|pair|recover|uninstall|--help|--version|version) [ "$#" -eq 1 ] || exit 2 ;;\n' +
    'update|upgrade) [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && { [ "$2" = --auto ] || [ "$2" = --check ]; }; } || { [ "$#" -eq 3 ] && [ "$2" = --auto ] && { [ "$3" = on ] || [ "$3" = off ]; }; } || exit 2 ;;\n' +
    'secure-input) [ "$#" -eq 2 ] || exit 2; case "$2" in ????????-????-????-????-????????????) ;; *) exit 2 ;; esac; case "$2" in *[!0-9a-f-]*) exit 2 ;; esac ;;\n' +
    "*) echo 'Use the reviewed installer for installation or upgrade.' >&2; exit 2 ;;\n" +
    "esac\nexec '" + exe + "' \"$@\"\n";
}
// Test-only terminal on a disposable, unenrolled fixture.
const pty = [
  "import errno, os, pty, select, subprocess, sys, time",
  "master, slave = pty.openpty()",
  "child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)",
  "out = b''; sent = False; deadline = time.monotonic() + 10",
  "try:",
  "    while time.monotonic() < deadline:",
  "        if select.select([master], [], [], 0.1)[0]:",
  "            try: chunk = os.read(master, 4096)",
  "            except OSError as e:",
  "                if e.errno != errno.EIO: raise",
  "                break",
  "            if not chunk: break",
  "            out += chunk",
  "        if not sent and b'Confirm [y/N]:' in out and child.poll() is None:",
  "            os.write(master, (sys.argv[1] + '\\n').encode()); sent = True",
  "        if child.poll() is not None:",
  "            if not select.select([master], [], [], 0)[0]: break",
  "    code = child.wait(timeout=max(0.1, deadline - time.monotonic()))",
  "    sys.exit(code)",
  "finally:",
  "    if child.poll() is None:",
  "        child.kill()",
  "        child.wait(timeout=5)",
  "    sys.stdout.buffer.write(out)",
  "    os.close(master)",
  "    os.close(slave)",
].join("\n");

test("native-only STOP upgrade and interrupted-switch recovery", async t => {
  absent();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rca-native-local-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = path.join(root, "home");
  const base = path.join(home, ".local/share/mcp-workers/remote-control");
  const mac = path.join(base, "macos");
  const programs = path.join(mac, "programs");
  const agents = path.join(home, "Library/LaunchAgents");
  const bin = path.join(home, ".local/bin");
  const state = path.join(home, ".local/state/mcp-workers/remote-control-agent");
  for (const dir of [programs, agents, bin, state]) await mkdir(dir, {recursive:true, mode:0o700});
  const meta = JSON.parse(await readFile(path.join(candidate,"bundle.json"),"utf8"));
  assert.equal(meta.artifact_profile, "rust-native-only-v1");
  const oldVersion = "v0.1.59";
  const oldRoot = path.join(programs, oldVersion + "-" + meta.target);
  const nextRoot = path.join(programs, meta.version + "-" + meta.target);
  await mkdir(oldRoot,{mode:0o700});
  ok(run("/usr/bin/tar",["-xzf",baseline,"-C",oldRoot]));
  const oldExe = path.join(oldRoot,entry), nextExe = path.join(nextRoot,entry);
  const exe = path.join(candidate,entry);
  const local = (file,args) => run(file,args,{env:{...process.env,HOME:home}});
  const owner = (answer,file,args) => local("python3",["-c",pty,answer,file,...args]);
  assert.equal(ok(local(oldExe,["--verify-bundle",oldVersion,meta.target])).trim(),meta.source_commit);
  assert.equal(ok(local(exe,["--verify-bundle",meta.version,meta.target])).trim(),meta.source_commit);
  const keyPath = path.join(base,"v2-identity.pem");
  const key = generateKeyPairSync("ed25519").privateKey.export({format:"pem",type:"pkcs8"});
  const device = randomUUID()+"\n";
  const marker = path.join(mac,"stopped"), config = path.join(agents,label+".plist");
  const cli = path.join(bin,"rca"), journal = path.join(mac,"switch.json");
  const previous = plist(oldExe,randomUUID()), oldCli = launcher(oldExe);
  for (const [p,v] of [[keyPath,key],[keyPath+".device-id",device],[marker,"stopped\n"],
    [path.join(mac,"endpoint"),endpoint+"\n"],[config,previous]]) await writeFile(p,v,{mode:0o600});
  await writeFile(cli,oldCli,{mode:0o700});
  const receipts=path.join(state,"operation-receipts.sqlite");
  await writeFile(receipts,"",{mode:0o600});
  const db=new DatabaseSync(receipts);
  try {
    db.exec("CREATE TABLE receipts (operation_id TEXT PRIMARY KEY NOT NULL,tool_name TEXT NOT NULL,argument_digest TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,safe_result_summary TEXT,session_id TEXT,guarded INTEGER NOT NULL CHECK(guarded IN (0,1))); PRAGMA user_version=1;");
    db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?,?,NULL,1)").run(randomUUID(),"write_file","a".repeat(64),"unknown","2026-11-22T00:00:00Z","2026-11-22T00:00:00Z","Historical Unknown");
  } finally {db.close();}
  const before=await readFile(receipts);
  const preserved=async()=>{
    absent();
    assert.equal(await readFile(keyPath,"utf8"),key.toString());
    assert.equal(await readFile(keyPath+".device-id","utf8"),device);
    assert.equal(await readFile(marker,"utf8"),"stopped\n");
    assert.deepEqual(await readFile(receipts),before);
  };
  const noJournal=()=>assert.rejects(readFile(journal),{code:"ENOENT"});
  // Reproduce the existing Node management binding, including key/id SHA-256,
  // JSON property order and the original intentional STOP marker. The Rust
  // manager must reject any change to this exact installation after admission.
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const binding = digest(JSON.stringify({
    plist:previous, cli:oldCli, endpoint, stop:"stopped\n",
    keyHash:digest(key), idHash:digest(device),
  }));
  const args=["--upgrade-local",endpoint,meta.version,meta.source_commit,binding];
  const refusedBinding=owner("y",exe,["--upgrade-local",endpoint,meta.version,meta.source_commit,"0".repeat(64)]);
  assert.equal(refusedBinding.status,1,refusedBinding.stdout+refusedBinding.stderr);
  assert.doesNotMatch(refusedBinding.stdout,/Confirm \[y\/N\]/);
  await noJournal();
  const refused=owner("n",exe,args);
  assert.equal(refused.status,1,refused.stdout+refused.stderr);
  assert.match(refused.stdout,/Confirm \[y\/N\]/,refused.stdout+refused.stderr);
  assert.equal(await readFile(config,"utf8"),previous);
  assert.equal(await readFile(cli,"utf8"),oldCli);
  await noJournal();
  await assert.rejects(readFile(path.join(nextRoot,"bundle.json")),{code:"ENOENT"});
  await preserved();
  // Exercise the exact packaged shell, archive checksum and Rust manager on
  // the disposable macOS runner. A corrupted archive must be refused before
  // any state change or owner prompt.
  const bytes=await readFile(candidateArchive);
  const updater=path.join(candidate,"apps/remote-control-agent/scripts/macos-update.sh");
  const shellArgs=[updater,candidateArchive,digest(bytes),String(bytes.length),
    meta.version,meta.target,endpoint,binding];
  const corrupt=owner("y","/bin/sh",[
    updater,candidateArchive,"0".repeat(64),String(bytes.length),
    meta.version,meta.target,endpoint,binding,
  ]);
  assert.equal(corrupt.status,1,corrupt.stdout+corrupt.stderr);
  assert.doesNotMatch(corrupt.stdout,/Confirm \[y\/N\]/);
  assert.equal(await readFile(config,"utf8"),previous);
  await noJournal();
  const upgraded=ok(owner("y","/bin/sh",shellArgs));
  assert.match(upgraded,/Confirm \[y\/N\]/);
  assert.match(upgraded,/"status":"stopped_preserved"/);
  const installed=await readFile(config,"utf8");
  const generation=installed.match(/<string>([0-9a-f-]{36})<\/string><\/array>/)?.[1];
  assert.ok(generation);
  assert.equal(installed,plist(nextExe,generation));
  assert.notEqual(installed,previous);
  assert.equal(await readFile(cli,"utf8"),launcher(nextExe));
  assert.equal(ok(local(cli,["--version"])).trim(),meta.version);
  await noJournal();
  await preserved();
  // Inject the existing journal boundary, not an actual crash. An unknown
  // configuration must remain untouched; a proven stopped switch can reconcile.
  const record=JSON.stringify({version:meta.version+"-"+meta.target,
    previous,generation,stopped:true,phase:"switch_pending"})+"\n";
  await writeFile(journal,record,{mode:0o600});
  // Explicit disable is local even when an unresolved journal makes the
  // installed program/configuration untrustworthy. Enabling must refuse.
  const policy = keyPath + ".automatic-update";
  await writeFile(policy,JSON.stringify({device_id:device.trim(),enabled:true})+"\n",{mode:0o600});
  const deniedPolicy = local(nextExe,["update","--auto","on"]);
  assert.equal(deniedPolicy.status,1,deniedPolicy.stdout+deniedPolicy.stderr);
  assert.equal(JSON.parse(await readFile(policy,"utf8")).enabled,true);
  const disabled = JSON.parse(ok(local(nextExe,["update","--auto","off"])));
  assert.equal(disabled.automatic_update,"off");
  assert.equal(disabled.automatic_update_activity,"needs_attention");
  assert.equal(JSON.parse(await readFile(policy,"utf8")).enabled,false);
  assert.equal(await readFile(journal,"utf8"),record);
  await preserved();
  await writeFile(cli,oldCli);
  await writeFile(config,"<foreign/>");
  const unknown=owner("y",cli,["recover"]);
  assert.equal(unknown.status,1,unknown.stdout+unknown.stderr);
  assert.match(unknown.stdout,/Switch outcome unconfirmed/,unknown.stdout+unknown.stderr);
  assert.doesNotMatch(unknown.stdout,/Confirm \[y\/N\]/);
  assert.equal(await readFile(journal,"utf8"),record);
  assert.equal(await readFile(config,"utf8"),"<foreign/>");
  assert.equal(await readFile(cli,"utf8"),oldCli);
  await preserved();
  await writeFile(config,installed);
  const recovered=ok(owner("y",cli,["recover"]));
  assert.match(recovered,/Confirm \[y\/N\]/);
  assert.match(recovered,/Switch reconciled/);
  assert.equal(ok(local(cli,["--version"])).trim(),meta.version);
  assert.equal(await readFile(cli,"utf8"),launcher(nextExe));
  assert.equal(await readFile(config,"utf8"),installed);
  await noJournal();
  await preserved();
});
