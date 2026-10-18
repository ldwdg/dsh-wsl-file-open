#!/usr/bin/env bash
# Install the dsh-wsl-file-open plugin and skill into a DSH profile.
#
# Idempotent: re-running refreshes the plugin files and never duplicates the
# patch entry. The profile patch is backed up before every modification.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_DIR="$PROFILE_DIR/wsl-file-open"
PATCH="$PROFILE_DIR/cordis.patch.yml"
SKILL_DIR="$DSH_HOME/skills/dsh-wsl-file-open"
ENTRY_ID="wsl-file-open"
ENTRY_NAME="./wsl-file-open/index.js"
MARK_BEGIN="# >>> dsh-wsl-file-open >>>"
MARK_END="# <<< dsh-wsl-file-open <<<"

WITH_XDG_OPEN=0
FORCE_XDG_OPEN=0
for arg in "$@"; do
  case "$arg" in
    --with-xdg-open) WITH_XDG_OPEN=1 ;;
    --force-xdg-open) FORCE_XDG_OPEN=1; WITH_XDG_OPEN=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "install: unknown option $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

[ -d "$PROFILE_DIR" ] || fail "profile not found: $PROFILE_DIR (set DSH_PROFILE)"
[ -f "$HERE/lib/index.js" ] || fail "run this from the repository root"

if command -v dsh >/dev/null 2>&1; then
  say "DSH: $(dsh --version 2>/dev/null | head -1)"
fi

# Legacy install guard: the earlier name was wsl-reveal.
if grep -q "id: wsl-reveal" "$PATCH" 2>/dev/null || [ -d "$PROFILE_DIR/wsl-reveal" ]; then
  say "WARNING: an older 'wsl-reveal' install was found."
  say "         Remove its entry/directory before relying on this one, or both shims compete."
fi

# 1. plugin files
mkdir -p "$PLUGIN_DIR"
cp "$HERE/lib/index.js" "$HERE/lib/impl.mjs" "$HERE/lib/program.ps1" "$PLUGIN_DIR/"
# A named, versioned manifest is what DSH's package inventory expects. A
# manifest with a name but no version makes every model request fail with
# REQUEST_EXTENSION; `"type": "module"` is required for index.js to load as ESM.
VERSION=$(node -p "require('$HERE/package.json').version" 2>/dev/null || printf '1.0.0')
cat > "$PLUGIN_DIR/package.json" <<JSON
{
  "name": "dsh-wsl-file-open",
  "version": "$VERSION",
  "private": true,
  "type": "module"
}
JSON
say "plugin: $PLUGIN_DIR (v$VERSION)"

# 2. patch entry (marked block, added once)
if [ -f "$PATCH" ]; then
  cp "$PATCH" "$PATCH.bak.$(date +%Y%m%d%H%M%S)"
else
  printf '[]\n' > "$PATCH"
  say "created missing patch layer: $PATCH"
fi

if grep -qF "$MARK_BEGIN" "$PATCH"; then
  say "patch: entry already present (left untouched)"
else
  # An empty patch layer is written as a bare flow sequence (`[]`). Appending a
  # block sequence to it produces invalid YAML, so drop that line first and keep
  # any surrounding comments.
  if [ "$(grep -vE '^[[:space:]]*(#|$)' "$PATCH" | tr -d '[:space:]')" = "[]" ]; then
    # `grep -v` exits 1 when every line is filtered out (a patch that is only
    # `[]`); tolerate that so `set -e` does not abort the install.
    { grep -vE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH" || true; } > "$PATCH.tmp"
    mv "$PATCH.tmp" "$PATCH"
  fi
  # A missing trailing newline would glue the marker onto the last line.
  if [ -s "$PATCH" ] && [ -n "$(tail -c 1 "$PATCH")" ]; then printf '\n' >> "$PATCH"; fi
  {
    printf '%s\n' "$MARK_BEGIN"
    printf -- '- insert:\n'
    printf -- '    - id: %s\n' "$ENTRY_ID"
    printf -- "      name: '%s'\n" "$ENTRY_NAME"
    printf '%s\n' "$MARK_END"
  } >> "$PATCH"
  say "patch: installed marked entry in $PATCH"
fi

# 3. skill
mkdir -p "$SKILL_DIR"
cp "$HERE/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
say "skill:  $SKILL_DIR"

# 4. optional xdg-open shim ("Open In…" button)
if [ "$WITH_XDG_OPEN" = "1" ]; then
  BIN="$HOME/.local/bin"
  TARGET="$BIN/xdg-open"
  mkdir -p "$BIN"
  if [ -e "$TARGET" ] && [ "$FORCE_XDG_OPEN" != "1" ]; then
    say "xdg-open: $TARGET already exists (use --force-xdg-open to replace)"
  else
    [ -e "$TARGET" ] && cp -a "$TARGET" "$TARGET.bak.$(date +%Y%m%d%H%M%S)"
    cp "$HERE/extras/xdg-open.sh" "$TARGET"
    chmod +x "$TARGET"
    say "xdg-open: installed $TARGET"
  fi
fi

say ""
say "Restart DSH web so the profile patch is loaded:"
if systemctl --user list-unit-files 2>/dev/null | grep -q 'dsh-web'; then
  say "  systemctl --user restart dsh-web"
else
  say "  restart your 'dsh web' process, then hard-refresh the browser"
fi
say "Diagnostics: ${DSH_WSL_FILE_OPEN_LOG:-/tmp/dsh-wsl-file-open.log}"
