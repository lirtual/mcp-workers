import { DurableObject } from 'cloudflare:workers';
import { connect as connectTcp } from 'cloudflare:sockets';
import { connect as connectSsh, SshAuthenticationError, SshHostKeyError, type SshChannel, type SshClient, type SshSocket } from '@meitaim/ssh';
import { getSshHostCredentials, HostError } from './hosts.ts';
import type { Env } from './types.ts';
import { isIpLiteral, isPublicAddress, normalizeDnsName } from './target-security.ts';
import { closeSshResources } from './ssh-lifecycle.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIN = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_CAPTURE_BYTES = 4 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const TERMINAL_RECEIPTS = ['completed', 'failed'] as const;
const RECEIPT_RETENTION_MS = 30 * DAY;
const RECEIPT_CLEANUP_BATCH_SIZE = 50;
const SESSION_IDLE_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const SESSION_RING_BYTES = 256 * 1024;
const SESSION_READ_BYTES = 64 * 1024;
const SHELL_OPEN_TIMEOUT_MS = 30_000;
const HOST_CONNECTION_LIMIT = 2;
const TOTAL_CONNECTION_LIMIT = 4;
const encoder = new TextEncoder();

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
  session_id?: string;
}

export interface SessionStartRequest { hostId: string; operationId: string; termType?: string }
export interface SessionOutputRequest { sessionId: string; offset?: number; limit?: number }
export interface SessionInputRequest { sessionId: string; operationId: string; input: string }
export interface SessionStopRequest { sessionId: string; operationId: string }
export interface SessionReply {
  operation_id?: string;
  session_id?: string;
  status: 'live' | 'closing' | 'closed' | 'lost' | 'failed' | 'running' | 'completed' | 'unknown';
  created_at?: number;
  last_activity_at?: number;
  idle_deadline_at?: number;
  absolute_deadline_at?: number;
  output_cursor?: number;
  output_offset?: number;
  next_offset?: number;
  output?: string;
  truncated?: boolean;
  error?: string;
  admitted?: boolean;
  write_accepted?: boolean;
  unverified?: boolean;
  session_status?: 'live' | 'closing' | 'closed' | 'lost' | 'unknown';
  channel_close_attempted?: boolean;
  transport_close_attempted?: boolean;
  remote_descendants?: 'not_observed';
}

interface LiveSession {
  sessionId: string;
  operationId: string;
  hostId: string;
  client: SshClient;
  channel: SshChannel;
  socket: ReturnType<typeof connectTcp>;
  createdAt: number;
  lastActivityAt: number;
  absoluteDeadlineAt: number;
  ring: OutputRing;
  securityDigest: string;
  releaseReason: 'live' | 'closing' | 'closed' | 'lost';
  settled?: Promise<void>;
}

class OutputRing {
  private chunks: Array<{ start: number; data: Uint8Array }> = [];
  start = 0;
  end = 0;
  evicted = false;

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push({ start: this.end, data: chunk });
    this.end += chunk.byteLength;
    const retainFrom = this.end - SESSION_RING_BYTES;
    while (this.chunks.length > 0 && this.chunks[0]!.start + this.chunks[0]!.data.byteLength <= retainFrom) {
      this.chunks.shift();
      this.evicted = true;
    }
    const first = this.chunks[0];
    if (first && first.start < retainFrom) {
      const cut = retainFrom - first.start;
      this.chunks[0] = { start: retainFrom, data: first.data.subarray(cut) };
      this.evicted = true;
    }
    this.start = this.chunks[0]?.start ?? this.end;
  }

  read(from: number, maxBytes: number): { bytes: Uint8Array; offset: number; truncated: boolean } {
    const offset = Math.max(from, this.start);
    const available = Math.max(0, this.end - offset);
    const size = Math.min(Math.max(0, maxBytes), available);
    const bytes = new Uint8Array(size);
    let cursor = offset;
    let written = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.start + chunk.data.byteLength;
      if (chunkEnd <= cursor || written === size) continue;
      const begin = Math.max(0, cursor - chunk.start);
      const copy = Math.min(chunk.data.byteLength - begin, size - written);
      bytes.set(chunk.data.subarray(begin, begin + copy), written);
      written += copy;
      cursor += copy;
    }
    return { bytes, offset, truncated: from < this.start || size < available };
  }
}

function utf8Prefix(bytes: Uint8Array): { text: string; consumed: number } {
  for (let trim = 0; trim <= 3 && trim <= bytes.byteLength; trim++) {
    const consumed = bytes.byteLength - trim;
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, consumed)), consumed };
    } catch { /* keep a trailing partial code unit for the next read */ }
  }
  return { text: '', consumed: 0 };
}

interface ReceiptRow extends Record<string, SqlStorageValue> {
  operation_id: string;
  digest: string;
  status: string;
  result_json: string | null;
  created_at: number;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  session_id: string;
  operation_id: string;
  host_id: string;
  status: string;
  created_at: number;
  last_activity_at: number;
  absolute_deadline_at: number;
}

type Admission =
  | { kind: 'admitted' }
  | { kind: 'existing'; row: ReceiptRow }
  | { kind: 'capacity' };

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

async function sessionSecurityDigest(saved: { host: string; port: number; username: string; authMethod: string; fingerprint: string; password?: string; privateKey?: string }): Promise<string> {
  const canonical = JSON.stringify([
    saved.host, saved.port, saved.username, saved.authMethod, saved.fingerprint, saved.password ?? null, saved.privateKey ?? null,
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
  protected readonly sessions = new Map<string, LiveSession>();
  private readonly unresolvedOutcomes = new Set<string>();
  private readonly sessionEffects = new Map<string, Promise<unknown>>();
  private deadlineSweep: Promise<void> = Promise.resolve();

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
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS managed_sessions (
        session_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
        absolute_deadline_at INTEGER NOT NULL
      )`);
      // A restarted DO no longer owns the previous TCP sockets. Stored IDs become lost, not reconnectable.
      ctx.storage.sql.exec('UPDATE managed_sessions SET status = \'lost\' WHERE status IN (\'live\', \'closing\')');
      ctx.storage.sql.exec('UPDATE operations SET status = \'unknown\', result_json = NULL WHERE status IN (\'admitted\', \'running\')');
      ctx.storage.sql.exec('DELETE FROM connection_leases');
    });
  }

  protected now(): number {
    return Date.now();
  }

  async execute(request: ExecRequest): Promise<ExecReply> {
    request = { ...request, hostId: request.hostId.toLowerCase() };
    const operationId = request.operationId.toLowerCase();
    try {
      await this.enforceSessionDeadlines();
    } catch {
      return { operation_id: operationId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    const requestDigest = await canonicalOperationDigest({
      tool: 'ssh_exec',
      hostId: request.hostId,
      sessionId: null,
      normalizedArgs: [request.command, request.timeoutMs],
    });
    const sql = this.ctx.storage.sql;
    const now = this.now();
    let admission: Admission;
    try {
      admission = this.claimOperation(operationId, request.hostId, requestDigest, now);
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
    try {
      sql.exec('UPDATE operations SET status = \'running\' WHERE operation_id = ?', operationId);
    } catch {
      this.releaseLease(operationId);
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
      this.releaseLease(operationId);
    }
    return reply;
  }

  protected dispatchExec(request: ExecRequest, operationId: string): Promise<ExecReply> {
    return runSshExec(this.env, request, operationId, (host, signal) => this.resolveTarget(host, signal));
  }

  protected resolveTarget(host: string, signal?: AbortSignal): Promise<string> {
    return resolvePublicAddress(host, signal);
  }

  async getOperationStatus(operationId: string): Promise<ExecReply | null> {
    if (!UUID.test(operationId)) return null;
    try {
      await this.enforceSessionDeadlines();
    } catch {
      return { operation_id: operationId.toLowerCase(), status: 'failed', error: 'receipt_store_unavailable' };
    }
    const normalized = operationId.toLowerCase();
    const row = this.ctx.storage.sql.exec<ReceiptRow>('SELECT * FROM operations WHERE operation_id = ?', normalized).toArray()[0];
    if (!row) return null;
    if (this.unresolvedOutcomes.has(normalized)) {
      return { operation_id: normalized, status: 'unknown', error: 'unknown_outcome' };
    }
    if (row.result_json) return JSON.parse(row.result_json) as ExecReply;
    return { operation_id: row.operation_id, status: row.status === 'admitted' ? 'unknown' : row.status as ExecReply['status'] };
  }

  async startSession(request: SessionStartRequest): Promise<SessionReply> {
    const hostId = request.hostId.toLowerCase();
    const operationId = request.operationId.toLowerCase();
    const termType = request.termType ?? 'xterm-256color';
    try {
      await this.enforceSessionDeadlines();
    } catch {
      return { operation_id: operationId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    const digest = await canonicalOperationDigest({
      tool: 'ssh_session_start', hostId, sessionId: null, normalizedArgs: [termType],
    });
    const now = this.now();
    let admission: Admission;
    try {
      admission = this.claimOperation(operationId, hostId, digest, now);
    } catch {
      return { operation_id: operationId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    if (admission.kind === 'capacity') return { operation_id: operationId, status: 'failed', error: 'capacity_reached' };
    if (admission.kind === 'existing') return this.existingStartReply(operationId, digest, admission.row);
    const sql = this.ctx.storage.sql;
    try {
      sql.exec('UPDATE operations SET status = \'running\' WHERE operation_id = ?', operationId);
    } catch {
      this.releaseLease(operationId);
      return { operation_id: operationId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    let opened: { client: SshClient; channel: SshChannel; socket: ReturnType<typeof connectTcp>; securityDigest: string } | undefined;
    try {
      opened = await this.openManagedShell(hostId, termType);
      const sessionId = crypto.randomUUID().toLowerCase();
      const createdAt = this.now();
      const session: LiveSession = {
        sessionId, operationId, hostId, client: opened.client, channel: opened.channel, socket: opened.socket,
        createdAt, lastActivityAt: createdAt, absoluteDeadlineAt: createdAt + SESSION_MAX_AGE_MS,
        ring: new OutputRing(), securityDigest: opened.securityDigest, releaseReason: 'live',
      };
      const receipt = { operation_id: operationId, status: 'completed', session_id: sessionId };
      try {
        this.ctx.storage.transactionSync(() => {
          sql.exec(`INSERT INTO managed_sessions(
            session_id, operation_id, host_id, status, created_at, last_activity_at, absolute_deadline_at
          ) VALUES(?,?,?,'live',?,?,?)`, sessionId, operationId, hostId, createdAt, createdAt, session.absoluteDeadlineAt);
          sql.exec('UPDATE operations SET status = \'completed\', result_json = ? WHERE operation_id = ?', JSON.stringify(receipt), operationId);
        });
      } catch {
        await this.closeShell(opened);
        this.releaseLease(operationId);
        return this.persistUncertainOutcome(operationId);
      }
      this.sessions.set(sessionId, session);
      this.observeSession(session);
      await this.scheduleSessionAlarm();
      return this.sessionView(session);
    } catch (error) {
      if (opened) await this.closeShell(opened);
      const observed = error instanceof Error && error.message === 'shell_observed';
      if (!observed) {
        const failed: SessionReply = { operation_id: operationId, status: 'failed', error: errorCode(error) };
        try {
          sql.exec('UPDATE operations SET status = ?, result_json = ? WHERE operation_id = ?', failed.status, JSON.stringify(failed), operationId);
          this.releaseLease(operationId);
          return failed;
        } catch { /* a definitive failure that cannot be stored is still not safe to retry */ }
      }
      const reply = this.persistUncertainOutcome(operationId);
      this.releaseLease(operationId);
      return reply;
    }
  }

  async readSessionOutput(request: SessionOutputRequest): Promise<SessionReply> {
    const sessionId = request.sessionId.toLowerCase();
    await this.enforceSessionDeadlines();
    const session = this.sessions.get(sessionId);
    const row = this.sessionRow(sessionId);
    if (!session && !row) return { session_id: sessionId, status: 'failed', error: 'session_not_found' };
    const view = session ? this.sessionView(session, row) : this.storedSessionView(row!);
    if (!session) return { ...view, output: '', output_offset: 0, next_offset: 0, truncated: true };
    const from = request.offset ?? 0;
    const limit = Math.min(request.limit ?? SESSION_READ_BYTES, SESSION_READ_BYTES);
    const slice = session.ring.read(from, limit);
    const decoded = utf8Prefix(slice.bytes);
    return {
      ...view,
      output: decoded.text,
      output_offset: slice.offset,
      next_offset: slice.offset + decoded.consumed,
      truncated: slice.truncated || decoded.consumed < slice.bytes.byteLength,
    };
  }

  async readSessionStatus(sessionId: string): Promise<SessionReply> {
    const normalized = sessionId.toLowerCase();
    const closing = this.sessions.get(normalized);
    if (closing?.releaseReason === 'closing') return this.sessionView(closing);
    await this.enforceSessionDeadlines();
    const session = this.sessions.get(normalized);
    const row = this.sessionRow(normalized);
    if (!session && !row) return { session_id: normalized, status: 'failed', error: 'session_not_found' };
    return session ? this.sessionView(session, row) : this.storedSessionView(row!);
  }

  async alarm(): Promise<void> {
    await this.enforceSessionDeadlines();
  }

  async inputSession(request: SessionInputRequest): Promise<SessionReply> {
    const sessionId = request.sessionId.toLowerCase();
    const operationId = request.operationId.toLowerCase();
    try {
      await this.enforceSessionDeadlines();
    } catch {
      return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    const state = { admitted: false, wrote: false };
    return this.enqueueSession(sessionId, async () => {
      try {
        return await this.performInput(sessionId, operationId, request.input, state);
      } catch {
        if (state.wrote || state.admitted) return this.persistUncertainOutcome(operationId);
        return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'receipt_store_unavailable' };
      }
    });
  }

  async stopSession(request: SessionStopRequest): Promise<SessionReply> {
    const sessionId = request.sessionId.toLowerCase();
    const operationId = request.operationId.toLowerCase();
    try {
      await this.enforceSessionDeadlines();
    } catch { /* a storage fault still allows one owned live close */ }
    return this.enqueueSession(sessionId, async () => {
      try {
        return await this.performStop(sessionId, operationId);
      } catch {
        return this.emergencyStop(operationId, sessionId);
      }
    });
  }

  private existingStartReply(operationId: string, digest: string, existing: ReceiptRow): SessionReply {
    if (existing.digest !== digest) return { operation_id: operationId, status: 'failed', error: 'receipt_conflict' };
    if (this.unresolvedOutcomes.has(operationId) || existing.status === 'unknown' || existing.status === 'admitted') {
      return { operation_id: operationId, status: 'unknown', error: 'unknown_outcome' };
    }
    if (existing.result_json) return JSON.parse(existing.result_json) as SessionReply;
    return { operation_id: operationId, status: existing.status as SessionReply['status'] };
  }

  private persistUncertainOutcome(operationId: string): SessionReply {
    const reply: SessionReply = { operation_id: operationId, status: 'unknown', error: 'unknown_outcome' };
    try {
      this.ctx.storage.sql.exec(
        'UPDATE operations SET status = ?, result_json = ? WHERE operation_id = ?',
        'unknown', JSON.stringify(reply), operationId,
      );
      this.unresolvedOutcomes.delete(operationId);
    } catch {
      try {
        // result_json may be unwritable; status alone must still stop a later same-id start from seeing running.
        this.ctx.storage.sql.exec('UPDATE operations SET status = \'unknown\' WHERE operation_id = ?', operationId);
        this.unresolvedOutcomes.delete(operationId);
      } catch {
        this.unresolvedOutcomes.add(operationId);
      }
    }
    return reply;
  }

  private claimOperation(operationId: string, hostId: string, digest: string, now: number, reserveConnection = true): Admission {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      // Each request prunes a finite indexed batch; unresolved and in-flight rows are never eligible.
      sql.exec(`DELETE FROM operations WHERE operation_id IN (
        SELECT operation_id FROM operations
        WHERE status IN (?, ?) AND created_at <= ?
        LIMIT ?
      )`, TERMINAL_RECEIPTS[0], TERMINAL_RECEIPTS[1], now - RECEIPT_RETENTION_MS, RECEIPT_CLEANUP_BATCH_SIZE);
      const existing = sql.exec<ReceiptRow>('SELECT * FROM operations WHERE operation_id = ?', operationId).toArray()[0];
      if (existing) return { kind: 'existing', row: existing };
      // In-flight starts and live shells share the exec lease table; over-limit rejects instead of queueing.
      // Input and stop reuse the owned channel and must not take another slot.
      if (reserveConnection) {
        const total = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM connection_leases').one().count;
        const perHost = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM connection_leases WHERE host_id = ?', hostId).one().count;
        if (total >= TOTAL_CONNECTION_LIMIT || perHost >= HOST_CONNECTION_LIMIT) return { kind: 'capacity' };
      }
      sql.exec('INSERT INTO operations(operation_id,digest,host_id,status,created_at) VALUES(?,?,?,\'admitted\',?)', operationId, digest, hostId, now);
      if (reserveConnection) sql.exec('INSERT INTO connection_leases(operation_id,host_id,created_at) VALUES(?,?,?)', operationId, hostId, now);
      return { kind: 'admitted' };
    });
  }

  private releaseLease(operationId: string): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.ctx.storage.sql.exec('DELETE FROM connection_leases WHERE operation_id = ?', operationId);
        return;
      } catch { /* retry once before returning from a reserved operation */ }
    }
  }

  protected async enforceSessionDeadlines(): Promise<void> {
    const run = this.deadlineSweep.then(() => this.sweepSessions());
    this.deadlineSweep = run.catch(() => undefined);
    await run;
  }

  private async sweepSessions(): Promise<void> {
    const now = this.now();
    const sql = this.ctx.storage.sql;
    const rows = sql.exec<SessionRow>('SELECT * FROM managed_sessions WHERE status IN (\'live\', \'closing\')').toArray();
    for (const row of rows) {
      const session = this.sessions.get(row.session_id);
      if (!session || session.releaseReason !== 'live') {
        if (!session) {
          sql.exec('UPDATE managed_sessions SET status = \'lost\' WHERE session_id = ? AND status IN (\'live\', \'closing\')', row.session_id);
          sql.exec('DELETE FROM connection_leases WHERE operation_id = ?', row.operation_id);
        }
        continue;
      }
      // Output polling is not activity. Only admission (and later authorized input) moves the idle deadline.
      if (now >= session.lastActivityAt + SESSION_IDLE_MS || now >= session.absoluteDeadlineAt) {
        await this.enqueueSession(session.sessionId, async () => {
          if (session.releaseReason !== 'live') return;
          const current = this.now();
          if (current >= session.lastActivityAt + SESSION_IDLE_MS || current >= session.absoluteDeadlineAt) {
            await this.settleSession(session, 'closed');
          }
        });
      }
    }
    await this.scheduleSessionAlarm();
  }

  protected async scheduleSessionAlarm(): Promise<void> {
    let next: number | undefined;
    for (const session of this.sessions.values()) {
      if (session.releaseReason !== 'live') continue;
      const deadline = Math.min(session.lastActivityAt + SESSION_IDLE_MS, session.absoluteDeadlineAt);
      if (next === undefined || deadline < next) next = deadline;
    }
    if (next === undefined) {
      if (await this.ctx.storage.getAlarm() !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  private async openManagedShell(hostId: string, termType: string): Promise<{ client: SshClient; channel: SshChannel; socket: ReturnType<typeof connectTcp>; securityDigest: string }> {
    let client: SshClient | undefined;
    let socket: ReturnType<typeof connectTcp> | undefined;
    let channel: SshChannel | undefined;
    let timedOut = false;
    try {
      const saved = await getSshHostCredentials(this.env, hostId);
      if (!PIN.test(saved.fingerprint)) throw new HostError('host_untrusted');
      if (saved.port === 25 || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) throw new HostError('invalid_target');
      const securityDigest = await sessionSecurityDigest(saved);
      const checkedIp = await this.resolveTarget(saved.host);
      const credentials = saved.authMethod === 'password' ? { password: saved.password! } : { privateKey: saved.privateKey! };
      const connected = await connectSsh({
        host: saved.host,
        port: saved.port,
        username: saved.username,
        ...credentials,
        timeout: 10_000,
        verifyHostKey: key => key.fingerprint === saved.fingerprint,
        openSocket: async ({ port }): Promise<SshSocket> => {
          const openedSocket = connectTcp({ hostname: checkedIp, port }, { secureTransport: 'off', allowHalfOpen: false });
          socket = openedSocket;
          openedSocket.closed.catch(() => undefined);
          const writer = openedSocket.writable.getWriter();
          writer.closed.catch(() => undefined);
          try {
            await writer.ready;
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
      let shellTimer: ReturnType<typeof setTimeout> | undefined;
      const shellPromise = connected.shell({ pty: { term: termType, columns: 80, rows: 24 } }).then(opened => {
        if (timedOut) void this.closeShell({ client: connected, channel: opened, socket });
        return opened;
      });
      void shellPromise.catch(() => undefined);
      try {
        channel = await Promise.race([
          shellPromise,
          new Promise<SshChannel>((_resolve, reject) => {
            shellTimer = setTimeout(() => {
              timedOut = true;
              reject(new Error('shell_timeout'));
            }, SHELL_OPEN_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (shellTimer !== undefined) clearTimeout(shellTimer);
      }
      if (!socket || !channel) throw new Error('shell_timeout');
      return { client: connected, channel, socket, securityDigest };
    } catch (error) {
      const observed = channel !== undefined;
      await this.closeShell({ client, channel, socket });
      if (observed) throw new Error('shell_observed', { cause: error });
      throw error;
    }
  }

  protected async closeShell(resources: { client?: SshClient; channel?: SshChannel; socket?: ReturnType<typeof connectTcp> }): Promise<void> {
    try { resources.socket?.close(); } catch { /* already closed */ }
    await closeSshResources(resources.channel, resources.client);
  }

  private observeSession(session: LiveSession): void {
    this.pumpOutput(session, session.channel.stdout, true);
    this.pumpOutput(session, session.channel.stderr, false);
    void session.channel.exit.then(() => this.settleSession(session, 'lost')).catch(() => this.settleSession(session, 'lost'));
    void session.socket.closed.then(() => this.settleSession(session, 'lost')).catch(() => this.settleSession(session, 'lost'));
  }

  private pumpOutput(session: LiveSession, stream: ReadableStream<Uint8Array>, endsSession: boolean): void {
    void (async () => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.byteLength) session.ring.append(value);
        }
      } catch {
        if (endsSession) await this.settleSession(session, 'lost');
        return;
      } finally {
        try { reader.releaseLock(); } catch { /* the stream may already be cancelled */ }
      }
      if (endsSession) await this.settleSession(session, 'lost');
    })();
  }

  private settleSession(session: LiveSession, status: 'closed' | 'lost'): Promise<void> {
    if (session.settled) return session.settled;
    if (session.releaseReason === 'live') session.releaseReason = 'closing';
    session.settled = (async () => {
      try {
        await this.finishSession(session, status);
      } finally {
        if (session.releaseReason === 'closing') session.releaseReason = status;
      }
    })();
    return session.settled;
  }

  private async finishSession(session: LiveSession, status: 'closed' | 'lost'): Promise<void> {
    const sql = this.ctx.storage.sql;
    try {
      sql.exec('UPDATE managed_sessions SET status = \'closing\' WHERE session_id = ? AND status = \'live\'', session.sessionId);
    } catch { /* the transport close still proceeds */ }
    await this.closeShell(session);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.ctx.storage.transactionSync(() => {
          sql.exec('UPDATE managed_sessions SET status = ? WHERE session_id = ? AND status IN (\'live\', \'closing\')', status, session.sessionId);
          sql.exec('DELETE FROM connection_leases WHERE operation_id = ?', session.operationId);
        });
        break;
      } catch { /* retry the durable release once */ }
    }
    await this.scheduleSessionAlarm();
  }

  private sessionRow(sessionId: string): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM managed_sessions WHERE session_id = ?', sessionId).toArray()[0];
  }

  private sessionView(session: LiveSession, row?: SessionRow): SessionReply {
    const lastActivityAt = session.lastActivityAt;
    const status = session.releaseReason === 'live' ? 'live' : session.releaseReason;
    return {
      operation_id: session.operationId,
      session_id: session.sessionId,
      status,
      created_at: row?.created_at ?? session.createdAt,
      last_activity_at: lastActivityAt,
      idle_deadline_at: lastActivityAt + SESSION_IDLE_MS,
      absolute_deadline_at: row?.absolute_deadline_at ?? session.absoluteDeadlineAt,
      output_cursor: session.ring.end,
      truncated: session.ring.evicted,
    };
  }

  private enqueueSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionEffects.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.sessionEffects.set(sessionId, run);
    void run.finally(() => {
      if (this.sessionEffects.get(sessionId) === run) this.sessionEffects.delete(sessionId);
    }).catch(() => undefined);
    return run;
  }

  private async performInput(sessionId: string, operationId: string, input: string, state: { admitted: boolean; wrote: boolean }): Promise<SessionReply> {
    const session = this.sessions.get(sessionId);
    let row: SessionRow | undefined;
    try {
      row = this.sessionRow(sessionId);
    } catch {
      return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    if (!session && !row) return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'session_not_found' };
    if (session?.releaseReason === 'live' && this.sessionExpired(session)) await this.settleSession(session, 'closed');
    const hostId = session?.hostId ?? row!.host_id;
    const digest = await canonicalOperationDigest({
      tool: 'ssh_session_input', hostId, sessionId, normalizedArgs: [input],
    });
    let admission: Admission;
    try {
      admission = this.claimOperation(operationId, hostId, digest, this.now(), false);
    } catch {
      return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'receipt_store_unavailable' };
    }
    if (admission.kind === 'capacity') return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'capacity_reached' };
    if (admission.kind === 'existing') return this.existingStartReply(operationId, digest, admission.row);
    state.admitted = true;
    try {
      this.ctx.storage.sql.exec('UPDATE operations SET status = \'running\' WHERE operation_id = ?', operationId);
    } catch {
      return this.persistUncertainOutcome(operationId);
    }
    const owned = this.sessions.get(sessionId);
    if (!owned || owned.releaseReason !== 'live') {
      return this.storeEffectResult(operationId, {
        operation_id: operationId, session_id: sessionId, status: 'failed', error: 'session_not_live', admitted: true, write_accepted: false,
      });
    }
    const rejected = await this.rejectInputIfTargetChanged(owned);
    if (rejected) {
      return this.storeEffectResult(operationId, {
        ...rejected, operation_id: operationId, session_id: sessionId, admitted: true, write_accepted: false,
      });
    }
    if (owned.releaseReason !== 'live') {
      return this.storeEffectResult(operationId, {
        operation_id: operationId, session_id: sessionId, status: 'failed', error: 'session_not_live', admitted: true, write_accepted: false,
      });
    }
    try {
      state.wrote = true;
      await owned.channel.write(input);
    } catch {
      if (owned.releaseReason === 'live') await this.settleSession(owned, 'lost').catch(() => undefined);
      return this.persistUncertainOutcome(operationId);
    }
    owned.lastActivityAt = this.now();
    try {
      this.ctx.storage.sql.exec('UPDATE managed_sessions SET last_activity_at = ? WHERE session_id = ?', owned.lastActivityAt, owned.sessionId);
      await this.scheduleSessionAlarm();
    } catch { /* an accepted write is not sent again to repair the idle deadline */ }
    return this.storeEffectResult(operationId, {
      operation_id: operationId, session_id: sessionId, status: 'completed', admitted: true, write_accepted: true,
    });
  }

  private async performStop(sessionId: string, operationId: string): Promise<SessionReply> {
    let row: SessionRow | undefined;
    try {
      row = this.sessionRow(sessionId);
    } catch {
      return this.emergencyStop(operationId, sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (!session && !row) return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'session_not_found' };
    const hostId = session?.hostId ?? row!.host_id;
    const digest = await canonicalOperationDigest({ tool: 'ssh_session_stop', hostId, sessionId, normalizedArgs: [] });
    let admission: Admission;
    try {
      admission = this.claimOperation(operationId, hostId, digest, this.now(), false);
    } catch {
      return this.emergencyStop(operationId, sessionId);
    }
    if (admission.kind === 'existing') return this.existingStartReply(operationId, digest, admission.row);
    if (admission.kind === 'capacity') return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'capacity_reached' };
    const owned = this.sessions.get(sessionId);
    if (!owned || owned.releaseReason !== 'live') {
      return this.storeEffectResult(operationId, {
        operation_id: operationId, session_id: sessionId, status: 'failed', error: 'session_not_live', admitted: true,
      });
    }
    let runningStored = true;
    try {
      this.ctx.storage.sql.exec('UPDATE operations SET status = \'running\' WHERE operation_id = ?', operationId);
    } catch {
      runningStored = false;
    }
    let closeError = false;
    try {
      await this.settleSession(owned, 'closed');
    } catch {
      closeError = true;
    }
    const uncertain = closeError || !runningStored;
    const reply: SessionReply = {
      operation_id: operationId,
      session_id: sessionId,
      status: uncertain ? 'unknown' : 'completed',
      ...(uncertain ? { error: 'unknown_outcome', unverified: true } : {}),
      admitted: true,
      session_status: owned.releaseReason === 'live' ? 'unknown' : owned.releaseReason,
      channel_close_attempted: true,
      transport_close_attempted: true,
      remote_descendants: 'not_observed',
    };
    return this.storeEffectResult(operationId, reply);
  }

  private async emergencyStop(operationId: string, sessionId: string): Promise<SessionReply> {
    const session = this.sessions.get(sessionId);
    if (!session || session.releaseReason !== 'live') {
      return { operation_id: operationId, session_id: sessionId, status: 'failed', error: 'session_not_live' };
    }
    try {
      await this.settleSession(session, 'closed');
    } catch { /* the close attempt is still unrecorded */ }
    const reply: SessionReply = {
      operation_id: operationId,
      session_id: sessionId,
      status: 'unknown',
      error: 'unknown_outcome',
      unverified: true,
      channel_close_attempted: true,
      transport_close_attempted: true,
      remote_descendants: 'not_observed',
      session_status: session.releaseReason === 'live' ? 'unknown' : session.releaseReason,
    };
    try {
      const digest = await canonicalOperationDigest({
        tool: 'ssh_session_stop', hostId: session.hostId, sessionId, normalizedArgs: [],
      });
      const admission = this.claimOperation(operationId, session.hostId, digest, this.now(), false);
      if (admission.kind === 'admitted') this.storeEffectResult(operationId, reply);
    } catch { /* an unrecordable emergency stop stays unknown only on this response */ }
    return reply;
  }

  private async rejectInputIfTargetChanged(session: LiveSession): Promise<SessionReply | undefined> {
    try {
      const saved = await getSshHostCredentials(this.env, session.hostId);
      if (await sessionSecurityDigest(saved) === session.securityDigest) return undefined;
      await this.settleSession(session, 'closed').catch(() => undefined);
      return { status: 'failed', error: 'host_changed' };
    } catch (error) {
      if (error instanceof HostError) {
        await this.settleSession(session, 'closed').catch(() => undefined);
        const code = error.code === 'host_not_found' || error.code === 'host_untrusted' ? error.code : 'host_changed';
        return { status: 'failed', error: code };
      }
      return { status: 'failed', error: 'host_catalog_unavailable' };
    }
  }

  private sessionExpired(session: LiveSession): boolean {
    const now = this.now();
    return now >= session.lastActivityAt + SESSION_IDLE_MS || now >= session.absoluteDeadlineAt;
  }

  private storeEffectResult(operationId: string, reply: SessionReply): SessionReply {
    try {
      this.ctx.storage.sql.exec(
        'UPDATE operations SET status = ?, result_json = ? WHERE operation_id = ?',
        reply.status, JSON.stringify(reply), operationId,
      );
      this.unresolvedOutcomes.delete(operationId);
      return reply;
    } catch {
      const uncertain = this.persistUncertainOutcome(operationId);
      return { ...reply, ...uncertain, unverified: true, write_accepted: undefined };
    }
  }

  private storedSessionView(row: SessionRow): SessionReply {
    const status = row.status as SessionReply['status'];
    return {
      operation_id: row.operation_id,
      session_id: row.session_id,
      status,
      created_at: row.created_at,
      last_activity_at: row.last_activity_at,
      idle_deadline_at: row.last_activity_at + SESSION_IDLE_MS,
      absolute_deadline_at: row.absolute_deadline_at,
      truncated: status === 'lost',
    };
  }
}
