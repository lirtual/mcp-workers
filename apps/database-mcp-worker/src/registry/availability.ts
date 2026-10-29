import { PublicError } from '../errors.js';
import type { DatabaseTransport, Dialect } from '../types.js';

// Three approved combinations: MySQL Direct, MySQL Hyperdrive and PostgreSQL
// Hyperdrive. PostgreSQL Direct is not a supported Owner or MCP runtime mode.
// Hyperdrive references remain disabled until protected Actions verification.
export function isAvailableMode(transport: DatabaseTransport, dialect: Dialect): boolean {
  return (transport === 'direct' && dialect === 'mysql') ||
    (transport === 'hyperdrive' && (dialect === 'mysql' || dialect === 'postgres'));
}

export function requireAvailableMode(transport: DatabaseTransport, dialect: Dialect): void {
  if (!isAvailableMode(transport, dialect)) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'This connection mode is not enabled for this release.');
  }
}
