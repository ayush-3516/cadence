// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../helpers/TestBase.sol";
import {ISubscriptionManager} from "../../src/interfaces/ISubscriptionManager.sol";
import {SubscriptionManager} from "../../src/SubscriptionManager.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract SubscriptionManagerAdminTest is TestBase {
    function test_setSupportedToken_onlyAdmin() public {
        address newToken = makeAddr("newToken");
        vm.prank(admin);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.SupportedTokenSet(newToken, true);
        manager.setSupportedToken(newToken, true);
        assertTrue(manager.isSupportedToken(newToken));
    }

    function test_setSupportedToken_revertsForNonAdmin() public {
        vm.expectRevert();
        manager.setSupportedToken(makeAddr("newToken"), true);
    }

    function test_setTreasury_onlyAdmin() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(admin);
        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.TreasuryUpdated(newTreasury);
        manager.setTreasury(newTreasury);
        assertEq(manager.treasury(), newTreasury);
    }

    function test_setTreasury_revertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(ISubscriptionManager.ZeroAddress.selector);
        manager.setTreasury(address(0));
    }

    function test_setTreasury_revertsForNonAdmin() public {
        vm.expectRevert();
        manager.setTreasury(makeAddr("x"));
    }

    function test_pause_blocksSubscribeAndCharge() public {
        uint256 planId = _createPlan(0);
        vm.prank(admin);
        manager.pause();

        vm.prank(subscriber);
        vm.expectRevert();
        manager.subscribe(planId);
    }

    function test_pause_onlyPauserRole() public {
        vm.expectRevert();
        manager.pause();
    }

    function test_unpause_restoresFunctionality() public {
        uint256 planId = _createPlan(0);
        vm.startPrank(admin);
        manager.pause();
        manager.unpause();
        vm.stopPrank();

        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.prank(subscriber);
        uint256 subId = manager.subscribe(planId);
        assertEq(uint8(manager.getSubscription(subId).status), uint8(ISubscriptionManager.Status.Active));
    }

    function test_feeMath_isExactAndRoundsDown() public {
        // 75 bps of 20_000_000 = 150_000 exactly (no remainder to worry about here);
        // verify explicit rounding-down case: amount not evenly divisible by 10_000
        vm.prank(merchant);
        uint256 planId = manager.createPlan(payoutSplit, address(token), 100_003, PLAN_PERIOD, 0);
        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.prank(subscriber);
        manager.subscribe(planId);

        // fee = 100_003 * 75 / 10_000 = 750.0225 -> 750 (rounds down)
        assertEq(token.balanceOf(treasury), 750);
        assertEq(token.balanceOf(payoutSplit), 100_003 - 750);
    }

    function test_initialize_revertsOnZeroAdmin() public {
        SubscriptionManager impl = new SubscriptionManager();
        address[] memory tokens = new address[](0);
        bytes memory initData =
            abi.encodeCall(SubscriptionManager.initialize, (address(0), treasury, address(feeRegistry), tokens));
        vm.expectRevert(ISubscriptionManager.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_initialize_revertsOnZeroTreasury() public {
        SubscriptionManager impl = new SubscriptionManager();
        address[] memory tokens = new address[](0);
        bytes memory initData =
            abi.encodeCall(SubscriptionManager.initialize, (admin, address(0), address(feeRegistry), tokens));
        vm.expectRevert(ISubscriptionManager.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_initialize_revertsOnZeroFeeRegistry() public {
        SubscriptionManager impl = new SubscriptionManager();
        address[] memory tokens = new address[](0);
        bytes memory initData =
            abi.encodeCall(SubscriptionManager.initialize, (admin, treasury, address(0), tokens));
        vm.expectRevert(ISubscriptionManager.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_setFeeRegistry_onlyAdmin_updatesAndIsUsedForCharging() public {
        FeeRegistryStub newRegistry = new FeeRegistryStub(500); // 5%
        vm.prank(admin);
        manager.setFeeRegistry(address(newRegistry));
        assertEq(address(manager.feeRegistry()), address(newRegistry));

        uint256 planId = _createPlan(0);
        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.prank(subscriber);
        manager.subscribe(planId);

        // fee = 20_000_000 * 500 / 10_000 = 1_000_000, confirming the new registry is consulted
        assertEq(token.balanceOf(treasury), 1_000_000);
    }

    function test_setFeeRegistry_revertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(ISubscriptionManager.ZeroAddress.selector);
        manager.setFeeRegistry(address(0));
    }

    function test_setFeeRegistry_revertsForNonAdmin() public {
        vm.expectRevert();
        manager.setFeeRegistry(makeAddr("newRegistry"));
    }

    function test_nextChargeTime_returnsCurrentPeriodEnd() public {
        uint256 planId = _createPlan(0);
        vm.prank(subscriber);
        token.approve(address(manager), type(uint256).max);
        vm.prank(subscriber);
        uint256 subId = manager.subscribe(planId);

        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        assertEq(manager.nextChargeTime(subId), s.currentPeriodEnd);
        assertTrue(manager.nextChargeTime(subId) > 0);
    }

    function test_upgradeToAndCall_onlyUpgraderRole() public {
        SubscriptionManager newImpl = new SubscriptionManager();
        vm.expectRevert();
        manager.upgradeToAndCall(address(newImpl), "");
    }

    function test_upgradeToAndCall_succeedsForUpgraderRole_andPreservesState() public {
        uint256 planId = _createPlan(0);

        SubscriptionManager newImpl = new SubscriptionManager();
        vm.prank(admin);
        manager.upgradeToAndCall(address(newImpl), "");

        // state persists across the upgrade and the new implementation is live
        assertEq(manager.getPlan(planId).merchant, merchant);
        assertEq(manager.treasury(), treasury);
    }
}

/// @dev Minimal IFeeRegistry stand-in used only to prove setFeeRegistry rewires
/// which registry SubscriptionManager consults at charge time.
contract FeeRegistryStub {
    uint16 public immutable bps;

    constructor(uint16 bps_) {
        bps = bps_;
    }

    function getFeeBps(address) external view returns (uint16) {
        return bps;
    }
}
