// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IFeeRegistry} from "./interfaces/IFeeRegistry.sol";

contract FeeRegistry is Initializable, UUPSUpgradeable, AccessControlUpgradeable, IFeeRegistry {
    struct Override {
        bool set;
        uint16 bps;
    }

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    uint16 public constant MAX_FEE_BPS = 1000;

    uint16 public defaultFeeBps;
    mapping(address => Override) public merchantFee;

    uint256[45] private __gap;

    error FeeTooHigh();

    event DefaultFeeUpdated(uint16 bps);
    event MerchantFeeUpdated(address indexed merchant, uint16 bps, bool set);

    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, uint16 defaultFeeBps_) external initializer {
        __AccessControl_init();
        if (defaultFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        defaultFeeBps = defaultFeeBps_;
    }

    function getFeeBps(address merchant) external view returns (uint16) {
        Override memory o = merchantFee[merchant];
        uint16 bps = o.set ? o.bps : defaultFeeBps;
        return bps > MAX_FEE_BPS ? MAX_FEE_BPS : bps;
    }

    function setDefaultFeeBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        defaultFeeBps = bps;
        emit DefaultFeeUpdated(bps);
    }

    function setMerchantFee(address merchant, uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        merchantFee[merchant] = Override(true, bps);
        emit MerchantFeeUpdated(merchant, bps, true);
    }

    function clearMerchantFee(address merchant) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete merchantFee[merchant];
        emit MerchantFeeUpdated(merchant, 0, false);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
