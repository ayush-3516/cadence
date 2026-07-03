// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../helpers/TestBase.sol";
import {ISubscriptionManager} from "../../src/interfaces/ISubscriptionManager.sol";

contract SubscriptionManagerFuzzTest is TestBase {
    function testFuzz_feeMath_neverExceedsAmount(uint256 amount, uint16 merchantBps) public {
        amount = bound(amount, 1, 1_000_000_000_000);
        merchantBps = uint16(bound(merchantBps, 0, 1000));

        vm.prank(admin);
        feeRegistry.setMerchantFee(merchant, merchantBps);

        vm.prank(merchant);
        uint256 planId = manager.createPlan(payoutSplit, address(token), amount, PLAN_PERIOD, 0);

        token.mint(subscriber, amount);
        vm.prank(subscriber);
        token.approve(address(manager), amount);
        vm.prank(subscriber);
        uint256 subId = manager.subscribe(planId);

        uint256 fee = token.balanceOf(treasury);
        uint256 net = token.balanceOf(payoutSplit);
        assertLe(fee, amount);
        assertEq(fee + net, amount);
        assertEq(uint8(manager.getSubscription(subId).status), uint8(ISubscriptionManager.Status.Active));
    }

    function testFuzz_periodMath_neverDriftsNegative(uint40 period, uint40 warpForward) public {
        period = uint40(bound(period, 1, 365 days));
        warpForward = uint40(bound(warpForward, 0, 3650 days));

        vm.prank(merchant);
        uint256 planId = manager.createPlan(payoutSplit, address(token), PLAN_AMOUNT, period, 0);

        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.prank(subscriber);
        uint256 subId = manager.subscribe(planId);

        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);
        vm.warp(uint256(before.currentPeriodEnd) + warpForward);

        // top up so the charge always succeeds regardless of how much time passed
        token.mint(subscriber, PLAN_AMOUNT * 10);

        manager.charge(subId);
        ISubscriptionManager.Subscription memory after_ = manager.getSubscription(subId);

        assertGe(after_.currentPeriodEnd, uint40(block.timestamp));
        assertEq(uint8(after_.status), uint8(ISubscriptionManager.Status.Active));
    }

    function testFuzz_multipleSubscribers_noCrossContamination(uint8 numSubs) public {
        numSubs = uint8(bound(numSubs, 1, 20));
        uint256 planId = _createPlan(0);

        uint256[] memory subIds = new uint256[](numSubs);
        address[] memory subscribers = new address[](numSubs);

        for (uint256 i; i < numSubs; ++i) {
            address s = address(uint160(uint256(keccak256(abi.encode("sub", i)))));
            subscribers[i] = s;
            token.mint(s, PLAN_AMOUNT);
            vm.prank(s);
            token.approve(address(manager), PLAN_AMOUNT);
            vm.prank(s);
            subIds[i] = manager.subscribe(planId);
        }

        for (uint256 i; i < numSubs; ++i) {
            ISubscriptionManager.Subscription memory s = manager.getSubscription(subIds[i]);
            assertEq(s.subscriber, subscribers[i]);
            assertEq(uint8(s.status), uint8(ISubscriptionManager.Status.Active));
        }
    }
}
