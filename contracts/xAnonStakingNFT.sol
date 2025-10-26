// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import {
    ERC721Enumerable,
    ERC721
} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IxAnonStakingNFT } from "./interfaces/IxAnonStakingNFT.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { INonfungibleTokenPositionDescriptor } from "./interfaces/INonfungibleTokenPositionDescriptor.sol";

// import "hardhat/console.sol";

// Custom errors for gas optimization
error InvalidTokenAddress();
error InvalidDescriptorAddress();
error AmountTooSmall();
error AmountExceedsMaximum();
error InvalidPoolId();
error ZeroAddress();
error TokenDoesNotExist();
error NotAuthorized();
error PositionLocked();
error NoRewards();
error TopUpTooFrequent();
error CannotRescueAnonToken();
error InsufficientPrincipal();
error NoActiveStake();

/// @title xAnonStakingNFT - Time-Weighted Staking with NFT Positions
/// @notice NFT-based staking system with three fixed pools and time-weighted rewards
/// @dev Key Features:
///      - Three fixed pools with different lock periods (91/182/365 days) and allocations (20%/30%/50%)
///      - Empty Pool Redistribution: rewards from empty pools automatically go to active pools
///      - Per-pool topUp frequency control (minimum 2 days between topUps per pool)
///      - Ring buffer for O(1) expiration tracking
///      - Principal protection: contract balance >= totalStaked
contract xAnonStakingNFT is ERC721Enumerable, IxAnonStakingNFT, Ownable, Pausable, ReentrancyGuard {
    uint256 private constant PRECISION = 1e18;
    uint256 private constant MAX_DAILY_ROLL = 1000; // Max days to process day-by-day (gas protection)
    uint256 public constant MIN_AMOUNT = 1 ether; // Minimum topUp to prevent DoS (1 ANON tokens)

    // Fixed pool configuration (3 pools only, immutable)
    uint256 private constant POOL_COUNT = 3;
    uint256 private constant TOTAL_ALLOC_POINT = 10000; // 100% = 10000 basis points (for reference)

    // Pool 0: Short (91 days, 20% allocation)
    // Allocation: 2000/10000 = 20% when all pools active
    // With empty pool redistribution: gets larger share if other pools empty
    uint16 private constant POOL0_ALLOC = 2000;
    uint256 private constant POOL0_LOCK_DAYS = 91;

    // Pool 1: Medium (182 days, 30% allocation)
    uint16 private constant POOL1_ALLOC = 3000;
    uint256 private constant POOL1_LOCK_DAYS = 182;

    // Pool 2: Long (365 days, 50% allocation)
    uint16 private constant POOL2_ALLOC = 5000;
    uint256 private constant POOL2_LOCK_DAYS = 365;

    /// @dev Snapshot representing a reward interval boundary
    /// @param day Unix day marking the END of this interval (exclusive upper bound)
    /// @param perDayRate Reward per token-day in this interval (scaled by PRECISION = 1e18)
    ///        Formula: perDayRate = totalRewards * PRECISION / totalStakeDays
    struct RewardSnapshot {
        uint256 day;
        uint256 perDayRate;
    }

    /// @dev Per-pool state and configuration
    /// @notice Each pool tracks active stakes, expirations, and reward distribution independently
    struct Pool {
        /// @notice Allocation points (immutable): 2000/3000/5000 for 20%/30%/50% split
        /// @dev Used for proportional reward distribution among active pools only (empty pools skipped)
        uint16 allocPoint;
        /// @notice Lock period in days (immutable): 91/182/365
        uint256 lockDays;
        /// @notice Current active stake within the rolling window
        /// @dev Updated on mint and during ring buffer rolls when positions expire
        uint256 rollingActiveStake;
        /// @notice Last day when ring buffer and stake-days were updated
        uint256 lastUpdatedDay;
        /// @notice Last day when this pool was included in topUp distribution
        /// @dev Per-pool topUp frequency control: prevents topUp more frequently than once per 2 days
        ///      This is checked individually per pool (not global), allowing different pools to topUp independently
        uint256 lastTopUpDay;
        /// @dev Ring buffer for tracking daily deposits: dayBuckets[day % lockDays] = amount
        ///      Enables O(1) expiration of old stakes
        mapping(uint256 => uint256) dayBuckets;
        /// @notice Total stake-days accumulated since last topUp
        /// @dev Resets to 0 after each topUp. Increases daily by rollingActiveStake amount.
        ///      Example: 100 tokens active for 5 days = 500 stake-days
        uint256 poolStakeDays;
        /// @notice Array of reward snapshots defining interval boundaries and rates
        /// @dev Each snapshot: (endDay, perDayRate). First snapshot is init with perDayRate=0
        RewardSnapshot[] snapshots;
    }

    address private immutable _tokenDescriptor;
    address public immutable ANON_TOKEN;

    Pool[POOL_COUNT] private _pools;

    /// @dev Storage optimization: packed in single slot (30/32 bytes used)
    uint176 private _nextId = 1; // Next tokenId to mint (22 bytes)

    /// @notice Total principal staked across all positions
    /// @dev Used for principal protection: ensures contract balance >= totalStaked
    ///      Prevents reward calculation bugs from affecting user deposits
    uint256 public totalStaked;

    /// @dev tokenId => position data
    mapping(uint256 => IxAnonStakingNFT.PositionData) private _positions;

    /// @notice Initialize contract with ANON token and descriptor
    /// @dev Creates three immutable pools with fixed allocations (20%/30%/50%)
    ///      Pool parameters cannot be changed after deployment
    /// @param anonToken Address of ANON token contract
    /// @param tokenDescriptor_ Address of NFT metadata descriptor
    constructor(
        address anonToken,
        address tokenDescriptor_
    ) Ownable(msg.sender) ERC721("xAnon Staking NFT", "xAnonS") {
        if (anonToken == address(0)) revert InvalidTokenAddress();
        if (tokenDescriptor_ == address(0)) revert InvalidDescriptorAddress();
        _tokenDescriptor = tokenDescriptor_;
        ANON_TOKEN = anonToken;

        // Initialize three fixed pools (immutable configuration)
        _addPool(0, POOL0_ALLOC, POOL0_LOCK_DAYS); // Pool 0: Short (91 days, 20%)
        _addPool(1, POOL1_ALLOC, POOL1_LOCK_DAYS); // Pool 1: Medium (182 days, 30%)
        _addPool(2, POOL2_ALLOC, POOL2_LOCK_DAYS); // Pool 2: Long (365 days, 50%)
    }

    // ═══════════════════════════════════════════════════════════════
    //                        USER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /// @notice Create a new staking position NFT
    /// @dev Staking process:
    ///      1. Validates amount and pool ID
    ///      2. Updates pool state (_rollPool)
    ///      3. Mints NFT to user
    ///      4. Adds stake to ring buffer at (currentDay - 1) % lockDays
    ///      5. Increases rollingActiveStake
    ///      6. Sets position data with lock expiration
    ///
    ///      Position starts earning rewards from the day AFTER minting (currentDay + 1).
    ///      This prevents same-block mint + topUp exploits.
    ///
    /// @param amount Amount of ANON tokens to stake (minimum: MIN_AMOUNT = 1 ether)
    /// @param pid Pool ID: 0 (91d), 1 (182d), or 2 (365d)
    /// @return tokenId ID of newly minted NFT position
    function mint(
        uint256 amount,
        uint256 pid
    ) external nonReentrant whenNotPaused returns (uint256 tokenId) {
        if (amount < MIN_AMOUNT) revert AmountTooSmall();
        if (amount > type(uint96).max) revert AmountExceedsMaximum();
        if (pid >= POOL_COUNT) revert InvalidPoolId();
        Pool storage pool = _pools[pid];
        _rollPool(pool);
        _safeMint(msg.sender, (tokenId = _nextId++));

        // Initialize lastTopUpDay when pool becomes active (first stake)
        if (pool.rollingActiveStake == 0) {
            pool.lastTopUpDay = _currentDay();
        }

        uint256 dayIdx = (_currentDay() - 1) % pool.lockDays;

        pool.dayBuckets[dayIdx] += amount;
        pool.rollingActiveStake += amount;

        // lockedUntil = start of day (currentDay + lockDays)
        // Tokens expire in ring buffer on this same day (after accumulating stake-days)
        uint256 lockTime = (_currentDay() + pool.lockDays) * 1 days;
        _positions[tokenId] = IxAnonStakingNFT.PositionData({
            amount: uint96(amount),
            poolId: uint8(pid),
            lockedUntil: uint64(lockTime),
            lastPaidDay: uint64(_currentDay())
        });

        totalStaked += amount; // Track total principal
        _safeErc20TransferFrom(ANON_TOKEN, msg.sender, amount);
        emit Mint(msg.sender, tokenId, pid, amount, lockTime);
    }

    /// @notice Burn position NFT and withdraw principal + rewards
    /// @dev Only callable after position unlock. Claims all accumulated rewards first,
    ///      then returns principal. Position is deleted and NFT burned.
    ///      Emits: EarnReward (if rewards > 0), Burn
    /// @param to Recipient address for principal and rewards
    /// @param tokenId Position NFT ID to burn
    /// @return amount Principal amount returned (rewards sent separately)
    function burn(address to, uint256 tokenId) external nonReentrant returns (uint256 amount) {
        return _burnPosition(to, tokenId, true);
    }

    /// @notice Emergency withdraw: retrieve ONLY principal, skip rewards
    /// @dev Safety mechanism if reward calculation is suspected to be broken.
    ///      Only available after position unlock. Does NOT claim any rewards.
    ///      Use burn() for normal withdrawals with rewards.
    /// @param to Recipient address for principal only
    /// @param tokenId Position NFT ID to withdraw
    /// @return amount Principal amount returned (no rewards)
    function emergencyWithdraw(
        address to,
        uint256 tokenId
    ) external nonReentrant returns (uint256 amount) {
        return _burnPosition(to, tokenId, false);
    }

    /// @notice Claim accumulated rewards for a position
    /// @dev Can be called multiple times. Rewards accrue until min(currentDay, unlockDay).
    ///      After unlock, rewards stop accruing but can still be claimed.
    ///      Reverts with NoRewards if nothing to claim.
    /// @param to Recipient address for reward tokens
    /// @param tokenId Position NFT ID to claim rewards from
    /// @return reward Amount of ANON tokens paid as rewards
    function earnReward(
        address to,
        uint256 tokenId
    ) external nonReentrant returns (uint256 reward) {
        _validateTokenOwnership(to, tokenId);

        IxAnonStakingNFT.PositionData storage position = _positions[tokenId];
        Pool storage pool = _pools[position.poolId];

        _rollPool(pool);

        uint256 payout = _collectPositionRewards(pool, position);
        if (payout == 0) revert NoRewards();

        _safeErc20Transfer(ANON_TOKEN, to, payout);

        // CRITICAL: Verify principal protection AFTER reward payout
        _ensurePrincipalProtection();
        emit EarnReward(msg.sender, to, tokenId, position.poolId, payout);

        return payout;
    }

    /// @notice Add rewards to active pools (skips empty pools)
    /// @dev Empty Pool Redistribution Algorithm:
    ///      Distributes rewards ONLY to pools with accumulated stake-days (poolStakeDays > 0).
    ///      Empty pools are skipped, and their allocations are redistributed proportionally among active pools.
    ///
    ///      Example: If pool0 and pool1 are empty, pool2 gets 100% of rewards (not 50%).
    ///
    ///      Distribution Steps:
    ///      1. Update all pools (_rollPool): advance ring buffers, accumulate stake-days
    ///      2. Identify active pools: check poolStakeDays > 0 and lastTopUpDay + 2 days elapsed
    ///      3. Calculate total allocation: sum allocPoints of active pools only
    ///      4. Distribute proportionally: each active pool gets (amount * allocPoint / totalActiveAllocPoint)
    ///      5. Create snapshots: record perDayRate for each active pool
    ///      6. Reset poolStakeDays to 0 for next interval
    ///
    ///      Per-Pool TopUp Frequency:
    ///      - Each pool enforces minimum 2-day gap independently
    ///      - Prevents reward calculation issues from too frequent distributions
    ///      - Allows different pools to receive topUps at different times
    ///
    ///      Restrictions:
    ///      - Minimum amount: MIN_AMOUNT (1 ANON) to prevent DoS
    ///      - Only owner can call
    ///      - At least one pool must have active stakes (reverts NoActiveStake otherwise)
    ///
    /// @param amount Total ANON tokens to add as rewards
    /// @return bool Always returns true on success
    function topUp(uint256 amount) external nonReentrant onlyOwner returns (bool) {
        if (amount < MIN_AMOUNT) revert AmountTooSmall();

        uint256 today = _currentDay();
        _safeErc20TransferFrom(ANON_TOKEN, msg.sender, amount);

        // Step 1: Update all pools and identify active ones
        // Cache allocPoints to avoid repeated storage reads in step 3
        uint256 totalActiveAllocPoint = 0;
        bool[POOL_COUNT] memory isActive;
        uint16[POOL_COUNT] memory allocPoints; // Cache allocPoints from storage
        uint256 lastActivePool; // Track last active pool index for rounding fix

        for (uint256 i = 0; i < POOL_COUNT; i++) {
            Pool storage pool = _pools[i];
            _rollPool(pool);

            // Pool is active if it has stake-days
            if (pool.poolStakeDays > 0) {
                // Prevent topUp more frequently than once per 2 days for each pool
                if (today < pool.lastTopUpDay + 2) revert TopUpTooFrequent();

                isActive[i] = true;
                lastActivePool = i; // Remember last active pool
                allocPoints[i] = pool.allocPoint; // Cache allocPoint
                totalActiveAllocPoint += pool.allocPoint;
            }
        }

        // Step 2: Revert if ALL pools are empty
        if (totalActiveAllocPoint == 0) revert NoActiveStake();

        // Step 3: Distribute rewards only to active pools
        uint256 remaining = amount;

        for (uint256 i = 0; i < POOL_COUNT; i++) {
            if (!isActive[i]) continue; // Skip empty pools

            // Calculate this pool's share from total amount based on active pools
            // Use cached allocPoint instead of reading from storage again
            uint256 part;

            if (i == lastActivePool) {
                // Last active pool gets all remaining (fixes rounding)
                part = remaining;
            } else {
                part = (amount * allocPoints[i]) / totalActiveAllocPoint;
                remaining -= part;
            }

            if (part == 0) continue;

            // Only access storage once per active pool for distribution
            Pool storage pool = _pools[i];

            // Step 4: Create snapshot and update lastTopUpDay
            _distributeRewards(pool, part, today);
            pool.lastTopUpDay = today;

            emit TopUp(msg.sender, i, part);
        }
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    //                        VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /// @notice Get NFT metadata URI
    /// @dev Delegates to external descriptor contract for dynamic metadata generation
    /// @param tokenId Position NFT ID
    /// @return uri Base64-encoded JSON metadata URI
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert TokenDoesNotExist();
        return
            INonfungibleTokenPositionDescriptor(_tokenDescriptor).tokenURI(
                IxAnonStakingNFT(address(this)),
                tokenId
            );
    }

    /// @notice Estimate claimable rewards for a position
    /// @dev Returns approximate value based on last on-chain state.
    ///      Returns 0 for non-existent tokens (does not revert).
    ///
    /// @param tokenId Position NFT ID
    /// @return pending Estimated reward amount
    function pendingRewards(uint256 tokenId) public view returns (uint256 pending) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) return 0;
        IxAnonStakingNFT.PositionData memory position = _positions[tokenId];
        RewardSnapshot[] memory snaps = _pools[position.poolId].snapshots;
        if (snaps.length == 0) return 0;
        uint256 capDay = _getCapDay(position);
        uint256 startDay = position.lastPaidDay;
        if (capDay <= startDay) return 0;
        return _earnedDaysInterval(snaps, startDay, capDay, position.amount);
    }

    /// @notice Get pool configuration and current state
    /// @dev Returns key metrics for UI/analytics. All pools have immutable allocation and lockDays.
    /// @param pid Pool ID (0, 1, or 2)
    /// @return allocPoint Allocation points (2000/3000/5000 for 20%/30%/50%)
    /// @return lockDays Lock period in days (91/182/365)
    /// @return rollingActiveStake Current active stake within rolling window
    /// @return lastUpdatedDay Last day when pool state was updated
    /// @return snapshotsCount Total number of reward snapshots created
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
        )
    {
        Pool storage pool = _pools[pid];
        return (
            pool.allocPoint,
            pool.lockDays,
            pool.rollingActiveStake,
            pool.lastUpdatedDay,
            pool.snapshots.length
        );
    }

    /// @notice Calculate projected Annual Percentage Rate (APR) for a pool
    /// @dev Estimates future APR based on historical reward rates using stake-days model:
    ///
    ///      Algorithm:
    ///      1. Averages perDayRate from last N snapshots (or last snapshot if lookbackPeriod=0)
    ///      2. Simulates staking 1 token for full lockDays period
    ///      3. Calculates reward: token * lockDays * avgPerDayRate / PRECISION
    ///      4. Annualizes: APR = reward * (365 / lockDays) * 100
    ///
    ///      Returns 0 if insufficient data (< 2 snapshots).
    ///
    ///      WARNING: This is a PROJECTION, not a guarantee. Actual APR varies based on:
    ///      - Future topUp frequency and amounts
    ///      - Pool dilution (more stakers = lower APR per staker)
    ///      - Entry timing within reward intervals (earlier = more rewards)
    ///
    /// @param pid Pool ID (0, 1, or 2)
    /// @param lookbackPeriod Number of recent snapshots to average (0 = last only, 10 = last 10)
    /// @return apr Projected APR in basis points (10000 = 100.00%, 2500 = 25.00%)
    /// @return confidence Data quality score (0-10000, higher = more reliable estimate)
    function getPoolAPR(
        uint256 pid,
        uint256 lookbackPeriod
    ) external view returns (uint256 apr, uint256 confidence) {
        Pool storage pool = _pools[pid];
        uint256 snapsLength = pool.snapshots.length;

        // Need at least 2 snapshots (first is init with perDayRate=0)
        if (snapsLength < 2) return (0, 0);

        // Skip init snapshot, start from index 1
        uint256 startIdx = snapsLength > 1 ? 1 : 0;
        uint256 dataPoints = snapsLength - startIdx;

        if (dataPoints == 0) return (0, 0);

        // Determine how many snapshots to use
        uint256 samplesToUse = lookbackPeriod == 0 ? 1 : lookbackPeriod;
        if (samplesToUse > dataPoints) samplesToUse = dataPoints;

        // Calculate average perDayRate from recent snapshots
        uint256 sumRates = 0;
        uint256 countNonZero = 0;
        uint256 startSample = snapsLength - samplesToUse;

        for (uint256 i = startSample; i < snapsLength; i++) {
            uint256 rate = pool.snapshots[i].perDayRate;
            sumRates += rate;
            if (rate > 0) countNonZero++;
        }

        if (sumRates == 0) return (0, 0);

        uint256 avgPerDayRate = sumRates / samplesToUse;

        // Calculate projected rewards for staking 1 token for full lockDays
        // totalStakeDays = 1 token * lockDays
        // reward = totalStakeDays * avgPerDayRate / PRECISION
        // reward = lockDays * avgPerDayRate / PRECISION
        uint256 rewardPerToken = Math.mulDiv(pool.lockDays * avgPerDayRate, 1, PRECISION);

        // APR = (reward / principal) * (365 / lockDays) * 100
        // APR = reward * 365 / lockDays * 100
        // In basis points (10000 = 100%):
        // APR_bp = reward * 365 * 10000 / lockDays
        apr = Math.mulDiv(rewardPerToken * 365, 10000, pool.lockDays);

        // Confidence calculation:
        // - More data points = higher confidence
        // - More non-zero rates = higher confidence
        // - Scale: 0-10000 (10000 = 100% confidence)
        uint256 dataConfidence = samplesToUse >= 10 ? 10000 : (samplesToUse * 10000) / 10;
        uint256 rateConfidence = countNonZero >= samplesToUse
            ? 10000
            : (countNonZero * 10000) / samplesToUse;

        confidence = (dataConfidence + rateConfidence) / 2;
    }

    /// @notice Get a specific reward snapshot for a pool
    /// @param pid Pool id
    /// @param index Snapshot index
    /// @return day Snapshot end day (exclusive)
    /// @return perDayRate Reward per token-day (PRECISION)
    function getPoolSnapshot(
        uint256 pid,
        uint256 index
    ) external view returns (uint256 day, uint256 perDayRate) {
        RewardSnapshot storage s = _pools[pid].snapshots[index];
        return (s.day, s.perDayRate);
    }

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
    ) external view returns (uint256[] memory endDays, uint256[] memory rates) {
        RewardSnapshot[] storage snaps = _pools[pid].snapshots;
        uint256 n = snaps.length;
        if (offset >= n) return (new uint256[](0), new uint256[](0));
        uint256 end = offset + limit;
        if (end > n) end = n;
        uint256 len = end - offset;
        endDays = new uint256[](len);
        rates = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            RewardSnapshot storage s = snaps[offset + i];
            endDays[i] = s.day;
            rates[i] = s.perDayRate;
        }
    }

    /// @notice Get raw position data from storage
    /// @dev Returns zeroed struct for non-existent tokens (does not revert).
    ///      Use ownerOf() or balanceOf() to verify token existence.
    ///
    ///      Returned fields:
    ///      - amount: staked principal
    ///      - poolId: pool index (0/1/2)
    ///      - lockedUntil: unlock timestamp
    ///      - lastPaidDay: last reward claim day
    ///
    /// @param tokenId Position NFT ID
    /// @return position Position data struct
    /// @return pendingRewards Pending rewards
    function positionOf(
        uint256 tokenId
    ) external view returns (IxAnonStakingNFT.PositionData memory, uint256) {
        return (_positions[tokenId], pendingRewards(tokenId));
    }

    // ═══════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /// @notice Pause new staking positions
    /// @dev Prevents mint() calls. Existing positions can still claim rewards and burn.
    ///      Use in emergency situations (e.g., discovered vulnerability).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume normal operations
    /// @dev Re-enables mint() calls after pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Rescue accidentally sent ERC20 tokens
    /// @dev CANNOT rescue ANON token (prevents stealing user deposits).
    ///      Use only for tokens mistakenly sent to contract.
    /// @param token ERC20 token address to rescue
    /// @param to Recipient address
    /// @param amount Amount to transfer
    /// @return bool Always returns true on success
    function rescueTokens(
        address token,
        address to,
        uint256 amount
    ) public onlyOwner returns (bool) {
        if (token == ANON_TOKEN) revert CannotRescueAnonToken();
        _safeErc20Transfer(token, to, amount);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    //                       INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /// @dev Initialize pool at specified index (constructor only)
    /// @param pid Pool index (0, 1, or 2)
    /// @param allocPoint Allocation points (2000/3000/5000)
    /// @param lockDays Lock period in days (91/182/365)
    function _addPool(uint256 pid, uint16 allocPoint, uint256 lockDays) private {
        Pool storage pool = _pools[pid];
        pool.allocPoint = allocPoint;
        pool.lockDays = lockDays;
        pool.lastUpdatedDay = _currentDay();
        pool.snapshots.push(RewardSnapshot({ day: _currentDay(), perDayRate: 0 }));
        emit PoolAdded(pid, allocPoint, lockDays);
    }

    /// @dev Convert current timestamp to unix day
    /// @return uint256 Current day number (block.timestamp / 86400)
    function _currentDay() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @dev Update pool to current day: advance ring buffer and accumulate stake-days
    ///
    ///      This function is called before every state-changing operation to ensure pool data is current.
    ///
    ///      Ring Buffer Mechanics:
    ///      - Tracks deposits by day: dayBuckets[day % lockDays]
    ///      - When advancing to day N, bucket at (N % lockDays) contains deposits that expired on this day
    ///      - Expired amounts are subtracted from rollingActiveStake
    ///      - Enables O(1) expiration without iterating all positions
    ///
    ///      Stake-Days Accumulation:
    ///      - Each day adds rollingActiveStake to poolStakeDays
    ///      - Example: 100 tokens active for 5 days → 500 stake-days
    ///      - Used for fair reward distribution: more stake-days = larger share
    ///
    ///      Gas Optimization for Large Gaps:
    ///      - Small gap (≤1000 days): precise day-by-day iteration
    ///      - Large gap (>1000 days): approximation (accumulate for active period only, then clear buffers)
    ///      - Tests verify no overpayment occurs with approximation
    ///
    /// @param pool Pool storage reference to update
    function _rollPool(Pool storage pool) internal {
        uint256 currDay = _currentDay();
        uint256 lastUpdatedDay = pool.lastUpdatedDay;
        if (currDay <= lastUpdatedDay) return;

        // Cache storage reads
        uint256 activeStake = pool.rollingActiveStake;
        if (activeStake == 0) {
            pool.lastUpdatedDay = currDay;
            return;
        }

        uint256 lockDays = pool.lockDays;
        uint256 gap = currDay - lastUpdatedDay;
        uint256 poolStakeDays = pool.poolStakeDays;

        // Emergency (simplified calculation) for very large gaps (> MAX_DAILY_ROLL)
        if (gap > MAX_DAILY_ROLL) {
            // Accumulate stake-days only for the active period (up to lockDays from last)
            // After lockDays, all positions expired → no more stake-days accrue
            uint256 activeDays = gap < lockDays ? gap : lockDays;
            poolStakeDays += activeStake * activeDays;

            // Clear all expired buckets and update activeStake
            for (uint256 j = 1; j <= lockDays; j++) {
                uint256 idx = (lastUpdatedDay + j) % lockDays;
                uint256 expAmt = pool.dayBuckets[idx];
                if (expAmt > 0) {
                    activeStake -= expAmt;
                    pool.dayBuckets[idx] = 0;
                }
            }

            // Write back all updates at once
            pool.poolStakeDays = poolStakeDays;
            pool.rollingActiveStake = activeStake;
            pool.lastUpdatedDay = currDay;
        } else {
            // Normal case: process day-by-day for accurate stake-days accounting
            // CRITICAL PRINCIPLE: Do NOT include currDay (topUp day excluded from period)
            // Process days from (lastUpdatedDay+1) to (currDay-1) inclusive
            while (lastUpdatedDay < currDay) {
                // Accumulate stake-days for this day
                poolStakeDays += activeStake;
                // Clear expirations for this day
                uint256 idx = lastUpdatedDay % lockDays;
                uint256 expired = pool.dayBuckets[idx];
                if (expired > 0) {
                    activeStake -= expired;
                    pool.dayBuckets[idx] = 0;
                }

                // Increment day first
                lastUpdatedDay++;
            }

            // Set lastUpdatedDay to currDay (but don't process it)
            pool.lastUpdatedDay = currDay;

            // Write back all updates at once
            pool.poolStakeDays = poolStakeDays;
            pool.rollingActiveStake = activeStake;
        }
    }

    /// @dev Common logic for burning a position and transferring principal.
    ///      Validates ownership, lock status, and principal protection.
    ///      Does NOT handle rewards - caller must handle rewards separately.
    /// @param to Recipient of principal
    /// @param tokenId Position id to burn
    /// @param claimRewards Whether to claim rewards
    /// @return amount Principal amount returned
    function _burnPosition(
        address to,
        uint256 tokenId,
        bool claimRewards
    ) internal returns (uint256 amount) {
        _validateTokenOwnership(to, tokenId);
        IxAnonStakingNFT.PositionData storage position = _positions[tokenId];
        if (block.timestamp < position.lockedUntil) revert PositionLocked();
        Pool storage pool = _pools[position.poolId];
        _rollPool(pool);

        amount = position.amount;
        totalStaked -= amount; // Decrease total principal

        if (claimRewards) {
            // Pay any pending rewards up to cap day (lockedUntil)
            uint256 payout = _collectPositionRewards(pool, position);

            if (payout > 0) {
                _safeErc20Transfer(ANON_TOKEN, to, payout);
                emit EarnReward(msg.sender, to, tokenId, position.poolId, payout);
            }
        }
        delete _positions[tokenId];
        _burn(tokenId);
        _safeErc20Transfer(ANON_TOKEN, to, amount);

        // CRITICAL: Verify principal protection AFTER all transfers
        _ensurePrincipalProtection();
        emit Burn(msg.sender, to, tokenId, position.poolId, amount);
    }

    /// @dev Compute and collect rewards for a position up to min(nowDay, lockedUntilDay).
    ///      Requires that caller already called _updatePoolState.
    ///      Updates lastPaidDay upon successful collection.
    /// @param pool Pool storage reference
    /// @param position Position storage reference
    /// @return payout Rewards to pay
    function _collectPositionRewards(
        Pool storage pool,
        IxAnonStakingNFT.PositionData storage position
    ) internal returns (uint256 payout) {
        if (pool.snapshots.length == 0) return 0;
        uint256 capDay = _getCapDay(position);
        uint256 startDay = position.lastPaidDay;
        if (capDay <= startDay) return 0;

        payout = _earnedDaysInterval(pool.snapshots, startDay, capDay, position.amount);

        if (payout == 0) return 0;

        uint256 coveredDay = pool.snapshots[pool.snapshots.length - 1].day;
        position.lastPaidDay = uint64(capDay > coveredDay ? coveredDay : capDay);

        return payout;
    }

    /// @dev Binary search: first snapshot with end day > query day
    ///      Canonical implementation - finds smallest index i where snaps[i].day > day
    /// @param snaps Array of snapshots
    /// @param day Query day
    /// @return idx Index of first snapshot after day, or len if not found
    function _firstSnapshotAfter(
        RewardSnapshot[] memory snaps,
        uint256 day
    ) internal pure returns (uint256 idx) {
        uint256 lo = 0;
        uint256 hi = snaps.length;

        while (lo < hi) {
            uint256 mid = lo + (hi - lo) / 2; // Overflow-safe
            if (snaps[mid].day > day) {
                hi = mid; // Search in left half
            } else {
                lo = mid + 1; // Search in right half
            }
        }

        return lo; // lo == hi at end, points to first element > day (or len)
    }

    /// @dev Compute rewards over (fromDay, toDay] by summing overlaps with snapshots:
    ///      reward = amount * sum_i(perDayRate_i * overlapDays_i) / PRECISION
    function _earnedDaysInterval(
        RewardSnapshot[] memory snaps,
        uint256 fromDay,
        uint256 toDay,
        uint256 amount
    ) internal pure returns (uint256) {
        if (toDay <= fromDay) return 0;
        uint256 snapsLength = snaps.length;
        if (snapsLength == 0) return 0;

        uint256 total;
        uint256 i = _firstSnapshotAfter(snaps, fromDay);

        if (i == snapsLength) return 0; // no snapshots after fromDay

        uint256 prevDay = (i == 0) ? 0 : snaps[i - 1].day;

        for (; i < snapsLength; i++) {
            uint256 endDay = snaps[i].day;
            uint256 start = fromDay > prevDay ? fromDay : prevDay;
            uint256 end = toDay < endDay ? toDay : endDay;
            if (end > start) {
                uint256 daysOverlap = end - start;
                uint256 perDay = snaps[i].perDayRate;
                uint256 amountPerDay = Math.mulDiv(amount, perDay, PRECISION);
                total += amountPerDay * daysOverlap;
            }
            if (endDay >= toDay) break;
            prevDay = endDay; // Update for next iteration
        }
        return total;
    }

    /// @dev CRITICAL: Verify contract balance covers all staked principal AFTER withdrawal
    ///      This prevents reward calculation bugs from affecting user principal
    ///      Must be called AFTER token transfer
    function _ensurePrincipalProtection() private view {
        uint256 balance = IERC20(ANON_TOKEN).balanceOf(address(this));
        if (balance < totalStaked) revert InsufficientPrincipal();
    }

    // ═══════════════════════════════════════════════════════════════
    //                       HELPER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    /// @dev Validate caller is authorized to operate on token
    /// @param to Recipient address (must not be zero)
    /// @param tokenId Token to validate
    /// @return owner Token owner address
    function _validateTokenOwnership(
        address to,
        uint256 tokenId
    ) private view returns (address owner) {
        if (to == address(0)) revert ZeroAddress();
        owner = _ownerOf(tokenId);
        if (owner == address(0)) revert TokenDoesNotExist();
        if (!_isAuthorized(owner, msg.sender, tokenId)) revert NotAuthorized();
    }

    /// @dev Get last day position can earn rewards (min of now and unlock day)
    /// @param position Position data
    /// @return capDay Maximum reward accrual day
    function _getCapDay(
        IxAnonStakingNFT.PositionData memory position
    ) private view returns (uint256 capDay) {
        return _min(_currentDay(), position.lockedUntil / 1 days);
    }

    /// @dev Distribute rewards: create snapshot and reset stake-days
    ///
    ///      Algorithm:
    ///      1. Calculate perDayRate: rewardAmount * PRECISION / poolStakeDays
    ///      2. Create snapshot: (snapshotDay, perDayRate)
    ///      3. Reset poolStakeDays to 0 for next interval
    ///
    ///      CRITICAL: poolStakeDays must be > 0 (caller's responsibility to check)
    ///      Empty pools are never passed to this function (handled in topUp)
    ///
    /// @param pool Pool storage reference
    /// @param rewardAmount Reward allocation for this pool (after empty pool redistribution)
    /// @param snapshotDay Day to mark snapshot end (typically today)
    /// @return created Always returns true (snapshot always created)
    function _distributeRewards(
        Pool storage pool,
        uint256 rewardAmount,
        uint256 snapshotDay
    ) private returns (bool created) {
        uint256 perDay = Math.mulDiv(
            rewardAmount,
            PRECISION,
            pool.poolStakeDays // always > 0
        );
        pool.snapshots.push(RewardSnapshot({ day: snapshotDay, perDayRate: perDay }));
        pool.poolStakeDays = 0; // Reset for next interval
        return true;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _safeErc20Transfer(address token, address to, uint256 value) private {
        if (value == 0) return;
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function _safeErc20TransferFrom(address token, address from, uint256 amount) private {
        if (amount == 0) return;
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TransferFrom failed");
    }
}
