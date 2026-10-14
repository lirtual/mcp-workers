import { describe, expect, it } from 'vitest';
import { getMaxWriteAffectedRows, getRuntimeLimits, parseDirectDatabaseUrl, parseDatabaseConfig } from '../../src/config.js';
import type { Env } from '../../src/types.js';

describe('database configuration limits and URLs', () => {
  it('derives dialect from SQL URLs and rejects direct TLS requests', () => {
    expect(parseDirectDatabaseUrl('postgresql://u:p@host/db', 'pg').dialect).toBe('postgres');
    expect(parseDirectDatabaseUrl('mysql://u:p@host/db', 'mysql').dialect).toBe('mysql');
    expect(() => parseDirectDatabaseUrl('mysql://u:p@host/db?ssl=true', 'mysql')).toThrow();
  });

  it('accepts between one and fifty flat entries only', () => {
    expect(() => parseDatabaseConfig(JSON.stringify(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`db${i}`, 'mysql://u:p@h/db']))))).not.toThrow();
    expect(() => parseDatabaseConfig(JSON.stringify(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`db${i}`, 'mysql://u:p@h/db']))))).toThrow();
  });

  it('uses bounded safe runtime defaults', () => {
    const env: Env = { RATE_LIMITER: { async limit() { return { success: true }; } } };
    expect(getRuntimeLimits(env)).toEqual({ maxRows: 500, maxResultBytes: 1_048_576, maxSchemaBytes: 524_288, queryTimeoutMs: 15_000 });
    expect(getMaxWriteAffectedRows(env)).toBe(20);
  });
});
