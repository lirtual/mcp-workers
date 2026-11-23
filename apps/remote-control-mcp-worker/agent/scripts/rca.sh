#!/bin/sh
# Portable rca entry, executed from the installer-owned versioned release.
# Uses the verified bundled Node 24, never the host's node or Python.
set -eu
resolved=$(readlink -f -- "$0") || exit 1
root=$(dirname -- "$(dirname -- "$(dirname -- "$(dirname -- "$resolved")")")")
case "$root" in
  "$HOME"/.local/share/mcp-workers/remote-control/programs/v*-linux-*-glibc)
    ;;
  *)
    echo "rca: untrusted installed program path" >&2
    exit 1
    ;;
esac
# Rust candidates use the reviewed Python CLI only for read-only local
# inspection. Keep paired lifecycle mutations on the existing Node path until
# their separate Node-free safety/rollback checks are proven.
if test -x "$root/apps/remote-control-agent/.build/rca-standard-linux-candidate"; then
  case "${1:-}" in
    status|logs|version|--version)
      test -r "$root/apps/remote-control-agent/scripts/manage-v2.py" || exit 1
      exec /usr/bin/python3 -I -B "$root/apps/remote-control-agent/scripts/manage-v2.py" "$@"
      ;;
  esac
fi
test -x "$root/bin/node" || exit 1
test -r "$root/apps/remote-control-agent/scripts/manage-v2.mjs" || exit 1
unset NODE_OPTIONS NODE_PATH
exec "$root/bin/node" "$root/apps/remote-control-agent/scripts/manage-v2.mjs" "$@"
