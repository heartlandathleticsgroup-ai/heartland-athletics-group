#!/usr/bin/env bash
set -euo pipefail
deno="$1"
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSFILE
export PATH="$(pg_config --bindir):$PATH"
dir="$(mktemp -d /tmp/hag-tls-pg-XXXXXX)"
trap 'pg_ctl -D "$dir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$dir/ca.key" -out "$dir/ca.crt" -subj "/CN=HAG isolated test CA" -days 1 >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$dir/wrong.key" -out "$dir/wrong.crt" -subj "/CN=Wrong isolated test CA" -days 1 >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$dir/server.key" -out "$dir/server.csr" -subj "/CN=aws-0-us-east-2.pooler.supabase.com" >/dev/null 2>&1
printf 'subjectAltName=DNS:aws-0-us-east-2.pooler.supabase.com\nextendedKeyUsage=serverAuth\n' > "$dir/ext"
openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial -out "$dir/server.crt" -days 1 -extfile "$dir/ext" >/dev/null 2>&1
chmod 600 "$dir/server.key"
port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
initdb -D "$dir/data" --auth=trust --no-locale >/dev/null
printf 'local all all trust\nhostssl all all 127.0.0.1/32 trust\n' > "$dir/data/pg_hba.conf"
pg_ctl -D "$dir/data" -l "$dir/server.log" -o "-k $dir -p $port -c listen_addresses=127.0.0.1 -c ssl=on -c ssl_cert_file=$dir/server.crt -c ssl_key_file=$dir/server.key -c log_statement=none -c log_min_error_statement=panic" -w start >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -p "$port" -d postgres <<'SQL'
create role hag_subscription_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role hag_subscription_gateway_login login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant hag_subscription_runtime to hag_subscription_gateway_login;
create schema hag_private;
grant usage on schema hag_private to hag_subscription_runtime;
-- Test-only narrow metadata probe: SET ROLE hides session user's SSL stats.
create function hag_private.release_tls_is_encrypted() returns boolean language sql security definer set search_path='' as $$ select ssl from pg_catalog.pg_stat_ssl where pid=pg_catalog.pg_backend_pid() $$;
revoke all on function hag_private.release_tls_is_encrypted() from public;
grant execute on function hag_private.release_tls_is_encrypted() to hag_subscription_runtime;
create function hag_private.release_tls_fixture(p text[]) returns jsonb language sql security invoker set search_path='' as $$ select jsonb_build_object('ssl',hag_private.release_tls_is_encrypted(),'items',p,'role',current_user) $$;
revoke all on function hag_private.release_tls_fixture(text[]) from public;
grant execute on function hag_private.release_tls_fixture(text[]) to hag_subscription_runtime;
SQL
HAG_TEST_PORT="$port" HAG_TEST_CA="$dir/ca.crt" HAG_TEST_WRONG_CA="$dir/wrong.crt" \
 "$deno" run --cached-only --frozen --config release/gmail/deno.json --allow-env --allow-read="$dir/ca.crt,$dir/wrong.crt" --allow-net="127.0.0.1:$port" tests/gmail-release-tls.test.mjs
