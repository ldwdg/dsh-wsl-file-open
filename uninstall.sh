#!/usr/bin/env bash
# Remove the dsh-wsl-file-open plugin, skill, and marked patch block.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
MARK_BEGIN="# >>> dsh-wsl-file-open >>>"
MARK_END="# <<< dsh-wsl-file-open <<<"

WITH_XDG_OPEN=0
for arg in "$@"; do
  case "$arg" in
    --with-xdg-open) WITH_XDG_OPEN=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "uninstall: unknown option $arg" >&2; exit 2 ;;
  esac
done

if [ -f "$PATCH" ] && grep -qF "$MARK_BEGIN" "$PATCH"; then
  cp "$PATCH" "$PATCH.bak.$(date +%Y%m%d%H%M%S)"
  python3 - "$PATCH" "$MARK_BEGIN" "$MARK_END" <<'PY'
import sys
path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding='utf-8').read().splitlines()
out, skip = [], False
for line in lines:
    if line.strip() == begin:
        skip = True
        continue
    if line.strip() == end:
        skip = False
        continue
    if not skip:
        out.append(line)
# Keep the layer a valid empty array when nothing else remains.
significant = [l for l in out if l.strip() and not l.strip().startswith('#')]
if not significant:
    out.append('[]')
open(path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
  echo "patch: removed marked block from $PATCH"
fi

rm -rf "$PROFILE_DIR/wsl-file-open"
rm -rf "$DSH_HOME/skills/dsh-wsl-file-open"
echo "removed plugin and skill"

if [ "$WITH_XDG_OPEN" = "1" ]; then
  TARGET="$HOME/.local/bin/xdg-open"
  if [ -e "$TARGET" ]; then
    LATEST_BAK=$(ls -1t "$TARGET".bak.* 2>/dev/null | head -1 || true)
    rm -f "$TARGET"
    if [ -n "$LATEST_BAK" ]; then
      mv "$LATEST_BAK" "$TARGET"
      echo "xdg-open: restored $TARGET from $LATEST_BAK"
    else
      echo "xdg-open: removed $TARGET"
    fi
  fi
fi

echo ""
echo "Restart DSH web to drop the shim: systemctl --user restart dsh-web"
