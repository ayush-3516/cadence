// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISubscriptionManager {
    enum Status {
        None,
        Trialing,
        Active,
        PastDue,
        Paused,
        Canceled
    }

    struct Plan {
        address merchant;
        address payoutSplit;
        address token;
        uint256 amount;
        uint40 period;
        uint40 trialPeriod;
        bool active;
    }

    struct Subscription {
        uint256 planId;
        address subscriber;
        Status status;
        uint40 currentPeriodEnd;
        uint40 pausedRemaining;
        uint40 canceledAt;
        bool pendingCancel;
    }

    // --- merchant ---
    function createPlan(address payoutSplit, address token, uint256 amount, uint40 period, uint40 trialPeriod)
        external
        returns (uint256 planId);
    function setPlanActive(uint256 planId, bool active) external;

    // --- subscriber ---
    function subscribe(uint256 planId) external returns (uint256 subId);
    function subscribeWithPermit(uint256 planId, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256 subId);
    function cancel(uint256 subId, bool immediate) external;
    function pauseSubscription(uint256 subId) external;
    function resumeSubscription(uint256 subId) external;

    // --- charging (permissionless) ---
    function charge(uint256 subId) external;
    function chargeBatch(uint256[] calldata subIds) external;

    // --- admin ---
    function setSupportedToken(address token, bool supported) external;
    function setTreasury(address treasury) external;
    function setFeeRegistry(address feeRegistry) external;
    function pause() external;
    function unpause() external;

    // --- views ---
    function getPlan(uint256 planId) external view returns (Plan memory);
    function getSubscription(uint256 subId) external view returns (Subscription memory);
    function isActive(uint256 subId) external view returns (bool);
    function isDue(uint256 subId) external view returns (bool);
    function nextChargeTime(uint256 subId) external view returns (uint40);
    function isSupportedToken(address token) external view returns (bool);

    // --- events ---
    event PlanCreated(
        uint256 indexed planId,
        address indexed merchant,
        address payoutSplit,
        address token,
        uint256 amount,
        uint40 period,
        uint40 trialPeriod
    );
    event PlanStatusChanged(uint256 indexed planId, bool active);
    event Subscribed(
        uint256 indexed subId,
        uint256 indexed planId,
        address indexed subscriber,
        uint40 currentPeriodEnd,
        bool trialing
    );
    event Charged(
        uint256 indexed subId,
        uint256 indexed planId,
        uint256 amount,
        uint256 platformFee,
        uint256 net,
        uint40 newPeriodEnd
    );
    event ChargeFailed(uint256 indexed subId, uint8 reason);
    event StatusChanged(uint256 indexed subId, Status status);
    event Paused(uint256 indexed subId, uint40 remaining);
    event Resumed(uint256 indexed subId, uint40 newPeriodEnd);
    event CancelScheduled(uint256 indexed subId, uint40 effectiveAt);
    event Canceled(uint256 indexed subId);
    event TreasuryUpdated(address treasury);
    event SupportedTokenSet(address token, bool supported);

    // --- errors ---
    error ZeroAddress();
    error NotMerchant();
    error NotSubscriber();
    error PlanNotFound();
    error PlanInactive();
    error SubNotFound();
    error InvalidStatus();
    error NotDue();
    error AlreadyActive();
    error TokenNotSupported();
    error InvalidPeriod();
    error InvalidAmount();
    error TransferFailed();
    error FeeTooHigh();
    error ContractPaused();
}
