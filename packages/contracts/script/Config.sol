// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library Config {
    // Base Sepolia (chainId 84532)
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint16 constant DEFAULT_FEE_BPS = 75; // 0.75%
    uint256 constant TIMELOCK_MIN_DELAY = 48 hours;
}
