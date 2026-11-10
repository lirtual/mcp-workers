/** Immutable GitHub manifest lookup on the owner device (never executable input). */
export const RELEASE_MANIFEST_NAME = "remote-control-agent-manifest.txt";
export const LATEST_MANIFEST_URL =
  "https://github.com/lirtual/mcp-workers/releases/latest/download/" + RELEASE_MANIFEST_NAME;

const VALIDATE_AWK = "function reject(){bad=1;exit 1}\nNR==1 {\n  if(NF!=2 || $1!=\"rca-release-v1\" ||\n     $2 !~ /^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$/)\n    reject()\n  tag=$2\n  next\n}\n{\n  if(NF!=3 || NR>6 || seen[$1]++) reject()\n  if($1!=\"linux-x64-glibc\" && $1!=\"linux-arm64-glibc\" &&\n     $1!=\"windows-x64\" && $1!=\"darwin-arm64\" && $1!=\"darwin-x64\") reject()\n  if($2 !~ /^[0-9]+$/ || length($2)>9 || $2+0<1 || $2+0>180000000 ||\n     length($3)!=64 || $3 !~ /^[0-9a-f]+$/) reject()\n  count++\n  if($1==wanted){size=$2;sha=$3;found++}\n}\nEND {\n  if(bad || NR!=6 || count!=5 || found!=1 ||\n     !seen[\"linux-x64-glibc\"] || !seen[\"linux-arm64-glibc\"] ||\n     !seen[\"windows-x64\"] || !seen[\"darwin-arm64\"] || !seen[\"darwin-x64\"]) exit 1\n  print tag \" \" size \" \" sha\n}";

/** Call after choosing a platform target and creating private $stage. */
export function renderClientReleaseManifestShell(): string[] {
  return [
    "manifest_url='" + LATEST_MANIFEST_URL + "'",
    'manifest="$stage/' + RELEASE_MANIFEST_NAME + '"',
    "manifest_effective=$(curl -fL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --max-time 45 --max-filesize 1024 -w '%{url_effective}' \"$manifest_url\" -o \"$manifest\")",
    '[ "$(wc -c < "$manifest")" -le 1024 ] || { echo "Release manifest too large" >&2; exit 1; }',
    'fields=$(LC_ALL=C awk -v wanted="$target" \'' + VALIDATE_AWK + '\' "$manifest") || { echo "Invalid immutable Agent Release manifest" >&2; exit 1; }',
    'tag=${fields%% *}',
    'manifest_rest=${fields#* }',
    'expected_size=${manifest_rest%% *}',
    'expected=${manifest_rest##* }',
    'download="https://github.com/lirtual/mcp-workers/releases/download/$tag/remote-control-agent-$tag-$target.tar.gz"',
    'case "$manifest_effective" in',
    '  "$manifest_url"|"https://github.com/lirtual/mcp-workers/releases/download/$tag/' + RELEASE_MANIFEST_NAME + '"|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) ;;',
    '  *) echo "Unexpected GitHub manifest redirect" >&2; exit 1 ;;',
    'esac',
  ];
}
