import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '../helpers/catalog.js';
import { resolveConnection, resolveWriteConnection } from '../../src/config.js';
import { deleteRows, insertRows, queryRead } from '../../src/db/index.js';
import type { Env } from '../../src/types.js';

function writableConnection(id: string, writeUrl: string) {
  const env: Env = {
    RATE_LIMITER: { async limit() { return { success: true }; } },

    MAX_WRITE_AFFECTED_ROWS: '1'
  };
  const catalog = parseDatabaseConfig(JSON.stringify({ [id]: writeUrl }));
  return {
    read: resolveConnection(env, catalog, id),
    write: resolveWriteConnection(env, catalog, id)
  };
}

const pgWriteUrl = process.env.TEST_POSTGRES_WRITE_URL;
const mysqlWriteUrl = process.env.TEST_MYSQL_WRITE_URL;
const describeIntegration = pgWriteUrl && mysqlWriteUrl ? describe : describe.skip;

describeIntegration('safe write delete guard', () => {
  it('rolls back PostgreSQL and MySQL deletes above the affected-row limit', async () => {
    const pg = writableConnection('pg_delete_guard', pgWriteUrl!);
    const mysql = writableConnection('mysql_delete_guard', mysqlWriteUrl!);

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
