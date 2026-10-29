import type { Connection } from 'mysql2/promise';
import { PublicError } from '../errors.js';
import { withTimeout } from './timeout.js';
import type { EffectiveConnection } from '../types.js';

export type SqlPrimitive = string | number | boolean | null;

/** mysql2.query interpolates client-side. Reject any exotic object escape hooks. */
export function mysqlSafeParams(values: readonly unknown[]): SqlPrimitive[] {
  return values.map(value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return value;
    throw new PublicError('INVALID_INPUT', 'Hyperdrive MySQL parameters must be primitive values.');
  });
}
/** Check the actual MySQL session before client-side parameter interpolation.
 * Hyperdrive calls this inside its pinned transaction. Direct uses a dedicated
 * TCP connection, so the checked session is also the execution session.
 */
export async function assertMysqlInterpolationSqlMode(client: Connection, connection: EffectiveConnection): Promise<void> {
  // Cloudflare Hyperdrive may return zero rows for SELECT @@SESSION.sql_mode;
  // SHOW SESSION VARIABLES produces a row within the pinned transaction.
  const [rows] = await withTimeout(client.query("SHOW SESSION VARIABLES LIKE 'sql_mode'"),
    Math.min(connection.limits.queryTimeoutMs, 5_000), () => client.destroy());
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'MySQL SQL mode could not be verified.');
  }
  const first: unknown = rows[0];
  const name: unknown = Array.isArray(first) ? first[0]
    : first && typeof first === 'object' ? (first as Record<string, unknown>).Variable_name : undefined;
  const mode: unknown = Array.isArray(first) ? first[1]
    : first && typeof first === 'object' ? (first as Record<string, unknown>).Value : undefined;
  if (typeof name !== 'string' || name.toLowerCase() !== 'sql_mode' ||
      typeof mode !== 'string' ||
      mode.toUpperCase().split(',').some(x => x.trim() === 'NO_BACKSLASH_ESCAPES')) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'MySQL escaping is incompatible with this session.');
  }
}

/** Hyperdrive only: caller pins the backend with BEGIN before checking. */
export async function assertMysqlHyperdriveSqlMode(client: Connection, connection: EffectiveConnection): Promise<void> {
  if (connection.transport !== 'hyperdrive') return;
  await assertMysqlInterpolationSqlMode(client, connection);
}
