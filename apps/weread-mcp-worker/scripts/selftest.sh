#!/usr/bin/env bash
set -euo pipefail
rm -rf .selftest-build
mkdir -p .selftest-build
./node_modules/.bin/tsc \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --lib ES2022,DOM \
  --strict \
  --skipLibCheck \
  --outDir .selftest-build \
  src/errors.ts src/weread-client.ts src/normalize.ts
node --test test/core.test.mjs
rm -rf .selftest-build
