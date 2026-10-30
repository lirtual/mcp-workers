// Protected one-shot origin authentication after a password-only rotation.
// No Worker/Hyperdrive routing evidence. Never print credentials or PEM material.
import {createRequire} from 'node:module';
import {checkServerIdentity} from 'node:tls';
const requireDriver=createRequire(new URL('../apps/database-mcp-worker/package.json',import.meta.url));
const fail=()=>{throw Error('isolated_origin_sql_unverified')};
const dns=/^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const pem=/^(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/;
export async function verifyOriginSql476({target,password,caPem},drivers={
 mysql:()=>requireDriver('mysql2/promise'),pg:()=>requireDriver('pg')
}){
 if(!target||!['mysql','postgres'].includes(target.dialect)||
    typeof target.origin_host!=='string'||!dns.test(target.origin_host)||
    !Number.isSafeInteger(target.origin_port)||target.origin_port<1||target.origin_port>65535||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(target.origin_database??'')||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(target.origin_user??'')||
    typeof password!=='string'||Buffer.byteLength(password,'utf8')<1||
    Buffer.byteLength(password,'utf8')>2048||
    typeof caPem!=='string'||caPem.length>16384||!pem.test(caPem))fail();
 const host=target.origin_host;
 const ssl={ca:caPem,servername:host,rejectUnauthorized:true,minVersion:'TLSv1.2',
  checkServerIdentity:(_name,cert)=>checkServerIdentity(host,cert)};
 if(target.dialect==='mysql'){
  let connection;
  try{
   connection=await drivers.mysql().createConnection({host,port:target.origin_port,
    database:target.origin_database,user:target.origin_user,password,ssl,
    connectTimeout:5000,multipleStatements:false});
   const [rows]=await connection.query({sql:'SELECT 1 AS credential_probe',timeout:5000});
   if(!Array.isArray(rows)||rows.length!==1||Number(rows[0]?.credential_probe)!==1)fail();
  }catch{fail()}
  finally{if(connection)await connection.end().catch(()=>{});}
 }else{
  let client,connected=false;
  try{
   const {Client}=drivers.pg();
   client=new Client({host,port:target.origin_port,database:target.origin_database,
    user:target.origin_user,password,ssl,connectionTimeoutMillis:5000,
    query_timeout:5000,statement_timeout:5000,
    application_name:'db476-readonly-credential-probe'});
   await client.connect();connected=true;
   const answer=await client.query('SELECT 1 AS credential_probe');
   if(answer.rows?.length!==1||Number(answer.rows[0]?.credential_probe)!==1)fail();
  }catch{fail()}
  finally{if(client&&connected)await client.end().catch(()=>{});}
 }
 return {originSqlVerified:true,hyperdriveWorkerVerified:false};
}