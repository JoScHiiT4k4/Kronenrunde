#!/usr/bin/env bash
# Ablauf-Test der ganzen Web-App gegen eine LEERE Test-Datenbank.
#
#   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tippspiel_test bash scripts/test-app.sh
#
# Der Test bricht ab, wenn die Datenbank schon Tabellen enthält, und leert sie am Ende wieder.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEST_DATABASE_URL:?Bitte TEST_DATABASE_URL auf eine leere Test-Datenbank setzen}"
node --experimental-strip-types --disable-warning=ExperimentalWarning --test src/server/app.test.ts
