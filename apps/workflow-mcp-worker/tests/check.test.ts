import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('check invokes typecheck, tests and the existing dry-run exactly once',t=>{
  const scripts=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).scripts;
  const dir=mkdtempSync(join(tmpdir(),'workflow-check-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const log=join(dir,'calls');
  // Record command dispatch without building twice or requiring credentials.
  writeFileSync(join(dir,'pnpm'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},process.argv.slice(2).join(' ')+'\\n');\n`,{mode:0o755});
  const child=spawnSync('/bin/sh',['-c',scripts.check],{env:{PATH:dir},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),['run typecheck','test','run deploy:dry-run']);
});
