import { describe, expect, it } from 'vitest';
import { PublicError } from '../../src/errors.js';
import {
  buildAlterTableStatement,
  buildCreateIndexStatement,
  buildCreateTableStatement,
  buildDropIndexStatement,
  buildDropTableStatement
} from '../../src/sql/admin.js';

describe('safe admin DDL builder', () => {
  it('builds PostgreSQL CREATE TABLE from the bounded type subset', () => {
    const built = buildCreateTableStatement('postgres', 'public', 'widgets', [
      { name: 'id', type: 'bigint', primaryKey: true },
      { name: 'name', type: 'varchar', length: 120, nullable: false },
      { name: 'enabled', type: 'boolean', default: true },
      { name: 'meta', type: 'json', nullable: true }
    ]);
    expect(built.sql).toBe(
      'CREATE TABLE "public"."widgets" ("id" BIGINT NOT NULL PRIMARY KEY, "name" VARCHAR(120) NOT NULL, "enabled" BOOLEAN DEFAULT TRUE, "meta" JSONB)'
    );
  });

  it('builds MySQL CREATE TABLE and escapes literal defaults rather than accepting SQL expressions', () => {
    const built = buildCreateTableStatement('mysql', 'app', 'widgets', [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'label', type: 'varchar', length: 50, default: "O'Reilly" },
      { name: 'created_at', type: 'datetime' }
    ]);
    expect(built.sql).toContain("DEFAULT 'O''Reilly'");
    expect(built.sql).toContain('`created_at` DATETIME');
  });

  it('builds the supported ALTER TABLE operations without raw SQL fragments', () => {
    expect(buildAlterTableStatement('postgres', 'public', 'widgets', {
      action: 'add_column',
      column: { name: 'score', type: 'numeric', precision: 10, scale: 2 }
    }).sql).toBe('ALTER TABLE "public"."widgets" ADD COLUMN "score" NUMERIC(10,2)');

    expect(buildAlterTableStatement('mysql', 'app', 'widgets', {
      action: 'rename_column',
      column: 'label',
      newName: 'name'
    }).sql).toBe('ALTER TABLE `app`.`widgets` RENAME COLUMN `label` TO `name`');

    expect(buildAlterTableStatement('postgres', 'public', 'widgets', {
      action: 'drop_column',
      column: 'legacy'
    }).sql).toBe('ALTER TABLE "public"."widgets" DROP COLUMN "legacy"');
  });

  it('builds portable simple indexes and dialect-specific DROP INDEX', () => {
    expect(buildCreateIndexStatement('postgres', 'public', 'widgets', ['name'], true, 'widgets_name_uniq').sql).toBe(
      'CREATE UNIQUE INDEX "widgets_name_uniq" ON "public"."widgets" ("name")'
    );
    expect(buildDropIndexStatement('postgres', 'public', 'widgets', 'widgets_name_uniq').sql).toBe(
      'DROP INDEX "public"."widgets_name_uniq"'
    );
    expect(buildDropIndexStatement('mysql', 'app', 'widgets', 'widgets_name_idx').sql).toBe(
      'DROP INDEX `widgets_name_idx` ON `app`.`widgets`'
    );
    expect(buildDropTableStatement('mysql', 'app', 'widgets').sql).toBe('DROP TABLE `app`.`widgets`');
  });

  it('rejects unbounded or incompatible type options', () => {
    expect(() => buildCreateTableStatement('postgres', 'public', 'bad', [
      { name: 'name', type: 'varchar' }
    ])).toThrow(PublicError);
    expect(() => buildCreateTableStatement('postgres', 'public', 'bad', [
      { name: 'n', type: 'numeric', scale: 2 }
    ])).toThrow(PublicError);
    expect(() => buildCreateTableStatement('mysql', 'app', 'bad', [
      { name: 'text_col', type: 'text', length: 10 }
    ])).toThrow(PublicError);
    expect(() => buildCreateIndexStatement('mysql', 'app', 'widgets', [], false)).toThrow(PublicError);
  });
});
