// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../helpers/TestBase.sol";
import {ISubscriptionManager} from "../../src/interfaces/ISubscriptionManager.sol";

contract SubscriptionManagerCreatePlanTest is TestBase {
    function test_createPlan_storesPlanAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.PlanCreated(1, merchant, payoutSplit, address(token), PLAN_AMOUNT, PLAN_PERIOD, 0);
        vm.prank(merchant);
        uint256 planId = manager.createPlan(payoutSplit, address(token), PLAN_AMOUNT, PLAN_PERIOD, 0);

        assertEq(planId, 1);
        ISubscriptionManager.Plan memory p = manager.getPlan(planId);
        assertEq(p.merchant, merchant);
        assertEq(p.payoutSplit, payoutSplit);
        assertEq(p.token, address(token));
        assertEq(p.amount, PLAN_AMOUNT);
        assertEq(p.period, PLAN_PERIOD);
        assertEq(p.trialPeriod, 0);
        assertTrue(p.active);
    }

    function test_createPlan_incrementsPlanId() public {
        uint256 id1 = _createPlan(0);
        uint256 id2 = _createPlan(0);
        assertEq(id1, 1);
        assertEq(id2, 2);
    }

    function test_createPlan_revertsOnZeroPayoutSplit() public {
        vm.prank(merchant);
        vm.expectRevert(ISubscriptionManager.ZeroAddress.selector);
        manager.createPlan(address(0), address(token), PLAN_AMOUNT, PLAN_PERIOD, 0);
    }

    function test_createPlan_revertsOnUnsupportedToken() public {
        vm.prank(merchant);
        vm.expectRevert(ISubscriptionManager.TokenNotSupported.selector);
        manager.createPlan(payoutSplit, makeAddr("randomToken"), PLAN_AMOUNT, PLAN_PERIOD, 0);
    }

    function test_createPlan_revertsOnZeroAmount() public {
        vm.prank(merchant);
        vm.expectRevert(ISubscriptionManager.InvalidAmount.selector);
        manager.createPlan(payoutSplit, address(token), 0, PLAN_PERIOD, 0);
    }

    function test_createPlan_revertsOnZeroPeriod() public {
        vm.prank(merchant);
        vm.expectRevert(ISubscriptionManager.InvalidPeriod.selector);
        manager.createPlan(payoutSplit, address(token), PLAN_AMOUNT, 0, 0);
    }

    function test_setPlanActive_onlyMerchantCanToggle() public {
        uint256 planId = _createPlan(0);
        vm.prank(merchant);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.PlanStatusChanged(planId, false);
        manager.setPlanActive(planId, false);
        assertFalse(manager.getPlan(planId).active);
    }

    function test_setPlanActive_revertsForNonMerchant() public {
        uint256 planId = _createPlan(0);
        vm.expectRevert(ISubscriptionManager.NotMerchant.selector);
        manager.setPlanActive(planId, false);
    }

    function test_setPlanActive_revertsForUnknownPlan() public {
        vm.expectRevert(ISubscriptionManager.PlanNotFound.selector);
        manager.setPlanActive(999, false);
    }
}
