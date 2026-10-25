import { currentKeyId, decrypt, encrypt, sha256 } from './crypto.ts';
import { fail } from './types.ts';
import type { Env, MailAccount } from './types.ts';

type Session = {
  state_hash: string;
  pkce_ciphertext: string;
  key_id: string;
};
/**
 * Owner initiated, bounded, resumable application-layer key rotation.
 * Old key MUST remain available until pending is zero and readback succeeds.
 * Concurrent refresh is protected by the encrypted blob and token_version predicates.
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
      'UPDATE mail_accounts SET credential_ciphertext=?,credential_key_id=?,token_version=token_version+1,updated_at=? WHERE account_id=? AND credential_ciphertext=? AND credential_key_id=? AND token_version=?',
    ).bind(newRecord.ciphertext, newRecord.keyId, Math.floor(Date.now() / 1000),
      account.account_id, account.credential_ciphertext, account.credential_key_id, account.token_version).run();
    rotated += result.meta.changes ?? 0;
  }
  const now = Math.floor(Date.now() / 1000);
  const sessions = await env.DB.prepare(
    'SELECT state_hash,pkce_ciphertext,key_id FROM oauth_sessions WHERE key_id!=? AND consumed_at IS NULL AND expires_at>? LIMIT 16',
  ).bind(currentKeyId(env), now).all<Session>();
  for (const session of sessions.results) {
    const context = 'oauth:' + session.state_hash;
    const value = await decrypt<unknown>(env, context, session.pkce_ciphertext, session.key_id);
    const sealed = await encrypt(env, context, value);
    if (sealed.keyId !== currentKeyId(env) ||
      await sha256(JSON.stringify(value)) !==
        await sha256(JSON.stringify(await decrypt(env, context, sealed.ciphertext, sealed.keyId))))
      fail('rotation_verification_failed');
    const result = await env.DB.prepare(
      'UPDATE oauth_sessions SET pkce_ciphertext=?,key_id=? WHERE state_hash=? AND pkce_ciphertext=? AND key_id=? AND consumed_at IS NULL AND expires_at>?',
    ).bind(sealed.ciphertext, sealed.keyId, session.state_hash, session.pkce_ciphertext, session.key_id, now).run();
    rotated += result.meta.changes ?? 0;
  }
  const outstanding = await env.DB.prepare(
    'SELECT (SELECT count(*) FROM mail_accounts WHERE credential_key_id!=?) + (SELECT count(*) FROM oauth_sessions WHERE key_id!=? AND consumed_at IS NULL AND expires_at>?) AS pending',
  ).bind(currentKeyId(env), currentKeyId(env), now).first<{ pending: number }>();
  return { rotated, pending: outstanding?.pending ?? 0 };
}
