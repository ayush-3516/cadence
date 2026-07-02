// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {FeeRegistry} from "../src/FeeRegistry.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {Config} from "./Config.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        vm.startBroadcast(deployerPk);

        // 1. Timelock: 48h delay, deployer is proposer+executor+canceller for Phase 0.
        address[] memory proposers = new address[](1);
        proposers[0] = deployer;
        address[] memory executors = new address[](1);
        executors[0] = deployer;
        TimelockController timelock = new TimelockController(Config.TIMELOCK_MIN_DELAY, proposers, executors, deployer);

        // 2. FeeRegistry proxy — deployer is temporary admin so it can wire things up.
        FeeRegistry feeImpl = new FeeRegistry();
        FeeRegistry feeRegistry = FeeRegistry(
            address(new ERC1967Proxy(address(feeImpl), abi.encodeCall(FeeRegistry.initialize, (deployer, Config.DEFAULT_FEE_BPS))))
        );

        // 3. SubscriptionManager proxy — treasury = deployer EOA placeholder for Phase 0.
        address[] memory tokens = new address[](1);
        tokens[0] = Config.BASE_SEPOLIA_USDC;
        SubscriptionManager mgrImpl = new SubscriptionManager();
        SubscriptionManager manager = SubscriptionManager(
            address(
                new ERC1967Proxy(
                    address(mgrImpl),
                    abi.encodeCall(SubscriptionManager.initialize, (deployer, deployer, address(feeRegistry), tokens))
                )
            )
        );

        // 4. Transfer roles to Timelock, then deployer renounces.
        {
            bytes32 defaultAdminRole = feeRegistry.DEFAULT_ADMIN_ROLE();
            bytes32 feeUpgraderRole = feeRegistry.UPGRADER_ROLE();
            feeRegistry.grantRole(defaultAdminRole, address(timelock));
            feeRegistry.grantRole(feeUpgraderRole, address(timelock));
            feeRegistry.renounceRole(feeUpgraderRole, deployer);
            feeRegistry.renounceRole(defaultAdminRole, deployer);
        }

        {
            bytes32 mgrAdminRole = manager.DEFAULT_ADMIN_ROLE();
            bytes32 mgrUpgraderRole = manager.UPGRADER_ROLE();
            bytes32 mgrPauserRole = manager.PAUSER_ROLE();
            manager.grantRole(mgrAdminRole, address(timelock));
            manager.grantRole(mgrUpgraderRole, address(timelock));
            manager.grantRole(mgrPauserRole, address(timelock));
            manager.renounceRole(mgrPauserRole, deployer);
            manager.renounceRole(mgrUpgraderRole, deployer);
            manager.renounceRole(mgrAdminRole, deployer);
        }

        vm.stopBroadcast();

        console2.log("Timelock:", address(timelock));
        console2.log("FeeRegistry (proxy):", address(feeRegistry));
        console2.log("FeeRegistry (impl):", address(feeImpl));
        console2.log("SubscriptionManager (proxy):", address(manager));
        console2.log("SubscriptionManager (impl):", address(mgrImpl));

        _writeDeploymentJson(deployer, address(timelock), address(feeRegistry), address(feeImpl), address(manager), address(mgrImpl));
    }

    function _writeDeploymentJson(
        address deployer,
        address timelock,
        address feeRegistry,
        address feeImpl,
        address manager,
        address mgrImpl
    ) private {
        string memory json = string.concat(
            "{",
            '"chainId":84532,',
            '"timelock":"', vm.toString(timelock), '",',
            '"feeRegistry":"', vm.toString(feeRegistry), '",',
            '"feeRegistryImpl":"', vm.toString(feeImpl), '",',
            '"subscriptionManager":"', vm.toString(manager), '",',
            '"subscriptionManagerImpl":"', vm.toString(mgrImpl), '",',
            '"usdc":"', vm.toString(Config.BASE_SEPOLIA_USDC), '",',
            '"treasury":"', vm.toString(deployer), '"',
            "}"
        );
        vm.writeFile("../../deployments/84532.json", json);
    }
}
