import type { Env } from './types.ts';
import { fitsMcpToolResultBudget } from './result-budget.ts';
import { normalizeDnsName } from './target-security.ts';

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const utf8 = new TextEncoder();

export type HostErrorCode = 'host_not_found' | 'host_record_invalid' | 'unsupported_crypto_version' | 'secret_mismatch' | 'result_too_large' | 'host_untrusted' | 'invalid_target';

export class HostError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode) {
    super(code);
    this.name = 'HostError';
    this.code = code;
  }
}

interface WorkspaceRow { account_id: string }
interface HostRow { id: string; account_id: string; encrypted_payload: string; updated_at: number }
interface HostPayload {
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey';
  password?: string;
  privateKey?: string;
  keychainId?: string;
  keyPassphrase?: string;
  fingerprint: string;
  initialCommand?: string;
}

export interface HostView {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey';
  trustReady: boolean;
  readinessReason: 'ready' | 'host_untrusted' | 'credential_missing';
}

export interface SshHostCredentials {
  id: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  fingerprint: string;
}

function decodeBase64Strict(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HostError('host_record_invalid');
  }
  try {
    const decoded = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    let binary = '';
    for (let offset = 0; offset < decoded.length; offset += 0x8000) {
      binary += String.fromCharCode(...decoded.subarray(offset, offset + 0x8000));
    }
    if (btoa(binary) !== value) throw new Error('noncanonical');
    return decoded;
  } catch {
    throw new HostError('host_record_invalid');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validHost(host: string): boolean {
  if (host.includes(':')) {
    try { return new URL(`http://[${host.replace(/^\[|\]$/g, '')}]`).hostname.length > 2; }
    catch { return false; }
  }
  if (/^[\d.]+$/.test(host)) {
    return IPV4.test(host) && host.split('.').every(part => Number(part) <= 255 && (part === '0' || !part.startsWith('0')));
  }
  return normalizeDnsName(host) !== null;
}

function validPayload(value: unknown): value is HostPayload {
  if (!record(value)) return false;
  const allowedFields = new Set([
    'name', 'group', 'host', 'port', 'username', 'authMethod', 'password', 'privateKey',
    'keychainId', 'keyPassphrase', 'initialCommand', 'termType', 'encoding', 'fingerprint', 'location', 'locationCheckedAt', 'system',
  ]);
  if (Object.keys(value).some(field => !allowedFields.has(field))) return false;
  const authMethod = value.authMethod;
  const validPassword = authMethod === 'password'
    && typeof value.password === 'string' && value.password.length <= 4096
    && value.privateKey === undefined && value.keychainId === undefined && value.keyPassphrase === undefined;
  const inlineKey = typeof value.privateKey === 'string' && value.privateKey.length > 0
    && value.privateKey.length <= 128 * 1024 && value.privateKey.includes('BEGIN OPENSSH PRIVATE KEY');
  const referencedKey = typeof value.keychainId === 'string' && HOST_ID.test(value.keychainId);
  const validPrivateKey = authMethod === 'publickey'
    && (inlineKey || referencedKey)
    && (value.privateKey === undefined || inlineKey)
    && (value.keychainId === undefined || referencedKey)
    && (value.keyPassphrase === undefined || (typeof value.keyPassphrase === 'string' && value.keyPassphrase.length <= 1024))
    && value.password === undefined;
  return typeof value.name === 'string' && value.name.length <= 80
    && typeof value.group === 'string' && value.group.length <= 40
    && typeof value.host === 'string' && value.host.length > 0 && value.host.length <= 253
    && validHost(value.host)
    && Number.isInteger(value.port) && Number(value.port) >= 1 && Number(value.port) <= 65_535
    && Number(value.port) !== 25
    && typeof value.username === 'string' && value.username.length > 0 && value.username.length <= 128
    && !/[\0\r\n]/.test(value.username)
    && (authMethod === 'password' || authMethod === 'publickey')
    && (validPassword || validPrivateKey)
    && typeof value.fingerprint === 'string'
    && typeof value.initialCommand === 'string' && value.initialCommand.length <= 4096
    && typeof value.termType === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(value.termType)
    && typeof value.encoding === 'string' && ['utf-8', 'gb18030', 'big5'].includes(value.encoding.toLowerCase())
    && (value.location === null || record(value.location))
    && (value.locationCheckedAt === undefined || Number.isSafeInteger(value.locationCheckedAt))
    && (value.system === undefined || value.system === null || record(value.system));
}

async function decryptPayload(ciphertext: string, secret: string, accountId: string, recordId: string): Promise<unknown> {
  if (ciphertext.length > 250_000) throw new HostError('host_record_invalid');
  const parts = ciphertext.split('.');
  if (parts.length !== 3) throw new HostError('host_record_invalid');
  const [version, encodedIv, encodedCiphertext] = parts;
  if (version !== 'v1') throw new HostError('unsupported_crypto_version');
  if (!encodedIv || !encodedCiphertext) throw new HostError('host_record_invalid');

  try {
    const keyBytes = decodeBase64Strict(secret);
    if (keyBytes.length !== 32) throw new HostError('host_record_invalid');
    const iv = decodeBase64Strict(encodedIv);
    const data = decodeBase64Strict(encodedCiphertext);
    if (iv.length !== 12 || data.length < 16) throw new HostError('host_record_invalid');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const clear = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: utf8.encode(`edgessh:v1:${accountId}:${recordId}`),
    }, key, data);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)) as unknown;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError('secret_mismatch');
  }
}

async function decryptHost(ciphertext: string, secret: string, accountId: string, hostId: string): Promise<HostPayload> {
  const payload = await decryptPayload(ciphertext, secret, accountId, hostId);
  if (!validPayload(payload)) throw new HostError('host_record_invalid');
  return payload;
}

async function resolvePrivateKey(env: Env, payload: HostPayload, accountId: string, secret: string): Promise<{ privateKey: string; passphrase?: string }> {
  if (payload.keychainId) {
    const row = await env.EDGE_SSH_DB!.prepare(
      'SELECT encrypted_payload FROM keychain WHERE id = ? AND account_id = ?',
    ).bind(payload.keychainId, accountId).first<{ encrypted_payload: string }>();
    if (!row || typeof row.encrypted_payload !== 'string') throw new HostError('host_record_invalid');
    const entry = await decryptPayload(row.encrypted_payload, secret, accountId, `keychain:${payload.keychainId}`);
    if (!record(entry) || typeof entry.privateKey !== 'string'
      || entry.privateKey.length === 0 || entry.privateKey.length > 128 * 1024
      || !entry.privateKey.includes('BEGIN OPENSSH PRIVATE KEY')
      || (entry.passphrase !== undefined && (typeof entry.passphrase !== 'string' || entry.passphrase.length > 1024))) {
      throw new HostError('host_record_invalid');
    }
    const passphrase = payload.keyPassphrase || entry.passphrase;
    return { privateKey: entry.privateKey, ...(passphrase ? { passphrase } : {}) };
  }
  if (!payload.privateKey) throw new HostError('host_record_invalid');
  return { privateKey: payload.privateKey, ...(payload.keyPassphrase ? { passphrase: payload.keyPassphrase } : {}) };
}

function project(id: string, payload: HostPayload): HostView {
  const credentialPresent = payload.authMethod === 'password'
    ? typeof payload.password === 'string' && payload.password.length > 0
    : (typeof payload.privateKey === 'string' && payload.privateKey.length > 0) || Boolean(payload.keychainId);
  const trustReady = FINGERPRINT.test(payload.fingerprint);
  return {
    id,
    name: payload.name,
    group: payload.group,
    host: payload.host,
    port: payload.port,
    username: payload.username,
    authMethod: payload.authMethod,
    trustReady,
    readinessReason: trustReady ? (credentialPresent ? 'ready' : 'credential_missing') : 'host_untrusted',
  };
}

async function readAccount(env: Env): Promise<string> {
  if (!env.EDGE_SSH_DB) throw new Error('host_catalog_unavailable');
  const result = await env.EDGE_SSH_DB.prepare(
    'SELECT account_id FROM workspace_state WHERE id = ?',
  ).bind(1).all<WorkspaceRow>();
  if (result.results.length !== 1 || typeof result.results[0]?.account_id !== 'string' || !result.results[0].account_id) {
    throw new Error('host_catalog_unavailable');
  }
  return result.results[0].account_id;
}

function requiredSecret(env: Env): string {
  if (!env.ENCRYPTION_KEY) throw new Error('host_catalog_unavailable');
  return env.ENCRYPTION_KEY;
}

async function decodeRow(row: HostRow, accountId: string, secret: string): Promise<HostView> {
  if (!HOST_ID.test(row.id) || row.account_id !== accountId || typeof row.encrypted_payload !== 'string'
      || !Number.isSafeInteger(row.updated_at)) throw new HostError('host_record_invalid');
  return project(row.id, await decryptHost(row.encrypted_payload, secret, accountId, row.id));
}

/** Read the current catalog row for an effectful operation; never persist this result. */
export async function getSshHostCredentials(env: Env, hostId: string): Promise<SshHostCredentials> {
  if (!HOST_ID.test(hostId)) throw new HostError('host_not_found');
  const accountId = await readAccount(env);
  const secret = requiredSecret(env);
  const row = await env.EDGE_SSH_DB!.prepare(
    'SELECT id, account_id, encrypted_payload, updated_at FROM hosts WHERE id = ? AND account_id = ?',
  ).bind(hostId, accountId).first<HostRow>();
  if (!row) throw new HostError('host_not_found');
  if (!HOST_ID.test(row.id) || row.account_id !== accountId || !Number.isSafeInteger(row.updated_at)) {
    throw new HostError('host_record_invalid');
  }
  const payload = await decryptHost(row.encrypted_payload, secret, accountId, row.id);
  const view = project(row.id, payload);
  if (!view.trustReady) throw new HostError('host_untrusted');
  if (view.readinessReason === 'credential_missing') throw new HostError('host_record_invalid');
  const key = payload.authMethod === 'publickey'
    ? await resolvePrivateKey(env, payload, accountId, secret) : {};
  return {
    id: row.id,
    host: payload.host,
    port: payload.port,
    username: payload.username,
    authMethod: payload.authMethod,
    ...(payload.password === undefined ? {} : { password: payload.password }),
    ...key,
    fingerprint: payload.fingerprint,
  };
}

export async function listHosts(env: Env, input: { cursor?: string; limit?: number }): Promise<{ hosts: HostView[]; nextCursor: string | null }> {
  const accountId = await readAccount(env);
  const secret = requiredSecret(env);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HostError('host_record_invalid');
  const cursor = input.cursor;
  if (cursor !== undefined && !HOST_ID.test(cursor)) throw new HostError('host_record_invalid');
  const query = cursor === undefined
    ? 'SELECT id, account_id, encrypted_payload, updated_at FROM hosts WHERE account_id = ? ORDER BY id LIMIT ?'
    : 'SELECT id, account_id, encrypted_payload, updated_at FROM hosts WHERE account_id = ? AND id > ? ORDER BY id LIMIT ?';
  const statement = env.EDGE_SSH_DB!.prepare(query);
  const result = cursor === undefined
    ? await statement.bind(accountId, limit + 1).all<HostRow>()
    : await statement.bind(accountId, cursor, limit + 1).all<HostRow>();
  const rows = result.results.slice(0, limit + 1);
  const hosts: HostView[] = [];
  let lastIncludedId: string | undefined;

  for (let index = 0; index < Math.min(limit, rows.length); index += 1) {
    const row = rows[index]!;
    const host = await decodeRow(row, accountId, secret);
    const hasMoreAfterCandidate = index < rows.length - 1;
    const candidate = {
      hosts: [...hosts, host],
      nextCursor: hasMoreAfterCandidate ? row.id : null,
    };
    if (!fitsMcpToolResultBudget(candidate)) {
      if (hosts.length === 0) throw new HostError('result_too_large');
      break;
    }
    hosts.push(host);
    lastIncludedId = row.id;
    if (!hasMoreAfterCandidate) return { hosts, nextCursor: null };
  }

  return { hosts, nextCursor: lastIncludedId ?? null };
}

export async function getHost(env: Env, hostId: string): Promise<HostView> {
  if (!HOST_ID.test(hostId)) throw new HostError('host_not_found');
  const accountId = await readAccount(env);
  const secret = requiredSecret(env);
  const row = await env.EDGE_SSH_DB!.prepare(
    'SELECT id, account_id, encrypted_payload, updated_at FROM hosts WHERE id = ? AND account_id = ?',
  ).bind(hostId, accountId).first<HostRow>();
  if (!row) throw new HostError('host_not_found');
  return decodeRow(row, accountId, secret);
}
