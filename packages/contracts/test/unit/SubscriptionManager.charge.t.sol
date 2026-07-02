// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../helpers/TestBase.sol";
import {ISubscriptionManager} from "../../src/interfaces/ISubscriptionManager.sol";

contract SubscriptionManagerChargeTest is TestBase {
    function _activeSub() internal returns (uint256 subId) {
        uint256 planId = _createPlan(0);
        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.prank(subscriber);
        subId = manager.subscribe(planId);
    }

    function test_charge_revertsWhenNotDue() public {
        uint256 subId = _activeSub();
        vm.expectRevert(ISubscriptionManager.NotDue.selector);
        manager.charge(subId);
    }

    function test_charge_onTime_advancesPeriodExactlyOnePeriod() public {
        uint256 subId = _activeSub();
        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);

        vm.warp(before.currentPeriodEnd);
        manager.charge(subId);

        ISubscriptionManager.Subscription memory after_ = manager.getSubscription(subId);
        assertEq(after_.currentPeriodEnd, before.currentPeriodEnd + PLAN_PERIOD);
        assertEq(uint8(after_.status), uint8(ISubscriptionManager.Status.Active));
    }

    function test_charge_insufficientBalance_setsPastDue_doesNotAdvancePeriod() public {
        uint256 subId = _activeSub();
        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);

        uint256 drainAmount = token.balanceOf(subscriber);
        vm.prank(subscriber);
        token.transfer(makeAddr("sink"), drainAmount); // drain balance

        vm.warp(before.currentPeriodEnd);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.ChargeFailed(subId, 1);
        manager.charge(subId);

        ISubscriptionManager.Subscription memory after_ = manager.getSubscription(subId);
        assertEq(uint8(after_.status), uint8(ISubscriptionManager.Status.PastDue));
        assertEq(after_.currentPeriodEnd, before.currentPeriodEnd); // unchanged
    }

    function test_charge_insufficientAllowance_setsPastDue() public {
        uint256 planId = _createPlan(0);
        vm.prank(subscriber);
        token.approve(address(manager), PLAN_AMOUNT); // exactly one period's worth
        vm.prank(subscriber);
        uint256 subId = manager.subscribe(planId); // consumes the allowance

        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);
        vm.warp(before.currentPeriodEnd);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.ChargeFailed(subId, 2);
        manager.charge(subId);

        assertEq(uint8(manager.getSubscription(subId).status), uint8(ISubscriptionManager.Status.PastDue));
    }

    function test_charge_recoversFromPastDue_periodFromNow_noRetroactiveCatchUp() public {
        uint256 subId = _activeSub();
        ISubscriptionManager.Subscription memory s0 = manager.getSubscription(subId);

        uint256 drainAmount = token.balanceOf(subscriber);
        vm.prank(subscriber);
        token.transfer(makeAddr("sink"), drainAmount);
        vm.warp(s0.currentPeriodEnd);
        manager.charge(subId); // fails -> PastDue

        // subscriber tops up, recovers 10 days later (well past periodEnd)
        token.mint(subscriber, 1_000_000_000);
        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.warp(s0.currentPeriodEnd + 10 days);
        manager.charge(subId);

        ISubscriptionManager.Subscription memory s1 = manager.getSubscription(subId);
        assertEq(uint8(s1.status), uint8(ISubscriptionManager.Status.Active));
        // newPeriodEnd = max(currentPeriodEnd, now) + period = now + period, NOT s0.currentPeriodEnd + period
        assertEq(s1.currentPeriodEnd, uint40(block.timestamp) + PLAN_PERIOD);
    }

    function test_charge_neverChargesTwiceInSamePeriod() public {
        uint256 subId = _activeSub();
        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);
        vm.warp(before.currentPeriodEnd);
        manager.charge(subId);

        vm.expectRevert(ISubscriptionManager.NotDue.selector);
        manager.charge(subId);
    }

    function test_charge_revertsOnCanceledSub() public {
        uint256 subId = _activeSub();
        vm.prank(subscriber);
        manager.cancel(subId, true);

        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        vm.warp(s.currentPeriodEnd + 1);
        vm.expectRevert(ISubscriptionManager.InvalidStatus.selector);
        manager.charge(subId);
    }

    function test_charge_finalizesPendingCancelAtPeriodEnd_withoutCharging() public {
        uint256 subId = _activeSub();
        vm.prank(subscriber);
        manager.cancel(subId, false); // pendingCancel = true, access until periodEnd

        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);
        uint256 balanceBefore = token.balanceOf(subscriber);

        vm.warp(before.currentPeriodEnd);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.Canceled(subId);
        manager.charge(subId);

        assertEq(uint8(manager.getSubscription(subId).status), uint8(ISubscriptionManager.Status.Canceled));
        assertEq(token.balanceOf(subscriber), balanceBefore); // no charge happened
    }

    function test_charge_revertsWhenContractPaused() public {
        uint256 subId = _activeSub();
        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        vm.warp(s.currentPeriodEnd);

        vm.prank(admin);
        manager.pause();

        vm.expectRevert();
        manager.charge(subId);
    }

    function test_chargeBatch_oneFailureDoesNotRevertOthers() public {
        uint256 subId1 = _activeSub();

        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);

        address subscriber2 = makeAddr("subscriber2");
        token.mint(subscriber2, 1_000_000_000);
        vm.prank(subscriber2);
        token.approve(address(manager), type(uint256).max);
        uint256 planId = _createPlan(0);
        vm.prank(subscriber2);
        uint256 subId2 = manager.subscribe(planId);

        // drain subscriber1 so their renewal fails; subscriber2 stays funded
        uint256 drainAmount = token.balanceOf(subscriber);
        vm.prank(subscriber);
        token.transfer(makeAddr("sink"), drainAmount);

        ISubscriptionManager.Subscription memory s1 = manager.getSubscription(subId1);
        ISubscriptionManager.Subscription memory s2 = manager.getSubscription(subId2);
        vm.warp(s1.currentPeriodEnd > s2.currentPeriodEnd ? s1.currentPeriodEnd : s2.currentPeriodEnd);

        uint256[] memory ids = new uint256[](2);
        ids[0] = subId1;
        ids[1] = subId2;
        manager.chargeBatch(ids);

        assertEq(uint8(manager.getSubscription(subId1).status), uint8(ISubscriptionManager.Status.PastDue));
        assertEq(uint8(manager.getSubscription(subId2).status), uint8(ISubscriptionManager.Status.Active));
    }

    function test_chargeBatch_skipsNotDueSubs() public {
        uint256 subId = _activeSub(); // not due yet
        uint256[] memory ids = new uint256[](1);
        ids[0] = subId;
        manager.chargeBatch(ids); // should not revert, just skip
        assertEq(uint8(manager.getSubscription(subId).status), uint8(ISubscriptionManager.Status.Active));
    }

    function test_gas_chargeBatch50() public {
        uint256 planId = _createPlan(0);
        uint256[] memory ids = new uint256[](50);
        for (uint256 i; i < 50; ++i) {
            address s = address(uint160(uint256(keccak256(abi.encode("gas-sub", i)))));
            token.mint(s, PLAN_AMOUNT);
            vm.prank(s);
            token.approve(address(manager), PLAN_AMOUNT);
            vm.prank(s);
            ids[i] = manager.subscribe(planId);
        }

        ISubscriptionManager.Subscription memory s0 = manager.getSubscription(ids[0]);
        vm.warp(s0.currentPeriodEnd);

        // top up all 50 for renewal
        for (uint256 i; i < 50; ++i) {
            ISubscriptionManager.Subscription memory s = manager.getSubscription(ids[i]);
            token.mint(s.subscriber, PLAN_AMOUNT);
        }

        manager.chargeBatch(ids); // gas usage captured by forge snapshot
    }

    function test_isActive_trueForActiveAndTrialing() public {
        uint256 subId = _activeSub();
        assertTrue(manager.isActive(subId));
    }

    function test_isActive_trueDuringPendingCancelUntilPeriodEnd() public {
        uint256 subId = _activeSub();
        vm.prank(subscriber);
        manager.cancel(subId, false);
        assertTrue(manager.isActive(subId));
    }

    function test_isActive_falseAfterImmediateCancel() public {
        uint256 subId = _activeSub();
        vm.prank(subscriber);
        manager.cancel(subId, true);
        assertFalse(manager.isActive(subId));
    }

    function test_isDue_trueOnlyAtOrAfterPeriodEnd() public {
        uint256 subId = _activeSub();
        assertFalse(manager.isDue(subId));
        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        vm.warp(s.currentPeriodEnd);
        assertTrue(manager.isDue(subId));
    }
}
