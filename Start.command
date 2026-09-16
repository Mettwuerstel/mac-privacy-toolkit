#!/bin/zsh
set -euo pipefail
umask 077

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  print -u2 'Dieses Programm ist fuer macOS bestimmt.'
  exit 1
fi

TASK_ROOT="${0:A:h}"
TASK_BUILD="$TASK_ROOT/build"
TASK_SOURCE="$TASK_BUILD/mac-privacy.js"

# This launcher only builds and opens the app. It does not change network settings.
if [[ -L "$TASK_BUILD" || -L "$TASK_SOURCE" ]]; then
  print -u2 'Abbruch: Der Build-Pfad darf keine symbolische Verknuepfung sein.'
  exit 1
fi
/bin/mkdir -p "$TASK_BUILD"
/bin/cat "$TASK_ROOT/src/core.js" "$TASK_ROOT/src/app.js" > "$TASK_SOURCE"
TASK_NEW="$TASK_BUILD/Mac Privacy Toolkit-$(/bin/date +%Y%m%d-%H%M%S)-$$.app"
/usr/bin/osacompile -l JavaScript -o "$TASK_NEW" "$TASK_SOURCE"

# Keep existing builds intact. The Finder opens the newly compiled app.
/usr/bin/open "$TASK_NEW"
print "App erstellt: $TASK_NEW"
print 'Du kannst diese App spaeter direkt oeffnen oder nach Programme ziehen.'
