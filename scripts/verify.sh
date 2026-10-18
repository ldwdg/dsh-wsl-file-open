#!/usr/bin/env bash
# Verify the host side of dsh-wsl-file-open.
set -uo pipefail

BASE="${DSH_WEB_URL:-http://127.0.0.1:30808}"
TOKEN="${DSH_WEB_TOKEN:-}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

if [ -z "$TOKEN" ] && command -v journalctl >/dev/null 2>&1; then
  TOKEN=$(journalctl --user -u dsh-web --since "2 hours ago" --no-pager 2>/dev/null \
    | grep -o 'token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)
fi
if [ -z "$TOKEN" ]; then
  printf 'Set DSH_WEB_TOKEN to the token from the "dsh web:" startup line.\n' >&2
  exit 2
fi

curl -fsS -L -c "$JAR" -b "$JAR" -o /dev/null "$BASE/?token=$TOKEN" || {
  printf 'auth failed against %s\n' "$BASE" >&2; exit 3; }

echo "== /api/present.host =="
curl -fsS -b "$JAR" "$BASE/api/present.host"; echo
echo "== /open-in-app/apps =="
curl -fsS -b "$JAR" "$BASE/open-in-app/apps"; echo
echo "== diagnostic log =="
tail -n 5 "${DSH_WSL_FILE_OPEN_LOG:-/tmp/dsh-wsl-file-open.log}" 2>/dev/null \
  || echo "(no log yet — click a card, then re-run)"
