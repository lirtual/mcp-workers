#!/bin/sh
# Portable rca entry, executed from the installer-owned versioned release.
# Node Releases use bundled Node. Node-free Linux Rust uses Python stdlib
# only for owner-local management, signed-WSS-gated upgrades, and uninstall.
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
# Native-only upgrade and uninstall retain the existing owner-terminal,
# process, identity, and immutable-release validation protections.
if test -x "$root/apps/remote-control-agent/.build/rca-standard-linux-candidate"; then
  case "${1:-}" in
    status|logs|version|--version)
      test -r "$root/apps/remote-control-agent/scripts/manage-v2.py" || exit 1
      exec /usr/bin/python3 -I -B "$root/apps/remote-control-agent/scripts/manage-v2.py" "$@"
      ;;
    *)
      if ! test -e "$root/bin/node"; then
        test -r "$root/apps/remote-control-agent/scripts/manage-v2.py" || exit 1
        exec /usr/bin/python3 -I -B "$root/apps/remote-control-agent/scripts/manage-v2.py" "$@"
      fi
      ;;
  esac
fi
test -x "$root/bin/node" || exit 1
test -r "$root/apps/remote-control-agent/scripts/manage-v2.mjs" || exit 1
unset NODE_OPTIONS NODE_PATH
exec "$root/bin/node" "$root/apps/remote-control-agent/scripts/manage-v2.mjs" "$@"
