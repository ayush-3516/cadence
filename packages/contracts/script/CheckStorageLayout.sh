#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p storage-layouts
forge inspect FeeRegistry storageLayout --json > storage-layouts/FeeRegistry.json
forge inspect SubscriptionManager storageLayout --json > storage-layouts/SubscriptionManager.json
echo "Storage layouts written to storage-layouts/. Diff against the previous release before any upgrade."
