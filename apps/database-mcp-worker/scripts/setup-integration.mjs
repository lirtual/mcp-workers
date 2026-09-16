import { Client as PgClient } from 'pg';
import { createConnection } from 'mysql2/promise';

const pgUrl = process.env.TEST_POSTGRES_ADMIN_URL;
const mysqlUrl = process.env.TEST_MYSQL_ADMIN_URL;
if (!pgUrl || !mysqlUrl) {
  throw new Error('TEST_POSTGRES_ADMIN_URL and TEST_MYSQL_ADMIN_URL are required');
}

const pg = new PgClient({ connectionString: pgUrl });
await pg.connect();
try {
  await pg.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
      CREATE ROLE mcp_reader LOGIN PASSWORD 'reader';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
      CREATE ROLE mcp_writer LOGIN PASSWORD 'writer';
    END IF;
  END $$`);
  await pg.query(`DROP FUNCTION IF EXISTS public.dangerous_bump()`);
  await pg.query(`DROP TABLE IF EXISTS public.write_items CASCADE`);
  await pg.query(`DROP TABLE IF EXISTS public.counter CASCADE`);
  await pg.query(`DROP TABLE IF EXISTS public.users CASCADE`);
  await pg.query(`CREATE TABLE public.users (
    id integer PRIMARY KEY,
    tenant_id integer NOT NULL,
    email text NOT NULL
  )`);
  await pg.query(`INSERT INTO public.users VALUES
    (1, 1, 'one@example.com'),
    (2, 2, 'two@example.com')`);
  await pg.query(`CREATE TABLE public.write_items (
    id integer PRIMARY KEY,
    tenant_id integer NOT NULL,
    value text NOT NULL,
    note text NULL
  )`);
  await pg.query(`INSERT INTO public.write_items VALUES
    (101, 1, 'bulk', NULL),
    (102, 1, 'bulk', NULL),
    (103, 1, 'update-me', 'note'),
    (104, 1, 'delete-me', NULL),
    (106, 1, 'delete-bulk', NULL),
    (107, 1, 'delete-bulk', NULL),
    (105, 2, 'hidden', NULL)`);
  await pg.query(`CREATE TABLE public.counter (value integer NOT NULL)`);
  await pg.query(`INSERT INTO public.counter VALUES (0)`);

  await pg.query(`ALTER TABLE public.users ENABLE ROW LEVEL SECURITY`);
  await pg.query(`ALTER TABLE public.write_items ENABLE ROW LEVEL SECURITY`);
  await pg.query(`CREATE POLICY mcp_reader_users_policy ON public.users FOR SELECT TO mcp_reader USING (tenant_id = 1)`);
  await pg.query(`CREATE POLICY mcp_reader_write_items_policy ON public.write_items FOR SELECT TO mcp_reader USING (tenant_id = 1)`);
  await pg.query(`CREATE POLICY mcp_writer_select_policy ON public.write_items FOR SELECT TO mcp_writer USING (tenant_id = 1)`);
  await pg.query(`CREATE POLICY mcp_writer_insert_policy ON public.write_items FOR INSERT TO mcp_writer WITH CHECK (tenant_id = 1)`);
  await pg.query(`CREATE POLICY mcp_writer_update_policy ON public.write_items FOR UPDATE TO mcp_writer USING (tenant_id = 1) WITH CHECK (tenant_id = 1)`);
  await pg.query(`CREATE POLICY mcp_writer_delete_policy ON public.write_items FOR DELETE TO mcp_writer USING (tenant_id = 1)`);

  await pg.query(`GRANT USAGE ON SCHEMA public TO mcp_reader, mcp_writer`);
  await pg.query(`REVOKE CREATE ON SCHEMA public FROM mcp_reader, mcp_writer`);
  await pg.query(`GRANT SELECT ON public.users, public.counter, public.write_items TO mcp_reader`);
  await pg.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.write_items TO mcp_writer`);

  await pg.query(`CREATE FUNCTION public.dangerous_bump() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      UPDATE public.counter SET value = value + 1;
      RETURN (SELECT value FROM public.counter);
    END $$`);
  await pg.query(`REVOKE EXECUTE ON FUNCTION public.dangerous_bump() FROM PUBLIC, mcp_reader, mcp_writer`);
  await pg.query(`ALTER ROLE mcp_reader SET default_transaction_read_only = on`);
  await pg.query(`ALTER ROLE mcp_reader SET statement_timeout = '2s'`);
  await pg.query(`ALTER ROLE mcp_writer SET statement_timeout = '2s'`);
} finally {
  await pg.end();
}

const mysqlParsed = new URL(mysqlUrl);
const mysql = await createConnection({
  host: mysqlParsed.hostname,
  port: Number(mysqlParsed.port || 3306),
  user: decodeURIComponent(mysqlParsed.username),
  password: decodeURIComponent(mysqlParsed.password),
  database: mysqlParsed.pathname.slice(1),
  disableEval: true,
  multipleStatements: true
});
try {
  await mysql.query(`CREATE USER IF NOT EXISTS 'mcp_reader'@'%' IDENTIFIED BY 'reader'`);
  await mysql.query(`CREATE USER IF NOT EXISTS 'mcp_writer'@'%' IDENTIFIED BY 'writer'`);
  await mysql.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'mcp_reader'@'%'`);
  await mysql.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'mcp_writer'@'%'`);
  await mysql.query(`DROP PROCEDURE IF EXISTS dangerous_bump`);
  await mysql.query(`DROP TABLE IF EXISTS write_items`);
  await mysql.query(`DROP TABLE IF EXISTS counter`);
  await mysql.query(`DROP TABLE IF EXISTS users`);
  await mysql.query(`CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255) NOT NULL) ENGINE=InnoDB`);
  await mysql.query(`INSERT INTO users VALUES (1, 'one@example.com'), (2, 'two@example.com')`);
  await mysql.query(`CREATE TABLE write_items (
    id INT PRIMARY KEY,
    tenant_id INT NOT NULL,
    value VARCHAR(255) NOT NULL,
    note VARCHAR(255) NULL
  ) ENGINE=InnoDB`);
  await mysql.query(`INSERT INTO write_items VALUES
    (101, 1, 'bulk', NULL),
    (102, 1, 'bulk', NULL),
    (103, 1, 'update-me', 'note'),
    (104, 1, 'delete-me', NULL),
    (106, 1, 'delete-bulk', NULL),
    (107, 1, 'delete-bulk', NULL)`);
  await mysql.query(`CREATE TABLE counter (value INT NOT NULL) ENGINE=InnoDB`);
  await mysql.query(`INSERT INTO counter VALUES (0)`);
  await mysql.query(`CREATE PROCEDURE dangerous_bump() SQL SECURITY DEFINER MODIFIES SQL DATA UPDATE counter SET value = value + 1`);
  await mysql.query(`GRANT SELECT ON testdb.users TO 'mcp_reader'@'%'`);
  await mysql.query(`GRANT SELECT ON testdb.write_items TO 'mcp_reader'@'%'`);
  await mysql.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON testdb.write_items TO 'mcp_writer'@'%'`);
  await mysql.query(`FLUSH PRIVILEGES`);
} finally {
  await mysql.end();
}
