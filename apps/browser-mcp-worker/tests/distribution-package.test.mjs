import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const repo=new URL('../../../',import.meta.url).pathname;
const builder=join(repo,'scripts/build-browser-extension.py');
const stager=join(repo,'scripts/stage-browser-distribution.py');
const run=(script,...args)=>spawnSync('python3',[script,...args],{encoding:'utf8'});

test('public distribution is bound to one verified ZIP and refuses dirty/tampered/stale release inputs',()=>{
  const temp=mkdtempSync(join(tmpdir(),'browser609-distribution-'));
  const input=join(temp,'artifact'),out=join(temp,'public');
  try{
    const build=run(builder,'--out-dir',input);
    assert.equal(build.status,0,build.stderr);
    const filename=readdirSync(input).find(n=>n.endsWith('.zip'));
    assert.ok(filename);
    const archive=join(input,filename);
    const sidecar=archive+'.json';
    const version=JSON.parse(readFileSync(sidecar,'utf8')).version;
    const original=readFileSync(archive);
    const digest=createHash('sha256').update(original).digest('hex');
    const stage=(target,...extra)=>run(stager,'--artifact-dir',input,'--out-dir',target,...extra);
    const success=stage(out);
    assert.equal(success.status,0,success.stderr);
    assert.deepEqual(readdirSync(out),['downloads','index.html']);
    assert.deepEqual(readdirSync(join(out,'downloads')),[`browser-mcp-extension-v${version}-${digest}.zip`]);
    const html=readFileSync(join(out,'index.html'),'utf8');
    assert.ok(html.includes(digest));
    assert.ok(html.includes('/download'));
    assert.equal(createHash('sha256').update(readFileSync(join(out,'downloads',`browser-mcp-extension-v${version}-${digest}.zip`))).digest('hex'),digest);
    assert.notEqual(stage(out).status,0,'a reused public directory cannot retain stale files');
    writeFileSync(archive,Buffer.concat([original,Buffer.from('tamper')]));
    assert.notEqual(stage(join(temp,'tampered')).status,0,'changed ZIP bytes must fail before publish');
    writeFileSync(archive,original);
    mkdirSync(join(temp,'stale'));writeFileSync(join(temp,'stale','secret.env'),'blocked');
    assert.notEqual(stage(join(temp,'stale')).status,0,'extra public asset must not ship');
    const meta=JSON.parse(readFileSync(sidecar,'utf8'));
    writeFileSync(sidecar,JSON.stringify({...meta,source_dirty:true}));
    assert.notEqual(stage(join(temp,'dirty'),'--require-clean').status,0,'production rejects dirty build');
  }finally{rmSync(temp,{recursive:true,force:true});}
});
