import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/bootstrap-v2.py");
const PY = String.raw`import importlib.util, json, pathlib, sys, tempfile, shutil, tarfile, io
spec=importlib.util.spec_from_file_location("bootstrap",sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
# The published Agent assets are in the monorepo, not the retired split repo.
assert m.OWNER=="lirtual/mcp-workers",m.OWNER
assert m.API=="https://api.github.com/repos/lirtual/mcp-workers",m.API
tag="v0.1.0"; target="linux-x64-glibc"; commit="a"*40
assert m.safe_member("bin/node",False)=="bin/node"
for unsafe in ["../../.ssh/id_rsa","/tmp/evil","bin/../evil","apps/remote-control-agent/tests/evil.js"]:
    try: m.safe_member(unsafe,False); raise AssertionError(unsafe)
    except ValueError: pass
for url in ["http://github.com/file","https://evil.example/file","https://github.com.evil.test/file"]:
    assert not m.https_origin(url),url
assert m.https_origin("https://github.com/lirtual/mcp-workers/releases/download/v0.1.0/agent.tgz")
try: m.resolve_pinned("latest",commit,target); raise AssertionError("latest accepted")
except ValueError: pass
print("PYTHON_BOOTSTRAP_FAIL_CLOSED_OK")
`;
function python(args,{input,env}={}) {
  return spawnSync("python3",args,{input,encoding:"utf8",timeout:15000,env:{...process.env,...env}});
}

test("#74 version-pinned bootstrap validates inputs and prevents unsafe redirects",()=>{
  const result=python(["-c",PY,script]);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/PYTHON_BOOTSTRAP_FAIL_CLOSED_OK/);
});

test("#914 Python verifier accepts only the explicit prerelease Rust Linux archive and preserves executable mode",()=>{
  const body=String.raw`import importlib.util,sys,tarfile,tempfile,pathlib,json,platform,struct,os,io,stat
spec=importlib.util.spec_from_file_location("b",sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
target="linux-x64-glibc";tag="v0.1.1-rust-candidate.1"
def make(path,version,agent_runtime="rust-standard-linux-v1",include_manager=True):
    elf=bytearray(80);elf[:4]=b"\x7fELF";elf[4:6]=b"\x02\x01";struct.pack_into("<H",elf,18,62)
    libc,glibc=platform.libc_ver()
    files={"bin/node":bytes(elf),"apps/remote-control-agent/.build/session-supervisor":bytes(elf),
      "apps/remote-control-agent/.build/rca-standard-linux-candidate":bytes(elf),
      "bundle.json":json.dumps({"name":"remote-control-agent","artifact_schema":1,
        "version":version,"target":target,"node":"v24.1.0","modules":[],
        "glibc_min":glibc,"upgrade_profile":"paired-full-v1",
        "agent_runtime":agent_runtime,"candidate_profile":"standard-linux-rust-runtime-v1"}).encode(),
      "apps/remote-control-agent/package.json":b'{"type":"module"}',
      "apps/remote-control-agent/src/v2-main.js":b'export {}',
      "apps/remote-control-agent/scripts/install-v2.mjs":b'export {}'}
    for name in b.NODE_REQUIRED:files[name]=b'export {}'
    if include_manager:files[b.APP+"/scripts/manage-v2.py"]=b'print("inspection-only")'
    with tarfile.open(path,"w:gz") as archive:
      for name,data in files.items():
        item=tarfile.TarInfo(name);item.size=len(data);item.mode=0o700 if name in b.ELF_FILES or name==b.APP+"/.build/rca-standard-linux-candidate" else 0o600
        archive.addfile(item,io.BytesIO(data))
with tempfile.TemporaryDirectory() as d:
    p=pathlib.Path(d)/"candidate.tar.gz";make(p,tag)
    records=b.inspect_archive(p,tag,target)
    missing=pathlib.Path(d)/"missing-manager.tar.gz";make(missing,tag,include_manager=False)
    try:b.inspect_archive(missing,tag,target);raise AssertionError("Rust manager omission accepted")
    except ValueError:pass
    dest=pathlib.Path(d)/"installed";b.unpack_verified(p,dest,records,tag,target)
    st=(dest/b.APP/".build/rca-standard-linux-candidate").lstat()
    assert stat.S_ISREG(st.st_mode) and st.st_mode&0o777==0o700 and st.st_nlink==1
    stable=pathlib.Path(d)/"stable.tar.gz";make(stable,"v0.1.1")
    try:b.inspect_archive(stable,"v0.1.1",target);raise AssertionError("stable Rust package accepted")
    except ValueError:pass
    node_archive=pathlib.Path(d)/"node-with-unused-rust.tar.gz";make(node_archive,"v0.1.0","node-v2")
    try:b.inspect_archive(node_archive,"v0.1.0",target);raise AssertionError("unused Rust binary accepted")
    except ValueError:pass
print("RUST_CANDIDATE_ARCHIVE_OK")
`;
  const r=python(["-c",body,script]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/RUST_CANDIDATE_ARCHIVE_OK/);
});

test("#74 standalone bootstrap fails without real TTY, before network or identity change",async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"rc-bootstrap-tty-"));
  try {
    const r=python([script,"--tag","v0.1.0","--commit","a".repeat(40),
      "--endpoint","https://rc.example.org/"],{input:"",env:{HOME:home}});
    assert.equal(r.status,1,r.stderr);
    assert.match(r.stderr,/real interactive terminal/);
    assert.equal(existsSync(path.join(home,".local","share","mcp-workers")),false);
  } finally {await rm(home,{recursive:true,force:true});}
});

test("#74 public immutable Release metadata and exact tag SHA are necessary",()=>{
  const body=String.raw`import importlib.util,sys
spec=importlib.util.spec_from_file_location("bootstrap",sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
tag="v0.1.0";c="a"*40;t="linux-x64-glibc"
name="remote-control-agent-"+tag+"-"+t+".tar.gz"
asset={"name":name,"state":"uploaded","id":42,"size":50000,"digest":"sha256:"+"b"*64,
       "url":m.API+"/releases/assets/42",
       "browser_download_url":"https://github.com/lirtual/mcp-workers/releases/download/"+tag+"/"+name}
calls=[]
def response(url):
    calls.append(url)
    if "/releases/tags/" in url:return {"immutable":True,"draft":False,"tag_name":tag,"id":1,"assets":[asset]}
    return {"ref":"refs/tags/"+tag,"object":{"type":"commit","sha":c}}
m.json_api=response
info=m.resolve_pinned(tag,c,t)
assert info["digest"]=="b"*64
assert len(calls)==2
assert all("/immutable-releases" not in p for p in calls)
asset["digest"]=None
try:m.resolve_pinned(tag,c,t);raise AssertionError("missing digest accepted")
except ValueError:pass
asset["digest"]="sha256:"+"b"*64
old=response
def bad(url):
    x=old(url)
    if "/releases/tags/" in url: x=dict(x,immutable=False)
    return x
m.json_api=bad
try:m.resolve_pinned(tag,c,t);raise AssertionError("mutable release accepted")
except ValueError:pass
print("PINNED_RELEASE_API_OK")
`;
  const r=python(["-c",body,script]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/PINNED_RELEASE_API_OK/);
});

test("#74 bootstrap rejects archive symlink/traversal and safely inspects the real unpublished x64 test archive",()=>{
  const body=String.raw`import importlib.util,sys,tarfile,tempfile,pathlib,io,os
spec=importlib.util.spec_from_file_location("bootstrap",sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
    f=pathlib.Path(d)/"bad.tar.gz"
    with tarfile.open(f,"w:gz") as tf:
        ti=tarfile.TarInfo("apps/remote-control-agent/src/backdoor.js")
        ti.type=tarfile.SYMTYPE;ti.linkname="/tmp/evil";tf.addfile(ti)
    try:m.inspect_archive(f,"v0.1.0","linux-x64-glibc");raise AssertionError("link accepted")
    except ValueError:pass
archive=sys.argv[2] if len(sys.argv)>2 else ""
if archive:
    entries=m.inspect_archive(archive,"v0.1.0","linux-x64-glibc")
    assert len(entries)>20
    with tempfile.TemporaryDirectory() as d:
        dest=pathlib.Path(d)/"installed"
        m.unpack_verified(archive,dest,entries,"v0.1.0","linux-x64-glibc")
        assert (dest/"bin/node").is_file()
        assert os.stat(dest/"bin/node").st_mode&0o777 ==0o700
        try:m.unpack_verified(archive,dest,entries,"v0.1.0","linux-x64-glibc");raise AssertionError("overwrote install")
        except ValueError:pass
print("PYTHON_TAR_SAFETY_OK")
`;
  const archive=process.env.RC_V2_PACKAGE_SMOKE;
  const r=python(["-c",body,script,...(archive?[archive]:[])]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/PYTHON_TAR_SAFETY_OK/);
});

test("#76 same verified archive reuses installed program; tampering never overwrites it",()=>{
  const validation=String.raw`import importlib.util,sys,tarfile,tempfile,pathlib,os
spec=importlib.util.spec_from_file_location("b",sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
archive=sys.argv[2]
with tempfile.TemporaryDirectory() as d:
    root=pathlib.Path(d);dest=root/"v0.1.0"
    records=b.inspect_archive(archive,"v0.1.0","linux-x64-glibc")
    b.unpack_verified(archive,dest,records,"v0.1.0","linux-x64-glibc")
    assert b.verify_existing_program(archive,dest,records)
    target=dest/"apps/remote-control-agent/src/v2-main.js"
    with target.open("ab") as f:f.write(b"malicious extension")
    try:b.verify_existing_program(archive,dest,records);raise AssertionError("modified program accepted")
    except ValueError:pass
    assert target.read_bytes().endswith(b"malicious extension")
    orphan=root/".download-historical"
    orphan.write_bytes(b"partial");orphan.chmod(0o600)
    b.clean_orphaned_staging(root)
    assert not orphan.exists()
    foreign=root/".download-unsafe"
    foreign.symlink_to(dest)
    try:b.clean_orphaned_staging(root);raise AssertionError("staging symlink deleted")
    except ValueError:pass
    assert foreign.is_symlink()
print("SAME_ARCHIVE_SAFE_RETRY_OK")
`;
  const archive=process.env.RC_V2_PACKAGE_SMOKE;
  if (!archive) return;
  const r=python(["-c",validation,script,archive]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/SAME_ARCHIVE_SAFE_RETRY_OK/);
});

test("#73 clean-host bootstrap rejects a release whose real glibc ABI exceeds host",()=>{
  const archive=process.env.RC_V2_PACKAGE_SMOKE;
  if(!archive) return;
  const code=String.raw`import importlib.util,sys
spec=importlib.util.spec_from_file_location("b",sys.argv[1])
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
archive=sys.argv[2]
records=b.inspect_archive(archive,"v0.1.0","linux-x64-glibc")
assert len(records)>20
original=b.platform.libc_ver
b.platform.libc_ver=lambda:("glibc","2.28")
try:
    b.inspect_archive(archive,"v0.1.0","linux-x64-glibc")
    raise AssertionError("ABI mismatch accepted")
except ValueError as e:
    assert "newer glibc ABI" in str(e)
finally:
    b.platform.libc_ver=original
print("GLIBC_ABI_FAILS_BEFORE_UNPACK_OR_EXECUTE")
`;
  const r=python(["-c",code,script,archive]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/GLIBC_ABI_FAILS_BEFORE_UNPACK_OR_EXECUTE/);
});

test("#914 native-only Rust archive stages, runs read-only CLI without Node and never pairs",()=>{
  if(process.platform!=="linux") return;
  const body=String.raw`import importlib.util,sys,pathlib,tempfile,tarfile,io,os,platform,struct,json,subprocess,stat
bootstrap=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location("b",bootstrap)
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
tag="v0.1.57-rust-candidate.1";target="linux-x64-glibc"
manifest={"name":"remote-control-agent","artifact_schema":1,"version":tag,
          "target":target,"agent_runtime":"rust-standard-linux-v1",
          "artifact_profile":"rust-native-only-v1",
          "candidate_profile":"standard-linux-rust-runtime-v1",
          "glibc_min":"2.28","upgrade_profile":"paired-full-v1",
          "device_protocol":2,"receipt_schema":1,"modules":[]}
elf=bytearray(80);elf[:4]=b"\x7fELF";elf[4:6]=b"\x02\x01"
struct.pack_into("<H",elf,18,62)
src=bootstrap.parent
files={"bundle.json":json.dumps(manifest).encode(),
       b.APP+"/.build/session-supervisor":bytes(elf),
       b.APP+"/.build/rca-standard-linux-candidate":bytes(elf),
       b.APP+"/scripts/bootstrap-v2.py":bootstrap.read_bytes(),
       b.APP+"/scripts/manage-v2.py":(src/"manage-v2.py").read_bytes(),
       b.APP+"/scripts/rca.sh":(src/"rca.sh").read_bytes()}
def archive(where,entries):
    with tarfile.open(where,"w:gz") as tar:
        for name,body in entries.items():
            member=tarfile.TarInfo(name);member.mode=0o700 if (
                name.endswith(("rca.sh","manage-v2.py","session-supervisor",
                               "rca-standard-linux-candidate"))) else 0o600
            member.size=len(body)
            tar.addfile(member,io.BytesIO(body))
with tempfile.TemporaryDirectory(prefix="rca-native-only-") as t:
    os.umask(0o077)
    home=pathlib.Path(t)/"home";home.mkdir(mode=0o700)
    programs=home/".local/share/mcp-workers/remote-control/programs"
    programs.mkdir(parents=True,mode=0o700)
    packed=pathlib.Path(t)/"native.tar.gz";archive(packed,files)
    records=b.inspect_archive(packed,tag,target)
    dest=programs/(tag+"-"+target)
    b.unpack_verified(packed,dest,records,tag,target)
    assert b.validated_owned_version(dest)
    assert not (dest/"bin/node").exists()
    assert not (dest/b.APP/"src").exists()
    for command in ["status","--version"]:
        result=subprocess.run(["/bin/sh",str(dest/b.APP/"scripts/rca.sh"),command],
            env={**os.environ,"HOME":str(home)},capture_output=True,text=True,timeout=8)
        assert result.returncode==0,(command,result.stderr)
        assert tag in result.stdout
    for command in ["pair","upgrade","uninstall"]:
        result=subprocess.run(["/usr/bin/python3","-I","-B",
             str(dest/b.APP/"scripts/manage-v2.py"),command],
            env={**os.environ,"HOME":str(home)},capture_output=True,text=True,timeout=8)
        assert result.returncode!=0,command
    assert not (home/".local/share/mcp-workers/remote-control/v2-identity.pem").exists()
    assert not (dest/b.APP/"scripts/__pycache__").exists()
    invalid=pathlib.Path(t)/"invalid.tar.gz"
    archive(invalid,{**files,"bin/node":bytes(elf)})
    try:b.inspect_archive(invalid,tag,target);raise AssertionError("bundled Node accepted")
    except ValueError:pass
    archive(invalid,{key:value for key,value in files.items() if not key.endswith("manage-v2.py")})
    try:b.inspect_archive(invalid,tag,target);raise AssertionError("missing Python manager accepted")
    except ValueError:pass
print("NATIVE_ONLY_STAGING_AND_STATUS_PASS")`;
  const result=python(["-c",body,script]);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/NATIVE_ONLY_STAGING_AND_STATUS_PASS/);
});
