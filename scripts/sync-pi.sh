#!/usr/bin/env bash
# Re-vendor the Pi agent (github.com/badlogic/pi-mono) at a release tag.
#
#   scripts/sync-pi.sh v0.87.1
#
# Copies packages ai, agent, chord and telemetry into vendor/pi-mono (without
# tests/docs), takes the generated model catalogue from the matching npm
# release, applies the patches listed in vendor/pi-mono/UPSTREAM.md, then
# rebuilds. Review `git diff vendor/` afterwards: local edits to vendored files
# are overwritten, so any Alex change to Pi itself must be listed as a patch.
set -euo pipefail
TAG="${1:?usage: scripts/sync-pi.sh <tag, e.g. v0.87.1>}"
VERSION="${TAG#v}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

GIT_LFS_SKIP_SMUDGE=1 git clone --quiet --depth 1 --branch "$TAG" https://github.com/badlogic/pi-mono "$WORK/pi-mono"
COMMIT="$(git -C "$WORK/pi-mono" rev-parse HEAD)"

V="$ROOT/vendor/pi-mono"
rm -rf "$V/packages"
mkdir -p "$V/packages"
for p in ai agent chord telemetry; do
  # Top-level test/docs/benchmark dirs only (src/ has a testing/benchmark module that must stay).
  (cd "$WORK/pi-mono/packages" && tar cf - --anchored --exclude "$p/node_modules" --exclude "$p/dist" --exclude "$p/test" --exclude "$p/docs" --exclude "$p/benchmark" --exclude "$p/vitest*.ts" "$p") | (cd "$V/packages" && tar xf -)
done
cp "$WORK/pi-mono/LICENSE" "$WORK/pi-mono/tsconfig.base.json" "$V/"

# Patch 1: generated model catalogue (not committed upstream; generated from provider APIs).
(cd "$WORK" && npm pack --silent "@earendil-works/pi-ai@$VERSION" >/dev/null && tar xzf "earendil-works-pi-ai-$VERSION.tgz")
mkdir -p "$V/packages/ai/src/providers/data"
cp -a "$WORK/package/dist/providers/data/." "$V/packages/ai/src/providers/data/"

# Patch 2: drop devDependencies (tests are not vendored; vitest/canvas break workspace installs).
for p in ai agent chord telemetry; do
  node -e 'const f=process.argv[1],fs=require("fs");const d=JSON.parse(fs.readFileSync(f));delete d.devDependencies;fs.writeFileSync(f,JSON.stringify(d,null,"\t")+"\n")' "$V/packages/$p/package.json"
done

sed -i.bak -E "s/^(- \*\*Tag:\*\*).*/\1 \`$TAG\`/; s/^(- \*\*Commit:\*\*).*/\1 \`$COMMIT\`/" "$V/UPSTREAM.md" && rm -f "$V/UPSTREAM.md.bak"
node "$ROOT/scripts/build-pi.mjs"
echo "Vendored pi-mono $TAG ($COMMIT). Now run: npm install && npm run typecheck && npm test"
