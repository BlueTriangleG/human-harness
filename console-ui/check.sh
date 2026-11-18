#!/bin/bash
# The reproducibility check: installs exactly the lock file, rebuilds into a temp dir and compares byte for byte with
# what is committed in src/console/web/app/. Exit 0 = same. Run it the way build.sh is run.
set -euo pipefail
cd "$(dirname "$0")"
npm ci --ignore-scripts --no-audit --no-fund
out=$(mktemp -d)
HH_UI_OUT="$out" npx --no-install vite build --logLevel warn
for f in chat.js chat.css; do cmp "$out/$f" "../src/console/web/app/$f"; done
(cd ../src/console/web/app && shasum -a 256 -c ../../../../console-ui/app.sha256)
echo "rebuilt from the lock file: identical to the committed output"
