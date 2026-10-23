#!/usr/bin/env bash
# Updates the Android app with the latest planner and raises its version numbers, in one go:
#   1. downloads index.html from GitHub (the "main" branch) and checks it
#   2. backs up the old www/index.html, then replaces it
#   3. sets versionName to the version printed in the planner (for example 1.29) and raises versionCode by 1
#   4. runs "npx cap sync android"
#
# Run it from anywhere:   bash update-android.sh
# Optional settings (put them before the command):
#   PROJECT_DIR=/path/to/project   the folder with capacitor.config.* (default below)
#   VERSION_NAME=1.30              use this versionName instead of the one in the planner
#   VERSION_CODE=15                use this versionCode instead of "old + 1"
#   REF=some-branch                download from another branch instead of main (to test before merging)
#   DRY_RUN=1                      show what would change and change nothing
#   NO_SYNC=1                      skip "npx cap sync android"
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/jason/Downloads/Tiling/capacitor/jcs-tile-planner}"
REF="${REF:-main}"
URL="https://raw.githubusercontent.com/jasoncousineausolutions/tile-layout-planner-web/${REF}/index.html"

say() { printf '%s\n' "$*"; }
stop() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }

[ -d "$PROJECT_DIR" ] || stop "Project folder not found: $PROJECT_DIR (set PROJECT_DIR=/path/to/it)"
cd "$PROJECT_DIR"
CONFIG="$(ls capacitor.config.json capacitor.config.ts capacitor.config.js 2>/dev/null | head -1 || true)"
[ -n "$CONFIG" ] || stop "No capacitor.config.* in $PROJECT_DIR, so this is not the app project folder."

# The web folder Capacitor copies into the app (webDir in the config; "www" if not found).
WEBDIR="$(grep -hoE "webDir['\"]?[[:space:]]*:[[:space:]]*['\"][^'\"]+" "$CONFIG" | head -1 | sed -E "s/.*['\"]//" || true)"
WEBDIR="${WEBDIR:-www}"
[ -d "$WEBDIR" ] || stop "Web folder '$WEBDIR' does not exist in $PROJECT_DIR."

GRADLE="$(ls android/app/build.gradle android/app/build.gradle.kts 2>/dev/null | head -1 || true)"
[ -n "$GRADLE" ] || stop "Could not find android/app/build.gradle in $PROJECT_DIR."

# 1. download and check
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
say "Downloading: $URL"
curl -fsSL "$URL" -o "$TMP" || stop "Download failed. Check your internet connection."
head -c 200 "$TMP" | grep -qi '<!doctype html' || stop "The download is not an HTML page."
grep -q '</html>' "$TMP" || stop "The download looks cut off (no </html>)."
grep -q 'class TileApp' "$TMP" || stop "The download does not look like the Tile Planner."
SIZE="$(wc -c < "$TMP")"
[ "$SIZE" -ge 100000 ] || stop "The download is suspiciously small ($SIZE bytes)."
grep -q 'api/sketch' "$TMP" || stop "The download has no sketch import, so it is not the current planner."
grep -q 'sites.google.com' "$TMP" && stop "The download still has old Google Sites links."

# the version the planner shows (for example "JCS Tile Layout Planner V1.29")
PLANNER_VERSION="$(grep -oE 'Tile Layout Planner V[0-9]+(\.[0-9]+)*' "$TMP" | head -1 | sed -E 's/.*V//' || true)"
NEW_NAME="${VERSION_NAME:-$PLANNER_VERSION}"
[ -n "$NEW_NAME" ] || stop "Could not find the planner's version number. Set VERSION_NAME=1.xx and run again."

# 2. versions now in the project
OLD_CODE="$(grep -oE 'versionCode[[:space:]]*=?[[:space:]]*[0-9]+' "$GRADLE" | head -1 | grep -oE '[0-9]+$' || true)"
OLD_NAME="$(grep -oE 'versionName[[:space:]]*=?[[:space:]]*"[^"]+"' "$GRADLE" | head -1 | sed -E 's/.*"([^"]+)"/\1/' || true)"
[ -n "$OLD_CODE" ] || stop "Could not read versionCode from $GRADLE."
[ -n "$OLD_NAME" ] || stop "Could not read versionName from $GRADLE."

DEST="$WEBDIR/index.html"
if [ -f "$DEST" ] && cmp -s "$TMP" "$DEST" && [ "$OLD_NAME" = "$NEW_NAME" ] && [ -z "${VERSION_CODE:-}" ]; then
  say "Already up to date: the app has this index.html and version $OLD_NAME (code $OLD_CODE). Nothing changed."
  exit 0
fi
NEW_CODE="${VERSION_CODE:-$((OLD_CODE + 1))}"
[ "$NEW_CODE" -gt "$OLD_CODE" ] || stop "versionCode must go up: it is $OLD_CODE now and you asked for $NEW_CODE."

say ""
say "Planner downloaded: $SIZE bytes, shows version V$PLANNER_VERSION"
say "versionName: $OLD_NAME  ->  $NEW_NAME"
say "versionCode: $OLD_CODE  ->  $NEW_CODE"
if [ "${DRY_RUN:-}" = "1" ]; then say "DRY_RUN=1, so nothing was changed."; exit 0; fi

# 3. back up (outside the web folder, because everything inside it goes into the app), then update
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p index-backups
[ -f "$DEST" ] && cp "$DEST" "index-backups/index.html.$STAMP"
cp "$GRADLE" "index-backups/$(basename "$GRADLE").$STAMP"
cp "$TMP" "$DEST"
perl -0pi -e "s/(versionCode\\s*=?\\s*)\\d+/\${1}$NEW_CODE/; s/(versionName\\s*=?\\s*\")[^\"]+(\")/\${1}$NEW_NAME\${2}/" "$GRADLE"
grep -qE "versionCode[[:space:]]*=?[[:space:]]*$NEW_CODE" "$GRADLE" || stop "Could not set versionCode in $GRADLE (the old file is in index-backups)."
grep -qE "versionName[[:space:]]*=?[[:space:]]*\"$NEW_NAME\"" "$GRADLE" || stop "Could not set versionName in $GRADLE (the old file is in index-backups)."
say "Copied to $DEST and set the versions in $GRADLE (backups are in $PROJECT_DIR/index-backups)."

# 4. sync
if [ "${NO_SYNC:-}" = "1" ]; then
  say "NO_SYNC=1, so skipping the sync. Run: npx cap sync android"
else
  say "Running: npx cap sync android"
  npx cap sync android
fi

cat <<MSG

Done: version $NEW_NAME, code $NEW_CODE. Before you upload:
  1. npx cap open android            (opens Android Studio)
  2. Build > Generate Signed App Bundle, with the same keystore and key as before
  3. Install and try it on your phone (save and open a file, the Tile and Cut List, sketch import)
  4. Play Console > Production > Create new release: upload the .aab, add the release notes, staged rollout
Run this script again whenever index.html changes, so the app is never built with an old copy.
MSG
