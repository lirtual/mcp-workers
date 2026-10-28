// Offline-only transaction contract for a future separately authorized Direct cutover.
// Do not invoke against production or expose this helper through any workflow.
import { verifyDirectCutoverPreflight } from './database-direct-preflight-344.mjs';

function reject() {
  throw Error('Direct cutover transaction contract rejected inconsistent state (no values disclosed)');
}

/**
 * Return a parameterized, single-statement two-record compare-and-swap after
 * authenticating both AES-GCM ciphertexts against approved legacy connection URLs.
 * This function does not execute SQL or perform any network I/O.
 */
export async function prepareDirectActivationStatement({
  rows, originalConfig, encryptionKey, keyId, now
}) {
  await verifyDirectCutoverPreflight({ rows, originalConfig, encryptionKey, keyId });
  if (!Number.isSafeInteger(now) || now <= 0) reject();

  // MATERIALIZED freezes the all-or-nothing eligibility before the first row
  // is changed. Inventory/retirement predicates prevent an unexpected extra ID.
  // Bind actual authenticated ciphertext so a post-preflight credential change
  // prevents both rows from changing.
  const sql = `
WITH eligible AS MATERIALIZED (
  SELECT COUNT(*) AS n FROM database_connections
  WHERE status='disabled' AND revision=1 AND dialect='mysql'
    AND transport='direct' AND key_id=?
    AND ((id='b2b' AND ciphertext=?) OR (id='scrape_relay' AND ciphertext=?))
),
inventory AS MATERIALIZED (SELECT COUNT(*) AS n FROM database_connections),
retired AS MATERIALIZED (SELECT COUNT(*) AS n FROM retired_connection_ids)
UPDATE database_connections
  SET status='active', revision=revision+1, updated_at=?
WHERE status='disabled' AND revision=1 AND dialect='mysql'
  AND transport='direct' AND key_id=?
  AND ((id='b2b' AND ciphertext=?) OR (id='scrape_relay' AND ciphertext=?))
  AND (SELECT n FROM eligible)=2
  AND (SELECT n FROM inventory)=2
  AND (SELECT n FROM retired)=0
RETURNING id,status,revision,key_id`.trim();

  const params = [
    keyId, rows[0].ciphertext, rows[1].ciphertext,
    now, keyId, rows[0].ciphertext, rows[1].ciphertext
  ];
  return { sql, params, expectedChanges: 2 };
}

/**
 * Offline-only symmetric rollback contract. A production runner MUST first
 * independently prove the original Worker/Secret is serving traffic or has
 * been restored; this function never checks deployment and never runs SQL.
 * A release-phase authenticated readback is required before preparing SQL.
 */
export async function prepareDirectRollbackStatement({
  rows, originalConfig, encryptionKey, keyId, now
}) {
  await verifyDirectCutoverPreflight({
    rows, originalConfig, encryptionKey, keyId, phase: 'release'
  });
  if (!Number.isSafeInteger(now) || now <= 0) reject();

  // In SQLite, one UPDATE statement is atomic. The materialized eligibility
  // requires BOTH authenticated ciphertexts at exact active revision 2.
  // A concurrently changed record, extra identity or retired identity makes
  // the affected set empty instead of disabling just one connection.
  const sql = `
WITH eligible AS MATERIALIZED (
  SELECT COUNT(*) AS n FROM database_connections
  WHERE status='active' AND revision=2 AND dialect='mysql'
    AND transport='direct' AND key_id=?
    AND ((id='b2b' AND ciphertext=?) OR (id='scrape_relay' AND ciphertext=?))
),
inventory AS MATERIALIZED (SELECT COUNT(*) AS n FROM database_connections),
retired AS MATERIALIZED (SELECT COUNT(*) AS n FROM retired_connection_ids)
UPDATE database_connections
  SET status='disabled', revision=revision+1, updated_at=?
WHERE status='active' AND revision=2 AND dialect='mysql'
  AND transport='direct' AND key_id=?
  AND ((id='b2b' AND ciphertext=?) OR (id='scrape_relay' AND ciphertext=?))
  AND (SELECT n FROM eligible)=2
  AND (SELECT n FROM inventory)=2
  AND (SELECT n FROM retired)=0
RETURNING id,status,revision,key_id`.trim();
  return {
    sql,
    params: [
      keyId, rows[0].ciphertext, rows[1].ciphertext,
      now, keyId, rows[0].ciphertext, rows[1].ciphertext
    ],
    expectedChanges: 2
  };
}
