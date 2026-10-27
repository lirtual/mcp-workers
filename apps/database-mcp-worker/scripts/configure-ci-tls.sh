#!/usr/bin/env bash
# Disposable GitHub Actions service fixtures only. No production credentials.
set -euo pipefail
: "${GITHUB_ENV:?CI only}" "${RUNNER_TEMP:?CI only}" "${POSTGRES_PORT:?}" "${MYSQL_PORT:?}"
work="$RUNNER_TEMP/database-ci-certs"
mkdir -p "$work"
chmod 700 "$work"
openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 1 \
  -subj '/CN=Database CI Root' -keyout "$work/root.key" -out "$work/root.crt" >/dev/null 2>&1
for name in postgres mysql; do
  host="${name}.db-ci.test"
  openssl req -new -nodes -newkey rsa:2048 -sha256 -subj "/CN=${host}" \
    -keyout "$work/${name}.key" -out "$work/${name}.csr" >/dev/null 2>&1
  printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\n' "$host" > "$work/${name}.ext"
  openssl x509 -req -in "$work/${name}.csr" -CA "$work/root.crt" -CAkey "$work/root.key" \
    -CAcreateserial -out "$work/${name}.crt" -days 1 -sha256 -extfile "$work/${name}.ext" >/dev/null 2>&1
  openssl verify -CAfile "$work/root.crt" "$work/${name}.crt"
done
pg=$(docker ps --filter ancestor=postgres:17 --format '{{.ID}}' | head -1)
my=$(docker ps --filter ancestor=mysql:8.4 --format '{{.ID}}' | head -1)
[[ -n "$pg" && -n "$my" ]] || { echo 'CI database containers missing'; exit 1; }
sudo sh -c 'printf "127.0.0.1 postgres.db-ci.test mysql.db-ci.test postgres-wrong.db-ci.test mysql-wrong.db-ci.test\n" >> /etc/hosts'
# PostgreSQL: install a trusted SAN cert and force hostssl (no plaintext TCP).
docker cp "$work/postgres.crt" "$pg:/var/lib/postgresql/data/server.crt"
docker cp "$work/postgres.key" "$pg:/var/lib/postgresql/data/server.key"
docker cp "$work/root.crt" "$pg:/var/lib/postgresql/data/root.crt"
docker exec -u 0 "$pg" sh -c 'chown postgres:postgres /var/lib/postgresql/data/{server.crt,server.key,root.crt} 2>/dev/null || chown postgres:postgres /var/lib/postgresql/data/*.crt /var/lib/postgresql/data/*.key; chmod 600 /var/lib/postgresql/data/server.key'
docker exec -u postgres "$pg" psql -d testdb -c "ALTER SYSTEM SET ssl = 'on'" >/dev/null
docker exec -u postgres "$pg" psql -d testdb -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/data/server.crt'" >/dev/null
docker exec -u postgres "$pg" psql -d testdb -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/data/server.key'" >/dev/null
docker exec -u 0 "$pg" sh -c "sed -i '1i hostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject' /var/lib/postgresql/data/pg_hba.conf"
docker exec -u postgres "$pg" psql -d testdb -c 'SELECT pg_reload_conf()' >/dev/null
[[ "$(docker exec -u postgres "$pg" psql -d testdb -Atc 'SHOW ssl')" == 'on' ]]
# MySQL: replace only ephemeral auto-generated service TLS materials and reload.
docker cp "$work/root.crt" "$my:/var/lib/mysql/ca.pem"
docker cp "$work/mysql.crt" "$my:/var/lib/mysql/server-cert.pem"
docker cp "$work/mysql.key" "$my:/var/lib/mysql/server-key.pem"
docker exec -u 0 "$my" sh -c 'chown mysql:mysql /var/lib/mysql/{ca.pem,server-cert.pem,server-key.pem} 2>/dev/null || chown mysql:mysql /var/lib/mysql/*.pem; chmod 600 /var/lib/mysql/server-key.pem'
docker exec "$my" mysql -uroot -proot -e 'ALTER INSTANCE RELOAD TLS; SET GLOBAL require_secure_transport=ON;'
# Explicitly prove network plaintext is disabled on both disposable test engines.
pg_ci_password=$(node -e 'process.stdout.write(new URL(process.env.TEST_POSTGRES_ADMIN_URL).password)')
if docker exec -e "PGPASSWORD=$pg_ci_password" "$pg" sh -c 'PGSSLMODE=disable psql -h 127.0.0.1 -U postgres -d testdb -Atqc "SELECT 1" >/dev/null 2>&1'; then
  echo 'PostgreSQL accepted plaintext TCP unexpectedly'; exit 1
fi
unset pg_ci_password
if docker exec "$my" mysql -h 127.0.0.1 --protocol=TCP --ssl-mode=DISABLED -umcp_reader -preader -e 'SELECT 1' >/dev/null 2>&1; then
  echo 'MySQL accepted plaintext TCP unexpectedly'; exit 1
fi
# Trust root applies to Node integration tests; do not disable verifier anywhere.
{
  printf 'NODE_EXTRA_CA_CERTS=%s/root.crt\n' "$work"
  printf 'TEST_POSTGRES_ADMIN_URL=postgres://postgres:postgres@postgres.db-ci.test:%s/testdb\n' "$POSTGRES_PORT"
  printf 'TEST_POSTGRES_READ_URL=postgres://mcp_reader:reader@postgres.db-ci.test:%s/testdb\n' "$POSTGRES_PORT"
  printf 'TEST_POSTGRES_WRITE_URL=postgres://mcp_writer:writer@postgres.db-ci.test:%s/testdb\n' "$POSTGRES_PORT"
  printf 'TEST_MYSQL_ADMIN_URL=mysql://root:root@mysql.db-ci.test:%s/testdb\n' "$MYSQL_PORT"
  printf 'TEST_MYSQL_READ_URL=mysql://mcp_reader:reader@mysql.db-ci.test:%s/testdb\n' "$MYSQL_PORT"
  printf 'TEST_MYSQL_WRITE_URL=mysql://mcp_writer:writer@mysql.db-ci.test:%s/testdb\n' "$MYSQL_PORT"
} >> "$GITHUB_ENV"
