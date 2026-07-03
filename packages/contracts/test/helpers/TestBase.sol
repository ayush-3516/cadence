// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {FeeRegistry} from "../../src/FeeRegistry.sol";
import {SubscriptionManager} from "../../src/SubscriptionManager.sol";
import {MockUSDC} from "./MockUSDC.sol";

abstract contract TestBase is Test {
    FeeRegistry feeRegistry;
    SubscriptionManager manager;
    MockUSDC token;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address merchant = makeAddr("merchant");
    address subscriber = makeAddr("subscriber");
    address payoutSplit = makeAddr("payoutSplit");

    uint256 constant PLAN_AMOUNT = 20_000_000; // 20 USDC (6 decimals)
    uint40 constant PLAN_PERIOD = 30 days;

    function setUp() public virtual {
        token = new MockUSDC();

        FeeRegistry feeImpl = new FeeRegistry();
        bytes memory feeInit = abi.encodeCall(FeeRegistry.initialize, (admin, 75));
        feeRegistry = FeeRegistry(address(new ERC1967Proxy(address(feeImpl), feeInit)));

        SubscriptionManager mgrImpl = new SubscriptionManager();
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        bytes memory mgrInit =
            abi.encodeCall(SubscriptionManager.initialize, (admin, treasury, address(feeRegistry), tokens));
        manager = SubscriptionManager(address(new ERC1967Proxy(address(mgrImpl), mgrInit)));

        token.mint(subscriber, 1_000_000_000); // 1000 USDC
    }

    function _createPlan(uint40 trialPeriod) internal returns (uint256 planId) {
        vm.prank(merchant);
        planId = manager.createPlan(payoutSplit, address(token), PLAN_AMOUNT, PLAN_PERIOD, trialPeriod);
    }
}
