import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptDirect } from './database-prep-344.mjs';
import { verifyDirectCutoverPreflight } from './database-direct-preflight-344.mjs';

const config = Object.freeze({
  b2b: 'mysql://test:example@db-b.example.net:3306/example',
  scrape_relay: 'mysql://test:example@db-a.example.net:3306/example'
});
const encryptionKey = Buffer.alloc(32, 17).toString('base64');
const keyId = 'db344-20261028';
async function fixture() {
  const rows = [];
  for (const id of ['b2b', 'scrape_relay']) {
    rows.push({
      id, dialect: 'mysql', transport: 'direct', status: 'disabled',
      revision: 1, key_id: keyId, config_id: null, binding_name: null,
      ciphertext: await encryptDirect(id, config[id], encryptionKey)
    });
  }
  return { rows, originalConfig: JSON.stringify(config), encryptionKey, keyId };
}

test('two matching disabled encrypted records authenticate without exposing secrets', async () => {
  const data = await fixture();
  const result = await verifyDirectCutoverPreflight(data);
  assert.deepEqual(result, { valid: true, ids: ['b2b', 'scrape_relay'], expectedRevision: 1 });
  assert.ok(!JSON.stringify(result).includes('mysql://'));
});

test('fail closed on incorrect, reordered, missing, extra or active identities', async () => {
  const base = await fixture();
  for (const mutate of [
    x => { x.rows.reverse(); },
    x => { x.rows.pop(); },
    x => { x.rows.push({ ...x.rows[0], id: 'other' }); },
    x => { x.rows[0].id = 'other'; },
    x => { x.rows[0].status = 'active'; },
    x => { x.rows[0].revision = 2; },
    x => { x.rows[1].transport = 'hyperdrive'; },
    x => { x.rows[1].config_id = 'hd'; },
    x => { x.rows[1].binding_name = 'HYPERDRIVE_B2B'; },
    x => { x.rows[1].key_id = 'wrong-id'; },
    x => { x.rows[0].dialect = 'postgres'; }
  ]) {
    const input = structuredClone(base);
    mutate(input);
    await assert.rejects(verifyDirectCutoverPreflight(input), /preflight failed/);
  }
});

test('fail closed on ciphertext substitution, tampering and key mismatch', async () => {
  const base = await fixture();
  for (const mutate of [
    x => { x.rows[0].ciphertext = x.rows[1].ciphertext; },
    x => { x.rows[0].ciphertext += '.extra'; },
    x => { x.rows[0].ciphertext = 'not-base64'; },
    x => { x.rows[0].ciphertext = x.rows[0].ciphertext.replace(/.$/, 'A'); },
    x => { x.encryptionKey = Buffer.alloc(32, 18).toString('base64'); },
    x => { x.encryptionKey = 'invalid'; },
    x => { x.keyId = 'different'; }
  ]) {
    const input = structuredClone(base);
    mutate(input);
    await assert.rejects(verifyDirectCutoverPreflight(input), /preflight failed/);
  }
});

test('fail closed if approved original URL changes, including implicit TLS changes', async () => {
  const base = await fixture();
  const changed = structuredClone(base);
  changed.originalConfig = JSON.stringify({
    ...config, b2b: 'mysql://test:example@different.example.net:3306/example'
  });
  await assert.rejects(verifyDirectCutoverPreflight(changed), /preflight failed/);
  const tls = structuredClone(base);
  tls.originalConfig = JSON.stringify({
    ...config, b2b: config.b2b + '?ssl=true'
  });
  await assert.rejects(verifyDirectCutoverPreflight(tls));
});
