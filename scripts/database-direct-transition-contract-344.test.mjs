import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { encryptDirect } from './database-prep-344.mjs';
import { prepareDirectActivationStatement, prepareDirectRollbackStatement } from './database-direct-transition-contract-344.mjs';

const key = Buffer.alloc(32, 31).toString('base64');
const keyId = 'db344-20261028';
const URLs = {
  b2b: 'mysql://synthetic:secret@db-b.example.net:3306/sample',
  scrape_relay: 'mysql://synthetic:secret@db-r.example.net:3306/sample'
};

async function fixture() {
  const rows = [];
  for (const id of ['b2b', 'scrape_relay']) {
    rows.push({
      id, dialect: 'mysql', transport: 'direct', status: 'disabled',
      revision: 1, key_id: keyId, config_id: null, binding_name: null,
      ciphertext: await encryptDirect(id, URLs[id], key)
    });
  }
  return {
    rows, originalConfig: JSON.stringify(URLs), encryptionKey: key,
    keyId, now: 1793160000000
  };
}
function database(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../apps/database-mcp-worker/migrations/0001_connections.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../apps/database-mcp-worker/migrations/0002_transport_and_retired_ids.sql', import.meta.url), 'utf8'));
  const insert = db.prepare(`INSERT INTO database_connections
    (id,dialect,transport,status,ciphertext,key_id,config_id,binding_name,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) insert.run(r.id,r.dialect,r.transport,r.status,r.ciphertext,
    r.key_id,r.config_id,r.binding_name,r.revision,1,1);
  return db;
}
const state = db => db.prepare('SELECT id,status,revision,key_id,ciphertext FROM database_connections ORDER BY id').all();
const execute = (db, prepared) => db.prepare(prepared.sql).all(...prepared.params);

test('one SQLite statement enables exactly both records with expected revisions', async () => {
  const input = await fixture();
  const prepared = await prepareDirectActivationStatement(input);
  assert.equal(prepared.expectedChanges, 2);
  assert.equal(prepared.params.length, 7);
  assert.doesNotMatch(prepared.sql, /mysql:\/\/|synthetic:secret/);
  const db = database(input.rows);
  try {
    assert.deepEqual(execute(db, prepared).map(r=>r.id), ['b2b','scrape_relay']);
    const rows = state(db);
    assert.ok(rows.every(r => r.status === 'active' && r.revision === 2 &&
      r.key_id === keyId));
    // Replays, including after a lost acknowledgment, cannot mutate again.
    assert.deepEqual(execute(db, prepared), []);
    assert.deepEqual(state(db), rows);
  } finally { db.close(); }
});

test('stale revision/status/key/ciphertext and extra inventory never partially enable', async () => {
  const input = await fixture();
  const prepared = await prepareDirectActivationStatement(input);
  for (const mutate of [
    db => db.prepare("UPDATE database_connections SET revision=2 WHERE id='b2b'").run(),
    db => db.prepare("UPDATE database_connections SET status='active' WHERE id='scrape_relay'").run(),
    db => db.prepare("UPDATE database_connections SET key_id='other' WHERE id='b2b'").run(),
    db => db.prepare("UPDATE database_connections SET ciphertext='changed' WHERE id='b2b'").run(),
    db => db.prepare("INSERT INTO database_connections(id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at) VALUES ('extra','mysql','direct','disabled','fake','id',1,1,1)").run(),
    db => db.prepare("INSERT INTO retired_connection_ids(id,retired_at) VALUES ('other',1)").run()
  ]) {
    const db = database(input.rows);
    try {
      mutate(db);
      const before = state(db);
      assert.deepEqual(execute(db, prepared), []);
      assert.deepEqual(state(db), before);
    } finally { db.close(); }
  }
});

test('the SQL builder fails closed for invalid approvals without executing anything', async () => {
  const input = await fixture();
  for (const mutate of [
    x=>{ x.now = 0; }, x=>{ x.now = Number.MAX_SAFE_INTEGER+1; },
    x=>{ x.rows[0].status = 'active'; }, x=>{ x.rows.reverse(); },
    x=>{ x.rows[1].revision=2; }, x=>{ x.keyId='wrong'; },
    x=>{ x.originalConfig=JSON.stringify({ ...URLs, b2b:'mysql://new:secret@changed.example.net/x' }); }
  ]) {
    const next=structuredClone(input); mutate(next);
    await assert.rejects(prepareDirectActivationStatement(next));
  }
});

test('offline rollback reverses both active revision-2 rows together, preserves ciphertext and refuses replay', async () => {
  const initial = await fixture();
  const activation = await prepareDirectActivationStatement(initial);
  const db = database(initial.rows);
  try {
    assert.equal(execute(db, activation).length, 2);
    const activeRows = initial.rows.map(r => ({ ...r, status: 'active', revision: 2 }));
    const rollback = await prepareDirectRollbackStatement({
      ...initial, rows: activeRows, now: initial.now + 1
    });
    assert.equal(rollback.expectedChanges, 2);
    assert.equal(rollback.params.length, 7);
    assert.doesNotMatch(rollback.sql, /mysql:\/\/|synthetic:secret/);
    assert.deepEqual(execute(db, rollback).map(r => r.id), ['b2b', 'scrape_relay']);
    const after = state(db);
    assert.ok(after.every((r, i) => r.status === 'disabled' &&
      r.revision === 3 && r.key_id === keyId &&
      r.ciphertext === initial.rows[i].ciphertext));
    assert.deepEqual(execute(db, rollback), []);
    assert.deepEqual(state(db), after);
    assert.deepEqual(execute(db, activation), []);
  } finally { db.close(); }
});

test('rollback never partially disables if either active record changes after attestation', async () => {
  const initial = await fixture();
  const activation = await prepareDirectActivationStatement(initial);
  const activeRows = initial.rows.map(r => ({ ...r, status: 'active', revision: 2 }));
  const rollback = await prepareDirectRollbackStatement({
    ...initial, rows: activeRows, now: initial.now + 1
  });
  const mutations = [
    db => db.prepare("UPDATE database_connections SET revision=3 WHERE id='b2b'").run(),
    db => db.prepare("UPDATE database_connections SET status='disabled' WHERE id='scrape_relay'").run(),
    db => db.prepare("UPDATE database_connections SET key_id='rotated' WHERE id='b2b'").run(),
    db => db.prepare("UPDATE database_connections SET ciphertext='replaced' WHERE id='scrape_relay'").run(),
    db => db.prepare("INSERT INTO database_connections(id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at) VALUES ('other','mysql','direct','disabled','fake','id',1,1,1)").run(),
    db => db.prepare("INSERT INTO retired_connection_ids(id,retired_at) VALUES ('other',1)").run()
  ];
  for (const mutate of mutations) {
    const db = database(initial.rows);
    try {
      assert.equal(execute(db, activation).length, 2);
      mutate(db);
      const before = state(db);
      assert.deepEqual(execute(db, rollback), []);
      assert.deepEqual(state(db), before);
    } finally { db.close(); }
  }
});

test('rollback builder fails closed for inactive, stale, altered or mismatched approval data', async () => {
  const initial = await fixture();
  const activeRows = initial.rows.map(r => ({ ...r, status: 'active', revision: 2 }));
  const accepted = { ...initial, rows: activeRows, now: initial.now + 1 };
  for (const mutate of [
    x => { x.now = 0; },
    x => { x.now = Number.MAX_SAFE_INTEGER + 1; },
    x => { x.rows[0].revision = 1; },
    x => { x.rows[1].status = 'disabled'; },
    x => { x.rows.reverse(); },
    x => { x.rows[0].ciphertext = x.rows[1].ciphertext; },
    x => { x.keyId = 'not-the-key'; },
    x => { x.originalConfig = JSON.stringify({ ...URLs, scrape_relay: 'mysql://changed:secret@unexpected.example.net/db' }); }
  ]) {
    const input = structuredClone(accepted);
    mutate(input);
    await assert.rejects(prepareDirectRollbackStatement(input));
  }
});
