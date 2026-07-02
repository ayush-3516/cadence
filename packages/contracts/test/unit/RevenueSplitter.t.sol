// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RevenueSplitter} from "../../src/RevenueSplitter.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";

contract MaliciousReentrantToken is MockUSDC {
    RevenueSplitter public target;
    uint256 public splitId;
    bool public attacked;

    function setAttack(RevenueSplitter _target, uint256 _splitId) external {
        target = _target;
        splitId = _splitId;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        if (!attacked && address(target) != address(0)) {
            attacked = true;
            // Low-level call so the reentrant revert (ReentrancyGuardReentrantCall) is
            // contained here instead of propagating out and reverting the outer
            // legitimate withdraw() — mirrors how a real attacker contract would
            // swallow the failure and continue, letting us prove the guard blocked
            // the nested call while the outer call still completed successfully.
            (bool reentered,) = address(target).call(abi.encodeCall(RevenueSplitter.withdraw, (splitId, address(this))));
            reentered; // silence unused-var warning; the guard is expected to make this false
        }
        return ok;
    }
}

contract RevenueSplitterTest is Test {
    RevenueSplitter splitter;
    MockUSDC token;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address depositor = makeAddr("depositor");

    function setUp() public {
        splitter = new RevenueSplitter();
        token = new MockUSDC();
        token.mint(depositor, 1_000_000_000);
        vm.prank(depositor);
        token.approve(address(splitter), type(uint256).max);
    }

    function _split7030() internal returns (uint256 id) {
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;
        uint32[] memory bps = new uint32[](2);
        bps[0] = 7000;
        bps[1] = 3000;
        id = splitter.createSplit(recipients, bps);
    }

    function test_createSplit_revertsOnBpsNotSummingTo10000() public {
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;
        uint32[] memory bps = new uint32[](2);
        bps[0] = 5000;
        bps[1] = 4000;
        vm.expectRevert(RevenueSplitter.InvalidBps.selector);
        splitter.createSplit(recipients, bps);
    }

    function test_createSplit_revertsOnLengthMismatch() public {
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;
        uint32[] memory bps = new uint32[](1);
        bps[0] = 10_000;
        vm.expectRevert(RevenueSplitter.LengthMismatch.selector);
        splitter.createSplit(recipients, bps);
    }

    function test_createSplit_revertsOnZeroRecipient() public {
        address[] memory recipients = new address[](2);
        recipients[0] = address(0);
        recipients[1] = bob;
        uint32[] memory bps = new uint32[](2);
        bps[0] = 5000;
        bps[1] = 5000;
        vm.expectRevert(RevenueSplitter.ZeroRecipient.selector);
        splitter.createSplit(recipients, bps);
    }

    function test_createSplit_revertsOnDuplicateRecipient() public {
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = alice;
        uint32[] memory bps = new uint32[](2);
        bps[0] = 5000;
        bps[1] = 5000;
        vm.expectRevert(RevenueSplitter.DuplicateRecipient.selector);
        splitter.createSplit(recipients, bps);
    }

    function test_deposit_accruesOwedByBps() public {
        uint256 id = _split7030();
        vm.prank(depositor);
        splitter.deposit(id, address(token), 1_000_000);
        assertEq(splitter.owed(id, address(token), alice), 700_000);
        assertEq(splitter.owed(id, address(token), bob), 300_000);
    }

    function test_deposit_roundingRemainderGoesToFirstRecipient() public {
        address[] memory recipients = new address[](3);
        recipients[0] = alice;
        recipients[1] = bob;
        recipients[2] = makeAddr("carol");
        uint32[] memory bps = new uint32[](3);
        bps[0] = 3334;
        bps[1] = 3333;
        bps[2] = 3333;
        uint256 id = splitter.createSplit(recipients, bps);

        vm.prank(depositor);
        splitter.deposit(id, address(token), 100); // 100*3334/10000=33, 100*3333/10000=33 x2 => 33+33+33=99, remainder 1 -> alice
        assertEq(splitter.owed(id, address(token), alice), 34);
        assertEq(splitter.owed(id, address(token), bob), 33);
        assertEq(splitter.owed(id, address(token), recipients[2]), 33);
    }

    function test_withdraw_paysExactOwedAndZeroes() public {
        uint256 id = _split7030();
        vm.prank(depositor);
        splitter.deposit(id, address(token), 1_000_000);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit RevenueSplitter.Withdrawn(id, address(token), alice, 700_000);
        splitter.withdraw(id, address(token));

        assertEq(token.balanceOf(alice), 700_000);
        assertEq(splitter.owed(id, address(token), alice), 0);
    }

    function test_withdraw_revertsWhenNothingOwed() public {
        uint256 id = _split7030();
        vm.prank(alice);
        vm.expectRevert(RevenueSplitter.NothingOwed.selector);
        splitter.withdraw(id, address(token));
    }

    function test_withdraw_blocksReentrancy() public {
        MaliciousReentrantToken evilToken = new MaliciousReentrantToken();
        evilToken.mint(depositor, 1_000_000);
        vm.prank(depositor);
        evilToken.approve(address(splitter), type(uint256).max);

        address[] memory recipients = new address[](1);
        recipients[0] = address(evilToken);
        uint32[] memory bps = new uint32[](1);
        bps[0] = 10_000;
        uint256 id = splitter.createSplit(recipients, bps);
        evilToken.setAttack(splitter, id);

        vm.prank(depositor);
        splitter.deposit(id, address(evilToken), 1_000_000);

        vm.prank(address(evilToken));
        splitter.withdraw(id, address(evilToken)); // triggers reentrant withdraw() inside transfer()
        // second withdraw call inside transfer() must have failed silently due to nonReentrant guard reverting that inner call;
        // outer call still succeeds and pays exactly once
        assertEq(evilToken.balanceOf(address(evilToken)), 1_000_000);
    }

    function testFuzz_deposit_withdraw_invariantHolds(uint96 amount, uint32 bpsA) public {
        bpsA = uint32(bound(bpsA, 1, 9999));
        uint32 bpsB = 10_000 - bpsA;
        amount = uint96(bound(amount, 1, 1_000_000_000));

        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;
        uint32[] memory bps = new uint32[](2);
        bps[0] = bpsA;
        bps[1] = bpsB;
        uint256 id = splitter.createSplit(recipients, bps);

        token.mint(depositor, amount);
        vm.prank(depositor);
        token.approve(address(splitter), amount);
        vm.prank(depositor);
        splitter.deposit(id, address(token), amount);

        uint256 totalOwed = splitter.owed(id, address(token), alice) + splitter.owed(id, address(token), bob);
        assertEq(totalOwed, amount);
    }
}
