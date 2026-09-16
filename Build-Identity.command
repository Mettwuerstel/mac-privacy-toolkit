#!/bin/zsh
set -euo pipefail
umask 077
trap 'print -u2 "Build abgebrochen. Bitte die Fehlermeldung oben beachten."' ZERR

if [[ "$(/usr/bin/uname -s)" != "Darwin" || "$(/usr/bin/uname -m)" != "x86_64" ]]; then
  print -u2 'Dieser Build ist fuer Intel-Macs mit macOS 15 oder neuer.'
  exit 1
fi
TASK_VERSION="$(/usr/bin/sw_vers -productVersion)"
if (( ${TASK_VERSION%%.*} < 15 )); then
  print -u2 'macOS 15 oder neuer wird benoetigt.'
  exit 1
fi
if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  print -u2 'Apples Command Line Tools fehlen. Einmal im Terminal ausfuehren: xcode-select --install'
  print -u2 'Nach der Installation diese Datei erneut oeffnen.'
  exit 1
fi
TASK_ROOT="${0:A:h}"
TASK_BUILD="$TASK_ROOT/build"
if [[ "$TASK_ROOT" == *:* || -L "$TASK_BUILD" ]]; then
  print -u2 'Der Projektpfad darf keinen Doppelpunkt enthalten; build darf kein Symlink sein.'
  exit 1
fi
/bin/mkdir -p "$TASK_BUILD"
TASK_OUTPUT="$(/usr/bin/mktemp -d "$TASK_BUILD/identity-XXXXXX")"
TASK_APP="$TASK_OUTPUT/Identity Session.app"
TASK_MACOS="$TASK_APP/Contents/MacOS"
TASK_RESOURCES="$TASK_APP/Contents/Resources"
/bin/mkdir -p "$TASK_MACOS" "$TASK_RESOURCES"
typeset -a TASK_FLAGS
TASK_FLAGS=(-arch x86_64 -mmacosx-version-min=15.0 -std=c11 -D_DARWIN_C_SOURCE -Wall -Wextra -O2)

print 'Kompiliere Sitzungslogik, Bibliothek, Oberflaeche und macOS-Test…'
/usr/bin/xcrun clang "${TASK_FLAGS[@]}" -fPIC -fvisibility=hidden -c "$TASK_ROOT/native/session.c" -o "$TASK_OUTPUT/session.o"
/usr/bin/xcrun clang "${TASK_FLAGS[@]}" -c "$TASK_ROOT/native/storage.c" -o "$TASK_OUTPUT/storage.o"
/usr/bin/xcrun clang "${TASK_FLAGS[@]}" "$TASK_ROOT/tests/session_test.c" "$TASK_OUTPUT/session.o" -o "$TASK_OUTPUT/session-test" -lpthread
"$TASK_OUTPUT/session-test"
/usr/bin/xcrun clang "${TASK_FLAGS[@]}" "$TASK_ROOT/tests/storage_test.c" "$TASK_OUTPUT/session.o" "$TASK_OUTPUT/storage.o" -o "$TASK_OUTPUT/storage-test"
"$TASK_OUTPUT/storage-test"
/usr/bin/xcrun clang "${TASK_FLAGS[@]}" -dynamiclib -fvisibility=hidden "$TASK_ROOT/native/identity.c" "$TASK_OUTPUT/session.o" \
  -framework CoreFoundation -framework IOKit -o "$TASK_RESOURCES/libmpt_identity.dylib"
/usr/bin/xcrun clang "${TASK_FLAGS[@]}" -fobjc-arc "$TASK_ROOT/native/probe.m" "$TASK_OUTPUT/session.o" "$TASK_OUTPUT/storage.o" \
  -framework Foundation -framework CoreFoundation -framework IOKit -o "$TASK_RESOURCES/identity-probe"
/usr/bin/xcrun clang "${TASK_FLAGS[@]}" -fobjc-arc "$TASK_ROOT/native/controller.m" "$TASK_OUTPUT/session.o" "$TASK_OUTPUT/storage.o" \
  -framework AppKit -framework Foundation -o "$TASK_MACOS/IdentitySession"
/bin/cat > "$TASK_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.macprivacy.identitysession</string>
<key>CFBundleName</key><string>Identity Session</string>
<key>CFBundleExecutable</key><string>IdentitySession</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
/usr/bin/plutil -lint "$TASK_APP/Contents/Info.plist"
# Only sign our own generated files; no target-app files are modified.
/usr/bin/codesign --force --sign - "$TASK_RESOURCES/libmpt_identity.dylib"
/usr/bin/codesign --force --sign - "$TASK_RESOURCES/identity-probe"
/usr/bin/codesign --force --sign - "$TASK_APP"
print 'Pruefe die echten macOS-Abfragen im eigenen Testprozess…'
"$TASK_RESOURCES/identity-probe" --self-test "$TASK_RESOURCES/libmpt_identity.dylib"
print "App erstellt und Testprozess geprueft: $TASK_APP"
print 'Der Test bestaetigt noch keine Kompatibilitaet mit LoL. Dafuer das Prueflog in der App beachten.'
/usr/bin/open "$TASK_APP"
