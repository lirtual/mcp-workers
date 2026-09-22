import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1WorkflowStore } from '../src/storage.js';

describe('T08 schedule cursor monotonicity', () => {
  it('does not rewind the evaluation or admitted minute when an older tick finishes last', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(readFileSync('migrations/0002_scheduler.sql', 'utf8'));
      type Arg = string | number | bigint | null;
      const statement = (sql: string, args: unknown[] = []) => ({
        bind: (...next: unknown[]) => statement(sql, next),
        first: async () => sqlite.prepare(sql).get(...(args as Arg[])) ?? null,
        run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...(args as Arg[])).changes } })
      });
      const store = new D1WorkflowStore({
        prepare: (sql: string) => statement(sql)
      } as unknown as D1Database);
      const minute = 60_000;
      await store.saveSchedulerState({
        scheduleKey: 'example:daily', lastEvaluatedAt: 20 * minute,
        lastAdmittedScheduledTime: 20 * minute
      });
      // A stale tick can finish after a newer tick; it must not overwrite its cursor.
      await store.saveSchedulerState({
        scheduleKey: 'example:daily', lastEvaluatedAt: 19 * minute,
        lastAdmittedScheduledTime: 19 * minute
      });
      expect(await store.getSchedulerState('example:daily')).toMatchObject({
        lastEvaluatedAt: 20 * minute, lastAdmittedScheduledTime: 20 * minute
      });
      // An evaluation without a due occurrence must preserve the admitted high-water mark.
      await store.saveSchedulerState({
        scheduleKey: 'example:daily', lastEvaluatedAt: 21 * minute
      });
      expect(await store.getSchedulerState('example:daily')).toMatchObject({
        lastEvaluatedAt: 21 * minute, lastAdmittedScheduledTime: 20 * minute
      });
      await store.saveSchedulerState({
        scheduleKey: 'example:daily', lastEvaluatedAt: 22 * minute,
        lastAdmittedScheduledTime: 22 * minute
      });
      expect(await store.getSchedulerState('example:daily')).toMatchObject({
        lastEvaluatedAt: 22 * minute, lastAdmittedScheduledTime: 22 * minute
      });
      expect((sqlite.prepare('SELECT COUNT(*) AS total FROM scheduler_state')
        .get() as { total: number }).total).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
