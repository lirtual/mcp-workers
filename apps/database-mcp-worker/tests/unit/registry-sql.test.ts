import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { createRegistryConnection, getRegistryConnection, listRegistryConnections, updateRegistryConnection,
  setRegistryConnectionStatus, deleteRegistryConnection } from '../../src/registry/store.js';
import type { D1Database } from '@cloudflare/workers-types';
import { admitConnection, catalogMetadata } from "../../src/registry/admission.js";
import { sealConnectionConfig, openConnectionConfig } from "../../src/registry/crypto.js";
import { rotateRegistryKeys } from "../../src/registry/rotation.js";

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../migrations/0001_connections.sql', import.meta.url), 'utf8'));
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
  it('permits zero records; inserts only up to 50 even on concurrent last-slot admissions', async () => {
    const f = fixture(); all.push(f.sqlite);
    expect(await listRegistryConnections(f.db)).toEqual([]);
    await Promise.all(Array.from({ length: 49 }, (_, i) => createRegistryConnection(f.db, input('db' + i))));
    const contenders = await Promise.allSettled([createRegistryConnection(f.db, input('db49')), createRegistryConnection(f.db, input('db50'))]);
    expect(contenders.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await listRegistryConnections(f.db)).length).toBe(50);
    const results = await Promise.allSettled([createRegistryConnection(f.db, input('slotA')), createRegistryConnection(f.db, input('slotB'))]);
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect((await listRegistryConnections(f.db)).length).toBe(50);
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
    const sealed = await sealConnectionConfig(env, 'main', 'postgres', { url: 'postgres://u@db.example.net/catalog' });
    await createRegistryConnection(f.db, { id: 'main', dialect: 'postgres', ciphertext: sealed.ciphertext, keyId: sealed.keyId });
    await setRegistryConnectionStatus(f.db, 'main', 1, 'active');
    const previous = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] });
    try {
      const admitted = await admitConnection(env, 'main');
      expect(admitted).toMatchObject({ dialect: 'postgres', host: 'db.example.net', transport: 'direct' });
      await setRegistryConnectionStatus(f.db, 'main', 2, 'disabled');
      await expect(admitConnection(env, 'main')).rejects.toMatchObject({ code: 'CONNECTION_DISABLED' });
    } finally { globalThis.fetch = previous; }
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
    expect(await openConnectionConfig(next, row!.id, row!.dialect, { keyId: row!.key_id, ciphertext: row!.ciphertext }))
      .toHaveProperty('url');
  });
});
