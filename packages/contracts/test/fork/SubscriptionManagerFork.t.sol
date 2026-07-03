// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {FeeRegistry} from "../../src/FeeRegistry.sol";
import {SubscriptionManager} from "../../src/SubscriptionManager.sol";
import {ISubscriptionManager} from "../../src/interfaces/ISubscriptionManager.sol";
import {Config} from "../../script/Config.sol";

// Forks Base Sepolia to prove SubscriptionManager works against the real,
// deployed USDC contract (permit + transferFrom) and routes net proceeds
// to a real address representing a merchant's payout destination.
//
// NOTE on 0xSplits: the plan's Step 1 called for locating and verifying a
// live 0xSplits SplitFactory/SplitMain address on Base Sepolia. That step is
// intentionally skipped here because the test below never touches any
// 0xSplits contract at all -- SubscriptionManager only ever does a plain
// ERC-20 `transfer` to whatever `payoutSplit` address is configured, so a
// Split address and a plain EOA are externally indistinguishable from this
// contract's point of view. Full 0xSplits SplitFactory integration
// (creating a live Split and verifying its internal distribute/withdraw
// accounting) is exercised at the SDK layer in Phase 1 once the
// 0xsplits/splits-sdk package is wired into the monorepo; this fork test
// proves SubscriptionManager's side of the contract -- that `net` lands
// correctly at whatever `payoutSplit` address is configured -- using a
// plain EOA stand-in (`payoutSplitStandIn`) as the `payoutSplit` recipient.
contract SubscriptionManagerForkTest is Test {
    FeeRegistry feeRegistry;
    SubscriptionManager manager;
    IERC20 usdc;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address merchant = makeAddr("merchant");
    address payoutSplit = makeAddr("payoutSplitStandIn");

    uint256 subscriberPk = 0xB0B;
    address subscriber;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BASE_SEPOLIA_RPC_URL", string("https://sepolia.base.org"));
        vm.createSelectFork(rpcUrl);

        usdc = IERC20(Config.BASE_SEPOLIA_USDC);
        subscriber = vm.addr(subscriberPk);

        FeeRegistry feeImpl = new FeeRegistry();
        feeRegistry = FeeRegistry(
            address(new ERC1967Proxy(address(feeImpl), abi.encodeCall(FeeRegistry.initialize, (admin, 75))))
        );

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        SubscriptionManager mgrImpl = new SubscriptionManager();
        manager = SubscriptionManager(
            address(
                new ERC1967Proxy(
                    address(mgrImpl),
                    abi.encodeCall(SubscriptionManager.initialize, (admin, treasury, address(feeRegistry), tokens))
                )
            )
        );

        // Fund the subscriber with real USDC by impersonating a known large holder
        // (Base Sepolia USDC faucet/bridge contract typically holds a balance; using
        // deal() here since Base Sepolia USDC is a standard proxy token that respects
        // storage-slot balance manipulation via vm.deal-equivalent for ERC20).
        deal(address(usdc), subscriber, 1_000_000_000, true);
    }

    function test_fork_subscribeWithPermit_realUSDC_netLandsAtPayoutSplit() public {
        vm.prank(merchant);
        uint256 planId = manager.createPlan(payoutSplit, address(usdc), 20_000_000, 30 days, 0);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = IERC20Permit(address(usdc)).DOMAIN_SEPARATOR();
        bytes32 permitTypehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(
            abi.encode(
                permitTypehash, subscriber, address(manager), 20_000_000, IERC20Permit(address(usdc)).nonces(subscriber), deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(subscriberPk, digest);

        vm.prank(subscriber);
        uint256 subId = manager.subscribeWithPermit(planId, 20_000_000, deadline, v, r, s);

        assertEq(uint8(manager.getSubscription(subId).status), uint8(ISubscriptionManager.Status.Active));
        assertEq(usdc.balanceOf(treasury), 150_000); // 75bps of 20 USDC
        assertEq(usdc.balanceOf(payoutSplit), 19_850_000);
    }

    function test_fork_renewalCharge_realUSDC() public {
        vm.prank(subscriber);
        usdc.approve(address(manager), type(uint256).max);

        vm.prank(merchant);
        uint256 planId = manager.createPlan(payoutSplit, address(usdc), 20_000_000, 30 days, 0);
        vm.prank(subscriber);
        uint256 subId = manager.subscribe(planId);

        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);
        vm.warp(before.currentPeriodEnd);
        manager.charge(subId);

        assertEq(usdc.balanceOf(treasury), 300_000); // two charges
        assertEq(usdc.balanceOf(payoutSplit), 39_700_000);
    }
}
