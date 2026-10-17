import { DurableObject } from 'cloudflare:workers';
import { connect as connectTcp } from 'cloudflare:sockets';
import { connect as connectSsh, SshAuthenticationError, SshHostKeyError, type SshChannel, type SshClient, type SshSocket } from '@meitaim/ssh';
import { getSshHostCredentials, HostError } from './hosts.ts';
import type { Env } from './types.ts';
import { isIpLiteral, isPublicAddress, normalizeDnsName } from './target-security.ts';
import { closeSshResources } from './ssh-lifecycle.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIN = /^SHA256:[A-Za-z0-9+/]{43}$/;
const encoder = new TextEncoder();
const MAX_CAPTURE_BYTES = 4 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const TERMINAL_RECEIPTS = ['completed', 'failed'] as const;
const RECEIPT_RETENTION_MS = 30 * DAY;
const RECEIPT_CLEANUP_BATCH_SIZE = 50;

export interface ExecRequest {
  hostId: string;
  operationId: string;
  command: string;
  timeoutMs: number;
}
export interface ExecReply {
  operation_id: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  stdout?: string;
  stderr?: string;
  exit_code?: number | null;
  truncated?: boolean;
  error?: string;
}

interface ReceiptRow extends Record<string, SqlStorageValue> {
  operation_id: string;
  digest: string;
  status: string;
  result_json: string | null;
  created_at: number;
}

interface DnsAnswer { type: number; data: string }

function errorCode(error: unknown): string {
  if (error instanceof HostError) return error.code;
  if (error instanceof SshHostKeyError) return 'host_untrusted';
  return 'host_unreachable';
}

async function resolvePublicAddress(host: string, signal?: AbortSignal): Promise<string> {
  const candidates = isIpLiteral(host)
    ? [host.replace(/^\[|\]$/g, '')]
    : await resolveDns(normalizeDnsName(host) ?? (() => { throw new HostError('invalid_target'); })(), signal);
  if (candidates.length === 0 || candidates.length > 16 || candidates.some(address => !isPublicAddress(address))) {
    throw new HostError('invalid_target');
  }
  return candidates[0]!;
}

async function resolveDns(host: string, signal?: AbortSignal): Promise<string[]> {
  const addresses: string[] = [];
  for (const type of [1, 28]) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new HostError('invalid_target');
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('Answer' in body)) continue;
    const answers = (body as { Answer?: DnsAnswer[] }).Answer;
    for (const answer of answers ?? []) {
      if (answer.type === type && typeof answer.data === 'string') addresses.push(answer.data);
      if (addresses.length > 16) throw new HostError('invalid_target');
    }
  }
  return [...new Set(addresses)];
}

function bounded(text: string, remaining: number): { value: string; bytes: number; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= remaining) return { value: text, bytes: bytes.byteLength, truncated: false };
  const prefix = bytes.subarray(0, remaining);
  let value = new TextDecoder('utf-8').decode(prefix);
  while (encoder.encode(value).byteLength > remaining) value = value.slice(0, -1);
  return { value, bytes: encoder.encode(value).byteLength, truncated: true };
}

async function readBounded(stream: ReadableStream<Uint8Array>, maximum: number): Promise<{ value: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const keep = Math.min(value.byteLength, Math.max(0, maximum - size));
      if (keep > 0) chunks.push(value.subarray(0, keep));
      size += keep;
      if (keep < value.byteLength) truncated = true;
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { value: new TextDecoder().decode(bytes), truncated };
}

export interface CanonicalOperationIntent {
  tool: string;
  hostId: string;
  sessionId: string | null;
  normalizedArgs: readonly (string | number | boolean | null)[];
}

export async function canonicalOperationDigest(intent: CanonicalOperationIntent): Promise<string> {
  const canonical = JSON.stringify([
    intent.tool,
    intent.hostId.toLowerCase(),
    intent.sessionId?.toLowerCase() ?? null,
    intent.normalizedArgs,
  ]);
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function legacyExecDigest(request: ExecRequest): Promise<string> {
  const canonical = JSON.stringify(['ssh_exec', request.hostId, request.command, request.timeoutMs]);
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function runSshExec(env: Env, request: ExecRequest, operationId: string, resolveTarget = resolvePublicAddress): Promise<ExecReply> {
  let client: SshClient | undefined;
  let channel: SshChannel | undefined;
  let socket: ReturnType<typeof connectTcp> | undefined;
  let dispatchStarted = false;
  let expired = false;
  let clientCloseStarted = false;
  let channelCloseStarted = false;
  let cleanupInFlight: Promise<void> = Promise.resolve();
  const deadline = Date.now() + request.timeoutMs;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const cleanupResources = () => {
    const closingChannel = channel && !channelCloseStarted ? channel : undefined;
    const closingClient = client && !clientCloseStarted ? client : undefined;
    if (closingChannel) channelCloseStarted = true;
    if (closingClient) clientCloseStarted = true;
    if (closingChannel || closingClient) {
      cleanupInFlight = Promise.all([cleanupInFlight, closeSshResources(closingChannel, closingClient)]).then(() => undefined);
    }
    return cleanupInFlight;
  };
  const ensureTime = () => {
    const remaining = deadline - Date.now();
    if (expired || remaining <= 0) throw new Error('exec_timeout');
    return remaining;
  };
  let rejectAtDeadline: ((error: Error) => void) | undefined;
  const deadlineReached = new Promise<never>((_resolve, reject) => { rejectAtDeadline = reject; });
  timeoutId = setTimeout(() => {
    expired = true;
    controller.abort();
    try { socket?.close(); } catch { /* force local socket termination */ }
    void cleanupResources();
    rejectAtDeadline?.(new Error('exec_timeout'));
  }, request.timeoutMs);

  const perform = async (): Promise<ExecReply> => {
    const saved = await getSshHostCredentials(env, request.hostId);
    ensureTime();
    if (!PIN.test(saved.fingerprint)) throw new HostError('host_untrusted');
    if (saved.port === 25 || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) {
      throw new HostError('invalid_target');
    }
    const checkedIp = await resolveTarget(saved.host, controller.signal);
    ensureTime();
    const credentials = saved.authMethod === 'password'
      ? { password: saved.password! }
      : { privateKey: saved.privateKey! };
    const connected = await connectSsh({
      host: saved.host,
      port: saved.port,
      username: saved.username,
      ...credentials,
      timeout: Math.min(10_000, ensureTime()),
      verifyHostKey: key => key.fingerprint === saved.fingerprint,
      openSocket: async ({ port }): Promise<SshSocket> => {
        ensureTime();
        const openedSocket = connectTcp({ hostname: checkedIp, port }, { secureTransport: 'off', allowHalfOpen: false });
        socket = openedSocket;
        openedSocket.closed.catch(() => undefined);
        const writer = openedSocket.writable.getWriter();
        writer.closed.catch(() => undefined);
        try {
          await writer.ready;
          ensureTime();
          return {
            readable: openedSocket.readable,
            write: data => writer.write(data),
            close: () => writer.close().catch(() => undefined),
          };
        } catch (error) {
          try { openedSocket.close(); } catch { /* socket is already closed */ }
          throw error;
        }
      },
    });
    client = connected;
    if (expired) {
      void cleanupResources();
      throw new Error('exec_timeout');
    }
    ensureTime();
    dispatchStarted = true;
    const openedChannel = await connected.spawn(request.command);
    channel = openedChannel;
    if (expired) {
      void cleanupResources();
      throw new Error('exec_timeout');
    }
    await openedChannel.end();
    ensureTime();
    const result = await Promise.all([
      readBounded(openedChannel.stdout, MAX_CAPTURE_BYTES * 3 / 4),
      readBounded(openedChannel.stderr, MAX_CAPTURE_BYTES / 4),
      openedChannel.exit,
    ]);
    ensureTime();
    const stdout = bounded(result[0].value, MAX_CAPTURE_BYTES * 3 / 4);
    const stderr = bounded(result[1].value, MAX_CAPTURE_BYTES / 4);
    return {
      operation_id: operationId,
      status: 'completed',
      stdout: stdout.value,
      stderr: stderr.value,
      exit_code: result[2].code,
      truncated: stdout.truncated || stderr.truncated || result[0].truncated || result[1].truncated,
    };
  };

  try {
    return await Promise.race([perform(), deadlineReached]);
  } catch (error) {
    if (error instanceof Error && error.message === 'exec_timeout') {
      return dispatchStarted
        ? { operation_id: operationId, status: 'unknown', error: 'unknown_outcome' }
        : { operation_id: operationId, status: 'failed', error: 'host_unreachable' };
    }
    if (dispatchStarted && !(error instanceof SshAuthenticationError) && !(error instanceof SshHostKeyError)) {
      return { operation_id: operationId, status: 'unknown', error: 'unknown_outcome' };
    }
    return { operation_id: operationId, status: 'failed', error: errorCode(error) };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    try { await cleanupResources(); } catch { /* bounded best-effort cleanup */ }
  }
}

export class SshOperationsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, host_id TEXT NOT NULL,
        status TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL
      )`);
      ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS operations_terminal_cleanup ON operations(status, created_at)');
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS connection_leases (
        operation_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS connection_leases_host ON connection_leases(host_id)');
      ctx.storage.sql.exec('UPDATE operations SET status = \'unknown\', result_json = NULL WHERE status IN (\'admitted\', \'running\')');
      ctx.storage.sql.exec('DELETE FROM connection_leases');
    });
  }

  async execute(request: ExecRequest): Promise<ExecReply> {
    request = { ...request, hostId: request.hostId.toLowerCase() };
    const operationId = request.operationId.toLowerCase();
    const requestDigest = await canonicalOperationDigest({
      tool: 'ssh_exec',
      hostId: request.hostId,
      sessionId: null,
      normalizedArgs: [request.command, request.timeoutMs],
    });
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    type Admission =
      | { kind: 'admitted' }
      | { kind: 'existing'; row: ReceiptRow }
      | { kind: 'capacity' };
    let admission: Admission;
    try {
      admission = this.ctx.storage.transactionSync(() => {
        // Each request prunes a finite indexed batch; unresolved and in-flight rows are never eligible.
        sql.exec(`DELETE FROM operations WHERE operation_id IN (
          SELECT operation_id FROM operations
          WHERE status IN (?, ?) AND created_at <= ?
          LIMIT ?
        )`, TERMINAL_RECEIPTS[0], TERMINAL_RECEIPTS[1], now - RECEIPT_RETENTION_MS, RECEIPT_CLEANUP_BATCH_SIZE);
        const existing = sql.exec<ReceiptRow>('SELECT * FROM operations WHERE operation_id = ?', operationId).toArray()[0];
        if (existing) return { kind: 'existing', row: existing };

        const total = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM connection_leases').one().count;
        const perHost = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM connection_leases WHERE host_id = ?', request.hostId).one().count;
        if (total >= 4 || perHost >= 2) return { kind: 'capacity' };

        // Durable admission and its connection reservation commit together before any SSH effect.
        sql.exec('INSERT INTO operations(operation_id,digest,host_id,status,created_at) VALUES(?,?,?,\'admitted\',?)', operationId, requestDigest, request.hostId, now);
        sql.exec('INSERT INTO connection_leases(operation_id,host_id,created_at) VALUES(?,?,?)', operationId, request.hostId, now);
        return { kind: 'admitted' };
      });
    } catch {
      return { operation_id: operationId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    if (admission.kind === 'capacity') return { operation_id: operationId, status: 'failed', error: 'capacity_reached' };
    if (admission.kind === 'existing') {
      const existing = admission.row;
      if (existing.digest !== requestDigest && existing.digest !== await legacyExecDigest(request)) {
        return { operation_id: operationId, status: 'failed', error: 'receipt_conflict' };
      }
      if (existing.result_json) return JSON.parse(existing.result_json) as ExecReply;
      return { operation_id: operationId, status: existing.status === 'admitted' ? 'unknown' : existing.status as ExecReply['status'] };
    }
    const releaseLease = () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          sql.exec('DELETE FROM connection_leases WHERE operation_id = ?', operationId);
          return;
        } catch { /* retry once before returning from a reserved operation */ }
      }
    };
    try {
      sql.exec('UPDATE operations SET status = \'running\' WHERE operation_id = ?', operationId);
    } catch {
      releaseLease();
      return { operation_id: operationId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    let reply: ExecReply;
    try { reply = await this.dispatchExec(request, operationId); }
    catch { reply = { operation_id: operationId, status: 'unknown', error: 'unknown_outcome' }; }
    try {
      const receipt = {
        operation_id: operationId,
        status: reply.status,
        ...(reply.exit_code === undefined ? {} : { exit_code: reply.exit_code }),
        ...(reply.truncated ? { truncated: true } : {}),
        ...(reply.error ? { error: reply.error } : {}),
      };
      this.ctx.storage.transactionSync(() => {
        sql.exec('UPDATE operations SET status = ?, result_json = ? WHERE operation_id = ?', reply.status, JSON.stringify(receipt), operationId);
      });
    } catch {
      return { operation_id: operationId, status: 'unknown', error: 'unknown_outcome' };
    } finally {
      releaseLease();
    }
    return reply;
  }

  protected dispatchExec(request: ExecRequest, operationId: string): Promise<ExecReply> {
    return runSshExec(this.env, request, operationId, (host, signal) => this.resolveTarget(host, signal));
  }

  protected resolveTarget(host: string, signal?: AbortSignal): Promise<string> {
    return resolvePublicAddress(host, signal);
  }

  getOperationStatus(operationId: string): ExecReply | null {
    if (!UUID.test(operationId)) return null;
    const row = this.ctx.storage.sql.exec<ReceiptRow>('SELECT * FROM operations WHERE operation_id = ?', operationId.toLowerCase()).toArray()[0];
    if (!row) return null;
    if (row.result_json) return JSON.parse(row.result_json) as ExecReply;
    return { operation_id: row.operation_id, status: row.status === 'admitted' ? 'unknown' : row.status as ExecReply['status'] };
  }
}
