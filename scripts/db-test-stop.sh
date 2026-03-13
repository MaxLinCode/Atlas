#!/usr/bin/env bash

set -euo pipefail

BREW_BIN="${HOMEBREW_PREFIX:-/opt/homebrew}/bin/brew"

if [[ ! -x "${BREW_BIN}" ]]; then
  echo "Homebrew not found at ${BREW_BIN}."
  echo "Install Homebrew or set HOMEBREW_PREFIX before using this helper."
  exit 1
fi

"${BREW_BIN}" services stop postgresql@16 >/dev/null
echo "Stopped local postgresql@16 service."
