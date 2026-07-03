// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RevenueSplitter} from "../../src/RevenueSplitter.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Reenters withdraw() on a SECOND split (`otherSplitId`) where this same attacker
/// contract is also a recipient with a still-nonzero `owed` balance at reentry time.
/// The attacker's balance on the FIRST split (the one being withdrawn in the outer
/// call) was already zeroed by CEI before this callback fires, so reentering on that
/// same split would revert with NothingOwed regardless of the nonReentrant guard and
/// would not isolate the guard's effect. Reentering on the second split means the
/// ONLY thing that can block the nested call is the guard (shared across all splits,
/// since `nonReentrant`'s lock is per-contract, not per-split) — without it, the call
/// would succeed and pay out the second split's balance from inside the first
/// withdrawal's execution, which is exactly the class of bug the guard exists to stop.
contract MaliciousReentrantToken is MockUSDC {
    RevenueSplitter public target;
    uint256 public otherSplitId;
    bool public attacked;
    bytes public lastRevertData;

    function setAttack(RevenueSplitter _target, uint256 _otherSplitId) external {
        target = _target;
        otherSplitId = _otherSplitId;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        if (!attacked && address(target) != address(0)) {
            attacked = true;
            // Low-level call so the inner revert is contained here instead of
            // propagating out and reverting the outer legitimate withdraw() —
            // mirrors how a real attacker contract would swallow the failure and
            // continue. The revert data is captured so the test can assert it is
            // specifically ReentrancyGuardReentrantCall, not some other failure mode.
            (bool reentered, bytes memory data) =
                address(target).call(abi.encodeCall(RevenueSplitter.withdraw, (otherSplitId, address(this))));
            if (!reentered) lastRevertData = data;
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
        evilToken.mint(depositor, 2_000_000);
        vm.prank(depositor);
        evilToken.approve(address(splitter), type(uint256).max);

        // Split A: the one being withdrawn in the outer call. Its owed balance for
        // evilToken is zeroed by CEI before the reentrant callback fires.
        address[] memory recipientsA = new address[](1);
        recipientsA[0] = address(evilToken);
        uint32[] memory bpsA = new uint32[](1);
        bpsA[0] = 10_000;
        uint256 splitA = splitter.createSplit(recipientsA, bpsA);

        // Split B: a second, independent split where evilToken is also a recipient
        // with a still-nonzero owed balance at reentry time. Only the nonReentrant
        // guard (shared per-contract, not per-split) can block withdrawing this.
        address[] memory recipientsB = new address[](1);
        recipientsB[0] = address(evilToken);
        uint32[] memory bpsB = new uint32[](1);
        bpsB[0] = 10_000;
        uint256 splitB = splitter.createSplit(recipientsB, bpsB);

        evilToken.setAttack(splitter, splitB);

        vm.prank(depositor);
        splitter.deposit(splitA, address(evilToken), 1_000_000);
        vm.prank(depositor);
        splitter.deposit(splitB, address(evilToken), 1_000_000);

        vm.prank(address(evilToken));
        splitter.withdraw(splitA, address(evilToken)); // triggers reentrant withdraw(splitB, ...) inside transfer()

        // The reentrant call must have been blocked specifically by the guard: split B's
        // owed balance was untouched by CEI at reentry time, so only nonReentrant could
        // have stopped it. Assert the exact revert reason, not just an outcome that CEI
        // could produce on its own.
        assertEq(bytes4(evilToken.lastRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

        // Outer withdrawal (split A) still completed exactly once; split B's balance
        // remains fully owed, proving the reentrant attempt paid out nothing.
        assertEq(evilToken.balanceOf(address(evilToken)), 1_000_000);
        assertEq(splitter.owed(splitB, address(evilToken), address(evilToken)), 1_000_000);
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
