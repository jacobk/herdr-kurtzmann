#!/bin/sh
# Copies the layout and mods into the Herdr app home (default ~/.config/herdr-app,
# or $HERDR_APP_HOME). Herdr hot-reloads copied folders, not symlinked ones.
#
#   ./install.sh             layout + both mods
#   ./install.sh --mod-only  just mods/kurtzmann (open it from the palette)
#   ./install.sh --watch     install, then reinstall on every change (needs fswatch)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
dest=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
mods="kurtzmann tabs-kurtzmann"
layout=1 watch=0
for arg in "$@"; do
  case $arg in
    --mod-only) mods="kurtzmann"; layout=0 ;;
    --watch) watch=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

[ -d "$dest" ] || { echo "no Herdr app home at $dest" >&2; exit 1; }

install() {
  mkdir -p "$dest/mods" "$dest/layouts"
  for m in $mods; do
    [ -L "$dest/mods/$m" ] && rm "$dest/mods/$m"
    # Keep Herdr's generated files and the person's own config.json.
    rsync -a --delete --exclude gpui-kit.d.ts --exclude herdr.d.ts --exclude jsconfig.json \
      --exclude config.json --exclude .DS_Store "$here/mods/$m/" "$dest/mods/$m/"
  done
  if [ "$layout" = 1 ]; then
    [ -L "$dest/layouts/main-kurtzmann.json" ] && rm "$dest/layouts/main-kurtzmann.json"
    cp "$here/layouts/main-kurtzmann.json" "$dest/layouts/main-kurtzmann.json"
  fi
  echo "installed into $dest: $mods$([ "$layout" = 1 ] && echo " + layout main-kurtzmann")"
}

install
if command -v herdr-app >/dev/null 2>&1; then
  for m in $mods; do herdr-app check "$dest/mods/$m" || exit 1; done
fi

if [ "$watch" = 1 ]; then
  command -v fswatch >/dev/null 2>&1 || { echo "--watch needs fswatch (brew install fswatch)" >&2; exit 1; }
  echo "watching $here (ctrl-c to stop)"
  fswatch -o -e '\.git/' "$here/mods" "$here/layouts" | while read -r _; do install; done
fi
