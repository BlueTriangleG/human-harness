#!/bin/bash
# build.sh <out.app> <bundle id> <name> <signing identity's SHA-1, or - for ad hoc> [keychain] [icon]
# An HH app: Sources/ (main.swift, the launcher, the windows) as Contents/MacOS/HH, with its name and icon, signed. A role's
# app is ai.hh.role.<id>, signed by the role's own identity in the role's own keychain (src/services/app.ts makes both);
# Human.app is ai.hh.human, a menu bar app (no Dock icon); a role's app is in the Dock while its window is open (started
# as the launcher it opens no window and shows nothing). macOS keeps the owner's grants by bundle id and signer, so a
# rebuild, a new name or a new icon signed by the same identity keeps them.
set -euo pipefail
APP=$1 ID=$2 NAME=$3 SIGN=$4 KC=${5:-} ICON=${6:-}
S=$(cd "$(dirname "$0")" && pwd)/Sources
xml() { local s=${1//&/&amp;}; s=${s//</&lt;}; printf '%s' "${s//>/&gt;}"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
C=$TMP/x.app/Contents
mkdir -p "$C/MacOS" "$C/Resources"
clang -O2 -Wall -Wextra -c "$S/launcher.c" -o "$TMP/launcher.o"
swiftc -O -import-objc-header "$S/launcher.h" "$S"/*.swift "$S"/UI/*.swift "$TMP/launcher.o" -o "$C/MacOS/HH"
ICONKEY="" UI=""
# Human.app: a menu bar app; HH_COMMAND, the hh command its "+ New Human" runs (hh setup --wizard), on HH_NODE
[ "$ID" = ai.hh.human ] && UI="  <key>LSUIElement</key><true/>${HH_COMMAND:+
  <key>HHCommand</key><string>$(xml "$HH_COMMAND")</string>}${HH_NODE:+
  <key>HHNode</key><string>$(xml "$HH_NODE")</string>}"
# a role's app opens its permission page for <bundle id>://grants (the console's settings page links to it)
case $ID in ai.hh.role.*) UI="  <key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>$ID</string><key>CFBundleURLSchemes</key><array><string>$ID</string></array></dict></array>" ;; esac
# no picture given: one drawn (icon.swift): a role's first letter on its colour (HH_ICON_LETTER, HH_ICON_COLOR), Human's dots
if [ -z "$ICON" ] && { [ -n "${HH_ICON_LETTER:-}" ] || [ "$ID" = ai.hh.human ]; }; then
  swiftc -O "$S/../icon.swift" -o "$TMP/icon"
  if [ "$ID" = ai.hh.human ]; then "$TMP/icon" human "$TMP/drawn.png"; else "$TMP/icon" letter "$HH_ICON_LETTER" "${HH_ICON_COLOR:-#1d6a5a}" "$TMP/drawn.png"; fi
  ICON=$TMP/drawn.png
fi
if [ -n "$ICON" ]; then
  mkdir "$TMP/i.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON" --out "$TMP/i.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ICON" --out "$TMP/i.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$TMP/i.iconset" -o "$C/Resources/icon.icns"
  ICONKEY="  <key>CFBundleIconFile</key><string>icon</string>"
fi
cat > "$C/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$(xml "$ID")</string>
  <key>CFBundleName</key><string>$(xml "$NAME")</string>
  <key>CFBundleDisplayName</key><string>$(xml "$NAME")</string>
  <key>CFBundleExecutable</key><string>HH</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
$UI
  <key>NSAppleEventsUsageDescription</key><string>$(xml "$NAME") controls other apps when it is asked to.</string>
$ICONKEY
</dict>
</plist>
PL
# codesign finds an identity only in a keychain on the user's search list: the role's is on it for the signing only
if [ -n "$KC" ]; then
  OLD=()
  while IFS= read -r l; do l=${l#*\"}; OLD+=("${l%\"}"); done < <(security list-keychains -d user)
  # (bash 3.2 with set -u: an empty array only expands as ${OLD[@]+…})
  trap 'security list-keychains -d user -s ${OLD[@]+"${OLD[@]}"}; rm -rf "$TMP"' EXIT
  security list-keychains -d user -s ${OLD[@]+"${OLD[@]}"} "$KC"
fi
codesign --force --sign "$SIGN" ${KC:+--keychain "$KC"} --identifier "$ID" "$TMP/x.app"
rm -rf "$APP"; mv "$TMP/x.app" "$APP"
