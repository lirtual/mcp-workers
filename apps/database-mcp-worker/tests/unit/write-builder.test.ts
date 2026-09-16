import { describe, expect, it } from 'vitest';
import { PublicError } from '../../src/errors.js';
import {
  buildDeleteStatement,
  buildInsertStatement,
  buildUpdateStatement,
  quoteWriteIdentifier
} from '../../src/sql/write.js';
import type { ConnectionConfig, Dialect, EffectiveWriteConnection } from '../../src/types.js';

function writer(dialect: Dialect): EffectiveWriteConnection {
  const config: ConnectionConfig = dialect === 'postgres'
    ? {
        id: 'db',
        displayName: 'DB',
        enabled: true,
        transport: 'hyperdrive',
        dialect: 'postgres',
        binding: 'READ_DB',
        defaultSchema: 'public',
        write: { transport: 'hyperdrive', binding: 'WRITE_DB' }
      }
    : {
        id: 'db',
        displayName: 'DB',
        enabled: true,
        transport: 'direct',
        urlSecret: 'READ_URL',
        write: { transport: 'direct', urlSecret: 'WRITE_URL' }
      };

  return {
    config,
    transport: config.write!.transport,
    dialect,
    connectionString: dialect === 'postgres' ? 'postgres://writer@db/app' : 'mysql://writer@db/app',
    host: 'db',
    user: 'writer',
    password: 'secret',
    database: 'app',
    port: dialect === 'postgres' ? 5432 : 3306,
    limits: { maxRows: 100, maxResultBytes: 1024, maxSchemaBytes: 1024, queryTimeoutMs: 1_000 },
    maxAffectedRows: 20
  };
}

describe('structured write SQL', () => {
  it('builds one parameterized PostgreSQL multi-row insert', () => {
    const statement = buildInsertStatement(writer('postgres'), undefined, 'users', [
      { id: 1, select: 'a' },
      { id: 2, select: 'b' }
    ]);

    expect(statement.sql).toBe(
      'INSERT INTO "public"."users" ("id", "select") VALUES ($1, $2), ($3, $4)'
    );
    expect(statement.params).toEqual([1, 'a', 2, 'b']);
    expect(statement.rowCount).toBe(2);
  });

  it('builds MySQL update predicates with AND, IN and null checks', () => {
    const statement = buildUpdateStatement(
      writer('mysql'),
      'app',
      'users',
      { status: 'done' },
      { id: { in: [1, 2] }, deleted_at: { isNull: true }, tenant: 'acme' }
    );

    expect(statement.sql).toBe(
      'UPDATE `app`.`users` SET `status` = ? WHERE `id` IN (?, ?) AND `deleted_at` IS NULL AND `tenant` = ?'
    );
    expect(statement.params).toEqual(['done', 1, 2, 'acme']);
  });

  it('builds explicit equality and IS NOT NULL predicates', () => {
    const statement = buildDeleteStatement(writer('postgres'), 'audit', 'events', {
      id: { eq: 9 },
      archived_at: { isNull: false }
    });
    expect(statement.sql).toBe(
      'DELETE FROM "audit"."events" WHERE "id" = $1 AND "archived_at" IS NOT NULL'
    );
    expect(statement.params).toEqual([9]);
  });

  it('rejects empty, ambiguous, and unsupported predicates', () => {
    expect(() => buildDeleteStatement(writer('postgres'), undefined, 'users', {})).toThrow(PublicError);
    expect(() => buildDeleteStatement(writer('postgres'), undefined, 'users', { id: null })).toThrow(PublicError);
    expect(() => buildDeleteStatement(writer('postgres'), undefined, 'users', {
      id: { eq: 1, in: [1] }
    })).toThrow(PublicError);
    expect(() => buildDeleteStatement(writer('postgres'), undefined, 'users', {
      id: { gt: 1 }
    })).toThrow(PublicError);
  });

  it('rejects insert rows with different column sets', () => {
    expect(() => buildInsertStatement(writer('mysql'), undefined, 'users', [
      { id: 1, name: 'a' },
      { id: 2, email: 'b@example.com' }
    ])).toThrow(PublicError);
  });

  it('restricts MySQL writes to the configured database', () => {
    expect(() => buildUpdateStatement(writer('mysql'), 'other', 'users', { active: true }, { id: 1 })).toThrow(
      PublicError
    );
  });

  it('quotes identifiers instead of accepting SQL fragments', () => {
    expect(quoteWriteIdentifier('a"b', 'postgres')).toBe('"a""b"');
    expect(quoteWriteIdentifier('a`b', 'mysql')).toBe('`a``b`');
    expect(() => quoteWriteIdentifier('bad\0name', 'postgres')).toThrow(PublicError);
  });

  it('rejects write payloads above 256 KiB', () => {
    expect(() => buildInsertStatement(writer('postgres'), undefined, 'users', [
      { id: 1, body: 'x'.repeat(300 * 1024) }
    ])).toThrow(PublicError);
  });
});
