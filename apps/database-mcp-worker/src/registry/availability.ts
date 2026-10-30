import { PublicError } from '../errors.js';
import type { DatabaseTransport, Dialect } from '../types.js';

// Four combinations: both database dialects support explicit plaintext Direct
// and separately verified, strict-TLS Hyperdrive.
// Hyperdrive references remain disabled until protected Actions verification.
export function isAvailableMode(transport: DatabaseTransport, dialect: Dialect): boolean {
  return (transport === 'direct' || transport === 'hyperdrive') &&
    (dialect === 'mysql' || dialect === 'postgres');
}

export function requireAvailableMode(transport: DatabaseTransport, dialect: Dialect): void {
  if (!isAvailableMode(transport, dialect)) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'This connection mode is not enabled for this release.');
  }
}
