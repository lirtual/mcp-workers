import { PublicError } from '../errors.js';
import type { Dialect } from '../types.js';
import { isStagedOriginalIdentity } from './availability.js';
import { openConnectionConfig, sealConnectionConfig, type EncryptionKeys } from './crypto.js';

interface RotationRow { id: string; dialect: Dialect; revision: number; ciphertext: string; key_id: string }
function fail(): never { throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The registry key rotation could not be completed.'); }

/** Caller must be the authenticated Owner. One bounded batch; repeat to resume. */
export async function rotateRegistryKeys(db: D1Database, keys: EncryptionKeys, batchSize = 10): Promise<{ rotated: number; pending: number }> {
  if (!db || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10 ||
    !keys.DATABASE_KEY_ID || !/^[A-Za-z0-9_-]{1,32}$/.test(keys.DATABASE_KEY_ID)) fail();
  try {
    // A rotation during first migration would change the frozen ciphertext/
    // revision and defeat the protected two-identity activation contract.
    const staged = await db.prepare("SELECT id,status,revision FROM database_connections WHERE id IN ('b2b','scrape_relay')")
      .all<{ id: string; status: string; revision: number }>();
    if (staged.results.some(isStagedOriginalIdentity)) fail();
    // Preflight every historic key identifier, not just the next batch.
    const distinct = await db.prepare("SELECT DISTINCT key_id FROM database_connections WHERE transport='direct' AND key_id<>?")
      .bind(keys.DATABASE_KEY_ID).all<{ key_id: string }>();
    if (distinct.results.some(row => row.key_id !== keys.DATABASE_PREVIOUS_KEY_ID ||
      !keys.DATABASE_ENCRYPTION_PREVIOUS_KEY)) {
      throw new PublicError('ENCRYPTION_KEY_UNAVAILABLE', 'A required database recovery key is unavailable.');
    }
    const source = await db.prepare(`SELECT id,dialect,revision,ciphertext,key_id FROM database_connections
      WHERE transport='direct' AND key_id<>? ORDER BY id LIMIT ?`).bind(keys.DATABASE_KEY_ID, batchSize).all<RotationRow>();
    let rotated = 0;
    for (const row of source.results) {
      const plaintext = await openConnectionConfig(keys, row.id, row.dialect,
        { keyId: row.key_id, ciphertext: row.ciphertext });
      const updated = await sealConnectionConfig(keys, row.id, row.dialect, plaintext);
      // Do not write a candidate that fails an authenticated readback.
      const readback = await openConnectionConfig(keys, row.id, row.dialect, updated);
      if (JSON.stringify(readback) !== JSON.stringify(plaintext)) fail();
      const result = await db.prepare(`UPDATE database_connections
        SET ciphertext=?,key_id=?,revision=revision+1,updated_at=?
        WHERE id=? AND dialect=? AND revision=? AND ciphertext=? AND key_id=?
          AND NOT (id IN ('b2b','scrape_relay') AND status='disabled' AND revision=1)`)
        .bind(updated.ciphertext, updated.keyId, Date.now(), row.id, row.dialect,
          row.revision, row.ciphertext, row.key_id).run();
      if (result.meta.changes === 1) rotated++;
      // Concurrent edit wins the CAS: do not overwrite newer credentials.
    }
    const result = await db.prepare("SELECT COUNT(*) AS n FROM database_connections WHERE transport='direct' AND key_id<>?")
      .bind(keys.DATABASE_KEY_ID).first<{ n: number }>();
    if (!result || !Number.isSafeInteger(result.n)) fail();
    return { rotated, pending: result.n };
  } catch (error) {
    if (error instanceof PublicError) throw error;
    return fail();
  }
}
