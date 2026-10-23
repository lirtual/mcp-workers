import type { Env } from './store.ts';

type EffectRow = {state: string; result: string | null; error_code: string | null};

export async function readProtectedEffect(db: Env['DB'], runId: string, stepId: string): Promise<EffectRow | null> {
  return db.prepare('SELECT state, result, error_code FROM protected_effects WHERE run_id=? AND step_id=?')
    .bind(runId, stepId).first<EffectRow>();
}

export async function grantRevoked(db: Env['DB'], versionId: string, grantKey: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS revoked FROM grant_revocations WHERE version_id=? AND grant_key=?')
    .bind(versionId, grantKey).first<{revoked: number}>();
  return row !== null && row !== undefined;
}

/**
 * Register dispatch only while this version's grant is still present.
 * A row that already exists is reconciled, not rewritten. Revocation after
 * this insert cannot unsend a call that has left; revocation before it refuses.
 */
export async function beginProtectedDispatch(
  db: Env['DB'], runId: string, stepId: string, grantKey: string, versionId: string, at: number,
): Promise<'started' | 'revoked' | 'exists'> {
  const inserted = await db.prepare(
    `INSERT INTO protected_effects(run_id,step_id,grant_key,state,result,error_code,created_at,updated_at)
     SELECT ?,?,?, 'dispatching', NULL, NULL, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM grant_revocations WHERE version_id=? AND grant_key=?)
       AND NOT EXISTS (SELECT 1 FROM protected_effects WHERE run_id=? AND step_id=?)`,
  ).bind(runId, stepId, grantKey, at, at, versionId, grantKey, runId, stepId).run();
  if (inserted.meta.changes > 0) return 'started';
  const prior = await readProtectedEffect(db, runId, stepId);
  return prior ? 'exists' : 'revoked';
}

export async function finishProtectedDispatch(
  db: Env['DB'], runId: string, stepId: string, state: 'succeeded' | 'indeterminate',
  result: string | null, errorCode: string | null, at: number,
): Promise<void> {
  await db.prepare(
    "UPDATE protected_effects SET state=?, result=?, error_code=?, updated_at=? WHERE run_id=? AND step_id=? AND state='dispatching'",
  ).bind(state, result, errorCode, at, runId, stepId).run();
}
