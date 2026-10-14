#!/usr/bin/env bash
# Prüft das Datenbank-Grundgerüst gegen eine LEERE Test-Datenbank.
#
#   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tippspiel_test bash scripts/test-db.sh
#
# Sicherheitsnetz: Das Skript bricht ab, wenn die Datenbank schon Tabellen enthält,
# damit nie versehentlich echte Daten überschrieben werden.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

: "${TEST_DATABASE_URL:?Bitte TEST_DATABASE_URL auf eine leere Test-Datenbank setzen}"
run() { psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }

tables=$(psql "$TEST_DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")
if [ "$tables" != "0" ]; then
  echo "Abbruch: Die Datenbank ist nicht leer ($tables Tabellen). Bitte eine leere Test-Datenbank verwenden." >&2
  exit 1
fi

reset() { run -c "set client_min_messages = warning; drop schema public cascade; create schema public;"; }

echo "1/2 Migrationen + Tests"
for f in db/migrations/*.sql; do run -f "$f"; done
for f in db/tests/*.sql; do run -f "$f"; done

echo "2/2 Migrationen + Beispieldaten"
reset
for f in db/migrations/*.sql; do run -f "$f"; done
for f in db/seed/*.sql; do run -f "$f"; done
run -Atc "select 'Beispieldaten: ' || (select count(*) from teams) || ' Teams, ' || (select count(*) from matches) || ' Spiele'"

reset
echo "Fertig – Test-Datenbank wieder leer."
