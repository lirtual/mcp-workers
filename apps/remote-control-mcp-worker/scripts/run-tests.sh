#!/usr/bin/env bash
# Run each test module in its own bounded process. The retired VPC tests once
# waited on a callback that never fired, silently hanging the entire CI job.
set -euo pipefail
shopt -s nullglob
files=(tests/*.test.ts tests/*.test.mjs)
if (( ${#files[@]} == 0 )); then
  echo "::error::No Remote Control test files were found"
  exit 1
fi
for file in "${files[@]}"; do
  echo "::group::Remote Control test: ${file}"
  echo "Starting ${file} at $(date -u +%H:%M:%S) UTC"
  if timeout --signal=TERM --kill-after=5s 45s \
    node --experimental-strip-types --test "${file}"; then
    echo "::endgroup::"
    continue
  else
    status=$?
    echo "::endgroup::"
    if [[ $status -eq 124 || $status -eq 137 ]]; then
      echo "::error file=${file}::Test exceeded 45 seconds. Check unresolved promises, open handles, and obsolete VPC callbacks."
    else
      echo "::error file=${file}::Test failed with exit status ${status}."
    fi
    exit "$status"
  fi
done
