// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {FeeRegistry} from "../src/FeeRegistry.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {MockUSDC} from "../test/helpers/MockUSDC.sol";
import {Config} from "./Config.sol";

// Local-only deploy script for e2e tests against a fresh anvil chain. Unlike
// Deploy.s.sol (the real deployment path, which targets a live network with a
// real USDC address and transfers admin roles to a Timelock), this script:
//   1. Deploys a MockUSDC token instead of referencing a real network's USDC
//      address, since a fresh anvil chain has no code at that address.
//   2. Leaves the deployer as admin directly (no Timelock role transfer) —
//      these tests never exercise governance/upgrade paths, so the extra
//      transactions would only slow down every test run.
// Never use this script against a real network.
contract DeployLocal is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        vm.startBroadcast(deployerPk);

        MockUSDC usdc = new MockUSDC();

        FeeRegistry feeImpl = new FeeRegistry();
        FeeRegistry feeRegistry = FeeRegistry(
            address(new ERC1967Proxy(address(feeImpl), abi.encodeCall(FeeRegistry.initialize, (deployer, Config.DEFAULT_FEE_BPS))))
        );

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        SubscriptionManager mgrImpl = new SubscriptionManager();
        SubscriptionManager manager = SubscriptionManager(
            address(
                new ERC1967Proxy(
                    address(mgrImpl),
                    abi.encodeCall(SubscriptionManager.initialize, (deployer, deployer, address(feeRegistry), tokens))
                )
            )
        );

        vm.stopBroadcast();

        console2.log("MockUSDC:", address(usdc));
        console2.log("FeeRegistry (proxy):", address(feeRegistry));
        console2.log("SubscriptionManager (proxy):", address(manager));
    }
}
