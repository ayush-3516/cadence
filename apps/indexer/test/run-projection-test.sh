#!/usr/bin/env bash
set -euo pipefail

# Assumes: anvil is running on localhost:8545 (Task 1), postgres is running
# (Task 2 Step 8), and `ponder start` is NOT currently running against the
# same DATABASE_URL (this script starts its own instance).

cd "$(dirname "$0")/.."

DEPLOYMENT=$(cat ../../deployments/84532.json)
MANAGER=$(echo "$DEPLOYMENT" | python3 -c "import json,sys; print(json.load(sys.stdin)['subscriptionManager'])")
USDC=$(echo "$DEPLOYMENT" | python3 -c "import json,sys; print(json.load(sys.stdin)['usdc'])")

MERCHANT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
SUBSCRIBER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
PAYOUT_SPLIT=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
SUBSCRIBER=0x90F79bf6EB2c4f870365E785982E1f101E93b906

echo "== creating plan =="
cast send "$MANAGER" "createPlan(address,address,uint256,uint40,uint40)" \
  "$PAYOUT_SPLIT" "$USDC" 20000000 2592000 0 \
  --private-key "$MERCHANT_KEY" --rpc-url http://localhost:8545

echo "== approving + subscribing =="
cast send "$USDC" "approve(address,uint256)" "$MANAGER" 20000000 \
  --private-key "$SUBSCRIBER_KEY" --rpc-url http://localhost:8545
cast send "$MANAGER" "subscribe(uint256)" 1 \
  --private-key "$SUBSCRIBER_KEY" --rpc-url http://localhost:8545

echo "== warping + charging renewal =="
cast send "$USDC" "approve(address,uint256)" "$MANAGER" 20000000 \
  --private-key "$SUBSCRIBER_KEY" --rpc-url http://localhost:8545
cast rpc anvil_increaseTime 2592001 --rpc-url http://localhost:8545
cast rpc anvil_mine --rpc-url http://localhost:8545
cast send "$MANAGER" "charge(uint256)" 1 --rpc-url http://localhost:8545 --private-key "$MERCHANT_KEY"

echo "== canceling =="
cast send "$MANAGER" "cancel(uint256,bool)" 1 true \
  --private-key "$SUBSCRIBER_KEY" --rpc-url http://localhost:8545

echo "done — check Postgres for projected rows"
