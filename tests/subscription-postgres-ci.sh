#!/usr/bin/env bash
set -euo pipefail
# No hosted connection or inherited credentials. Private UNIX socket, ephemeral cluster only.
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSFILE
export PATH="$(pg_config --bindir):$PATH"
dir="$(mktemp -d /tmp/hag-pg-XXXXXX)"
export HAG_QA_SOCKET="$dir"
trap 'pg_ctl -D "$dir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
initdb -D "$dir/data" --auth=trust --no-locale >/dev/null
pg_ctl -D "$dir/data" -l "$dir/server.log" -o "-k $dir -c listen_addresses='' -c log_statement=none -c log_min_error_statement=panic" -w start >/dev/null
createdb -h "$dir" hag_qa
psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_qa -f tests/subscription-ci-schema.sql
for file in pending-draft confirmation-draft gateway-draft runtime-role-draft email-readiness-draft; do
 psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_qa -f "supabase/admin-setup/phase-3c3-$file.sql"
done
python3 tests/subscription-concurrency.py
psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_qa -f tests/subscription-email-db.sql
# Earlier suites exercise historical pre-outbox permissions; raw issuance is now revoked.
psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_qa -f supabase/admin-setup/phase-3c3-outbox-draft.sql

psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_qa -f tests/subscription-outbox-db.sql

python3 tests/subscription-outbox-concurrency.py

# Final revised consent policy; previous suites exercise the superseded historical draft.
psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_qa -f supabase/admin-setup/phase-3c3-single-opt-in-draft.sql
psql -X -q -v ON_ERROR_STOP=1 -h "$dir" -d hag_qa -f tests/subscription-single-opt-in-db.sql
