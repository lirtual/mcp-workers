import { describe, expect, it } from 'vitest';
import { PublicError } from '../../src/errors.js';
import {
  assertWritePayloadWithinLimit,
  buildDeleteStatement,
  buildInsertStatement,
  buildUpdateStatement,
  quoteIdentifier
} from '../../src/sql/write.js';

describe('safe write SQL builder', () => {
  it('quotes identifiers for both dialects without treating identifier text as SQL', () => {
    expect(quoteIdentifier('odd"name', 'postgres')).toBe('"odd""name"');
    expect(quoteIdentifier('odd`name', 'mysql')).toBe('`odd``name`');
    expect(() => quoteIdentifier('bad\u0000name', 'postgres')).toThrow(PublicError);
  });

  it('builds one parameterized multi-row PostgreSQL insert and ignores row property order', () => {
    const built = buildInsertStatement('postgres', 'public', 'users', [
      { name: 'Ray', status: 'active' },
      { status: 'pending', name: 'Ada' }
    ]);

    expect(built.sql).toBe(
      'INSERT INTO "public"."users" ("name", "status") VALUES ($1, $2), ($3, $4)'
    );
    expect(built.params).toEqual(['Ray', 'active', 'Ada', 'pending']);
    expect(built.sql).not.toContain('Ray');
  });

  it('builds parameterized MySQL update predicates with AND-only eq, in, and null checks', () => {
    const built = buildUpdateStatement(
      'mysql',
      'app',
      'users',
      { status: 'disabled' },
      {
        id: { in: [1, 2, 3] },
        tenant_id: 7,
        deleted_at: { isNull: true }
      }
    );

    expect(built.sql).toBe(
      'UPDATE `app`.`users` SET `status` = ? WHERE `id` IN (?, ?, ?) AND `tenant_id` = ? AND `deleted_at` IS NULL'
    );
    expect(built.params).toEqual(['disabled', 1, 2, 3, 7]);
    expect(built.sql).not.toContain('disabled');
  });

  it('builds delete with explicit equality object and IS NOT NULL', () => {
    const built = buildDeleteStatement('postgres', 'public', 'sessions', {
      user_id: { eq: 42 },
      revoked_at: { isNull: false }
    });

    expect(built.sql).toBe(
      'DELETE FROM "public"."sessions" WHERE "user_id" = $1 AND "revoked_at" IS NOT NULL'
    );
    expect(built.params).toEqual([42]);
  });

  it('rejects empty or ambiguous predicates and unsupported expression shapes', () => {
    expect(() => buildUpdateStatement('postgres', 'public', 'users', { status: 'x' }, {})).toThrow(PublicError);
    expect(() => buildDeleteStatement('postgres', 'public', 'users', { id: null })).toThrow(PublicError);
    expect(() => buildDeleteStatement('postgres', 'public', 'users', { id: { eq: 1, isNull: false } })).toThrow(
      PublicError
    );
    expect(() => buildDeleteStatement('postgres', 'public', 'users', { id: { gt: 1 } })).toThrow(PublicError);
    expect(() => buildDeleteStatement('postgres', 'public', 'users', { id: { in: [] } })).toThrow(PublicError);
  });

  it('rejects inserts whose rows have different column sets', () => {
    expect(() => buildInsertStatement('mysql', 'app', 'users', [
      { id: 1, name: 'one' },
      { id: 2, email: 'two@example.com' }
    ])).toThrow(PublicError);
  });

  it('enforces the write payload budget before database execution', () => {
    expect(() => assertWritePayloadWithinLimit({ value: 'x'.repeat(300_000) })).toThrow(PublicError);
    expect(() => assertWritePayloadWithinLimit({ value: 'ok' })).not.toThrow();
  });
});
