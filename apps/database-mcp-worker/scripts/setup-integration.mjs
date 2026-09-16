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
  END $$`);
  await pg.query(`DROP FUNCTION IF EXISTS public.dangerous_bump()`);
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
  await pg.query(`CREATE TABLE public.counter (value integer NOT NULL)`);
  await pg.query(`INSERT INTO public.counter VALUES (0)`);
  await pg.query(`ALTER TABLE public.users ENABLE ROW LEVEL SECURITY`);
  await pg.query(`CREATE POLICY mcp_reader_policy ON public.users FOR SELECT TO mcp_reader USING (tenant_id = 1)`);
  await pg.query(`GRANT USAGE ON SCHEMA public TO mcp_reader`);
  await pg.query(`GRANT SELECT ON public.users, public.counter TO mcp_reader`);
  await pg.query(`CREATE FUNCTION public.dangerous_bump() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      UPDATE public.counter SET value = value + 1;
      RETURN (SELECT value FROM public.counter);
    END $$`);
  await pg.query(`REVOKE EXECUTE ON FUNCTION public.dangerous_bump() FROM PUBLIC, mcp_reader`);
  await pg.query(`ALTER ROLE mcp_reader SET default_transaction_read_only = on`);
  await pg.query(`ALTER ROLE mcp_reader SET statement_timeout = '2s'`);
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
  await mysql.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'mcp_reader'@'%'`);
  await mysql.query(`DROP PROCEDURE IF EXISTS dangerous_bump`);
  await mysql.query(`DROP TABLE IF EXISTS counter`);
  await mysql.query(`DROP TABLE IF EXISTS users`);
  await mysql.query(`CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255) NOT NULL)`);
  await mysql.query(`INSERT INTO users VALUES (1, 'one@example.com'), (2, 'two@example.com')`);
  await mysql.query(`CREATE TABLE counter (value INT NOT NULL)`);
  await mysql.query(`INSERT INTO counter VALUES (0)`);
  await mysql.query(`CREATE PROCEDURE dangerous_bump() SQL SECURITY DEFINER MODIFIES SQL DATA UPDATE counter SET value = value + 1`);
  await mysql.query(`GRANT SELECT ON testdb.users TO 'mcp_reader'@'%'`);
  await mysql.query(`FLUSH PRIVILEGES`);
} finally {
  await mysql.end();
}
