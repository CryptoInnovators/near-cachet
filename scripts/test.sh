#!/usr/bin/env bash
# Everything a clean clone needs to run every suite: fixtures first, then the workspace tests.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/fetch-fixtures.sh
cargo test --workspace --no-fail-fast
