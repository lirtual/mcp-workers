import { describe, expect, it } from 'vitest';
import { guardReadQuery, injectMySqlExecutionTimeout, sanitizedSqlPreview, toReadLimitedSql } from '../../src/sql/guard.js';

const rejected = [
  'UPDATE users SET active = false',
  'SELECT 1; DELETE FROM users',
  'WITH deleted AS (DELETE FROM users RETURNING *) SELECT * FROM deleted',
  "SELECT * FROM users INTO OUTFILE '/tmp/users'",
  'SELECT * FROM users FOR SHARE',
  "SELECT GET_LOCK('mcp', 10)",
  'EXPLAIN ANALYZE SELECT * FROM users',
  'SELECT 1 /*!50000 UNION SELECT 2 */',
  'SELECT /*+ MAX_EXECUTION_TIME(0) */ 1',
  'SELECT pg_advisory_lock(42)',
  "SELECT nextval('orders_id_seq')",
  "SELECT set_config('statement_timeout', '0', false)"
];

describe('read query guard', () => {
  it.each(rejected)('rejects unsafe SQL: %s', sql => {
    expect(() => guardReadQuery(sql, sql.includes('GET_LOCK') || sql.includes('OUTFILE') || sql.includes('FOR SHARE') ? 'mysql' : 'postgres')).toThrow();
  });

  it('accepts select and CTE reads with literals/comments containing scary words', () => {
    expect(guardReadQuery("SELECT 'DELETE FROM users' AS note -- DROP TABLE x", 'postgres').firstKeyword).toBe('SELECT');
    expect(guardReadQuery('WITH x AS (SELECT 1 AS n) SELECT * FROM x;', 'postgres').sql).toContain('WITH x');
  });

  it('injects a bounded MySQL execution-time hint into the first SELECT', () => {
    expect(injectMySqlExecutionTimeout('WITH x AS (SELECT 1) SELECT * FROM x', 15000)).toContain('SELECT /*+ MAX_EXECUTION_TIME(15000) */');
  });

  it('wraps reads with a server-controlled row limit', () => {
    expect(toReadLimitedSql('SELECT * FROM users', 'postgres', 11)).toBe('SELECT * FROM (SELECT * FROM users) AS __mcp_query LIMIT 11');
  });

  it('redacts string, dollar-quoted, and numeric literal contents from log previews', () => {
    const preview = sanitizedSqlPreview("SELECT * FROM users WHERE token = 'super-secret-token' AND note = $tag$another-secret$tag$ AND pin = 123456");
    expect(preview).not.toContain('super-secret-token');
    expect(preview).not.toContain('another-secret');
    expect(preview).not.toContain('123456');
    expect(preview).toContain("'?'");
    expect(preview).toContain('$?$');
  });
  it('never throws while redacting executable or optimizer comments for error logging', () => {
    expect(() => sanitizedSqlPreview('SELECT 1 /*!50000 UNION SELECT 2 */')).not.toThrow();
    expect(() => sanitizedSqlPreview('SELECT /*+ MAX_EXECUTION_TIME(0) */ 1')).not.toThrow();
    expect(sanitizedSqlPreview('SELECT 1 /*!50000 UNION SELECT 2 */')).not.toContain('UNION SELECT 2');
  });

});
