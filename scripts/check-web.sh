#!/usr/bin/env bash
# Requires npm ci, Python Playwright and Chromium; same checks locally and in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:database
npm run test:operations
