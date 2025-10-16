// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IxAnonStakingNFT (stake-days variant)
interface IxAnonStakingNFT {
    /// @dev Storage/view struct for xAnonStakingNFT positions (stake-days model)
    /// @dev Storage packing: 2 slots instead of 5 (saves ~42K gas on mint, ~15K on burn)
    /// Slot 0: amount(12) + poolId(1) + lockedUntil(8) + lastPaidDay(8) + padding(3) = 32 bytes
    /// Slot 1: accruedRewards(32) = 32 bytes
    struct PositionData {
        uint96 amount; // 12 bytes - max 79,228,162,514 tokens (79B with 18 decimals)
        uint8 poolId; // 1 byte  - max 255 pools (current max is 10)
        uint64 lockedUntil; // 8 bytes - timestamps until year 584,942,417,355
        uint64 lastPaidDay; // 8 bytes - day index until year 584,942,417,355
        uint256 accruedRewards; // 32 bytes - no limit for accumulated rewards
    }

    event Mint(
        address indexed user,
        uint256 indexed tokenId,
        uint256 amount,
        uint256 lockedUntil
    );
    event Burn(
        address indexed caller,
        address indexed to,
        uint256 indexed tokenId,
        uint256 amount
    );
    event EarnReward(
        address indexed caller,
        address indexed to,
        uint256 indexed tokenId,
        uint256 reward
    );
    event TopUp(address indexed caller, uint256 indexed poolId, uint256 amount);
    event PoolAdded(uint256 indexed pid, uint16 allocPoint, uint256 lockDays);

    /// @notice Mint a position and stake tokens into a pool
    /// @param amount Staked amount
    /// @param pid Pool id (0=short,1=medium,2=long)
    /// @return tokenId Newly minted position id
    function mint(
        uint256 amount,
        uint256 pid
    ) external returns (uint256 tokenId);

    /// @notice Burn an unlocked position and withdraw principal
    /// @param to Recipient of returned principal
    /// @param tokenId Position id
    /// @return amount Returned principal amount
    function burn(
        address to,
        uint256 tokenId
    ) external returns (uint256 amount);

    /// @notice Claim rewards for a position
    /// @param to Recipient of rewards
    /// @param tokenId Position id
    /// @return reward Amount paid
    function earnReward(
        address to,
        uint256 tokenId
    ) external returns (uint256 reward);

    /// @notice View pending rewards for a position if claimed now
    /// @param tokenId Position id
    /// @return pending Estimated rewards
    function pendingRewards(
        uint256 tokenId
    ) external view returns (uint256 pending);

    /// @notice Add rewards split by fixed 20/30/50 across pools
    /// @param amount Total reward to add
    function topUp(uint256 amount) external returns (bool);

    /// @notice View subset of pool state
    /// @param pid Pool id
    /// @return allocPoint Pool allocation points
    /// @return lockDays Ring buffer size in days
    /// @return rollingActiveStake Active stake in the window
    /// @return lastUpdatedDay Last rolled day
    /// @return snapshotsCount Number of reward snapshots
    function poolInfo(
        uint256 pid
    )
        external
        view
        returns (
            uint16 allocPoint,
            uint256 lockDays,
            uint256 rollingActiveStake,
            uint256 lastUpdatedDay,
            uint256 snapshotsCount
        );

    /// @notice Pause/unpause earning
    function pause() external;

    function unpause() external;

    /// @notice Rescue ERC20 tokens from the contract
    /// @param token ERC20 token address
    /// @param to Recipient
    /// @param amount Amount to transfer
    function rescueTokens(
        address token,
        address to,
        uint256 amount
    ) external returns (bool);

    /// @notice Get stored position data
    /// @param tokenId Position id
    /// @return position StakingPosition view struct
    function positionOf(
        uint256 tokenId
    ) external view returns (PositionData memory position);

    /// @notice Get a specific reward snapshot for a pool
    /// @param pid Pool id
    /// @param index Snapshot index
    /// @return day Snapshot end day (exclusive)
    /// @return perDayRate Reward per token-day (PRECISION)
    function getPoolSnapshot(
        uint256 pid,
        uint256 index
    ) external view returns (uint256 day, uint256 perDayRate);

    /// @notice Get a range of snapshots for pagination
    /// @param pid Pool id
    /// @param offset Start index
    /// @param limit Max number of snapshots
    /// @return endDays Array of end days
    /// @return rates Array of per-day rates
    function getPoolSnapshots(
        uint256 pid,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory endDays, uint256[] memory rates);
}
