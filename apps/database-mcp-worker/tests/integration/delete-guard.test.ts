import { describe, expect, it } from 'vitest';
import { parseConnectionCatalog, resolveConnection, resolveWriteConnection } from '../../src/config.js';
import { deleteRows, insertRows, queryRead } from '../../src/db/index.js';
import type { Env } from '../../src/types.js';

function writableConnection(id: string, readUrl: string, writeUrl: string) {
  const env: Env = {
    CONNECTIONS_JSON: '[]',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    TEST_READ_URL: readUrl,
    TEST_WRITE_URL: writeUrl,
    MAX_WRITE_AFFECTED_ROWS: '1'
  };
  const catalog = parseConnectionCatalog(JSON.stringify([
    {
      id,
      displayName: id,
      transport: 'direct',
      urlSecret: 'TEST_READ_URL',
      write: { transport: 'direct', urlSecret: 'TEST_WRITE_URL' }
    }
  ]));
  return {
    read: resolveConnection(env, catalog, id),
    write: resolveWriteConnection(env, catalog, id)
  };
}

const pgReadUrl = process.env.TEST_POSTGRES_READ_URL;
const pgWriteUrl = process.env.TEST_POSTGRES_WRITE_URL;
const mysqlReadUrl = process.env.TEST_MYSQL_READ_URL;
const mysqlWriteUrl = process.env.TEST_MYSQL_WRITE_URL;
const describeIntegration = pgReadUrl && pgWriteUrl && mysqlReadUrl && mysqlWriteUrl ? describe : describe.skip;

describeIntegration('safe write delete guard', () => {
  it('rolls back PostgreSQL and MySQL deletes above the affected-row limit', async () => {
    const pg = writableConnection('pg_delete_guard', pgReadUrl!, pgWriteUrl!);
    const mysql = writableConnection('mysql_delete_guard', mysqlReadUrl!, mysqlWriteUrl!);

    await insertRows(pg.write, 'public', 'write_items', [
      { id: 901, value: 'keep' },
      { id: 902, value: 'keep' }
    ]);
    await insertRows(mysql.write, undefined, 'write_items', [
      { id: 901, value: 'keep' },
      { id: 902, value: 'keep' }
    ]);

    await expect(deleteRows(pg.write, 'public', 'write_items', { id: { in: [901, 902] } })).rejects.toMatchObject({
      code: 'WRITE_LIMIT_EXCEEDED'
    });
    await expect(deleteRows(mysql.write, undefined, 'write_items', { id: { in: [901, 902] } })).rejects.toMatchObject({
      code: 'WRITE_LIMIT_EXCEEDED'
    });

    expect((await queryRead(pg.read, 'SELECT id FROM public.write_items WHERE id IN ($1, $2) ORDER BY id', [901, 902], 10)).rows).toEqual([[901], [902]]);
    expect((await queryRead(mysql.read, 'SELECT id FROM write_items WHERE id IN (?, ?) ORDER BY id', [901, 902], 10)).rows).toEqual([[901], [902]]);
  });
});
