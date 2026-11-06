import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

test('pinned Wrangler accepts required named Secrets in the same dry-run deploy and Workers serves the D1-free catalog', {timeout:60000},async()=>{
  const app=resolve('apps/database-mcp-worker');
  const dir=await mkdtemp(join(tmpdir(),'database-760-'));
  const server=createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  await new Promise(r=>server.close(r));
  const config={name:'database-local-760',main:join(app,'src/index.ts'),compatibility_date:'2026-09-12',compatibility_flags:['nodejs_compat'],
    secrets:{required:['MCP_ACCESS_TOKEN','DATABASE_B2B_PASSWORD']},
    vars:{DATABASE_CONNECTIONS:'{"b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@8.8.8.8/b2b"}'},
    ratelimits:[{name:'RATE_LIMITER',namespace_id:'1001',simple:{limit:120,period:60}}]};
  const secrets={MCP_ACCESS_TOKEN:'local-synthetic-token',DATABASE_B2B_PASSWORD:'synthetic@/%:password'};
  const configPath=join(dir,'wrangler.json');
  await writeFile(configPath,JSON.stringify(config));
  await writeFile(join(dir,'secrets.json'),JSON.stringify(secrets),{mode:0o600});
  await writeFile(join(dir,'.dev.vars'),Object.entries(secrets).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n'),{mode:0o600});
  let process;
  let client;
  try {
    // No Cloudflare credentials or remote publication. Never print deployment diagnostics.
    execFileSync('pnpm',['exec','wrangler','deploy','--dry-run','--config',configPath,'--secrets-file',join(dir,'secrets.json'),'--outdir',join(dir,'bundle')],{cwd:app,stdio:'pipe',timeout:30000});
    process=spawn('pnpm',['exec','wrangler','dev','--local','--config',configPath,'--port',String(port),'--ip','127.0.0.1'],{cwd:app,stdio:['ignore','pipe','pipe']});
    let ready=false;
    process.stdout.on('data',chunk=>{if(chunk.toString().includes('Ready on'))ready=true;});
    process.stderr.on('data',()=>{});
    const deadline=Date.now()+20000;
    while(!ready && Date.now()<deadline && process.exitCode===null) await new Promise(r=>setTimeout(r,100));
    assert.ok(ready,'local Workers runtime must start');
    const base=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(base+'/setup')).status,404);
    assert.equal((await fetch(base+'/mcp')).status,401);
    client=new Client({name:'workers-config-regression',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+secrets.MCP_ACCESS_TOKEN}}}));
    const result=await client.callTool({name:'list_connections',arguments:{}});
    assert.notEqual(result.isError,true);
    assert.match(JSON.stringify(result),/b2b/);
    assert.ok(!JSON.stringify(result).includes(secrets.DATABASE_B2B_PASSWORD));
  } finally {
    await client?.close();
    if(process){process.kill('SIGTERM');await new Promise(r=>process.once('close',r));}
    await rm(dir,{recursive:true,force:true});
  }
});
