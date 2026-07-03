// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../helpers/TestBase.sol";
import {ISubscriptionManager} from "../../src/interfaces/ISubscriptionManager.sol";

contract SubscriptionManagerLifecycleTest is TestBase {
    function _activeSub() internal returns (uint256 subId) {
        uint256 planId = _createPlan(0);
        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.prank(subscriber);
        subId = manager.subscribe(planId);
    }

    function test_pauseSubscription_storesRemainingTime() public {
        uint256 subId = _activeSub();
        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);
        uint40 elapsed = 5 days;
        vm.warp(block.timestamp + elapsed);

        vm.prank(subscriber);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.Paused(subId, before.currentPeriodEnd - uint40(block.timestamp));
        manager.pauseSubscription(subId);

        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        assertEq(uint8(s.status), uint8(ISubscriptionManager.Status.Paused));
        assertEq(s.pausedRemaining, before.currentPeriodEnd - uint40(block.timestamp));
    }

    function test_pauseSubscription_revertsOnWrongStatus() public {
        uint256 subId = _activeSub();
        vm.startPrank(subscriber);
        manager.pauseSubscription(subId);
        vm.expectRevert(ISubscriptionManager.InvalidStatus.selector);
        manager.pauseSubscription(subId); // already paused
        vm.stopPrank();
    }

    function test_pauseSubscription_revertsForNonSubscriber() public {
        uint256 subId = _activeSub();
        vm.expectRevert(ISubscriptionManager.NotSubscriber.selector);
        manager.pauseSubscription(subId);
    }

    function test_resumeSubscription_restoresRemainingTime() public {
        uint256 subId = _activeSub();
        vm.warp(block.timestamp + 5 days);
        vm.startPrank(subscriber);
        manager.pauseSubscription(subId);
        uint40 remaining = manager.getSubscription(subId).pausedRemaining;

        vm.warp(block.timestamp + 100 days); // paused time doesn't count
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.Resumed(subId, uint40(block.timestamp) + remaining);
        manager.resumeSubscription(subId);
        vm.stopPrank();

        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        assertEq(uint8(s.status), uint8(ISubscriptionManager.Status.Active));
        assertEq(s.currentPeriodEnd, uint40(block.timestamp) + remaining);
        assertEq(s.pausedRemaining, 0);
    }

    function test_resumeSubscription_revertsWhenNotPaused() public {
        uint256 subId = _activeSub();
        vm.prank(subscriber);
        vm.expectRevert(ISubscriptionManager.InvalidStatus.selector);
        manager.resumeSubscription(subId);
    }

    function test_cancel_immediate_setsCanceledNow() public {
        uint256 subId = _activeSub();
        vm.prank(subscriber);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.Canceled(subId);
        manager.cancel(subId, true);
        assertEq(uint8(manager.getSubscription(subId).status), uint8(ISubscriptionManager.Status.Canceled));
    }

    function test_cancel_atPeriodEnd_keepsAccessUntilThen() public {
        uint256 subId = _activeSub();
        vm.prank(subscriber);
        manager.cancel(subId, false);

        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        assertTrue(s.pendingCancel);
        assertEq(uint8(s.status), uint8(ISubscriptionManager.Status.Active)); // status unchanged until finalized
        assertTrue(manager.isActive(subId));
    }

    function test_cancel_revertsForNonSubscriber() public {
        uint256 subId = _activeSub();
        vm.expectRevert(ISubscriptionManager.NotSubscriber.selector);
        manager.cancel(subId, true);
    }

    function test_cancel_revertsOnAlreadyCanceled() public {
        uint256 subId = _activeSub();
        vm.startPrank(subscriber);
        manager.cancel(subId, true);
        vm.expectRevert(ISubscriptionManager.InvalidStatus.selector);
        manager.cancel(subId, true);
        vm.stopPrank();
    }

    function test_resubscribe_allowedAfterCancellation() public {
        uint256 subId = _activeSub();
        uint256 planId = manager.getSubscription(subId).planId;
        vm.prank(subscriber);
        manager.cancel(subId, true);

        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.prank(subscriber);
        uint256 newSubId = manager.subscribe(planId); // must not revert AlreadyActive
        assertTrue(newSubId != subId);
    }
}
