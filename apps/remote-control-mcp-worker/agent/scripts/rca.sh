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
# Rust Standard candidates can use the existing local Python manager for
# status, logs and owned uninstall. Pair/upgrade remain transitional until
# their independent Node-free lifecycle gates pass; the service itself is Rust.
if test -x "$root/apps/remote-control-agent/.build/rca-standard-linux-candidate"; then
  test -r "$root/apps/remote-control-agent/scripts/manage-v2.py" || exit 1
  exec python3 -B "$root/apps/remote-control-agent/scripts/manage-v2.py" "$@"
fi
test -x "$root/bin/node" || exit 1
test -r "$root/apps/remote-control-agent/scripts/manage-v2.mjs" || exit 1
unset NODE_OPTIONS NODE_PATH
exec "$root/bin/node" "$root/apps/remote-control-agent/scripts/manage-v2.mjs" "$@"
