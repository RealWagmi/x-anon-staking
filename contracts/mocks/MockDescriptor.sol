// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import { INonfungibleTokenPositionDescriptor } from "../interfaces/INonfungibleTokenPositionDescriptor.sol";
import { IxAnonStakingNFT } from "../interfaces/IxAnonStakingNFT.sol";

contract MockDescriptor is INonfungibleTokenPositionDescriptor {
    function tokenURI(
        IxAnonStakingNFT /*anonStaking*/,
        uint256 /*tokenId*/
    ) external pure returns (string memory) {
        return "ipfs://mock";
    }
}
