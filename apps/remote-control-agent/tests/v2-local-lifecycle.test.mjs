import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
const script=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../scripts/bootstrap-v2.py");
const python=String.raw`import importlib.util, pathlib, tempfile, os, json, stat, sys
spec=importlib.util.spec_from_file_location("bootstrap",sys.argv[1])
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
with tempfile.TemporaryDirectory(prefix="issue69-t09-") as home:
    root=pathlib.Path(home)
    programs=root/".local/share/mcp-workers/remote-control/programs"
    ver=programs/"v0.2.0-linux-x64-glibc"
    entry=ver/"apps/remote-control-agent/src/v2-main.js"
    entry.parent.mkdir(parents=True,mode=0o700)
    entry.write_text("readOnly: true, writeFile: false, shell: false,")
    mf=ver/"bundle.json"
    mf.write_text(json.dumps({"version":"v0.2.0","target":"linux-x64-glibc","artifact_schema":1,
      "device_protocol":2,"receipt_schema":1,"upgrade_profile":"read-only-no-shell-v1"}))
    for p in (programs.parent,programs,ver,ver/"apps",ver/"apps/remote-control-agent",
              ver/"apps/remote-control-agent/src"):
        p.chmod(0o700)
    entry.chmod(0o600);mf.chmod(0o600)
    state=root/".local/state/mcp-workers/remote-control-agent"
    state.mkdir(parents=True); receipts=state/"operation-receipts.sqlite"
    receipts.write_text("untouched receipts")
    keys=root/".local/share/mcp-workers/remote-control/v2-identity.pem"
    keys.write_text("untouched private key");keys.chmod(0o600)
    did=pathlib.Path(str(keys)+".device-id")
    did.write_text("e11d9c70-16fe-4d47-aafc-d01db72750fd");did.chmod(0o600)
    st=b.local_status(home)
    assert st["cloud_authorization"]=="unconfirmed"
    assert st["cloud_revoke"]=="not_performed"
    assert st["installed_versions"]==[ver.name]
    assert st["device_ids"]["permanent"]=="e11d9c70-16fe-4d47-aafc-d01db72750fd"
    try:b.local_uninstall(home,False,process_check=lambda _:True);raise AssertionError("No-confirmation delete")
    except ValueError:pass
    assert ver.exists()
    try:b.local_uninstall(home,True,process_check=lambda _:False);raise AssertionError("Running process delete")
    except ValueError:pass
    assert ver.exists()
    # Simulated owned permanent unit must be matched exactly, no real systemctl.
    unit=root/".config/systemd/user/remote-control-v2-agent.service"
    unit.parent.mkdir(parents=True)
    unit.write_text(b.MARKER+"\n[Unit]\n[Service]\nWorkingDirectory="+str(ver/"apps/remote-control-agent")+
      "\nExecStart="+str(ver/"bin/node")+" "+str(ver/"apps/remote-control-agent/src/v2-main.js")+"\n")
    systemcalls=[]
    result=b.local_uninstall(home,True,systemctl=lambda args:systemcalls.append(args),
      process_check=lambda _:True)
    assert result["cloud_revocation"]=="NOT_PERFORMED"
    assert len(systemcalls)==2 and systemcalls[0][-1]==b.UNIT
    assert not ver.exists() and not unit.exists()
    assert keys.read_text()=="untouched private key" and receipts.read_text()=="untouched receipts"
    assert did.is_file()
    # A foreign program or service causes refusal, no blind removal.
    ver.mkdir(mode=0o700)
    alien=ver/"alien-link"
    alien.symlink_to(keys)
    try:b.local_uninstall(home,True,process_check=lambda _:True);raise AssertionError("malicious tree")
    except ValueError:pass
    assert alien.is_symlink() and keys.exists()
print("T09_PRESERVE_KEYS_RECEIPTS_AND_REVOKE_WARNING_OK")
`;
test("#78 status reports local and cloud states separately; uninstall preserves keys and receipts",()=>{
  const result=spawnSync("python3",["-c",python,script],{encoding:"utf8",timeout:15000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/T09_PRESERVE_KEYS_RECEIPTS_AND_REVOKE_WARNING_OK/);
});
test("#78 no terminal refuses local uninstall before touching local files",()=>{
  const r=spawnSync("python3",[script,"--uninstall"],{encoding:"utf8",input:"",timeout:15000});
  assert.equal(r.status,1);
  assert.match(r.stderr,/real terminal|interactive terminal|non-root/);
});
