// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Portfolio showcase module — a from-scratch, pull-based revenue
/// splitter. NOT used by SubscriptionManager in production; production
/// routes net proceeds to an external 0xSplits Split address instead.
/// This exists to demonstrate Solidity depth (see README).
contract RevenueSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Split {
        address[] recipients;
        uint32[] bps;
    }

    mapping(uint256 => Split) internal splits;
    mapping(uint256 => mapping(address => mapping(address => uint256))) public owed; // splitId => token => recipient => amount
    uint256 public nextSplitId = 1;

    event SplitCreated(uint256 indexed id, address[] recipients, uint32[] bps);
    event Deposited(uint256 indexed id, address indexed token, uint256 amount);
    event Withdrawn(uint256 indexed id, address indexed token, address indexed recipient, uint256 amount);

    error LengthMismatch();
    error InvalidBps();
    error ZeroRecipient();
    error DuplicateRecipient();
    error SplitNotFound();
    error NothingOwed();

    function createSplit(address[] calldata recipients, uint32[] calldata bps) external returns (uint256 id) {
        if (recipients.length != bps.length || recipients.length == 0) revert LengthMismatch();

        uint32 total;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert ZeroRecipient();
            for (uint256 j; j < i; ++j) {
                if (recipients[j] == recipients[i]) revert DuplicateRecipient();
            }
            total += bps[i];
        }
        if (total != 10_000) revert InvalidBps();

        id = nextSplitId++;
        splits[id] = Split({recipients: recipients, bps: bps});
        emit SplitCreated(id, recipients, bps);
    }

    function getSplit(uint256 id) external view returns (address[] memory recipients, uint32[] memory bps) {
        Split storage sp = splits[id];
        if (sp.recipients.length == 0) revert SplitNotFound();
        return (sp.recipients, sp.bps);
    }

    function deposit(uint256 id, address token, uint256 amount) external nonReentrant {
        Split storage sp = splits[id];
        if (sp.recipients.length == 0) revert SplitNotFound();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        uint256 allocated;
        for (uint256 i; i < sp.recipients.length; ++i) {
            uint256 share = (amount * sp.bps[i]) / 10_000;
            owed[id][token][sp.recipients[i]] += share;
            allocated += share;
        }
        uint256 remainder = amount - allocated;
        if (remainder > 0) {
            owed[id][token][sp.recipients[0]] += remainder;
        }

        emit Deposited(id, token, amount);
    }

    function withdraw(uint256 id, address token) external nonReentrant {
        uint256 amount = owed[id][token][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[id][token][msg.sender] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(id, token, msg.sender, amount);
    }
}
