import assert from 'node:assert/strict';
import {createConnection} from 'node:net';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createAgentExecutionEngine} from '../src/execution.ts';
import {startUpgradeControl, upgradeSocketPath} from '../src/upgrade-control.ts';

async function ipc(socketPath: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setTimeout(2000, () => socket.destroy(Error('IPC timed out')));
    socket.on('connect', () => socket.write(command + '\n'));
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('end', () => resolve(response.trim()));
  });
}

test('Ubuntu Session local admission, activity, busy and freeze share the existing private socket', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-session-idle-'));
  const file = path.join(root, 'file.txt');
  const physical={attempt_id:'11111111-1111-4111-8111-111111111111', github_run_id:123, github_run_attempt:1, workflow_name:'ubuntu'};
  const engine = createAgentExecutionEngine({
    receiptDirectory: path.join(root, 'receipts'),
    sessionIdle:physical,
  });
  let control: Awaited<ReturnType<typeof startUpgradeControl>> | undefined;
  try {
    await writeFile(file, 'fixture');
    control = await startUpgradeControl(engine, path.join(root,'v2-identity.pem'));
    const socket = upgradeSocketPath(path.join(root,'v2-identity.pem'));
    const initial = JSON.parse(await ipc(socket, 'idle-status'));
    assert.deepEqual(Object.keys(initial).sort(), ['attempt_id','github_run_id','github_run_attempt','observed_at_ms','last_activity_ms','state'].sort());
    assert.equal(initial.last_activity_ms, null);
    assert.equal(initial.state, 'idle');
    assert.equal(initial.attempt_id,'11111111-1111-4111-8111-111111111111');
    const list = await engine.executeTool({tool:'list_sessions',arguments:{}},new AbortController().signal);
    assert.equal(list?.status,200);
    assert.equal(JSON.parse(await ipc(socket,'idle-status')).last_activity_ms,null);
    const read = await engine.executeTool({tool:'read_file',arguments:{path:file}},new AbortController().signal);
    assert.equal(read?.status,200);
    const touched = JSON.parse(await ipc(socket,'idle-status'));
    assert.ok(touched.last_activity_ms > 0);
    assert.equal(touched.state,'idle');
    assert.equal(await ipc(socket,'idle-freeze'),'ready');
    assert.equal((await engine.executeTool({tool:'read_file',arguments:{path:file}},new AbortController().signal))?.status,503);
    assert.equal(await ipc(socket,'release'),'released');
    assert.equal((await engine.executeTool({tool:'read_file',arguments:{path:file}},new AbortController().signal))?.status,200);
  } finally { await control?.close(); await engine.close(); await rm(root,{recursive:true,force:true}); }
});

test('permanent Agent exposes no idle control command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-no-idle-'));
  const engine = createAgentExecutionEngine();
  let control: Awaited<ReturnType<typeof startUpgradeControl>> | undefined;
  try {
    control = await startUpgradeControl(engine,path.join(root,'key.pem'));
    const socket = upgradeSocketPath(path.join(root,'key.pem'));
    assert.equal(await ipc(socket,'idle-status'),'');
  } finally { await control?.close(); await engine.close(); await rm(root,{recursive:true,force:true}); }
});

test('in-flight file write is Busy, cannot freeze, and completes before shutdown can be admitted', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'rc-idle-race-'));
  const file=path.join(root,'file.txt');
  let release!:()=>void;
  let staged!:()=>void;
  const stagedSignal=new Promise<void>(resolve => {staged=resolve;});
  const pause=new Promise<void>(resolve => {release=resolve;});
  const engine=createAgentExecutionEngine({
    receiptDirectory:path.join(root,'receipts'),
    sessionIdle:{attempt_id:'11111111-1111-4111-8111-111111111111',github_run_id:999,github_run_attempt:2},
    fileStageForTests:async stage => {if(stage==='staged'){staged();await pause;}},
  });
  let control: Awaited<ReturnType<typeof startUpgradeControl>> | undefined;
  try {
    control=await startUpgradeControl(engine,path.join(root,'key.pem'));
    const socket=upgradeSocketPath(path.join(root,'key.pem'));
    const updating=engine.executeTool({tool:'write_file',operation_id:'idle-race-write-1',
      arguments:{path:file,mode:'rewrite',content:'updated'}},new AbortController().signal);
    await stagedSignal;
    const busy=JSON.parse(await ipc(socket,'idle-status'));
    assert.equal(busy.state,'busy');
    assert.ok(busy.last_activity_ms>0);
    assert.equal(await ipc(socket,'idle-freeze'),'busy');
    release();
    assert.equal((await updating)?.status,200);
    assert.equal(JSON.parse(await ipc(socket,'idle-status')).state,'idle');
    assert.equal(await ipc(socket,'idle-freeze'),'ready');
    assert.equal((await engine.executeTool({tool:'read_file',arguments:{path:file}},new AbortController().signal))?.status,503);
    assert.equal(await ipc(socket,'release'),'released');
    assert.equal((await engine.executeTool({tool:'read_file',arguments:{path:file}},new AbortController().signal))?.status,200);
  } finally {
    release();
    await control?.close();await engine.close();await rm(root,{recursive:true,force:true});
  }
});
