import type { EffectClass } from './capabilities.js';
import { getConnection, type McpConnection } from './connections.js';

/**
 * Connection authorization for a single external attempt.
 *
 * This check is deliberately independent of the pinned Run definition: updating an
 * approved Connection must not silently retarget an existing Run. A caller must
 * load the current controls from D1 immediately before crossing the external
 * boundary, and must fail closed when the control row cannot be read.
 *
 * This is the pure decision layer only. It is NOT a substitute for the D1
 * read, admission/claim authorization, or the final pre-fetch check.
 */
export interface PinnedConnectionAuthority {
  connectionId: string;
  version: number;
  endpoint: string;
  toolName: string;
  effect: EffectClass;
  connection?: McpConnection;
}

export interface LiveConnectionControl {
  connectionId: string;
  disabled: boolean;
  /** The currently approved authority, inclusive of older pinned versions. */
  allowedTools: Readonly<Record<string, readonly EffectClass[]>>;
}

export type ConnectionAuthorization =
  | { allowed: true }
  | { allowed: false; reason: 'control_unavailable' | 'connection_mismatch' | 'revoked' | 'policy_tightened' };

export function authorizePinnedConnectionAttempt(
  pinned: PinnedConnectionAuthority,
  current: LiveConnectionControl | null | undefined
): ConnectionAuthorization {
  if (!current) return { allowed: false, reason: 'control_unavailable' };
  if (current.connectionId !== pinned.connectionId) {
    return { allowed: false, reason: 'connection_mismatch' };
  }
  if (current.disabled) return { allowed: false, reason: 'revoked' };
  const effects = current.allowedTools[pinned.toolName];
  if (!effects || !effects.includes(pinned.effect)) {
    return { allowed: false, reason: 'policy_tightened' };
  }
  return { allowed: true };
}

/**
 * Read the latest persisted controls for a pinned Connection.
 * Call this for each external attempt, not once per Run.
 * D1 failures propagate and must block the call; callers must not fall back to
 * static policy when a v0.2 Run has a pinned revision.
 */
export async function readLiveConnectionControl(
  db: D1Database,
  connectionId: string
): Promise<LiveConnectionControl | null> {
  const row = await db.prepare(
    'SELECT connection_id, disabled, allowed_tools_json FROM connection_controls WHERE connection_id = ?'
  ).bind(connectionId).first<{
    connection_id: string;
    disabled: number;
    allowed_tools_json: string;
  }>();
  if (!row) return null;
  const parsed: unknown = JSON.parse(row.allowed_tools_json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Connection control policy is invalid.');
  }
  const tools: Record<string, readonly EffectClass[]> = {};
  const validEffects: readonly string[] = ['read', 'idempotent_write', 'unsafe_write', 'unknown'];
  for (const [name, effects] of Object.entries(parsed)) {
    if (!name || !Array.isArray(effects) || !effects.every(
      item => typeof item === 'string' && validEffects.includes(item)
    )) {
      throw new Error('Connection control policy is invalid.');
    }
    tools[name] = effects as EffectClass[];
  }
  if (row.disabled !== 0 && row.disabled !== 1) {
    throw new Error('Connection control status is invalid.');
  }
  return {
    connectionId: row.connection_id,
    disabled: row.disabled === 1,
    allowedTools: tools
  };
}

/**
 * Resolve the immutable revision selected at Run admission. NULL is reserved
 * solely for pre-v0.2 Runs. A non-null malformed map or missing revision
 * fails closed instead of silently falling back to the static connection.
 */
export async function resolveRunConnectionPin(
  db: D1Database,
  runId: string,
  connectionId: string,
  toolName: string,
  effect: EffectClass
): Promise<PinnedConnectionAuthority | undefined> {
  const run = await db.prepare(
    'SELECT connection_versions_json FROM workflow_runs WHERE run_id = ?'
  ).bind(runId).first<{ connection_versions_json: string | null }>();
  if (!run) throw new Error('Pinned Run is unavailable.');
  if (run.connection_versions_json === null) return undefined;
  const versions: unknown = JSON.parse(run.connection_versions_json);
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) {
    throw new Error('Run Connection pins are invalid.');
  }
  const version = (versions as Record<string, unknown>)[connectionId];
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error('Run Connection revision is unavailable.');
  }
  const row = await db.prepare(
    'SELECT config_json FROM connection_config_versions WHERE connection_id = ? AND version = ?'
  ).bind(connectionId, version).first<{ config_json: string }>();
  if (!row) throw new Error('Pinned Connection revision is unavailable.');
  const config: unknown = JSON.parse(row.config_json);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Pinned Connection configuration is invalid.');
  }
  // v0.2's first tracer uses a separately approved revision of one of the
  // bundled endpoints. This explicit allowlist prevents an admin payload or D1
  // corruption from turning an arbitrary URL into an authenticated fetch.
  const approved = getConnection(connectionId);
  const candidate = config as Record<string, unknown>;
  if (!approved || candidate.endpoint !== approved.endpoint ||
      candidate.protocolVersion !== approved.protocolVersion ||
      candidate.transport !== 'streamable-http' ||
      candidate.authSecret !== approved.auth.secret ||
      candidate.trustAnnotations !== false) {
    throw new Error('Pinned Connection configuration is not approved.');
  }
  const rawTools = candidate.tools;
  if (!rawTools || typeof rawTools !== 'object' || Array.isArray(rawTools)) {
    throw new Error('Pinned Connection tool policy is invalid.');
  }
  const tools: Record<string, { effect: EffectClass; operationIdArgument?: string }> = {};
  for (const [name, value] of Object.entries(rawTools)) {
    const original = approved.tools[name];
    if (!original || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Pinned Connection tool policy is not approved.');
    }
    const tool = value as Record<string, unknown>;
    if (tool.effect !== original.effect || tool.operationIdArgument !== original.operationIdArgument) {
      throw new Error('Pinned Connection tool policy is not approved.');
    }
    tools[name] = original;
  }
  if (Object.keys(tools).length === 0 || !tools[toolName] || tools[toolName].effect !== effect) {
    throw new Error('Pinned Connection tool authority is not approved.');
  }
  const connection: McpConnection = { ...approved, tools };
  return {
    connectionId,
    version: version as number,
    endpoint: connection.endpoint,
    toolName,
    effect,
    connection
  };
}

/**
 * Capture current approved Connection revisions for a newly admitted Run.
 * A legacy static Connection without controls is intentionally omitted only
 * when no versioned Connection is used. Any explicitly versioned connection
 * without an approved control fails closed.
 */
export async function captureConnectionPins(
  db: D1Database,
  connectionIds: readonly string[]
): Promise<Record<string, number> | null> {
  if (connectionIds.length === 0) return null;
  const pins: Record<string, number> = {};
  for (const id of [...new Set(connectionIds)]) {
    const row = await db.prepare(
      'SELECT current_version, disabled FROM connection_controls WHERE connection_id = ?'
    ).bind(id).first<{ current_version: number; disabled: number }>();
    if (!row) {
      // The two bundled v0.1 Connections remain compatible until explicitly
      // registered. Never silently permit a missing dynamic Connection.
      if (id !== 'workflow-self' && id !== 'raindrop') {
        throw new Error('Connection is not approved.');
      }
      continue;
    }
    if (row.disabled !== 0 || !Number.isSafeInteger(row.current_version) || row.current_version < 1) {
      throw new Error('Connection is disabled or has an invalid revision.');
    }
    pins[id] = row.current_version;
  }
  // A partially pinned map cannot distinguish an intentionally legacy static
  // Connection from a missing pin on the same new Run. Reject mixed modes.
  if (Object.keys(pins).length > 0 && Object.keys(pins).length !== new Set(connectionIds).size) {
    throw new Error('Mixed versioned and legacy Connections are not yet supported.');
  }
  return Object.keys(pins).length ? pins : null;
}
