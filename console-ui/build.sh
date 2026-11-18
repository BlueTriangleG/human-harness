#!/bin/bash
# Builds the talk pane into src/console/web/app/ and records the output's sha256 in app.sha256. Run as the role's user,
# in the hh-fw mirror (hh-fw sh 'console-ui/build.sh'); then copy src/console/web/app/ and console-ui/app.sha256 back.
set -euo pipefail
cd "$(dirname "$0")"
npm ci --ignore-scripts --no-audit --no-fund
npx --no-install tsc -p .
npx --no-install vite build --logLevel warn
(cd ../src/console/web/app && shasum -a 256 chat.js chat.css) > app.sha256
cat app.sha256
