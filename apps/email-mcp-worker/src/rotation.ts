import { currentKeyId, decrypt, encrypt, sha256 } from './crypto.ts';
import { fail } from './types.ts';
import type { Env, MailAccount } from './types.ts';

/**
 * Owner initiated, bounded, resumable application-layer key rotation.
 * Old key MUST remain available until pending is zero and readback succeeds.
 * Concurrent key changes use the encrypted blob as a compare-and-update guard.
 */
export async function rotateCredentials(env: Env): Promise<{ rotated: number; pending: number }> {
  if (!env.MAIL_ENCRYPTION_PREVIOUS_KEY || !env.MAIL_PREVIOUS_KEY_ID ||
    env.MAIL_PREVIOUS_KEY_ID === currentKeyId(env)) fail('rotation_not_configured');
  let rotated = 0;
  const rows = await env.DB.prepare('SELECT * FROM mail_accounts WHERE credential_key_id!=? ORDER BY created_at LIMIT 16')
    .bind(currentKeyId(env)).all<MailAccount>();
  for (const account of rows.results) {
    const context = 'account:' + account.account_id + ':' + account.provider;
    const credentials = await decrypt<unknown>(env, context, account.credential_ciphertext, account.credential_key_id);
    const proof = await sha256(JSON.stringify(credentials));
    const newRecord = await encrypt(env, context, credentials);
    if (newRecord.keyId !== currentKeyId(env) ||
      proof !== await sha256(JSON.stringify(await decrypt(env, context, newRecord.ciphertext, newRecord.keyId))))
      fail('rotation_verification_failed');
    const result = await env.DB.prepare(
      'UPDATE mail_accounts SET credential_ciphertext=?,credential_key_id=?,updated_at=? WHERE account_id=? AND credential_ciphertext=? AND credential_key_id=?',
    ).bind(newRecord.ciphertext, newRecord.keyId, Math.floor(Date.now() / 1000),
      account.account_id, account.credential_ciphertext, account.credential_key_id).run();
    rotated += result.meta.changes ?? 0;
  }
  const outstanding = await env.DB.prepare(
    'SELECT count(*) AS pending FROM mail_accounts WHERE credential_key_id!=?',
  ).bind(currentKeyId(env)).first<{ pending: number }>();
  return { rotated, pending: outstanding?.pending ?? 0 };
}
