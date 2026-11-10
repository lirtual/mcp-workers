import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  constants,
} from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OLD_ENVIRONMENTS = Object.freeze({
  ACTIONS_GITHUB_DISPATCH_TOKENS: 'github-actions-mcp-worker',
  IMA_API_KEY: 'ima-mcp-worker',
  RAINDROP_ACCESS_TOKEN: 'raindrop-mcp-worker',
  SSH_ENCRYPTION_KEY: 'ssh-mcp-worker',
  WORKFLOW_GITHUB_DISPATCH_TOKEN: 'workflow-mcp-worker',
  WORKFLOW_MCP_PORTAL_CLIENT_SECRET: 'workflow-mcp-worker',
});

function validateMetadata(secretName, phase, nonce) {
  if (!Object.hasOwn(OLD_ENVIRONMENTS, secretName)) throw new Error('Unknown Secret');
  if (phase !== 'old' && phase !== 'repository') throw new Error('Unknown phase');
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid nonce');
}

function strictBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid ciphertext encoding');
  }
  return Buffer.from(value, 'base64');
}

export function sealSecret({ value, publicKeyPem, secretName, phase, nonce }) {
  validateMetadata(secretName, phase, nonce);
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > 49152) {
    throw new Error('Secret must contain 1-49152 bytes');
  }
  const recipient = createPublicKey(publicKeyPem);
  if (recipient.asymmetricKeyType !== 'rsa' || recipient.asymmetricKeyDetails.modulusLength < 3072) {
    throw new Error('Recipient must use RSA-3072 or stronger');
  }
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const metadata = { format: 'spec849-sealed-v1', secretName, phase, nonce };
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
  try {
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    const sealed = {
      ...metadata,
      wrappedKey: publicEncrypt({
        key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
      }, dataKey).toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
    return sealed;
  } finally {
    dataKey.fill(0);
  }
}

export function openSecret(sealed, { privateKey, secretName, phase, nonce }) {
  validateMetadata(secretName, phase, nonce);
  if (!sealed || sealed.format !== 'spec849-sealed-v1'
    || sealed.secretName !== secretName || sealed.phase !== phase || sealed.nonce !== nonce) {
    throw new Error('Sealed metadata mismatch');
  }
  const iv = strictBase64(sealed.iv);
  const tag = strictBase64(sealed.tag);
  const ciphertext = strictBase64(sealed.ciphertext);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > 49152) {
    throw new Error('Invalid sealed payload');
  }
  const dataKey = privateDecrypt({
    key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
  }, strictBase64(sealed.wrappedKey));
  try {
    if (dataKey.length !== 32) throw new Error('Invalid wrapped key');
    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
    decipher.setAAD(Buffer.from(JSON.stringify({
      format: 'spec849-sealed-v1', secretName, phase, nonce,
    })));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    dataKey.fill(0);
  }
}

function main() {
  const { SPEC849_SECRET_VALUE: value,
    SPEC849_RECIPIENT_PUBLIC_KEY: encodedKey,
    SPEC849_SECRET_NAME: secretName,
    SPEC849_PHASE: phase,
    SPEC849_NONCE: nonce,
    RUNNER_TEMP: runnerTemp,
  } = process.env;
  if (typeof value !== 'string' || !value.length || !encodedKey || !runnerTemp) {
    throw new Error('Missing required Runner input');
  }
  const sealed = sealSecret({
    value: Buffer.from(value, 'utf8'),
    publicKeyPem: strictBase64(encodedKey).toString('utf8'),
    secretName, phase, nonce,
  });
  const target = join(runnerTemp, 'spec849-sealed.json');
  writeFileSync(target, JSON.stringify(sealed), { mode: 0o600, flag: 'wx' });
  process.stdout.write('SEALED_OK\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    process.stderr.write('SPEC849_SEAL_FAILED\n');
    process.exitCode = 1;
  }
}
