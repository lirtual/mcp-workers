#!/usr/bin/env bash
# Materialize only the reviewed public Agent source for private Worker tests.
# The deployed v1 Agent remains at its independent pinned install path.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"
sha="3ef5a9c4d8741cba89b28f525dab4692826482f8"
target="apps/remote-control-agent"
if [[ -e "$target" || -L "$target" ]]; then
  if [[ -f "$target/.pinned-public-source" ]] &&
     [[ "$(cat "$target/.pinned-public-source")" == "$sha" ]] &&
     [[ -f "$target/package.json" ]]; then
    echo "Public Agent fixture already pinned: ${sha:0:12}"
    exit 0
  fi
  echo "Refusing to overwrite unrecognized or legacy private Agent files" >&2
  exit 1
fi
tmp="$(mktemp -d)"
stage="$(mktemp -d apps/.remote-control-source.XXXXXXXX)"
cleanup() { rm -rf -- "$tmp" "$stage"; }
trap cleanup EXIT
git init -q "$tmp/public"
git -C "$tmp/public" fetch --quiet --depth=1 \
  https://github.com/lirtual/remote-control-agent.git "$sha"
git -C "$tmp/public" checkout -q --detach FETCH_HEAD
[[ "$(git -C "$tmp/public" rev-parse HEAD)" == "$sha" ]] || {
  echo "Public Agent commit mismatch" >&2; exit 1;
}
[[ -f "$tmp/public/apps/remote-control-agent/src/v2-main.ts" ]] || {
  echo "Public Agent source missing" >&2; exit 1;
}
cp -a "$tmp/public/apps/remote-control-agent" "$stage/agent"
printf '%s\n' "$sha" > "$stage/agent/.pinned-public-source"
mv -T "$stage/agent" "$target"
echo "Staged reviewed public Agent: ${sha:0:12}"
