import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRegistryConnection } from '../../src/registry/store.js';
import { rotateRegistryKeys } from '../../src/registry/rotation.js';
import { describe, expect, it } from 'vitest';
import { previewHyperdriveCreation, createHyperdrivePreparation, listHyperdriveOperations,
  readHyperdrivePreparation, claimHyperdriveDispatch, recordHyperdriveDispatch, expireHyperdrivePreparations } from '../../src/setup/hyperdrive-operations.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_connections.sql', '0002_transport_and_retired_ids.sql', '0003_hyperdrive_operations.sql']) {
    sqlite.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  }
  const prepare = (sql: string, args: unknown[] = []) => {
    const stmt = sqlite.prepare(sql);
    return {
      bind(...a: unknown[]) { return prepare(sql, a); },
      async all<T>() { return { results: stmt.all(...args as []) as T[] }; },
      async first<T>() { return (stmt.get(...args as []) as T) ?? null; },
      async run() { const result = stmt.run(...args as []); return { meta: { changes: result.changes } }; }
    };
  };
  return { sqlite, db: { prepare } as unknown as D1Database };
}
const keys = { DATABASE_ENCRYPTION_KEY: btoa('p'.repeat(32)), DATABASE_KEY_ID: 'active' };
const candidate = {
  id: 'new_customer', dialect: 'mysql', host: 'mysql.example.net', port: '3306',
  database: 'catalog', user: 'reader', password: 'very-secret-password',
  caCertificateId: 'b0e4a5d3-1665-4e3c-a0a0-28f9a2b9b1c0'
} as const;

describe('Hyperdrive prepare: Owner preview → encrypted D1 operation', () => {
  it('preview does not write; confirmation stores only authenticated ciphertext and reserves one slot', async () => {
    const { sqlite, db } = fixture();
    try {
      const preview = previewHyperdriveCreation(candidate);
      expect(preview).toMatchObject({ id: 'new_customer', dialect: 'mysql',
        host: 'mysql.example.net', tls: 'VERIFY_IDENTITY', cachingDisabled: true });
      expect(JSON.stringify(preview)).not.toContain(candidate.password);
      expect((sqlite.prepare('SELECT COUNT(*) AS n FROM hyperdrive_operations').get() as {n:number}).n).toBe(0);
      const prepared = await createHyperdrivePreparation(db, keys, candidate);
      expect(prepared).toMatchObject({ id: 'new_customer', phase: 'pending', action: 'create' });
      const operations = await listHyperdriveOperations(db);
      expect(operations).toHaveLength(1);
      expect(JSON.stringify(operations)).not.toContain(candidate.password);
      const raw = sqlite.prepare('SELECT ciphertext,key_id FROM hyperdrive_operations').get() as {
        ciphertext: string; key_id: string
      };
      expect(raw.key_id).toBe('active');
      expect(raw.ciphertext).not.toContain(candidate.password);
      expect(await readHyperdrivePreparation(db, keys, prepared.operationId)).toMatchObject({
        host: candidate.host, password: candidate.password
      });
      await expect(createHyperdrivePreparation(db, keys, candidate)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    } finally { sqlite.close(); }
  });
  it('cannot prepare a retired ID or an active production connection', async () => {
    const { sqlite, db } = fixture();
    try {
      sqlite.prepare('INSERT INTO retired_connection_ids(id,retired_at) VALUES (?,?)').run('new_customer', Date.now());
      await expect(createHyperdrivePreparation(db, keys, candidate)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
      expect((sqlite.prepare('SELECT COUNT(*) AS n FROM hyperdrive_operations').get() as {n:number}).n).toBe(0);
    } finally { sqlite.close(); }
  });
  it('rejects malformed targets and secrets before storing or exposing them', () => {
    expect(() => previewHyperdriveCreation({...candidate, host:'localhost'})).toThrow();
    expect(() => previewHyperdriveCreation({...candidate, port:'0'})).toThrow();
    expect(() => previewHyperdriveCreation({...candidate, password:''})).toThrow();
    expect(() => previewHyperdriveCreation({...candidate, caCertificateId:''})).toThrow();
    expect(() => previewHyperdriveCreation({...candidate, database:'other/target'})).toThrow();
  });
});


describe('Hyperdrive receipt races and bounded expiry', () => {
  it('claims dispatch once and preserves a Runner result received before its dispatch receipt', async () => {
    const {sqlite,db}=fixture();
    try {
      const op = await createHyperdrivePreparation(db,keys,candidate);
      await claimHyperdriveDispatch(db,op.operationId);
      await expect(claimHyperdriveDispatch(db,op.operationId)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
      sqlite.prepare("UPDATE hyperdrive_operations SET phase='awaiting_confirmation',prepare_run_id=42 WHERE operation_id=?").run(op.operationId);
      await recordHyperdriveDispatch(db,op.operationId,42);
      expect((await listHyperdriveOperations(db))[0]).toMatchObject({phase:'awaiting_confirmation',prepare_run_id:42});
    } finally {sqlite.close();}
  });
  it('expires only undispatched requests; unknown effects keep their ID reservation but erase expired secrets', async () => {
    const {sqlite,db}=fixture();
    try {
      const pending=await createHyperdrivePreparation(db,keys,candidate);
      const unknown=await createHyperdrivePreparation(db,keys,{...candidate,id:'ambiguous'});
      await claimHyperdriveDispatch(db,unknown.operationId);
      await recordHyperdriveDispatch(db,unknown.operationId);
      sqlite.prepare('UPDATE hyperdrive_operations SET expires_at=1').run();
      await expireHyperdrivePreparations(db);
      expect(sqlite.prepare('SELECT phase,ciphertext,key_id FROM hyperdrive_operations WHERE operation_id=?').get(pending.operationId))
        .toMatchObject({phase:'failed',ciphertext:null,key_id:null});
      expect(sqlite.prepare('SELECT phase,ciphertext,key_id FROM hyperdrive_operations WHERE operation_id=?').get(unknown.operationId))
        .toMatchObject({phase:'unknown',ciphertext:null,key_id:null});
      await expect(createHyperdrivePreparation(db,keys,{...candidate,id:'ambiguous'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
      await createHyperdrivePreparation(db,keys,candidate);
    } finally {sqlite.close();}
  });
  it('rejects ciphertext transplant and expired payloads without revealing secrets', async () => {
    const {sqlite,db}=fixture();
    try {
      const op=await createHyperdrivePreparation(db,keys,candidate);
      sqlite.prepare('UPDATE hyperdrive_operations SET expected_revision=1 WHERE operation_id=?').run(op.operationId);
      await expect(readHyperdrivePreparation(db,keys,op.operationId)).rejects.toMatchObject({code:'CONFIGURATION_UNAVAILABLE'});
      sqlite.prepare('UPDATE hyperdrive_operations SET expected_revision=0,expires_at=1').run();
      await expect(readHyperdrivePreparation(db,keys,op.operationId)).rejects.toMatchObject({code:'CONFIGURATION_UNAVAILABLE'});
    } finally {sqlite.close();}
  });
});


it('reserves the tenth slot across Direct and Hyperdrive admission, including direct SQL',async()=>{
  const {sqlite,db}=fixture();
  try {
    for(let i=0;i<9;i++) await createRegistryConnection(db,{id:'direct_'+i,dialect:'mysql',
      ciphertext:'opaque.encrypted.synthetic',keyId:'active'});
    await createHyperdrivePreparation(db,keys,candidate);
    await expect(createRegistryConnection(db,{id:'eleventh',dialect:'mysql',
      ciphertext:'opaque.encrypted.synthetic',keyId:'active'})).rejects.toMatchObject({code:'RATE_LIMITED'});
    expect(()=>sqlite.prepare(`INSERT INTO database_connections(id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at)
      VALUES ('raw','mysql','direct','disabled','opaque','active',1,1,1)`).run()).toThrow(/reservation conflict/);
    await expect(rotateRegistryKeys(db,keys)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  }finally {sqlite.close();}
});

it('final apply claim cannot race or overwrite a faster Runner and cannot apply expired operations',async()=>{
  const {claimHyperdriveApply,recordHyperdriveApplyDispatch}=await import('../../src/setup/hyperdrive-operations.js');
  const {sqlite,db}=fixture();
  try {
    const op=await createHyperdrivePreparation(db,keys,candidate);
    const ready=()=>sqlite.prepare(`UPDATE hyperdrive_operations SET phase='awaiting_confirmation',
      expected_source_sha=?,head_sha=?,config_id=?,binding_name='HYPERDRIVE_NEW',pr_number=3,ciphertext=NULL,key_id=NULL
      WHERE operation_id=?`).run('a'.repeat(40),'b'.repeat(40),'c'.repeat(32),op.operationId);
    await expect(claimHyperdriveApply(db,op.operationId,candidate.id)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    ready();
    const shortExpiry = sqlite.prepare('SELECT expires_at FROM hyperdrive_operations')
      .get() as { expires_at: number };
    await claimHyperdriveApply(db,op.operationId,candidate.id);
    const renewed = sqlite.prepare('SELECT expires_at,ciphertext,key_id FROM hyperdrive_operations')
      .get() as { expires_at: number; ciphertext: string | null; key_id: string | null };
    expect(renewed.expires_at).toBeGreaterThan(shortExpiry.expires_at);
    expect(renewed.expires_at).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
    expect(renewed.ciphertext).toBeNull();
    expect(renewed.key_id).toBeNull();
    await expect(claimHyperdriveApply(db,op.operationId,candidate.id)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    sqlite.prepare("UPDATE hyperdrive_operations SET apply_run_id=71,error_class='apply_release_pending',release_run_id=99").run();
    await recordHyperdriveApplyDispatch(db,op.operationId,71);
    expect(sqlite.prepare('SELECT phase,error_class,release_run_id FROM hyperdrive_operations').get())
      .toMatchObject({phase:'running',error_class:'apply_release_pending',release_run_id:99});
    ready();
    sqlite.prepare('UPDATE hyperdrive_operations SET expires_at=1,apply_run_id=NULL').run();
    await expect(claimHyperdriveApply(db,op.operationId,candidate.id)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  } finally {sqlite.close();}
});


it('exposes only validated candidate CI receipts and fixed blocked reasons',async()=>{
  const {sqlite,db}=fixture();
  try {
    await createHyperdrivePreparation(db,keys,candidate);
    for(const reason of ['apply_ci_receipt_unknown','apply_ci_pending','apply_ci_failed']) {
      sqlite.prepare("UPDATE hyperdrive_operations SET phase='unknown',ci_run_id=98,error_class=?").run(reason);
      expect((await listHyperdriveOperations(db))[0]).toMatchObject({ci_run_id:98,error_class:reason});
    }
    sqlite.prepare('UPDATE hyperdrive_operations SET ci_run_id=-1').run();
    await expect(listHyperdriveOperations(db)).rejects.toMatchObject({code:'CONFIGURATION_UNAVAILABLE'});
  } finally {sqlite.close();}
});


it('Owner stores a revision-bound, encrypted credential rotation request', async () => {
 const {createHyperdriveCredentialRotation}=await import('../../src/setup/hyperdrive-operations.js');
 const {sqlite,db}=fixture();
 try {
  sqlite.prepare(`INSERT INTO database_connections
   (id,dialect,transport,status,revision,config_id,binding_name,target_metadata,created_at,updated_at)
   VALUES ('isolated','mysql','hyperdrive','disabled',4,?,?,?,1,1)`)
   .run('a'.repeat(32),'HYPERDRIVE_ISOLATED','{"dialect":"mysql"}');
  const op=await createHyperdriveCredentialRotation(db,keys,'isolated',4,'synthetic-test-credential');
  expect(op).toMatchObject({id:'isolated',phase:'pending',action:'rotate_credentials'});
  const stored=sqlite.prepare('SELECT action,expected_revision,config_id,binding_name,ciphertext,key_id FROM hyperdrive_operations WHERE operation_id=?').get(op.operationId) as Record<string,unknown>;
  expect(stored).toMatchObject({action:'rotate_credentials',expected_revision:4,config_id:'a'.repeat(32),binding_name:'HYPERDRIVE_ISOLATED',key_id:'active'});
  expect(JSON.stringify(stored)).not.toContain('synthetic-test-credential');
  expect(JSON.stringify(await listHyperdriveOperations(db))).not.toContain('synthetic-test-credential');
  await expect(createHyperdriveCredentialRotation(db,keys,'isolated',4,'synthetic-new')).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  await expect(createHyperdriveCredentialRotation(db,keys,'isolated',5,'synthetic-new')).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  await expect(createHyperdriveCredentialRotation(db,keys,'isolated',4,'')).rejects.toMatchObject({code:'INVALID_INPUT'});
 } finally {sqlite.close();}
});


it('expired credential operation preserves ambiguity only after the upstream write is claimed',async()=>{
 const {createHyperdriveCredentialRotation}=await import('../../src/setup/hyperdrive-operations.js');
 const {sqlite,db}=fixture();
 try{
  sqlite.prepare(`INSERT INTO database_connections
    (id,dialect,transport,status,revision,config_id,binding_name,target_metadata,created_at,updated_at)
    VALUES ('expiring','mysql','hyperdrive','disabled',4,?,?,?,1,1)`)
   .run('b'.repeat(32),'HYPERDRIVE_EXPIRING','{"dialect":"mysql"}');
  const before=await createHyperdriveCredentialRotation(db,keys,'expiring',4,'synthetic-secret-one');
  await claimHyperdriveDispatch(db,before.operationId);
  sqlite.prepare('UPDATE hyperdrive_operations SET expires_at=1 WHERE operation_id=?').run(before.operationId);
  await expireHyperdrivePreparations(db);
  expect(sqlite.prepare('SELECT phase,ciphertext,key_id FROM hyperdrive_operations WHERE operation_id=?').get(before.operationId))
   .toMatchObject({phase:'failed',ciphertext:null,key_id:null});
  const after=await createHyperdriveCredentialRotation(db,keys,'expiring',4,'synthetic-secret-two');
  await claimHyperdriveDispatch(db,after.operationId);
  sqlite.prepare('UPDATE hyperdrive_operations SET resource_write_started_at=100,expires_at=1 WHERE operation_id=?').run(after.operationId);
  await expireHyperdrivePreparations(db);
  expect(sqlite.prepare('SELECT phase,error_class,ciphertext,key_id FROM hyperdrive_operations WHERE operation_id=?').get(after.operationId))
   .toMatchObject({phase:'unknown',error_class:'credential_outcome_unknown',ciphertext:null,key_id:null});
  await expect(createHyperdriveCredentialRotation(db,keys,'expiring',4,'synthetic-secret-three')).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 }finally{sqlite.close();}
});
