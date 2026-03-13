#!/usr/bin/env bash

set -euo pipefail

DB_NAME="${ATLAS_TEST_DB_NAME:-atlas_test}"
BREW_BIN="${HOMEBREW_PREFIX:-/opt/homebrew}/bin/brew"
PG_BIN_DIR="${HOMEBREW_PREFIX:-/opt/homebrew}/opt/postgresql@16/bin"
PSQL_BIN="${PG_BIN_DIR}/psql"

if [[ ! -x "${BREW_BIN}" ]]; then
  echo "Homebrew not found at ${BREW_BIN}."
  echo "Install Homebrew or set HOMEBREW_PREFIX before using this helper."
  exit 1
fi

if [[ ! -x "${PSQL_BIN}" ]]; then
  echo "postgresql@16 is not installed under ${PG_BIN_DIR}."
  echo "Install it with: brew install postgresql@16"
  exit 1
fi

"${BREW_BIN}" services start postgresql@16 >/dev/null

for _ in {1..30}; do
  if "${PSQL_BIN}" -d postgres -tAc "select 1" >/dev/null 2>&1; then
    break
  fi

  sleep 1
done

if ! "${PSQL_BIN}" -d postgres -tAc "select 1" >/dev/null 2>&1; then
  echo "postgresql@16 did not become ready in time."
  exit 1
fi

"${PSQL_BIN}" -d "${DB_NAME}" -c "drop schema if exists public cascade; create schema public;" >/dev/null

echo "Reset schema for ${DB_NAME}."
