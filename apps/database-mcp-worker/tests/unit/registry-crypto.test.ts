import { describe, expect, it } from 'vitest';
import { openConnectionConfig, sealConnectionConfig } from '../../src/registry/crypto.js';

const first = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const next = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const keys = { DATABASE_ENCRYPTION_KEY: first, DATABASE_KEY_ID: 'key-a' };
const config = { url: 'postgres://worker:pw@db.example.com/app', ca: 'test-ca' };

describe('per-record D1 connection encryption', () => {
  it('uses unpredictable IV and binds id, dialect and purpose as authenticated data', async () => {
    const a = await sealConnectionConfig(keys, 'prod', 'postgres', config);
    const b = await sealConnectionConfig(keys, 'prod', 'postgres', config);
    expect(a.keyId).toBe('key-a');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await openConnectionConfig(keys, 'prod', 'postgres', a)).toEqual(config);
    for (const [id, dialect] of [['other', 'postgres'], ['prod', 'mysql']] as const) {
      await expect(openConnectionConfig(keys, id, dialect, a)).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    }
  });
  it('requires the historical recovery key when opening historical ciphertext', async () => {
    const historic = await sealConnectionConfig(keys, 'prod', 'postgres', config);
    await expect(openConnectionConfig({ DATABASE_ENCRYPTION_KEY: next, DATABASE_KEY_ID: 'key-b' }, 'prod', 'postgres', historic))
      .rejects.toMatchObject({ code: 'ENCRYPTION_KEY_UNAVAILABLE' });
    expect(await openConnectionConfig({ DATABASE_ENCRYPTION_KEY: next, DATABASE_KEY_ID: 'key-b',
      DATABASE_ENCRYPTION_PREVIOUS_KEY: first, DATABASE_PREVIOUS_KEY_ID: 'key-a'
    }, 'prod', 'postgres', historic)).toEqual(config);
  });
  it('rejects malformed key and corrupted ciphertext without disclosing secrets', async () => {
    await expect(sealConnectionConfig({ DATABASE_ENCRYPTION_KEY: 'bad', DATABASE_KEY_ID: 'key-a' }, 'prod', 'postgres', config))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    const sealed = await sealConnectionConfig(keys, 'prod', 'postgres', config);
    await expect(openConnectionConfig(keys, 'prod', 'postgres', { ...sealed, ciphertext: 'invalid' }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
  });
});
