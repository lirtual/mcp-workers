import type { EffectClass } from './capabilities.js';

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
