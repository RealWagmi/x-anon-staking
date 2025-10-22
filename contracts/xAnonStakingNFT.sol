// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC721Enumerable, ERC721} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IxAnonStakingNFT} from "./interfaces/IxAnonStakingNFT.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INonfungibleTokenPositionDescriptor} from "./interfaces/INonfungibleTokenPositionDescriptor.sol";

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

/// @title xAnonStakingNFT - Time-Weighted Staking with NFT Positions
/// @author AltRecipe Team
/// @notice NFT-based staking system with three fixed pools and time-weighted rewards
/// @dev Implements stake-days accounting with three immutable pools:
///      - Pool 0: 91 days lock, 20% reward allocation
///      - Pool 1: 182 days lock, 30% reward allocation
///      - Pool 2: 365 days lock, 50% reward allocation
///
///      Key features:
///      - O(1) scalability: no iteration over users
///      - Fair time-weighting: earlier stakers earn proportionally more
///      - Ring buffer expiration: precise handling of position expirations
///      - Principal protection: totalStaked tracking ensures user funds safety
///      - Fixed allocation: 20/30/50 split cannot be changed post-deployment
contract xAnonStakingNFT is
    ERC721Enumerable,
    IxAnonStakingNFT,
    Ownable,
    Pausable,
    ReentrancyGuard
{
    uint256 private constant PRECISION = 1e18;
    uint256 private constant MAX_DAILY_ROLL = 1000; // Max days to process day-by-day (gas protection)
    uint256 public constant MIN_AMOUNT = 1 ether; // Minimum topUp to prevent DoS (1 ANON tokens)

    // Fixed pool configuration (3 pools only)
    uint256 private constant POOL_COUNT = 3;
    uint256 private constant TOTAL_ALLOC_POINT = 10000; // 100% = 10000 basis points

    // Pool 0: Short (91 days, 20% allocation)
    uint16 private constant POOL0_ALLOC = 2000;
    uint256 private constant POOL0_LOCK_DAYS = 91; //should be at least 3 days minimum

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
        uint16 allocPoint;
        /// @notice Lock period in days (immutable): 91/182/365
        uint256 lockDays;
        /// @notice Current active stake within the rolling window
        /// @dev Updated on mint and during ring buffer rolls when positions expire
        uint256 rollingActiveStake;
        /// @notice Last day when ring buffer and stake-days were updated
        uint256 lastUpdatedDay;
        /// @dev Ring buffer for tracking daily deposits: dayBuckets[day % lockDays] = amount
        ///      Enables O(1) expiration of old stakes
        mapping(uint256 => uint256) dayBuckets;
        /// @notice Total stake-days accumulated since pool creation
        /// @dev Increases daily by rollingActiveStake amount
        uint256 poolStakeDays;
        /// @notice Checkpoint: poolStakeDays value at last topUp
        /// @dev Used to calculate interval stake-days: poolStakeDays - poolStakeDaysAtLastTopUp
        uint256 poolStakeDaysAtLastTopUp;
        /// @notice Array of reward snapshots defining interval boundaries and rates
        RewardSnapshot[] snapshots;
        /// @notice Rewards waiting for first interval to form (when poolStakeDays = 0)
        uint256 pendingRewards;
    }

    address private immutable _tokenDescriptor;
    address public immutable ANON_TOKEN;

    Pool[POOL_COUNT] private _pools;

    /// @dev Storage optimization: packed in single slot (30/32 bytes used)
    uint176 private _nextId = 1; // Next tokenId to mint (22 bytes)
    uint64 private _lastTopUpDay; // Last topUp day (8 bytes)

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
    /// @dev Transfers tokens from user, mints NFT, and adds stake to pool's ring buffer
    ///      Position starts earning rewards immediately based on stake-days accumulation
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
        _updatePoolState(pool);

        _safeMint(msg.sender, (tokenId = _nextId++));

        uint256 dayIdx = _currentDay() % pool.lockDays;

        pool.dayBuckets[dayIdx] += amount;
        pool.rollingActiveStake += amount;

        uint256 lockTime = (_currentDay() + pool.lockDays) * 1 days;
        _positions[tokenId] = IxAnonStakingNFT.PositionData({
            amount: uint96(amount),
            poolId: uint8(pid),
            lockedUntil: uint64(lockTime),
            lastPaidDay: uint64(_currentDay())
        });

        totalStaked += amount; // Track total principal
        _safeErc20TransferFrom(ANON_TOKEN, msg.sender, amount);
        emit Mint(msg.sender, tokenId, amount, lockTime);
    }

    /// @notice Burn position NFT and withdraw principal + rewards
    /// @dev Only callable after position unlock. Claims all accumulated rewards first,
    ///      then returns principal. Position is deleted and NFT burned.
    ///      Emits: EarnReward (if rewards > 0), Burn
    /// @param to Recipient address for principal and rewards
    /// @param tokenId Position NFT ID to burn
    /// @return amount Principal amount returned (rewards sent separately)
    function burn(
        address to,
        uint256 tokenId
    ) external nonReentrant returns (uint256 amount) {
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

        _updatePoolState(pool);

        uint256 payout = _collectPositionRewards(pool, position);
        if (payout == 0) revert NoRewards();

        _safeErc20Transfer(ANON_TOKEN, to, payout);

        // CRITICAL: Verify principal protection AFTER reward payout
        _ensurePrincipalProtection();
        emit EarnReward(msg.sender, to, tokenId, payout);

        return payout;
    }

    /// @notice Add rewards to be distributed across all pools
    /// @dev Distributes rewards with fixed allocation: 20% pool0, 30% pool1, 50% pool2
    ///
    ///      Reward distribution algorithm:
    ///      1. Updates each pool's ring buffer and stake-days
    ///      2. Creates intermediate snapshot (if gap exists since last topUp)
    ///      3. Distributes pool's share: creates snapshot with perDayRate or adds to pending
    ///
    ///      Restrictions:
    ///      - Minimum amount: MIN_AMOUNT (1 ANON) to prevent DoS
    ///      - Minimum interval: 2 days between topUps (ensures clean interval separation)
    ///      - Anyone can call (not restricted to owner)
    ///
    /// @param amount Total ANON tokens to add as rewards (split 20/30/50 across pools)
    /// @return bool Always returns true on success
    function topUp(
        uint256 amount
    ) external nonReentrant onlyOwner returns (bool) {
        if (amount < MIN_AMOUNT) revert AmountTooSmall();

        // Prevent topUp more frequently than once per 2 days
        uint256 today = _currentDay();
        if (today < _lastTopUpDay + 2) revert TopUpTooFrequent();
        _lastTopUpDay = uint64(today);

        _safeErc20TransferFrom(ANON_TOKEN, msg.sender, amount);
        uint256 remaining = amount;

        for (uint256 i = 0; i < POOL_COUNT; i++) {
            Pool storage pool = _pools[i];

            // Step 1: Update pool state to current day
            _updatePoolState(pool);

            // Step 2: Create intermediate snapshot if needed (closes old interval at "yesterday")
            _createIntermediateSnapshot(pool);

            // Step 3: Calculate this pool's share
            uint256 part = (amount * pool.allocPoint) / TOTAL_ALLOC_POINT;
            if (i == POOL_COUNT - 1)
                part = remaining; // Fix rounding for last pool
            else remaining -= part;

            if (part == 0) continue;

            // Step 4: Create main snapshot at current day or add to pending
            _distributeRewards(pool, part, today);

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
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
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
    ///      IMPORTANT: Does NOT simulate ring buffer rolls or stake-day accumulation.
    ///      If many days passed since last transaction, actual earnReward() may pay more.
    ///
    ///      Returns 0 for non-existent tokens (does not revert).
    ///
    /// @param tokenId Position NFT ID
    /// @return pending Estimated reward amount (may be lower than actual)
    function pendingRewards(
        uint256 tokenId
    ) external view returns (uint256 pending) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) return 0;
        IxAnonStakingNFT.PositionData storage position = _positions[tokenId];
        Pool storage pool = _pools[position.poolId];
        if (pool.snapshots.length == 0) return 0;
        uint256 capDay = _getCapDay(position);
        uint256 startDay = position.lastPaidDay;
        if (capDay <= startDay) return 0;
        return _earnedDaysInterval(pool, startDay, capDay, position.amount);
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
        uint256 rewardPerToken = Math.mulDiv(
            pool.lockDays * avgPerDayRate,
            1,
            PRECISION
        );

        // APR = (reward / principal) * (365 / lockDays) * 100
        // APR = reward * 365 / lockDays * 100
        // In basis points (10000 = 100%):
        // APR_bp = reward * 365 * 10000 / lockDays
        apr = Math.mulDiv(rewardPerToken * 365, 10000, pool.lockDays);

        // Confidence calculation:
        // - More data points = higher confidence
        // - More non-zero rates = higher confidence
        // - Scale: 0-10000 (10000 = 100% confidence)
        uint256 dataConfidence = samplesToUse >= 10
            ? 10000
            : (samplesToUse * 10000) / 10;
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
    function positionOf(
        uint256 tokenId
    ) external view returns (IxAnonStakingNFT.PositionData memory) {
        return _positions[tokenId];
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
    function _addPool(
        uint256 pid,
        uint16 allocPoint,
        uint256 lockDays
    ) private {
        Pool storage pool = _pools[pid];
        pool.allocPoint = allocPoint;
        pool.lockDays = lockDays;
        pool.lastUpdatedDay = _currentDay();
        pool.poolStakeDaysAtLastTopUp = 0;
        pool.snapshots.push(
            RewardSnapshot({day: _currentDay(), perDayRate: 0})
        );
        pool.pendingRewards = 0;
        emit PoolAdded(pid, allocPoint, lockDays);
    }

    /// @dev Convert current timestamp to unix day
    /// @return uint256 Current day number (block.timestamp / 86400)
    function _currentDay() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @dev Update pool to current day: advance ring buffer and accumulate stake-days
    ///
    ///      Ring Buffer Mechanics:
    ///      - Tracks deposits by day: dayBuckets[day % lockDays]
    ///      - When advancing to day N, bucket at (N % lockDays) contains deposits that expire
    ///      - Expired amounts are subtracted from rollingActiveStake
    ///
    ///      Stake-Days Accumulation:
    ///      - Each day adds rollingActiveStake to poolStakeDays
    ///      - Example: 100 tokens active for 5 days → 500 stake-days
    ///
    ///      Gas Optimization:
    ///      - Small gap (≤1000 days): precise day-by-day iteration
    ///      - Large gap (>1000 days): approximation (constant stake over gap)
    ///        Tests verify no overpayment occurs with approximation.
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
            while (lastUpdatedDay < currDay) {
                // Step 1: Accumulate stake-days for one day
                poolStakeDays += activeStake;

                // Step 2: Clear expirations for next day
                lastUpdatedDay++;
                uint256 idx = lastUpdatedDay % lockDays;
                uint256 expired = pool.dayBuckets[idx];
                if (expired > 0) {
                    activeStake -= expired;
                    pool.dayBuckets[idx] = 0;
                }
            }

            // Write back all updates at once
            pool.poolStakeDays = poolStakeDays;
            pool.rollingActiveStake = activeStake;
            pool.lastUpdatedDay = currDay;
        }
    }

    /// @dev Convert pending rewards into snapshot if interval exists
    ///
    ///      Called after _rollPool to distribute accumulated pending rewards.
    ///      Does NOT accumulate stake-days (that's _rollPool's job).
    ///
    ///      Pending rewards exist when:
    ///      - topUp occurs with intervalStakeDays = 0 (no interval formed yet)
    ///      - Rewards accumulate until first interval forms
    ///
    ///      INVARIANT: 1 day of stake = stake amount numerically
    ///      Critical for "yesterday snapshot" logic in topUp.
    ///
    /// @param pool Pool storage reference
    function _finalizePendingRewards(Pool storage pool) internal {
        // If there are pending rewards, distribute them
        if (pool.pendingRewards > 0) {
            _distributeRewards(pool, 0, _currentDay());
        }
    }

    /// @dev Create intermediate snapshot at "yesterday" before processing new topUp
    ///
    ///      Purpose: Prevents dilution from today's new stakers
    ///
    ///      Why needed: Without this, new stakers entering "today" would immediately
    ///      share in the topUp rewards despite not having accumulated stake-days.
    ///
    ///      Creates snapshot ONLY if:
    ///      1. Real snapshot exists (not just init with perDayRate=0)
    ///      2. Gap exists since last snapshot
    ///      3. Yesterday > last snapshot day (prevents duplicates)
    ///      4. Stake-days until yesterday > 0
    ///
    ///      Snapshot has perDayRate=0 (closes interval with no new rewards).
    ///
    /// @param pool Pool storage reference
    function _createIntermediateSnapshot(Pool storage pool) internal {
        // Skip if no real snapshots yet (only init snapshot with perDayRate=0)
        // Only create intermediate if we have at least one real snapshot or init has perDayRate > 0
        uint256 snapsLength = pool.snapshots.length;
        if (snapsLength == 0) return;
        if (snapsLength == 1 && pool.snapshots[0].perDayRate == 0) return;

        uint256 lastSnapshotDay = pool.snapshots[snapsLength - 1].day;
        uint256 today = _currentDay();

        // No gap = same day topUp, skip intermediate
        if (today <= lastSnapshotDay) return;

        uint256 yesterday = today - 1;

        // Verify yesterday is after last snapshot (avoid duplicates)
        if (yesterday <= lastSnapshotDay) return;

        // Calculate stake-days accumulated in old interval
        uint256 oldIntervalSD = pool.poolStakeDays -
            pool.poolStakeDaysAtLastTopUp;
        if (oldIntervalSD == 0) return;

        // Exclude today's stake-days from the interval
        // INVARIANT: today's token-days = rollingActiveStake (numerically)
        uint256 todayTokenDays = pool.rollingActiveStake;
        uint256 stakeDaysUntilYesterday = oldIntervalSD > todayTokenDays
            ? oldIntervalSD - todayTokenDays
            : 0;

        if (stakeDaysUntilYesterday == 0) return;

        // Create intermediate snapshot at yesterday with perDayRate = 0
        // NOTE: pendingRewards are always 0 at this point because _finalizePendingRewards
        //       was called before this function in topUp and either:
        //       1. Created a snapshot and zeroed pending (if intervalSD > 0), OR
        //       2. Left pending unchanged, but then intervalSD == 0 means oldIntervalSD == 0,
        //          so we would have returned at line 591.
        //       Therefore intermediate snapshots always have perDayRate = 0.
        pool.snapshots.push(RewardSnapshot({day: yesterday, perDayRate: 0}));

        // Update checkpoint: exclude today's token-days
        pool.poolStakeDaysAtLastTopUp = pool.poolStakeDays - todayTokenDays;
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
        _updatePoolState(pool);

        amount = position.amount;
        totalStaked -= amount; // Decrease total principal

        if (claimRewards) {
            // Pay any pending rewards up to cap day (lockedUntil)
            uint256 payout = _collectPositionRewards(pool, position);

            if (payout > 0) {
                _safeErc20Transfer(ANON_TOKEN, to, payout);
                emit EarnReward(msg.sender, to, tokenId, payout);
            }
        }
        delete _positions[tokenId];
        _burn(tokenId);
        _safeErc20Transfer(ANON_TOKEN, to, amount);

        // CRITICAL: Verify principal protection AFTER all transfers
        _ensurePrincipalProtection();
        emit Burn(msg.sender, to, tokenId, amount);
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

        payout = _earnedDaysInterval(pool, startDay, capDay, position.amount);

        if (payout == 0) return 0;

        uint256 coveredDay = pool.snapshots[pool.snapshots.length - 1].day;
        position.lastPaidDay = uint64(
            capDay > coveredDay ? coveredDay : capDay
        );

        return payout;
    }

    /// @dev Binary search: first snapshot with end day > query day
    ///      Canonical implementation - finds smallest index i where snaps[i].day > day
    /// @param pool Pool storage reference
    /// @param day Query day
    /// @return idx Index of first snapshot after day, or len if not found
    function _firstSnapshotAfter(
        Pool storage pool,
        uint256 day
    ) internal view returns (uint256 idx) {
        RewardSnapshot[] storage snaps = pool.snapshots;
        uint256 len = snaps.length;
        if (len == 0) return type(uint256).max;

        uint256 lo = 0;
        uint256 hi = len;

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
        Pool storage pool,
        uint256 fromDay,
        uint256 toDay,
        uint256 amount
    ) internal view returns (uint256) {
        if (toDay <= fromDay) return 0;
        RewardSnapshot[] storage snaps = pool.snapshots;
        if (snaps.length == 0) return 0;

        uint256 total;
        uint256 i = _firstSnapshotAfter(pool, fromDay);
        uint256 snapsLength = snaps.length;
        if (i == snapsLength) return 0;

        // Cache previous snapshot day to avoid repeated SLOAD
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

    /// @dev Bring pool to current day (roll ring buffer + finalize pending)
    /// @param pool Pool storage reference
    function _updatePoolState(Pool storage pool) private {
        _rollPool(pool);
        _finalizePendingRewards(pool);
    }

    /// @dev Get last day position can earn rewards (min of now and unlock day)
    /// @param position Position data
    /// @return capDay Maximum reward accrual day
    function _getCapDay(
        IxAnonStakingNFT.PositionData storage position
    ) private view returns (uint256 capDay) {
        return _min(_currentDay(), position.lockedUntil / 1 days);
    }

    /// @dev Distribute rewards: create snapshot or add to pending
    ///
    ///      If interval has stake-days: creates snapshot with perDayRate
    ///      If no interval yet: adds to pending (waits for first stake-days)
    ///
    /// @param pool Pool storage reference
    /// @param rewardAmount New rewards to add
    /// @param snapshotDay Day to mark snapshot (usually current day)
    /// @return created True if snapshot created, false if added to pending
    function _distributeRewards(
        Pool storage pool,
        uint256 rewardAmount,
        uint256 snapshotDay
    ) private returns (bool created) {
        uint256 intervalSD = pool.poolStakeDays - pool.poolStakeDaysAtLastTopUp;
        if (intervalSD > 0) {
            uint256 totalReward = pool.pendingRewards + rewardAmount;
            uint256 perDay = Math.mulDiv(totalReward, PRECISION, intervalSD);
            pool.snapshots.push(
                RewardSnapshot({day: snapshotDay, perDayRate: perDay})
            );
            pool.poolStakeDaysAtLastTopUp = pool.poolStakeDays;
            pool.pendingRewards = 0;
            return true;
        } else {
            pool.pendingRewards += rewardAmount;
            return false;
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _safeErc20Transfer(
        address token,
        address to,
        uint256 value
    ) private {
        if (value == 0) return;
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "Transfer failed"
        );
    }

    function _safeErc20TransferFrom(
        address token,
        address from,
        uint256 amount
    ) private {
        if (amount == 0) return;
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(
                IERC20.transferFrom.selector,
                from,
                address(this),
                amount
            )
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TransferFrom failed"
        );
    }
}
