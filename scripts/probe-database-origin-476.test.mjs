import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOriginSql476} from './probe-database-origin-476.mjs';
const target={dialect:'mysql',origin_host:'mysql.example.net',origin_port:3306,
 origin_database:'catalog',origin_user:'reader'};
const password='synthetic-credential';
const caPem='-----BEGIN CERTIFICATE-----\nQUJDRA==\n-----END CERTIFICATE-----'.replaceAll('\\n','\n');
test('MySQL verified CA, pinned hostname and read-only SELECT 1',async()=>{
 let calls=0,closed=0;
 const drivers={mysql:()=>({createConnection:async options=>{
  calls++;
  assert.equal(options.ssl.ca,caPem);
  assert.equal(options.ssl.rejectUnauthorized,true);
  assert.equal(options.ssl.servername,target.origin_host);
  assert.equal(options.ssl.minVersion,'TLSv1.2');
  assert.equal(typeof options.ssl.checkServerIdentity,'function');
  assert.equal(options.multipleStatements,false);
  assert.equal(options.password,password);
  return {query:async sql=>{assert.deepEqual(sql,{sql:'SELECT 1 AS credential_probe',timeout:5000});return [[{credential_probe:1}]]},
   end:async()=>{closed++}};
 }})};
 assert.deepEqual(await verifyOriginSql476({target,password,caPem},drivers),
  {originSqlVerified:true,hyperdriveWorkerVerified:false});
 assert.equal(calls,1);assert.equal(closed,1);
});
test('Postgres uses strict TLS and one read-only query',async()=>{
 let closed=0;
 const drivers={pg:()=>({Client:class{
  constructor(options){
   assert.equal(options.ssl.rejectUnauthorized,true);
   assert.equal(options.ssl.servername,target.origin_host);
   assert.equal(options.ssl.ca,caPem);
   assert.equal(options.password,password);
  }
  async connect(){}
  async query(sql){assert.equal(sql,'SELECT 1 AS credential_probe');return {rows:[{credential_probe:1}]}}
  async end(){closed++}
 }})};
 const pg={...target,dialect:'postgres',origin_port:5432};
 assert.deepEqual(await verifyOriginSql476({target:pg,password,caPem},drivers),
  {originSqlVerified:true,hyperdriveWorkerVerified:false});
 assert.equal(closed,1);
});
test('bad TLS, private target, incorrect SQL result and denied authentication cannot verify',async()=>{
 const drivers={mysql:()=>({createConnection:async()=>({query:async()=>[[{credential_probe:0}]],end:async()=>{}})})};
 for(const patch of [{caPem:''},{target:{...target,origin_host:'127.0.0.1'}},
  {target:{...target,origin_port:0}},{password:''}]){
  await assert.rejects(verifyOriginSql476({target,password,caPem,...patch},drivers),
   /isolated_origin_sql_unverified/);
 }
 await assert.rejects(verifyOriginSql476({target,password,caPem},drivers),
  /isolated_origin_sql_unverified/);
 const denied={mysql:()=>({createConnection:async()=>{throw Error('confidential-password-value')}})};
 await assert.rejects(verifyOriginSql476({target,password,caPem},denied),
  err=>err.message==='isolated_origin_sql_unverified');
});
