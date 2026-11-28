#!/usr/bin/env bash
set -euo pipefail
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSFILE
export PATH="$(pg_config --bindir):$PATH"
dir="$(mktemp -d /tmp/hag-release-pg-XXXXXX)"
trap 'pg_ctl -D "$dir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
initdb -D "$dir/data" --auth=trust --no-locale >/dev/null
pg_ctl -D "$dir/data" -l "$dir/server.log" -o "-k $dir -c listen_addresses='' -c log_statement=none -c log_min_error_statement=panic" -w start >/dev/null
createdb -h "$dir" hag_release_qa
for file in tests/subscription-ci-schema.sql tests/subscription-gmail-auth-fixture.sql release/gmail/consolidated-migration.sql release/gmail/disabled-deployment-preflight.sql release/gmail/welcome-incremental.sql tests/gmail-release-db.sql release/gmail/sport-preferences-incremental.sql release/gmail/consent-release-candidate.sql tests/sport-preferences-db.sql release/gmail/operational-rollback.sql; do
 psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_release_qa -f "$file"
done
psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_release_qa -c "do \$qa\$ begin if exists(select 1 from hag_private.gmail_connection where enabled or credential is not null) or pg_has_role('hag_gmail_control_login','hag_gmail_control','member') then raise exception 'rollback unsafe';end if;end \$qa\$;"
echo "PASS: operational rollback disables connection and removes runtime memberships without deleting consent schema"
