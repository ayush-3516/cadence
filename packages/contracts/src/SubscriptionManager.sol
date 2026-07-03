// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISubscriptionManager} from "./interfaces/ISubscriptionManager.sol";
import {IFeeRegistry} from "./interfaces/IFeeRegistry.sol";

contract SubscriptionManager is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuard,
    PausableUpgradeable,
    ISubscriptionManager
{
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    uint16 public constant MAX_FEE_BPS = 1000;

    mapping(uint256 => Plan) public plans;
    mapping(uint256 => Subscription) public subscriptions;
    mapping(address => bool) public supportedToken;
    mapping(bytes32 => uint256) public activeSubOf;

    uint256 public nextPlanId;
    uint256 public nextSubId;
    address public treasury;
    IFeeRegistry public feeRegistry;

    uint256[45] private __gap;

    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address treasury_, address feeRegistry_, address[] calldata tokens_)
        external
        initializer
    {
        __AccessControl_init();
        __Pausable_init();
        if (admin == address(0) || treasury_ == address(0) || feeRegistry_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        treasury = treasury_;
        feeRegistry = IFeeRegistry(feeRegistry_);
        for (uint256 i; i < tokens_.length; ++i) {
            supportedToken[tokens_[i]] = true;
            emit SupportedTokenSet(tokens_[i], true);
        }
        nextPlanId = 1;
        nextSubId = 1;
    }

    // --- merchant ---

    function createPlan(address payoutSplit, address token, uint256 amount, uint40 period, uint40 trialPeriod)
        external
        returns (uint256 planId)
    {
        if (payoutSplit == address(0)) revert ZeroAddress();
        if (!supportedToken[token]) revert TokenNotSupported();
        if (amount == 0) revert InvalidAmount();
        if (period == 0) revert InvalidPeriod();

        planId = nextPlanId++;
        plans[planId] = Plan({
            merchant: msg.sender,
            payoutSplit: payoutSplit,
            token: token,
            amount: amount,
            period: period,
            trialPeriod: trialPeriod,
            active: true
        });

        emit PlanCreated(planId, msg.sender, payoutSplit, token, amount, period, trialPeriod);
    }

    function setPlanActive(uint256 planId, bool active) external {
        Plan storage p = plans[planId];
        if (p.merchant == address(0)) revert PlanNotFound();
        if (p.merchant != msg.sender) revert NotMerchant();
        p.active = active;
        emit PlanStatusChanged(planId, active);
    }

    // --- subscriber ---

    function subscribe(uint256 planId) external nonReentrant whenNotPaused returns (uint256 subId) {
        subId = _openSubscription(planId, msg.sender);
    }

    function subscribeWithPermit(
        uint256 planId,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256 subId) {
        Plan storage p = plans[planId];
        if (p.merchant == address(0)) revert PlanNotFound();
        IERC20Permit(p.token).permit(msg.sender, address(this), value, deadline, v, r, s);
        subId = _openSubscription(planId, msg.sender);
    }

    function _openSubscription(uint256 planId, address subscriberAddr) internal returns (uint256 subId) {
        Plan storage p = plans[planId];
        if (p.merchant == address(0)) revert PlanNotFound();
        if (!p.active) revert PlanInactive();

        bytes32 key = keccak256(abi.encode(subscriberAddr, planId));
        uint256 existing = activeSubOf[key];
        if (existing != 0 && subscriptions[existing].status != Status.Canceled) revert AlreadyActive();

        subId = nextSubId++;
        activeSubOf[key] = subId;

        if (p.trialPeriod > 0) {
            subscriptions[subId] = Subscription({
                planId: planId,
                subscriber: subscriberAddr,
                status: Status.Trialing,
                currentPeriodEnd: uint40(block.timestamp) + p.trialPeriod,
                pausedRemaining: 0,
                canceledAt: 0,
                pendingCancel: false
            });
            emit Subscribed(subId, planId, subscriberAddr, subscriptions[subId].currentPeriodEnd, true);
        } else {
            subscriptions[subId] = Subscription({
                planId: planId,
                subscriber: subscriberAddr,
                status: Status.Active,
                currentPeriodEnd: 0,
                pausedRemaining: 0,
                canceledAt: 0,
                pendingCancel: false
            });
            emit Subscribed(subId, planId, subscriberAddr, uint40(block.timestamp) + p.period, false);
            bool ok = _charge(subId);
            if (!ok) revert TransferFailed();
        }
    }

    function _charge(uint256 subId) internal returns (bool success) {
        Subscription storage s = subscriptions[subId];
        Plan storage p = plans[s.planId];

        uint16 bps = feeRegistry.getFeeBps(p.merchant);
        if (bps > MAX_FEE_BPS) bps = MAX_FEE_BPS;
        uint256 fee = (p.amount * bps) / 10_000;
        uint256 net = p.amount - fee;

        IERC20 tok = IERC20(p.token);
        if (tok.balanceOf(s.subscriber) < p.amount || tok.allowance(s.subscriber, address(this)) < p.amount) {
            s.status = Status.PastDue;
            emit ChargeFailed(subId, tok.balanceOf(s.subscriber) < p.amount ? 1 : 2);
            emit StatusChanged(subId, Status.PastDue);
            return false;
        }

        tok.safeTransferFrom(s.subscriber, address(this), p.amount);
        tok.safeTransfer(treasury, fee);
        tok.safeTransfer(p.payoutSplit, net);

        uint40 base = s.currentPeriodEnd > uint40(block.timestamp) ? s.currentPeriodEnd : uint40(block.timestamp);
        s.currentPeriodEnd = base + p.period;
        s.status = Status.Active;

        emit Charged(subId, s.planId, p.amount, fee, net, s.currentPeriodEnd);
        return true;
    }

    function cancel(uint256 subId, bool immediate) external {
        Subscription storage s = subscriptions[subId];
        if (s.subscriber == address(0)) revert SubNotFound();
        if (s.subscriber != msg.sender) revert NotSubscriber();
        if (
            s.status != Status.Trialing && s.status != Status.Active && s.status != Status.PastDue
                && s.status != Status.Paused
        ) revert InvalidStatus();

        if (immediate) {
            s.status = Status.Canceled;
            s.canceledAt = uint40(block.timestamp);
            delete activeSubOf[keccak256(abi.encode(s.subscriber, s.planId))];
            emit Canceled(subId);
            emit StatusChanged(subId, Status.Canceled);
        } else {
            s.pendingCancel = true;
            s.canceledAt = uint40(block.timestamp);
            emit CancelScheduled(subId, s.currentPeriodEnd);
        }
    }

    function pauseSubscription(uint256 subId) external {
        Subscription storage s = subscriptions[subId];
        if (s.subscriber == address(0)) revert SubNotFound();
        if (s.subscriber != msg.sender) revert NotSubscriber();
        if (s.status != Status.Active) revert InvalidStatus();

        s.pausedRemaining = s.currentPeriodEnd > uint40(block.timestamp) ? s.currentPeriodEnd - uint40(block.timestamp) : 0;
        s.status = Status.Paused;
        emit Paused(subId, s.pausedRemaining);
    }

    function resumeSubscription(uint256 subId) external {
        Subscription storage s = subscriptions[subId];
        if (s.subscriber == address(0)) revert SubNotFound();
        if (s.subscriber != msg.sender) revert NotSubscriber();
        if (s.status != Status.Paused) revert InvalidStatus();

        s.currentPeriodEnd = uint40(block.timestamp) + s.pausedRemaining;
        s.pausedRemaining = 0;
        s.status = Status.Active;
        emit Resumed(subId, s.currentPeriodEnd);
    }

    // --- charging ---

    function charge(uint256 subId) external nonReentrant whenNotPaused {
        Subscription storage s = subscriptions[subId];
        if (s.subscriber == address(0)) revert SubNotFound();
        if (
            s.status != Status.Trialing && s.status != Status.Active && s.status != Status.PastDue
        ) revert InvalidStatus();
        if (block.timestamp < s.currentPeriodEnd) revert NotDue();

        if (s.pendingCancel && block.timestamp >= s.currentPeriodEnd) {
            s.status = Status.Canceled;
            s.canceledAt = uint40(block.timestamp);
            delete activeSubOf[keccak256(abi.encode(s.subscriber, s.planId))];
            emit Canceled(subId);
            return;
        }

        _charge(subId);
    }

    function chargeBatch(uint256[] calldata subIds) external nonReentrant whenNotPaused {
        for (uint256 i; i < subIds.length; ++i) {
            uint256 subId = subIds[i];
            Subscription storage s = subscriptions[subId];
            if (s.subscriber == address(0)) continue;
            if (s.status != Status.Trialing && s.status != Status.Active && s.status != Status.PastDue) continue;
            if (block.timestamp < s.currentPeriodEnd) continue;

            if (s.pendingCancel && block.timestamp >= s.currentPeriodEnd) {
                s.status = Status.Canceled;
                s.canceledAt = uint40(block.timestamp);
                delete activeSubOf[keccak256(abi.encode(s.subscriber, s.planId))];
                emit Canceled(subId);
                continue;
            }

            _charge(subId);
        }
    }

    // --- admin ---

    function setSupportedToken(address token, bool supported) external onlyRole(DEFAULT_ADMIN_ROLE) {
        supportedToken[token] = supported;
        emit SupportedTokenSet(token, supported);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setFeeRegistry(address feeRegistry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeRegistry_ == address(0)) revert ZeroAddress();
        feeRegistry = IFeeRegistry(feeRegistry_);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // --- views ---

    function getPlan(uint256 planId) external view returns (Plan memory) {
        return plans[planId];
    }

    function getSubscription(uint256 subId) external view returns (Subscription memory) {
        return subscriptions[subId];
    }

    function isActive(uint256 subId) external view returns (bool) {
        Subscription storage s = subscriptions[subId];
        if (s.status == Status.Active || s.status == Status.Trialing) return true;
        if (s.pendingCancel && block.timestamp < s.currentPeriodEnd) return true;
        return false;
    }

    function isDue(uint256 subId) external view returns (bool) {
        Subscription storage s = subscriptions[subId];
        bool chargeable = s.status == Status.Trialing || s.status == Status.Active || s.status == Status.PastDue;
        return chargeable && block.timestamp >= s.currentPeriodEnd;
    }

    function nextChargeTime(uint256 subId) external view returns (uint40) {
        return subscriptions[subId].currentPeriodEnd;
    }

    function isSupportedToken(address token) external view returns (bool) {
        return supportedToken[token];
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
