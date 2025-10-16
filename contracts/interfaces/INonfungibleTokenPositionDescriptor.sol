// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./IxAnonStakingNFT.sol";

/// @title Describes position NFT tokens via URI
interface INonfungibleTokenPositionDescriptor {
    /// @notice Produces the URI describing a particular token ID for a anon staking
    /// @dev Note this URI may be a data: URI with the JSON contents directly inlined
    /// @param anonStaking The position manager for which to describe the token
    /// @param tokenId The ID of the token for which to produce a description, which may not be valid
    /// @return The URI of the ERC721-compliant metadata
    function tokenURI(
        IxAnonStakingNFT anonStaking,
        uint256 tokenId
    ) external view returns (string memory);
}
