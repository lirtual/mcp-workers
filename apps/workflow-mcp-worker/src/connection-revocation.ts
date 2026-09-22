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
