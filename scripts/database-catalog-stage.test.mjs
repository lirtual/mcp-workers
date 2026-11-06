import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {collectBootstrapSecrets} from './bootstrap-worker-secrets.mjs';
import {collectWorkerVars} from './worker-release-variables.mjs';
import {verifyBindings,readConfiguration} from './manual-worker-release.mjs';
const catalog='{"b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@#{DB_HOST}:3306/b2b"}';
const env={DATABASE_CONNECTIONS:catalog,DATABASE_B2B_PASSWORD:'synthetic@/%:password',DB_HOST:'8.8.8.8',MCP_ACCESS_TOKEN:'synthetic-token'};
test('selected Database release keeps unresolved catalog and independent secret_text payloads',()=>{
  assert.deepEqual(collectBootstrapSecrets('database-mcp-worker',env),{MCP_ACCESS_TOKEN:env.MCP_ACCESS_TOKEN,DATABASE_B2B_PASSWORD:env.DATABASE_B2B_PASSWORD});
  const vars=collectWorkerVars('database-mcp-worker',env);
  assert.deepEqual(vars,['DATABASE_CONNECTIONS:'+catalog,'DB_HOST:8.8.8.8']);
  assert.ok(!vars.join().includes(env.DATABASE_B2B_PASSWORD));
  assert.deepEqual(collectBootstrapSecrets('browser-mcp-worker',env),{MCP_ACCESS_TOKEN:env.MCP_ACCESS_TOKEN});
});
test('missing, unapproved, recursive or malformed references fail before publication',()=>{
  for (const change of [
    {DATABASE_B2B_PASSWORD:''},{DB_HOST:''},{DATABASE_B2B_PASSWORD:'${OTHER}'},
    {DATABASE_CONNECTIONS:catalog.replace('DATABASE_B2B_PASSWORD','OTHER')},
    {DATABASE_CONNECTIONS:catalog.replace('DB_HOST','OTHER')},
    {DATABASE_CONNECTIONS:catalog.replace('3306','3306?tls=false')},
  ]) assert.throws(()=>collectBootstrapSecrets('database-mcp-worker',{...env,...change}));
});
test('postflight requires exact catalog, referenced Secret types and native binding identities; permits only enumerated recovery Secrets',()=>{
  const source=readConfiguration('database-mcp-worker',readFileSync('apps/database-mcp-worker/wrangler.jsonc','utf8'));
  const bindings=[{name:'MCP_ACCESS_TOKEN',type:'secret_text'},{name:'DATABASE_B2B_PASSWORD',type:'secret_text'},
    {name:'DATABASE_CONNECTIONS',type:'plain_text',text:catalog},{name:'DB_HOST',type:'plain_text',text:'8.8.8.8'},
    {name:'RATE_LIMITER',type:'ratelimit',namespace_id:'1001',simple:{limit:120,period:60}}];
  const settings={bindings,observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=[{name:'MCP_ACCESS_TOKEN'},{name:'DATABASE_B2B_PASSWORD'}];
  const options={mode:'readback',sourceConfig:source,databaseConnections:catalog,databaseVariables:{DB_HOST:'8.8.8.8'}};
  assert.equal(verifyBindings('database-mcp-worker',settings,secrets,options),true);
  for (const name of ['DATABASE_B2B_PASSWORD','DATABASE_CONNECTIONS','DB_HOST'])
    assert.throws(()=>verifyBindings('database-mcp-worker',{...settings,bindings:bindings.filter(b=>b.name!==name)},secrets,options));
  assert.throws(()=>verifyBindings('database-mcp-worker',settings,secrets,{...options,databaseConnections:'{}'}));
  assert.throws(()=>verifyBindings('database-mcp-worker',{...settings,bindings:[...bindings,{name:'DB',type:'d1',id:'old'}]},secrets,options));
  const legacy={name:'DATABASE_ENCRYPTION_KEY',type:'secret_text'};
  assert.equal(verifyBindings('database-mcp-worker',{...settings,bindings:[...bindings,legacy]},[...secrets,{name:legacy.name}],options),true);
});
test('retired lifecycle jobs, inputs and runtime binding requirements stay absent',()=>{
  const source=readFileSync('.github/workflows/release.yml','utf8');
  assert.doesNotMatch(source,/database_hyperdrive_|database-hyperdrive-|DATABASE_ENCRYPTION_KEY|DATABASE_GITHUB_ACTIONS_TOKEN|database-d1-/);
  assert.match(source,/DATABASE_EXPECTED_RELEASE_SHA/);
});

test('reusable CI retains its independent fail-closed application/database release gate',()=>{
  const ci=readFileSync('.github/workflows/ci.yml','utf8');
  assert.match(ci,/\n  release-gate:\n/);
  const gate=ci.slice(ci.indexOf('\n  release-gate:'));
  assert.match(gate,/needs: \[checks, database-integration\]/);
  assert.match(gate,/if: \$\{\{ always\(\) \}\}/);
  assert.match(gate,/release_ready: \$\{\{ steps.gate.outputs.release_ready \}\}/);
  assert.match(gate,/true:success\|false:skipped/);
});

test('removing a logical ID preserves omitted approved Secrets for separately authorized cleanup',()=>{
  const source=readConfiguration('database-mcp-worker',readFileSync('apps/database-mcp-worker/wrangler.jsonc','utf8'));
  const bindings=[{name:'MCP_ACCESS_TOKEN',type:'secret_text'},{name:'DATABASE_B2B_PASSWORD',type:'secret_text'},
    {name:'DATABASE_CONNECTIONS',type:'plain_text',text:'{}'},
    {name:'RATE_LIMITER',type:'ratelimit',namespace_id:'1001',simple:{limit:120,period:60}}];
  assert.equal(verifyBindings('database-mcp-worker',{bindings,observability:{enabled:true,logs:{invocation_logs:true}}},
    [{name:'MCP_ACCESS_TOKEN'},{name:'DATABASE_B2B_PASSWORD'}],{mode:'readback',sourceConfig:source,databaseConnections:'{}'}),true);
});

test('strict JSON, catalog bounds and component token placement fail closed',()=>{
  const uri='mysql://user:${DATABASE_B2B_PASSWORD}@8.8.8.8/db';
  for (const value of ['[]','null','{"one":2}',JSON.stringify({'bad id':uri}),
    '{"one":'+JSON.stringify(uri)+',"one":'+JSON.stringify(uri)+'}',
    '{\u00a0"one":'+JSON.stringify(uri)+'}',
    JSON.stringify(Object.fromEntries(Array.from({length:11},(_,i)=>['db'+i,uri]))),
    JSON.stringify({one:uri+'#fragment'}),JSON.stringify({one:uri+'?ssl=false'}),
    JSON.stringify({one:uri.replace('mysql:','postgres:')}),
    JSON.stringify({one:uri.replace('user','${DATABASE_B2B_PASSWORD}')}),
  ]) assert.throws(()=>collectBootstrapSecrets('database-mcp-worker',{...env,DATABASE_CONNECTIONS:value}));
});
test('encodes nonsecret user references within the component without treating # as a fragment',()=>{
  assert.deepEqual(collectWorkerVars('database-mcp-worker',{...env,DB_HOST:'reviewed_user',
    DATABASE_CONNECTIONS:'{"one":"postgresql://#{DB_HOST}:${DATABASE_B2B_PASSWORD}@8.8.8.8/db"}'}),
    ['DATABASE_CONNECTIONS:{"one":"postgresql://#{DB_HOST}:${DATABASE_B2B_PASSWORD}@8.8.8.8/db"}','DB_HOST:reviewed_user']);
});
