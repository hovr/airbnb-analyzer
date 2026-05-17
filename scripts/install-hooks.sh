#!/bin/sh
set -e

HOOK_DIR=".git/hooks"
HOOK_PATH="$HOOK_DIR/pre-commit"

if [ ! -d .git ]; then
  echo "Run this from the repository root."
  exit 1
fi

mkdir -p "$HOOK_DIR"

if [ -f "$HOOK_PATH" ] && grep -q "BEGIN AUTO VERSION BUMP" "$HOOK_PATH"; then
  echo "Version bump pre-commit hook is already installed."
  exit 0
fi

BACKUP_PATH=""
if [ -f "$HOOK_PATH" ]; then
  BACKUP_PATH="$HOOK_PATH.before-version-bump"
  if [ -e "$BACKUP_PATH" ]; then
    BACKUP_PATH="$HOOK_PATH.before-version-bump.$(date +%Y%m%d%H%M%S)"
  fi
  mv "$HOOK_PATH" "$BACKUP_PATH"
  echo "Moved existing pre-commit hook to $BACKUP_PATH."
fi

cat > "$HOOK_PATH" <<HOOK
#!/bin/sh
set -e
EXISTING_HOOK="$BACKUP_PATH"
if [ -n "\$EXISTING_HOOK" ] && [ -x "\$EXISTING_HOOK" ]; then
  "\$EXISTING_HOOK"
fi
# BEGIN AUTO VERSION BUMP
node scripts/bump-version.js
git add manifest.json
# END AUTO VERSION BUMP
HOOK
chmod +x "$HOOK_PATH"
echo "Installed pre-commit version bump hook."
