import { PublicError } from '../errors.js';
import type { DatabaseTransport, Dialect } from '../types.js';

// SQL drivers support MySQL/PostgreSQL over explicit plaintext Direct or
// dedicated verified Cloudflare Hyperdrive bindings. Hyperdrive references
// enter D1 disabled and are enabled only by protected Actions verification.
export function isAvailableMode(transport: DatabaseTransport, dialect: Dialect): boolean {
  return (transport === 'direct' || transport === 'hyperdrive') &&
    (dialect === 'mysql' || dialect === 'postgres');
}

export function requireAvailableMode(transport: DatabaseTransport, dialect: Dialect): void {
  if (!isAvailableMode(transport, dialect)) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'This connection mode is not enabled for this release.');
  }
}
