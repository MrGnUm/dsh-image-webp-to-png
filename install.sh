#!/usr/bin/env bash
#
# install.sh — install dsh-image-webp-to-png into a DSH profile (default: web).
#
# What it does (idempotent, with a package.json backup):
#   1. Adds the bundle as a `link:` dependency pointing at this directory.
#   2. Adds it to the profile's `dsh.profile.bundles` array.
#   3. Runs `pnpm install` in the profile so the symlink + lockfile update.
#
# The fix takes effect on the next DSH web session (or immediately if the
# profile has `patchReload: "live"`). The bundle is FAIL-OPEN: if anything is
# wrong, DSH behaves exactly as before (no image fix, but no breakage either).
#
# Usage:
#   ./install.sh                 # install into ~/.dsh/profiles/web
#   DSH_PROFILE_DIR=/path ./install.sh
set -euo pipefail

PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$PROFILE_DIR/package.json"

if [[ ! -f "$PKG" ]]; then
  echo "error: $PKG not found (is the web profile installed?)" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required but not on PATH" >&2
  exit 1
fi

BACKUP="$PKG.bak-$(date +%Y%m%d-%H%M%S)"
cp "$PKG" "$BACKUP"
echo "backed up $PKG -> $BACKUP"

# 1+2) Add the link: dependency and the bundle entry (node = safe JSON edit).
node - "$PKG" "$BUNDLE_DIR" <<'NODE'
const [file, bundleDir] = process.argv.slice(2);
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.dependencies ??= {};
pkg.dependencies["dsh-image-webp-to-png"] = "link:" + bundleDir;
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes("dsh-image-webp-to-png")) {
  pkg.dsh.profile.bundles.push("dsh-image-webp-to-png");
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
console.log("dependencies.dsh-image-webp-to-png =", pkg.dependencies["dsh-image-webp-to-png"]);
console.log("dsh.profile.bundles =", JSON.stringify(pkg.dsh.profile.bundles));
NODE

# 3) Link it into the profile.
echo "running pnpm install in $PROFILE_DIR ..."
pnpm install --dir "$PROFILE_DIR"

echo
echo "Done. The bundle is installed into $PROFILE_DIR."
echo "It applies on the next DSH web session (or now, if patchReload is live)."
echo "Revert at any time with: ./uninstall.sh   (or: cp $BACKUP $PKG && pnpm install --dir $PROFILE_DIR)"
