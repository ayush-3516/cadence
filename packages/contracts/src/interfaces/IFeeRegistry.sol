// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFeeRegistry {
    function getFeeBps(address merchant) external view returns (uint16);
    function defaultFeeBps() external view returns (uint16);
}
