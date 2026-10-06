#!/usr/bin/env bash
#
# uninstall.sh — remove dsh-image-webp-to-png from a DSH profile (default: web).
#
# Reverses install.sh: drops the `link:` dependency and the bundle entry from
# package.json, then `pnpm install` to remove the symlink. Optionally restores a
# package.json backup if you pass one as $1.
#
# Usage:
#   ./uninstall.sh                     # remove from ~/.dsh/profiles/web
#   ./uninstall.sh /path/to/backup.json  # and restore that backup instead
set -euo pipefail

PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PKG="$PROFILE_DIR/package.json"

if [[ ! -f "$PKG" ]]; then
  echo "error: $PKG not found" >&2
  exit 1
fi

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  echo "restoring package.json from $1"
  cp "$1" "$PKG"
else
  node - "$PKG" <<'NODE'
const [file] = process.argv.slice(2);
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
delete pkg.dependencies?.["dsh-image-webp-to-png"];
if (Array.isArray(pkg.dsh?.profile?.bundles)) {
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== "dsh-image-webp-to-png");
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
console.log("removed dsh-image-webp-to-png from package.json");
NODE
fi

echo "running pnpm install in $PROFILE_DIR to drop the symlink ..."
pnpm install --dir "$PROFILE_DIR"
rm -rf "$PROFILE_DIR/node_modules/dsh-image-webp-to-png" 2>/dev/null || true

echo "Done. dsh-image-webp-to-png removed from $PROFILE_DIR."
echo "(If WebP images fail again, that is expected — the fix is now off.)"
