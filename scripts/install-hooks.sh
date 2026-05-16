#!/bin/sh
set -e

HOOK_DIR=".git/hooks"
HOOK_PATH="$HOOK_DIR/pre-commit"

if [ ! -d .git ]; then
  echo "Run this from the repository root."
  exit 1
fi

mkdir -p "$HOOK_DIR"
cat > "$HOOK_PATH" <<'HOOK'
#!/bin/sh
set -e
node scripts/bump-version.js
git add manifest.json
HOOK
chmod +x "$HOOK_PATH"
echo "Installed pre-commit version bump hook."
