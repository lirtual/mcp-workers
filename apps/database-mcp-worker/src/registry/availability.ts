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

// Initial imported records are revision-1 and disabled until the independently
// authorized two-ID atomic cutover. Normal Owner CRUD/rotation cannot change
// their ciphertext, revision, status or retirement state in this phase.
export function isStagedOriginalIdentity(row: {
  id: string; status: string; revision: number;
}): boolean {
  return (row.id === 'b2b' || row.id === 'scrape_relay') &&
    row.status === 'disabled' && row.revision === 1;
}
