import { PublicError } from '../errors.js';
import type { DatabaseTransport, Dialect } from '../types.js';

// The initial reviewed release accepts MySQL Direct only. Deferred modes
// require separate evidence and a reviewed code change before they can be
// admitted; no runtime toggle or second deployment path can bypass this rule.
export function isAvailableMode(transport: DatabaseTransport, dialect: Dialect): boolean {
  return transport === 'direct' && dialect === 'mysql';
}

export function requireAvailableMode(transport: DatabaseTransport, dialect: Dialect): void {
  if (!isAvailableMode(transport, dialect)) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'This connection mode is not enabled for this release.');
  }
}
