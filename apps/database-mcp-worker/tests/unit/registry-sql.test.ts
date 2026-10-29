import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { createRegistryConnection, getRegistryConnection, listRegistryConnections, updateRegistryConnection,
  setRegistryConnectionStatus, deleteRegistryConnection } from '../../src/registry/store.js';
import type { D1Database } from '@cloudflare/workers-types';
import { admitConnection, catalogMetadata } from "../../src/registry/admission.js";
import { isAvailableMode } from '../../src/registry/availability.js';
import { sealConnectionConfig, openConnectionConfig } from "../../src/registry/crypto.js";
import { rotateRegistryKeys } from "../../src/registry/rotation.js";

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../migrations/0001_connections.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0002_transport_and_retired_ids.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0003_hyperdrive_operations.sql', import.meta.url), 'utf8'));
  function statement(sql: string, args: unknown[] = []) {
    const prepared = sqlite.prepare(sql);
    return {
      bind(...next: unknown[]) { return statement(sql, next); },
      async run() { const result = prepared.run(...args as []); return { meta: { changes: result.changes } }; },
      async first<T>() { return (prepared.get(...args as []) as T) ?? null; },
      async all<T>() { return { results: prepared.all(...args as []) as T[] }; }
    };
  }
  const db = { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
  return { sqlite, db };
}
const ciphertext = 'opaque.encrypted.value';
const input = (id: string) => ({ id, dialect: 'postgres' as const, ciphertext, keyId: 'key1' });
const all: DatabaseSync[] = [];
afterEach(() => { all.splice(0).forEach(db => db.close()); });

describe('actual D1 registry SQL', () => {
  it('permits zero records; inserts only up to 10 even on concurrent last-slot admissions', async () => {
    const f = fixture(); all.push(f.sqlite);
    expect(await listRegistryConnections(f.db)).toEqual([]);
    await Promise.all(Array.from({ length: 9 }, (_, i) => createRegistryConnection(f.db, input('db' + i))));
    const contenders = await Promise.allSettled([createRegistryConnection(f.db, input('db9')), createRegistryConnection(f.db, input('db10'))]);
    expect(contenders.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await listRegistryConnections(f.db)).length).toBe(10);
    const results = await Promise.allSettled([createRegistryConnection(f.db, input('slotA')), createRegistryConnection(f.db, input('slotB'))]);
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect((await listRegistryConnections(f.db)).length).toBe(10);
  });
  it('enforces immutable dialect and revision CAS on edit, disable, enable, delete', async () => {
    const f = fixture(); all.push(f.sqlite);
    await createRegistryConnection(f.db, input('primary'));
    const [row] = await listRegistryConnections(f.db);
    expect(row).toMatchObject({ id: 'primary', status: 'disabled', revision: 1, dialect: 'postgres' });
    expect(JSON.stringify(row)).not.toContain(ciphertext);
    await expect(updateRegistryConnection(f.db, 'primary', 1, { dialect: 'mysql', ciphertext: 'new', keyId: 'key2' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await updateRegistryConnection(f.db, 'primary', 1, { dialect: 'postgres', ciphertext: 'new', keyId: 'key2' });
    await expect(setRegistryConnectionStatus(f.db, 'primary', 1, 'active')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await setRegistryConnectionStatus(f.db, 'primary', 2, 'active');
    await expect(deleteRegistryConnection(f.db, 'primary', 3, 'primary')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await setRegistryConnectionStatus(f.db, 'primary', 3, 'disabled');
    await expect(deleteRegistryConnection(f.db, 'primary', 3, 'primary')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(deleteRegistryConnection(f.db, 'primary', 4, 'wrong')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await deleteRegistryConnection(f.db, 'primary', 4, 'primary');
    expect(await listRegistryConnections(f.db)).toEqual([]);
  });
  it('rejects simultaneous updates on the same revision; does not clobber newer ciphertext', async () => {
    const f = fixture(); all.push(f.sqlite);
    await createRegistryConnection(f.db, input('primary'));
    const results = await Promise.allSettled([
      updateRegistryConnection(f.db, 'primary', 1, { dialect: 'postgres', ciphertext: 'valueA', keyId: 'key2' }),
      updateRegistryConnection(f.db, 'primary', 1, { dialect: 'postgres', ciphertext: 'valueB', keyId: 'key2' })
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await listRegistryConnections(f.db))[0]?.revision).toBe(2);
  });
});

describe('connection admission from D1', () => {
  it('empty catalog is valid; an SQL admission must fail explicitly', async () => {
    const f = fixture(); all.push(f.sqlite);
    const env = { DB: f.db } as Parameters<typeof admitConnection>[0];
    expect(await catalogMetadata(env)).toEqual([]);
    await expect(admitConnection(env)).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });
  it('rejects disabled connections before attempting to decrypt', async () => {
    const f = fixture(); all.push(f.sqlite);
    await createRegistryConnection(f.db, input('primary'));
    await expect(admitConnection({ DB: f.db } as Parameters<typeof admitConnection>[0], 'primary'))
      .rejects.toMatchObject({ code: 'CONNECTION_DISABLED' });
  });
});

describe('fresh admission of a validated connection', () => {
  it('re-reads D1 status and decrypts only a currently active row', async () => {
    const f = fixture(); all.push(f.sqlite);
    const env = { DB: f.db, DATABASE_ENCRYPTION_KEY: btoa('q'.repeat(32)), DATABASE_KEY_ID: 'key1',
      RATE_LIMITER: { async limit() { return { success: true }; } } };
    const sealed = await sealConnectionConfig(env, 'main', 'mysql', { url: 'mysql://u@db.example.net/catalog' });
    await createRegistryConnection(f.db, { id: 'main', dialect: 'mysql', ciphertext: sealed.ciphertext, keyId: sealed.keyId });
    await setRegistryConnectionStatus(f.db, 'main', 1, 'active');
    const previous = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] });
    try {
      const admitted = await admitConnection(env, 'main');
      expect(admitted).toMatchObject({ dialect: 'mysql', host: 'db.example.net', transport: 'direct' });
      await setRegistryConnectionStatus(f.db, 'main', 2, 'disabled');
      await expect(admitConnection(env, 'main')).rejects.toMatchObject({ code: 'CONNECTION_DISABLED' });
    } finally { globalThis.fetch = previous; }
  });
});

describe('three-mode Owner and MCP admission enforcement', () => {
  it('permits only MySQL Direct plus both Hyperdrive dialects', () => {
    expect(isAvailableMode('direct', 'mysql')).toBe(true);
    expect(isAvailableMode('hyperdrive', 'mysql')).toBe(true);
    expect(isAvailableMode('hyperdrive', 'postgres')).toBe(true);
    expect(isAvailableMode('direct', 'postgres')).toBe(false);
  });
  it('rejects an already-active PostgreSQL Direct row before credential decryption', async () => {
    const f = fixture(); all.push(f.sqlite);
    const env = { DB: f.db } as Parameters<typeof admitConnection>[0];
    await createRegistryConnection(f.db, input('pg_active'));
    await setRegistryConnectionStatus(f.db, 'pg_active', 1, 'active');
    await expect(admitConnection(env, 'pg_active'))
      .rejects.toMatchObject({
        code: 'CONFIGURATION_UNAVAILABLE',
        message: 'This connection mode is not enabled for this release.'
      });
    await createRegistryConnection(f.db, { id: 'hyperdrive_active', dialect: 'mysql', transport: 'hyperdrive',
      configId: '11111111-2222-3333-4444-555555555555', bindingName: 'HYPERDRIVE_MYSQL' });
    await setRegistryConnectionStatus(f.db, 'hyperdrive_active', 1, 'active');
    await expect(admitConnection(env, 'hyperdrive_active'))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
  });
});

describe('bounded and resumable registry key rotation', () => {
  it('preserves stored credentials across single-row re-encryption and resume', async () => {
    const f = fixture(); all.push(f.sqlite);
    const old = { DATABASE_ENCRYPTION_KEY: btoa('a'.repeat(32)), DATABASE_KEY_ID: 'old' };
    const next = { DATABASE_ENCRYPTION_KEY: btoa('b'.repeat(32)), DATABASE_KEY_ID: 'new',
      DATABASE_ENCRYPTION_PREVIOUS_KEY: old.DATABASE_ENCRYPTION_KEY, DATABASE_PREVIOUS_KEY_ID: 'old' };
    for (const id of ['one', 'two']) {
      const sealed = await sealConnectionConfig(old, id, 'postgres', { url: 'postgres://u@db.example.net/catalog' });
      await createRegistryConnection(f.db, { id, dialect: 'postgres', ciphertext: sealed.ciphertext, keyId: sealed.keyId });
    }
    expect(await rotateRegistryKeys(f.db, next, 1)).toEqual({ rotated: 1, pending: 1 });
    expect(await rotateRegistryKeys(f.db, next, 1)).toEqual({ rotated: 1, pending: 0 });
    expect(await rotateRegistryKeys(f.db, next, 1)).toEqual({ rotated: 0, pending: 0 });
    const row = await getRegistryConnection(f.db, 'one');
    expect(row?.key_id).toBe('new');
    expect(await openConnectionConfig(next, row!.id, row!.dialect, { keyId: row!.key_id!, ciphertext: row!.ciphertext! }))
      .toHaveProperty('url');
  });
});

describe('Owner-managed registry rotation without migration locks', () => {
  it('rotates new disabled connections independently and never activates them', async () => {
    const f = fixture(); all.push(f.sqlite);
    const old = { DATABASE_ENCRYPTION_KEY: btoa('a'.repeat(32)), DATABASE_KEY_ID: 'old' };
    const next = { DATABASE_ENCRYPTION_KEY: btoa('b'.repeat(32)), DATABASE_KEY_ID: 'new',
      DATABASE_ENCRYPTION_PREVIOUS_KEY: old.DATABASE_ENCRYPTION_KEY, DATABASE_PREVIOUS_KEY_ID: 'old' };
    for (const id of ['sample_a', 'sample_b']) {
      const sealed = await sealConnectionConfig(old, id, 'mysql', { url: 'mysql://reader@db.example.net/catalog' });
      await createRegistryConnection(f.db, { id, dialect: 'mysql', ciphertext: sealed.ciphertext, keyId: sealed.keyId });
    }
    expect(await rotateRegistryKeys(f.db, next, 10)).toEqual({ rotated: 2, pending: 0 });
    const rows = f.sqlite.prepare('SELECT status, revision, key_id FROM database_connections ORDER BY id').all();
    expect(rows).toEqual([{ status: 'disabled', revision: 2, key_id: 'new' },
      { status: 'disabled', revision: 2, key_id: 'new' }]);
  });
});

describe('immutable connection identity', () => {
  it('reports duplicate ids as a stable conflict without replacing the original row', async () => {
    const f = fixture(); all.push(f.sqlite);
    await createRegistryConnection(f.db, input('same'));
    await expect(createRegistryConnection(f.db, input('same'))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await getRegistryConnection(f.db, 'same'))?.revision).toBe(1);
  });
});


describe('retired connection ids', () => {
  it('never reassigns a deleted id, even when the ten-record capacity is freed', async () => {
    const f = fixture(); all.push(f.sqlite);
    await createRegistryConnection(f.db, input('retired'));
    await deleteRegistryConnection(f.db, 'retired', 1, 'retired');
    await expect(createRegistryConnection(f.db, input('retired')))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(f.sqlite.prepare('SELECT id FROM retired_connection_ids').all()).toEqual([{ id: 'retired' }]);
  });
  it('preserves existing ciphertext and records the transport during additive migration', () => {
    const f = fixture(); all.push(f.sqlite);
    const row = f.sqlite.prepare('PRAGMA table_info(database_connections)').all();
    expect(row).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'transport' })]));
    const columns = f.sqlite.prepare('SELECT transport,ciphertext,key_id FROM database_connections').all();
    expect(columns).toEqual([]);
  });
});


describe('Hyperdrive metadata-only lifecycle', () => {
  it('persists only a dedicated reference, disabled by default, and rejects duplicate config IDs', async () => {
    const f = fixture(); all.push(f.sqlite);
    const ref = { id: 'proxy_mysql', dialect: 'mysql' as const, transport: 'hyperdrive' as const,
      configId: '11111111-2222-3333-4444-555555555555', bindingName: 'HYPERDRIVE_MYSQL' };
    await createRegistryConnection(f.db, ref);
    expect(await getRegistryConnection(f.db, ref.id)).toMatchObject({
      id: ref.id, dialect: 'mysql', transport: 'hyperdrive', status: 'disabled',
      ciphertext: null, key_id: null, config_id: ref.configId, binding_name: ref.bindingName
    });
    const records = await listRegistryConnections(f.db);
    expect(JSON.stringify(records)).not.toContain('11111111');
    await expect(admitConnection({ DB: f.db } as Parameters<typeof admitConnection>[0], ref.id))
      .rejects.toMatchObject({ code: 'CONNECTION_DISABLED' });
    await expect(createRegistryConnection(f.db, { ...ref, id: 'proxy_pg', dialect: 'postgres', bindingName: 'HYPERDRIVE_PG' }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(updateRegistryConnection(f.db, ref.id, 1, { dialect: 'mysql', ciphertext, keyId: 'key1' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('does not execute or fall back to Direct if an active Hyperdrive Binding is absent', async () => {
    const f = fixture(); all.push(f.sqlite);
    await createRegistryConnection(f.db, { id: 'missing', dialect: 'postgres', transport: 'hyperdrive',
      configId: '11111111-2222-3333-4444-555555555555', bindingName: 'HYPERDRIVE_MISSING' });
    await setRegistryConnectionStatus(f.db, 'missing', 1, 'active');
    await expect(admitConnection({ DB: f.db } as Parameters<typeof admitConnection>[0], 'missing'))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
  });
});


describe('legacy encrypted transport migration', () => {
  it('conserves encrypted credentials but disables active old rows instead of silently downgrading TLS to plaintext', () => {
    const db = new DatabaseSync(':memory:'); all.push(db);
    db.exec(readFileSync(new URL('../../migrations/0001_connections.sql', import.meta.url), 'utf8'));
    db.prepare(`INSERT INTO database_connections(id,dialect,status,ciphertext,key_id,revision,created_at,updated_at)
      VALUES ('old_mysql','mysql','active','opaque.original','old_key',4,1,2)`).run();
    db.exec(readFileSync(new URL('../../migrations/0002_transport_and_retired_ids.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT transport,status,ciphertext,key_id,revision FROM database_connections WHERE id=?').get('old_mysql'))
      .toEqual({transport:'direct',status:'disabled',ciphertext:'opaque.original',key_id:'old_key',revision:5});
  });
});
