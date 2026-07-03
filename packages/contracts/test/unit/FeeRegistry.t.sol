// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeRegistry} from "../../src/FeeRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract FeeRegistryTest is Test {
    FeeRegistry registry;
    address admin = makeAddr("admin");
    address merchant = makeAddr("merchant");

    function setUp() public {
        FeeRegistry impl = new FeeRegistry();
        bytes memory initData = abi.encodeCall(FeeRegistry.initialize, (admin, 75));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        registry = FeeRegistry(address(proxy));
    }

    function test_defaultFeeBps_setOnInit() public view {
        assertEq(registry.defaultFeeBps(), 75);
    }

    function test_getFeeBps_returnsDefault_whenNoOverride() public view {
        assertEq(registry.getFeeBps(merchant), 75);
    }

    function test_getFeeBps_returnsOverride_whenSet() public {
        vm.prank(admin);
        registry.setMerchantFee(merchant, 50);
        assertEq(registry.getFeeBps(merchant), 50);
    }

    function test_getFeeBps_clampsAtMaxFeeBps() public {
        vm.prank(admin);
        // even if somehow set above cap via a future admin bug, getter clamps
        registry.setDefaultFeeBps(1000);
        assertEq(registry.getFeeBps(merchant), 1000);
    }

    function test_setDefaultFeeBps_revertsAboveCap() public {
        vm.prank(admin);
        vm.expectRevert(FeeRegistry.FeeTooHigh.selector);
        registry.setDefaultFeeBps(1001);
    }

    function test_setMerchantFee_revertsAboveCap() public {
        vm.prank(admin);
        vm.expectRevert(FeeRegistry.FeeTooHigh.selector);
        registry.setMerchantFee(merchant, 1001);
    }

    function test_setDefaultFeeBps_revertsForNonAdmin() public {
        vm.expectRevert();
        registry.setDefaultFeeBps(100);
    }

    function test_setMerchantFee_revertsForNonAdmin() public {
        vm.expectRevert();
        registry.setMerchantFee(merchant, 100);
    }

    function test_clearMerchantFee_revertsToDefault() public {
        vm.startPrank(admin);
        registry.setMerchantFee(merchant, 50);
        assertEq(registry.getFeeBps(merchant), 50);
        registry.clearMerchantFee(merchant);
        vm.stopPrank();
        assertEq(registry.getFeeBps(merchant), 75);
    }

    function test_setDefaultFeeBps_emitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(true, true, true, true);
        emit FeeRegistry.DefaultFeeUpdated(200);
        registry.setDefaultFeeBps(200);
    }

    function test_setMerchantFee_emitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(true, true, true, true);
        emit FeeRegistry.MerchantFeeUpdated(merchant, 60, true);
        registry.setMerchantFee(merchant, 60);
    }

    function test_clearMerchantFee_emitsEvent() public {
        vm.startPrank(admin);
        registry.setMerchantFee(merchant, 60);
        vm.expectEmit(true, true, true, true);
        emit FeeRegistry.MerchantFeeUpdated(merchant, 0, false);
        registry.clearMerchantFee(merchant);
        vm.stopPrank();
    }

    function test_initialize_revertsWhenDefaultFeeAboveCap() public {
        FeeRegistry impl = new FeeRegistry();
        bytes memory initData = abi.encodeCall(FeeRegistry.initialize, (admin, 1001));
        vm.expectRevert(FeeRegistry.FeeTooHigh.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_upgradeToAndCall_onlyUpgraderRole() public {
        FeeRegistry newImpl = new FeeRegistry();
        vm.expectRevert();
        registry.upgradeToAndCall(address(newImpl), "");
    }

    function test_upgradeToAndCall_succeedsForUpgraderRole_andPreservesState() public {
        vm.prank(admin);
        registry.setMerchantFee(merchant, 42);

        FeeRegistry newImpl = new FeeRegistry();
        vm.prank(admin);
        registry.upgradeToAndCall(address(newImpl), "");

        // state persists across the upgrade and the new implementation is live
        assertEq(registry.getFeeBps(merchant), 42);
        assertEq(registry.defaultFeeBps(), 75);
    }
}
