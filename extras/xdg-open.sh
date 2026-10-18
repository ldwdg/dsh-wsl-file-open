#!/usr/bin/env bash
# xdg-open shim for WSL: hand paths to the Windows desktop.
#
# DSH's "Open In…" button resolves its file-manager entry as
# `desktopCli("xdg-open")` on Linux, and its Windows `explorer` entry is declared
# for win32 only. On WSL the host platform is linux, so the button runs this
# name. The stock /usr/bin/xdg-open fails without a desktop environment.
#
# Install this as ~/.local/bin/xdg-open (install.sh --with-xdg-open). It shadows
# /usr/bin/xdg-open for every process whose PATH starts with ~/.local/bin,
# including the systemd-managed dsh-web service. Keep that in mind if you rely
# on a Linux desktop handler elsewhere.
set -uo pipefail

ROOT="${DSH_WSL_FILE_OPEN_WINDOWS_ROOT:-/mnt/c}"

if [ "$#" -eq 0 ]; then
  printf 'xdg-open: missing file/directory operand\n' >&2
  exit 2
fi

find_exe() {
  local candidate
  for candidate in "$@"; do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  command -v "$(basename "$1")" 2>/dev/null || true
}

EXPLORER="$(find_exe "$ROOT/Windows/explorer.exe" "$ROOT/Windows/System32/explorer.exe")"
POWERSHELL="$(find_exe "$ROOT/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")"

target="$1"
if [ ! -e "$target" ]; then
  printf 'xdg-open: %s does not exist\n' "$target" >&2
  exit 4
fi

win="$(wslpath -w "$(readlink -f -- "$target")" 2>/dev/null)"
if [ -z "$win" ]; then
  printf 'xdg-open: wslpath could not translate %s\n' "$target" >&2
  exit 5
fi

if [ -d "$target" ]; then
  [ -n "$EXPLORER" ] || { printf 'xdg-open: no explorer.exe found\n' >&2; exit 6; }
  "$EXPLORER" "$win"
elif [ -n "$POWERSHELL" ]; then
  "$POWERSHELL" -NoProfile -NonInteractive -Command "Invoke-Item -LiteralPath '${win//\'/\'\'}'"
elif [ -n "$EXPLORER" ]; then
  "$EXPLORER" "$win"
else
  printf 'xdg-open: neither explorer.exe nor powershell.exe found\n' >&2
  exit 6
fi
status=$?

# explorer.exe reports 1 after a successful handoff.
[ "$status" -eq 1 ] && exit 0
exit "$status"
