#!/bin/sh
# Portable rca entry, executed from the installer-owned versioned release.
# Native Rust uses Python stdlib for owner-local management and upgrades.
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
# Only reviewed native Linux versions are supported.
test -x "$root/apps/remote-control-agent/.build/rca-standard-linux-candidate" || exit 1
test ! -e "$root/bin/node" || exit 1
test -r "$root/apps/remote-control-agent/scripts/manage-v2.py" || exit 1
exec /usr/bin/python3 -I -B "$root/apps/remote-control-agent/scripts/manage-v2.py" "$@"
