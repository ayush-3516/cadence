// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdUtils} from "forge-std/StdUtils.sol";
import {SubscriptionManager} from "../../../src/SubscriptionManager.sol";
import {ISubscriptionManager} from "../../../src/interfaces/ISubscriptionManager.sol";
import {MockUSDC} from "../../helpers/MockUSDC.sol";
import {Vm} from "forge-std/Vm.sol";

contract SubscriptionManagerHandler is StdUtils {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SubscriptionManager public manager;
    MockUSDC public token;
    address public merchant;
    address public payoutSplit;
    uint256 public planId;

    uint256[] public subIds;
    mapping(uint256 => bool) public everCharged;
    mapping(uint256 => uint40) public lastChargedPeriodEnd;

    uint256 public totalCharged;
    uint256 public ghost_chargedTwiceInSamePeriod;
    uint256 public ghost_chargedWhileTerminal;

    constructor(SubscriptionManager _manager, MockUSDC _token, address _merchant, address _payoutSplit, uint256 _planId) {
        manager = _manager;
        token = _token;
        merchant = _merchant;
        payoutSplit = _payoutSplit;
        planId = _planId;
    }

    function subscribeNew(uint256 seed) external {
        address s = address(uint160(uint256(keccak256(abi.encode("handler-sub", seed, subIds.length)))));
        token.mint(s, 1_000_000_000);
        vm.prank(s);
        token.approve(address(manager), type(uint256).max);
        vm.prank(s);
        try manager.subscribe(planId) returns (uint256 subId) {
            subIds.push(subId);
            totalCharged += _planAmountNet();
        } catch {}
    }

    function chargeExisting(uint256 idx, uint256 warpSeconds) external {
        if (subIds.length == 0) return;
        uint256 subId = subIds[bound(idx, 0, subIds.length - 1)];
        warpSeconds = bound(warpSeconds, 0, 60 days);
        vm.warp(block.timestamp + warpSeconds);

        ISubscriptionManager.Subscription memory before = manager.getSubscription(subId);
        if (before.status == ISubscriptionManager.Status.Canceled) {
            ghost_chargedWhileTerminal++; // will be checked: this branch must never actually succeed below
        }

        try manager.charge(subId) {
            ISubscriptionManager.Subscription memory after_ = manager.getSubscription(subId);
            // A genuine "charged twice in the same period" would mean this successful charge
            // produced the *same* resulting currentPeriodEnd as the previous successful charge
            // (i.e. the period failed to advance). Comparing `before.currentPeriodEnd` (this
            // call's pre-state, which for any legitimate 2nd+ charge always equals the previous
            // charge's post-state) against lastChargedPeriodEnd is always true for normal
            // sequential charging and is not evidence of a double charge — compare the two
            // *post*-charge results instead.
            if (
                after_.status == ISubscriptionManager.Status.Active && lastChargedPeriodEnd[subId] != 0
                    && after_.currentPeriodEnd == lastChargedPeriodEnd[subId]
            ) {
                ghost_chargedTwiceInSamePeriod++;
            }
            if (after_.status == ISubscriptionManager.Status.Active) {
                lastChargedPeriodEnd[subId] = after_.currentPeriodEnd;
                totalCharged += _planAmountNet();
            }
        } catch {}
    }

    function cancelExisting(uint256 idx, bool immediate) external {
        if (subIds.length == 0) return;
        uint256 subId = subIds[bound(idx, 0, subIds.length - 1)];
        ISubscriptionManager.Subscription memory s = manager.getSubscription(subId);
        vm.prank(s.subscriber);
        try manager.cancel(subId, immediate) {} catch {}
    }

    function _planAmountNet() internal view returns (uint256) {
        ISubscriptionManager.Plan memory p = manager.getPlan(planId);
        return p.amount; // gross; fee/net split checked separately in the invariant test via treasury+split balances
    }

    function subIdsLength() external view returns (uint256) {
        return subIds.length;
    }
}
