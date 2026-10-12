import { describe, expect, it } from 'vitest';
import { formatSchemaContextRows } from '../../src/db/schema-context.js';
import type { QueryResult } from '../../src/types.js';

function result(rows: unknown[][], truncated = false): QueryResult {
  return {
    columns: [],
    rows,
    rowCount: rows.length,
    truncated,
    ...(truncated ? { truncationReason: 'row_limit' as const } : {})
  };
}

describe('formatSchemaContextRows', () => {
  it('builds compact table, primary-key, and foreign-key context', () => {
    const columns = result([
      ['organizations', 'BASE TABLE', '2', 'id', 'bigint', 'NO', 1],
      ['organizations', 'BASE TABLE', '2', 'name', 'text', 'NO', 2],
      ['users', 'BASE TABLE', '2', 'id', 'bigint', 'NO', 1],
      ['users', 'BASE TABLE', '2', 'organization_id', 'bigint', 'NO', 2],
      ['users', 'BASE TABLE', '2', 'nickname', 'text', 'YES', 3]
    ]);
    const constraints = result([
      ['organizations', 'PRIMARY KEY', 'id', null, null, null, 1],
      ['users', 'PRIMARY KEY', 'id', null, null, null, 1],
      ['users', 'FOREIGN KEY', 'organization_id', 'public', 'organizations', 'id', 1]
    ]);

    const context = formatSchemaContextRows('postgres', 'public', columns, constraints, 1024 * 1024);

    expect(context).toEqual({
      dialect: 'postgres',
      schema: 'public',
      tableCount: 2,
      totalTables: 2,
      truncated: false,
      context:
        'organizations(id bigint PK NOT NULL, name text NOT NULL)\n' +
        'users(id bigint PK NOT NULL, organization_id bigint NOT NULL -> organizations.id, nickname text)'
    });
  });

  it('keeps cross-schema references qualified and marks views', () => {
    const columns = result([
      ['active_users', 'VIEW', '1', 'user_id', 'bigint', 'NO', 1]
    ]);
    const constraints = result([
      ['active_users', 'FOREIGN KEY', 'user_id', 'identity', 'users', 'id', 1]
    ]);

    const context = formatSchemaContextRows('postgres', 'reporting', columns, constraints, 1024 * 1024);

    expect(context.context).toBe('active_users [VIEW](user_id bigint NOT NULL -> identity.users.id)');
  });

  it('reports truncation from row limits or omitted tables', () => {
    const columns = result([
      ['users', 'BASE TABLE', '3', 'id', 'bigint', 'NO', 1]
    ], true);

    const context = formatSchemaContextRows('mysql', 'app', columns, result([]), 1024 * 1024);

    expect(context.tableCount).toBe(1);
    expect(context.totalTables).toBe(3);
    expect(context.truncated).toBe(true);
  });
});
