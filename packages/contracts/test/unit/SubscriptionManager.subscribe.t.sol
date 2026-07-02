// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../helpers/TestBase.sol";
import {ISubscriptionManager} from "../../src/interfaces/ISubscriptionManager.sol";

contract SubscriptionManagerSubscribeTest is TestBase {
    function test_subscribe_noTrial_pullsFirstChargeAndActivates() public {
        uint256 planId = _createPlan(0);

        vm.prank(subscriber);
        token.approve(address(manager), PLAN_AMOUNT);

        vm.prank(subscriber);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.Subscribed(1, planId, subscriber, uint40(block.timestamp + PLAN_PERIOD), false);
        uint256 subId = manager.subscribe(planId);

        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        assertEq(uint8(s.status), uint8(ISubscriptionManager.Status.Active));
        assertEq(s.currentPeriodEnd, block.timestamp + PLAN_PERIOD);

        // fee = 75 bps of 20_000_000 = 150_000; net = 19_850_000
        assertEq(token.balanceOf(treasury), 150_000);
        assertEq(token.balanceOf(payoutSplit), 19_850_000);
        assertEq(token.balanceOf(subscriber), 1_000_000_000 - PLAN_AMOUNT);
    }

    function test_subscribe_withTrial_noPull_setsTrialing() public {
        uint40 trial = 7 days;
        uint256 planId = _createPlan(trial);

        vm.prank(subscriber);
        uint256 subId = manager.subscribe(planId);

        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        assertEq(uint8(s.status), uint8(ISubscriptionManager.Status.Trialing));
        assertEq(s.currentPeriodEnd, block.timestamp + trial);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(payoutSplit), 0);
    }

    function test_subscribe_revertsOnInactivePlan() public {
        uint256 planId = _createPlan(0);
        vm.prank(merchant);
        manager.setPlanActive(planId, false);

        vm.prank(subscriber);
        vm.expectRevert(ISubscriptionManager.PlanInactive.selector);
        manager.subscribe(planId);
    }

    function test_subscribe_revertsOnUnknownPlan() public {
        vm.prank(subscriber);
        vm.expectRevert(ISubscriptionManager.PlanNotFound.selector);
        manager.subscribe(999);
    }

    function test_subscribe_revertsOnDuplicateActiveSub() public {
        uint40 trial = 7 days;
        uint256 planId = _createPlan(trial);
        vm.startPrank(subscriber);
        manager.subscribe(planId);
        vm.expectRevert(ISubscriptionManager.AlreadyActive.selector);
        manager.subscribe(planId);
        vm.stopPrank();
    }

    function test_subscribe_noTrial_revertsFullyOnInsufficientAllowance() public {
        uint256 planId = _createPlan(0);
        // no approve() — allowance is zero
        vm.prank(subscriber);
        vm.expectRevert();
        manager.subscribe(planId);

        // no half-open subscription: activeSubOf must not be set
        uint40 trial = 7 days;
        uint256 trialPlanId = _createPlan(trial);
        vm.prank(subscriber);
        uint256 subId = manager.subscribe(trialPlanId); // succeeds — proves prior revert left no state
        assertEq(subId, 1);
    }

    function test_subscribe_revertsWhenContractPaused() public {
        uint256 planId = _createPlan(0);
        vm.prank(admin);
        manager.pause();

        vm.prank(subscriber);
        vm.expectRevert();
        manager.subscribe(planId);
    }

    function test_subscribeWithPermit_setsAllowanceAndSubscribes() public {
        uint256 planId = _createPlan(0);
        uint256 subscriberPk = 0xA11CE;
        address signer = vm.addr(subscriberPk);
        token.mint(signer, 1_000_000_000);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = token.DOMAIN_SEPARATOR();
        bytes32 permitTypehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(permitTypehash, signer, address(manager), PLAN_AMOUNT, token.nonces(signer), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(subscriberPk, digest);

        vm.prank(signer);
        uint256 subId = manager.subscribeWithPermit(planId, PLAN_AMOUNT, deadline, v, r, s);

        assertEq(uint8(manager.getSubscription(subId).status), uint8(ISubscriptionManager.Status.Active));
        assertEq(token.balanceOf(payoutSplit), 19_850_000);
    }

    function test_subscribeWithPermit_revertsOnUnknownPlan_beforeConsumingPermit() public {
        // planId 999 doesn't exist: the plan-existence check must short-circuit
        // before the permit signature is ever validated/consumed.
        vm.prank(subscriber);
        vm.expectRevert(ISubscriptionManager.PlanNotFound.selector);
        manager.subscribeWithPermit(999, PLAN_AMOUNT, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }
}
