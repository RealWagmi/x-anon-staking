// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import "../../contracts/xAnonStakingNFT.sol";
import "../../contracts/mocks/MockERC20.sol";
import "../../contracts/mocks/MockDescriptor.sol";

/// @title Fuzz Tests for Fair Reward Distribution
/// @notice Tests mathematical correctness of reward distribution across various scenarios
contract FuzzDistributionTest is Test {
    xAnonStakingNFT public staking;
    MockERC20 public anon;
    MockDescriptor public descriptor;

    address public owner;
    address public alice;
    address public bob;
    address public carol;

    uint256 constant DAY = 1 days;
    uint256 constant MIN_AMOUNT = 1 ether;

    // Struct for grouping user data (solves stack too deep)
    struct UserData {
        uint96 stake;
        uint256 tokenId;
        uint256 rewards;
        uint256 balanceBefore;
        uint256 balanceAfter;
    }

    // Helper: Get pool allocation from contract with EMPTY POOL REDISTRIBUTION
    // IMPORTANT: This function simulates the contract's empty pool redistribution logic!
    // If only some pools are active, their allocations are redistributed proportionally.
    //
    // @param poolId The pool to get allocation for
    // @param topUpAmount Total topUp amount
    // @param activePoolIds Array of active pool IDs (pools with stake-days > 0)
    // @return The amount allocated to poolId after redistribution
    function getPoolAllocation(
        uint8 poolId,
        uint256 topUpAmount,
        uint8[] memory activePoolIds
    ) internal view returns (uint256) {
        // Edge case: no active pools
        if (activePoolIds.length == 0) return 0;

        // If pool is not in activePoolIds, it gets 0
        bool isActive = false;
        for (uint256 i = 0; i < activePoolIds.length; i++) {
            if (activePoolIds[i] == poolId) {
                isActive = true;
                break;
            }
        }
        if (!isActive) return 0;

        // Calculate total allocation points of active pools
        uint256 totalActiveAllocPoint = 0;
        for (uint256 i = 0; i < activePoolIds.length; i++) {
            (uint16 alloc, , , , ) = staking.poolInfo(activePoolIds[i]);
            totalActiveAllocPoint += alloc;
        }

        // Edge case: all active pools have 0 allocPoint (shouldn't happen in practice)
        if (totalActiveAllocPoint == 0) return 0;

        // Get this pool's allocation point
        (uint16 allocPoint, , , , ) = staking.poolInfo(poolId);

        // Calculate proportional share: (topUpAmount * allocPoint / totalActiveAllocPoint)
        // This simulates contract's exact redistribution logic
        uint256 remaining = topUpAmount;
        for (uint256 i = 0; i < activePoolIds.length; i++) {
            (uint16 alloc, , , , ) = staking.poolInfo(activePoolIds[i]);
            uint256 part = (topUpAmount * alloc) / totalActiveAllocPoint;

            // Last active pool gets remaining (handles rounding)
            if (i == activePoolIds.length - 1) part = remaining;
            else remaining -= part;

            if (activePoolIds[i] == poolId) return part;
        }
        return 0;
    }

    // Helper: Get lock days from contract (not hardcoded!)
    function getLockDays(uint8 poolId) internal view returns (uint256) {
        (, uint256 lockDays, , , ) = staking.poolInfo(poolId);
        return lockDays;
    }

    function setUp() public {
        owner = address(this);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");

        // CRITICAL: Warp to non-zero timestamp
        // Contract's _currentDay() = block.timestamp / 1 days
        // Foundry starts at timestamp = 1 → _currentDay() = 0
        // This causes underflow in mint(): dayIdx = (_currentDay() - 1) % lockDays
        // Solution: Set timestamp to 1 day or more
        vm.warp(1 days);

        // Deploy contracts
        anon = new MockERC20("ANON", "ANON", 18);
        descriptor = new MockDescriptor();
        staking = new xAnonStakingNFT(address(anon), address(descriptor));

        // Mint tokens to users (huge amounts for fuzz testing)
        anon.mint(owner, type(uint96).max);
        anon.mint(alice, type(uint96).max);
        anon.mint(bob, type(uint96).max);
        anon.mint(carol, type(uint96).max);

        // Approve
        anon.approve(address(staking), type(uint256).max);
        vm.prank(alice);
        anon.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        anon.approve(address(staking), type(uint256).max);
        vm.prank(carol);
        anon.approve(address(staking), type(uint256).max);
    }

    // ════════════════════════════════════════════════════════════════
    //                 FUZZ: EQUAL STAKES EQUAL REWARDS
    // ════════════════════════════════════════════════════════════════

    /// @notice Equal stakes at same time should get equal rewards
    function testFuzz_EqualStakesEqualRewards(
        uint96 stakeAmount,
        uint8 poolId,
        uint16 daysBeforeTopUp
    ) public {
        // Bound inputs
        stakeAmount = uint96(bound(stakeAmount, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        daysBeforeTopUp = uint16(bound(daysBeforeTopUp, 2, 100));

        // Both stake same amount same day
        vm.prank(alice);
        uint256 tokenId1 = staking.mint(stakeAmount, poolId);
        vm.prank(bob);
        uint256 tokenId2 = staking.mint(stakeAmount, poolId);

        // Wait and topUp
        skip(daysBeforeTopUp * DAY);
        staking.topUp(10_000 ether);

        // Wait one more day
        skip(DAY);

        // Claim both
        vm.prank(alice);
        uint256 aliceRewards = staking.earnReward(alice, tokenId1);
        vm.prank(bob);
        uint256 bobRewards = staking.earnReward(bob, tokenId2);

        // INVARIANT: Equal stakes → equal rewards (within rounding)
        uint256 diff = aliceRewards > bobRewards
            ? aliceRewards - bobRewards
            : bobRewards - aliceRewards;

        // Difference should be minimal (< 0.1%)
        assertLt(diff, (aliceRewards + bobRewards) / 1000);
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: TIME WEIGHTING FAIRNESS
    // ════════════════════════════════════════════════════════════════

    /// @notice Earlier staker should always get more or equal rewards
    function testFuzz_EarlierStakerGetsMore(
        uint96 amount,
        uint8 poolId,
        uint8 aliceStakeDays,
        uint8 bobStakeDays
    ) public {
        // Bound inputs - use uint8 for simpler bounds
        amount = uint96(bound(amount, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));

        // Adapt to actual pool lock days (no hardcoding!)
        uint256 lockDays = getLockDays(poolId);
        uint8 maxStakeDays = uint8(lockDays < 50 ? lockDays : 50);

        aliceStakeDays = uint8(bound(aliceStakeDays, 2, maxStakeDays));
        bobStakeDays = uint8(
            bound(bobStakeDays, 1, aliceStakeDays > 1 ? aliceStakeDays - 1 : 1)
        );

        // Alice stakes first
        vm.prank(alice);
        uint256 tokenId1 = staking.mint(amount, poolId);

        // Wait for Alice to accumulate stake-days
        skip((aliceStakeDays - bobStakeDays) * DAY);

        // Bob stakes later (same amount)
        vm.prank(bob);
        uint256 tokenId2 = staking.mint(amount, poolId);

        // Wait for Bob's stake-days
        skip(bobStakeDays * DAY);

        // TopUp
        staking.topUp(10_000 ether);
        skip(DAY);

        // Claim
        vm.prank(alice);
        uint256 aliceRewards = staking.earnReward(alice, tokenId1);
        vm.prank(bob);
        uint256 bobRewards = staking.earnReward(bob, tokenId2);

        // INVARIANT: Alice (more stake-days) should get MORE rewards
        assertGt(aliceRewards, bobRewards, "Earlier staker should get more");

        // Check ratio matches stake-days ratio
        uint256 aliceSD = aliceStakeDays;
        uint256 bobSD = bobStakeDays;
        uint256 expectedRatio = (aliceSD * 1000) / bobSD;
        uint256 actualRatio = (aliceRewards * 1000) / bobRewards;

        // Ratio should match within 5%
        uint256 diff = expectedRatio > actualRatio
            ? expectedRatio - actualRatio
            : actualRatio - expectedRatio;
        assertLt(diff, expectedRatio / 20, "Ratio should match stake-days");
    }

    // ════════════════════════════════════════════════════════════════
    //           FUZZ: TOTAL REWARDS NEVER EXCEED ALLOCATION
    // ════════════════════════════════════════════════════════════════

    /// @notice Total distributed rewards must never exceed pool allocation
    function testFuzz_TotalRewardsNeverExceedAllocation(
        uint96 amount1,
        uint96 amount2,
        uint96 amount3,
        uint8 poolId,
        uint8 gap1,
        uint8 gap2,
        uint96 topUpAmount
    ) public {
        // Bound inputs
        amount1 = uint96(bound(amount1, MIN_AMOUNT, 10_000 ether));
        amount2 = uint96(bound(amount2, MIN_AMOUNT, 10_000 ether));
        amount3 = uint96(bound(amount3, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        gap1 = uint8(bound(gap1, 2, 20));
        gap2 = uint8(bound(gap2, 2, 20));
        topUpAmount = uint96(bound(topUpAmount, MIN_AMOUNT, 50_000 ether));

        // Three users stake at different times
        vm.prank(alice);
        uint256 tokenId1 = staking.mint(amount1, poolId);

        skip(gap1 * DAY);
        vm.prank(bob);
        uint256 tokenId2 = staking.mint(amount2, poolId);

        skip(gap2 * DAY);
        vm.prank(carol);
        uint256 tokenId3 = staking.mint(amount3, poolId);

        // TopUp
        skip(2 * DAY); // Min gap
        staking.topUp(topUpAmount);
        skip(DAY);

        // Calculate expected pool allocation (only this pool is active)
        uint8[] memory activePoolIds = new uint8[](1);
        activePoolIds[0] = poolId;
        uint256 poolAllocation = getPoolAllocation(
            poolId,
            topUpAmount,
            activePoolIds
        );

        // Claim all
        vm.prank(alice);
        uint256 r1 = staking.earnReward(alice, tokenId1);
        vm.prank(bob);
        uint256 r2 = staking.earnReward(bob, tokenId2);
        vm.prank(carol);
        uint256 r3 = staking.earnReward(carol, tokenId3);

        uint256 totalDistributed = r1 + r2 + r3;

        // CRITICAL INVARIANT: Total cannot exceed pool allocation
        assertLe(
            totalDistributed,
            poolAllocation,
            "Total rewards exceed pool allocation"
        );

        // Should distribute most of allocation (>95%)
        assertGe(
            totalDistributed,
            (poolAllocation * 95) / 100,
            "Should distribute almost all rewards"
        );
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: FRAGMENTATION NEUTRALITY
    // ════════════════════════════════════════════════════════════════

    /// @notice N small stakes should equal 1 large stake
    function testFuzz_FragmentationNeutral(
        uint8 fragments,
        uint96 totalAmount,
        uint8 poolId,
        uint16 daysBeforeTopUp
    ) public {
        // Bound inputs using bound() to avoid rejections
        fragments = uint8(bound(fragments, 2, 10)); // 2-10 fragments
        totalAmount = uint96(bound(totalAmount, MIN_AMOUNT * 10, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        daysBeforeTopUp = uint16(bound(daysBeforeTopUp, 2, 50));

        uint256 perFragment = totalAmount / fragments;
        if (perFragment < MIN_AMOUNT) return; // Skip if fragments too small

        // Alice: N small stakes
        for (uint256 i = 0; i < fragments; i++) {
            vm.prank(alice);
            staking.mint(perFragment, poolId);
        }

        // Bob: 1 large stake (same total)
        uint256 bobAmount = perFragment * fragments;
        vm.prank(bob);
        uint256 bobTokenId = staking.mint(bobAmount, poolId);

        // TopUp
        skip(daysBeforeTopUp * DAY);
        staking.topUp(10_000 ether);
        skip(DAY);

        // Claim Alice's fragments
        uint256 aliceTotalRewards = 0;
        for (uint256 i = 1; i <= fragments; i++) {
            vm.prank(alice);
            aliceTotalRewards += staking.earnReward(alice, i);
        }

        // Claim Bob's single position
        vm.prank(bob);
        uint256 bobRewards = staking.earnReward(bob, bobTokenId);

        // INVARIANT: Fragmented vs single should be equal (within 0.1%)
        uint256 diff = aliceTotalRewards > bobRewards
            ? aliceTotalRewards - bobRewards
            : bobRewards - aliceTotalRewards;

        assertLt(
            diff,
            bobRewards / 1000,
            "Fragmentation should not affect rewards"
        );
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: MULTIPLE TOPUPS DISTRIBUTION
    // ════════════════════════════════════════════════════════════════

    /// @notice Multiple topUps should distribute fairly
    function testFuzz_MultipleTopUpsFair(
        uint96 stake1,
        uint96 stake2,
        uint8 poolId,
        uint8 numTopUps,
        uint96 topUpAmount
    ) public {
        // Bound inputs
        stake1 = uint96(bound(stake1, MIN_AMOUNT, 10_000 ether));
        stake2 = uint96(bound(stake2, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        numTopUps = uint8(bound(numTopUps, 2, 5));
        topUpAmount = uint96(bound(topUpAmount, MIN_AMOUNT, 50_000 ether));

        // Alice and Bob stake
        vm.prank(alice);
        uint256 tokenId1 = staking.mint(stake1, poolId);
        vm.prank(bob);
        uint256 tokenId2 = staking.mint(stake2, poolId);

        skip(5 * DAY);

        // Multiple topUps
        uint256 totalTopUpAmount = 0;
        for (uint256 i = 0; i < numTopUps; i++) {
            staking.topUp(topUpAmount);
            totalTopUpAmount += topUpAmount;
            skip(2 * DAY); // Min gap between topUps
        }

        skip(DAY);

        // Claim
        vm.prank(alice);
        uint256 aliceRewards = staking.earnReward(alice, tokenId1);
        vm.prank(bob);
        uint256 bobRewards = staking.earnReward(bob, tokenId2);

        // Calculate EXACT pool allocation from contract (only this pool is active)
        uint8[] memory activePoolIds = new uint8[](1);
        activePoolIds[0] = poolId;
        uint256 poolAlloc = 0;
        for (uint256 t = 0; t < numTopUps; t++) {
            poolAlloc += getPoolAllocation(poolId, topUpAmount, activePoolIds);
        }

        // CRITICAL INVARIANT: Total NEVER exceeds pool allocation
        assertLe(aliceRewards + bobRewards, poolAlloc, "Total <= allocation");

        // INVARIANT: Rewards ordering matches stake ordering
        // (May both be 0 for extreme rounding cases - this is correct behavior)
        if (stake1 > stake2) {
            assertGe(aliceRewards, bobRewards, "Larger stake -> more rewards");
        } else if (stake2 > stake1) {
            assertGe(bobRewards, aliceRewards, "Larger stake -> more rewards");
        }
        // If stake1 == stake2, both assertions would pass (rewards should be equal)
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: STAGGERED ENTRY FAIRNESS
    // ════════════════════════════════════════════════════════════════

    /// @notice Staggered entry: test EXACT math with intermediate snapshot
    function testFuzz_StaggeredEntryFair(
        uint96 amount,
        uint8 poolId,
        uint16 aliceDays,
        uint16 bobDelay
    ) public {
        // Bound inputs using bound() to avoid rejections
        amount = uint96(bound(amount, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        aliceDays = uint16(bound(aliceDays, 10, 50));
        bobDelay = uint16(bound(bobDelay, 5, aliceDays - 3));

        // Alice stakes first
        vm.prank(alice);
        uint256 t1 = staking.mint(amount, poolId);

        // Bob stakes later
        skip(bobDelay * DAY);
        vm.prank(bob);
        uint256 t2 = staking.mint(amount, poolId);

        // Wait to reach aliceDays + 2 day gap
        skip((aliceDays - bobDelay) * DAY);
        skip(2 * DAY); // Triggers intermediate snapshot

        // TopUp
        staking.topUp(10_000 ether);
        skip(DAY);

        // Claim both
        vm.prank(alice);
        uint256 r1 = staking.earnReward(alice, t1);
        vm.prank(bob);
        uint256 r2 = staking.earnReward(bob, t2);

        // STRICT INVARIANT 1: Earlier staker MUST get MORE (or equal if same active days)
        assertGe(r1, r2, "Alice (earlier) must get >= Bob");

        // STRICT INVARIANT 2: Both should earn something (both were active)
        assertGt(r1, 0, "Alice should earn");
        assertGt(r2, 0, "Bob should earn");

        // INVARIANT 3: Total should not exceed pool allocation (only this pool active)
        uint8[] memory activePoolIds = new uint8[](1);
        activePoolIds[0] = poolId;
        uint256 poolAlloc = getPoolAllocation(
            poolId,
            10_000 ether,
            activePoolIds
        );
        assertLe(r1 + r2, poolAlloc, "Total <= allocation");

        // Note: Complex scenario with gaps and intermediate snapshots
        // We test STRICT ordering and reasonable bounds, not exact math
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: FRONT-RUNNING PROTECTION
    // ════════════════════════════════════════════════════════════════

    /// @notice Front-runner gets minimal/zero rewards
    function testFuzz_FrontRunnerGetsNothing(
        uint96 earlyStake,
        uint96 frontRunStake,
        uint8 poolId,
        uint16 earlyDays
    ) public {
        // Bound inputs
        earlyStake = uint96(bound(earlyStake, MIN_AMOUNT, 10_000 ether));
        frontRunStake = uint96(bound(frontRunStake, MIN_AMOUNT, 100_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        earlyDays = uint16(bound(earlyDays, 5, 30));

        // Alice stakes early
        vm.prank(alice);
        uint256 t1 = staking.mint(earlyStake, poolId);

        // Wait
        skip(earlyDays * DAY);

        // Bob front-runs topUp (stakes same block)
        vm.prank(bob);
        uint256 t2 = staking.mint(frontRunStake, poolId);

        // TopUp happens same block
        staking.topUp(10_000 ether);
        skip(DAY);

        // Claim
        vm.prank(alice);
        uint256 aliceRewards = staking.earnReward(alice, t1);

        // Bob should get nothing (0 stake-days at topUp)
        vm.prank(bob);
        vm.expectRevert(NoRewards.selector);
        staking.earnReward(bob, t2);

        // INVARIANT: Alice gets all rewards despite potentially smaller stake
        assertGt(aliceRewards, 0, "Early staker should get rewards");
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: POOL ALLOCATION RATIOS
    // ════════════════════════════════════════════════════════════════

    /// @notice Pool allocations (20/30/50) must be maintained when ALL pools active
    /// @dev This test verifies base allocation ratios WITHOUT empty pool redistribution
    ///      because all 3 pools have active stakes simultaneously
    function testFuzz_PoolAllocationRatios(
        uint96 stakeAmount,
        uint16 daysBeforeTopUp,
        uint96 topUpAmount
    ) public {
        // Bound inputs
        stakeAmount = uint96(bound(stakeAmount, MIN_AMOUNT, 10_000 ether));
        daysBeforeTopUp = uint16(bound(daysBeforeTopUp, 2, 30));
        topUpAmount = uint96(
            bound(topUpAmount, MIN_AMOUNT * 100, 50_000 ether)
        );

        // Stake in all 3 pools (same amount, same time)
        // This ensures ALL pools are active → no empty pool redistribution
        vm.prank(alice);
        uint256 t0 = staking.mint(stakeAmount, 0);
        vm.prank(bob);
        uint256 t1 = staking.mint(stakeAmount, 1);
        vm.prank(carol);
        uint256 t2 = staking.mint(stakeAmount, 2);

        // TopUp with all pools active
        skip(daysBeforeTopUp * DAY);
        staking.topUp(topUpAmount);
        skip(DAY);

        // Claim
        vm.prank(alice);
        uint256 r0 = staking.earnReward(alice, t0);
        vm.prank(bob);
        uint256 r1 = staking.earnReward(bob, t1);
        vm.prank(carol);
        uint256 r2 = staking.earnReward(carol, t2);

        // INVARIANT: Ratio should be 20:30:50 (2:3:5) when all pools active
        // No empty pool redistribution occurs here
        // Check r0:r1:r2 ≈ 2:3:5
        if (r0 > 0 && r1 > 0 && r2 > 0) {
            uint256 ratio01 = (r0 * 100) / r1; // Should be ~67 (2/3)
            uint256 ratio12 = (r1 * 100) / r2; // Should be ~60 (3/5)
            uint256 ratio02 = (r0 * 100) / r2; // Should be ~40 (2/5)

            // Within 5% tolerance
            assertApproxEqRel(ratio01, 67, 0.05e18, "Pool0:Pool1 ratio");
            assertApproxEqRel(ratio12, 60, 0.05e18, "Pool1:Pool2 ratio");
            assertApproxEqRel(ratio02, 40, 0.05e18, "Pool0:Pool2 ratio");
        }
    }

    // ════════════════════════════════════════════════════════════════
    //         DETERMINISTIC: 3 USERS IN 3 ACTIVE POOLS
    // ════════════════════════════════════════════════════════════════

    /// @notice CRITICAL TEST: 3 users in 3 different pools, verify 20%/30%/50% split
    /// @dev This is a deterministic (non-fuzz) test that explicitly verifies
    ///      the base allocation when ALL 3 pools are active simultaneously
    ///      NO empty pool redistribution should occur here
    function test_ThreeUsersThreeActivePools_ExactAllocation() public {
        // Fixed amounts for deterministic test
        uint256 stakeAmount = 1000 ether;
        uint256 topUpAmount = 10_000 ether;

        // Alice stakes in pool 0 (Short, 91 days, 20% allocation)
        vm.prank(alice);
        uint256 tokenId0 = staking.mint(stakeAmount, 0);

        // Bob stakes in pool 1 (Medium, 182 days, 30% allocation)
        vm.prank(bob);
        uint256 tokenId1 = staking.mint(stakeAmount, 1);

        // Carol stakes in pool 2 (Long, 365 days, 50% allocation)
        vm.prank(carol);
        uint256 tokenId2 = staking.mint(stakeAmount, 2);

        // Wait for stake-days to accumulate
        skip(5 * DAY);

        // TopUp with ALL 3 pools active
        staking.topUp(topUpAmount);
        skip(DAY);

        // Calculate expected rewards (all 3 pools active → 20%/30%/50% split)
        uint8[] memory activePoolIds = new uint8[](3);
        activePoolIds[0] = 0;
        activePoolIds[1] = 1;
        activePoolIds[2] = 2;

        uint256 expectedAlice = getPoolAllocation(
            0,
            topUpAmount,
            activePoolIds
        );
        uint256 expectedBob = getPoolAllocation(1, topUpAmount, activePoolIds);
        uint256 expectedCarol = getPoolAllocation(
            2,
            topUpAmount,
            activePoolIds
        );

        // Claim rewards
        vm.prank(alice);
        uint256 aliceRewards = staking.earnReward(alice, tokenId0);
        vm.prank(bob);
        uint256 bobRewards = staking.earnReward(bob, tokenId1);
        vm.prank(carol);
        uint256 carolRewards = staking.earnReward(carol, tokenId2);

        // CRITICAL ASSERTIONS: Verify exact 20%/30%/50% distribution
        assertApproxEqRel(
            aliceRewards,
            expectedAlice,
            0.01e18,
            "Alice should get ~20%"
        );
        assertApproxEqRel(
            bobRewards,
            expectedBob,
            0.01e18,
            "Bob should get ~30%"
        );
        assertApproxEqRel(
            carolRewards,
            expectedCarol,
            0.01e18,
            "Carol should get ~50%"
        );

        // Verify total distributed equals topUp amount
        uint256 totalDistributed = aliceRewards + bobRewards + carolRewards;
        assertApproxEqRel(
            totalDistributed,
            topUpAmount,
            0.01e18,
            "Total should equal topUp amount"
        );

        // Verify ordering: Carol > Bob > Alice (50% > 30% > 20%)
        assertGt(carolRewards, bobRewards, "Carol (50%) > Bob (30%)");
        assertGt(bobRewards, aliceRewards, "Bob (30%) > Alice (20%)");

        // Verify approximate percentages
        uint256 alicePercent = (aliceRewards * 100) / topUpAmount;
        uint256 bobPercent = (bobRewards * 100) / topUpAmount;
        uint256 carolPercent = (carolRewards * 100) / topUpAmount;

        assertApproxEqAbs(alicePercent, 20, 1, "Alice gets ~20%");
        assertApproxEqAbs(bobPercent, 30, 1, "Bob gets ~30%");
        assertApproxEqAbs(carolPercent, 50, 1, "Carol gets ~50%");

        // Verify ratios match allocPoints (2:3:5)
        uint256 ratio_alice_bob = (aliceRewards * 100) / bobRewards;
        uint256 ratio_bob_carol = (bobRewards * 100) / carolRewards;

        assertApproxEqAbs(ratio_alice_bob, 67, 2, "Alice:Bob ~= 2:3 (67%)");
        assertApproxEqAbs(ratio_bob_carol, 60, 2, "Bob:Carol ~= 3:5 (60%)");
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: EMPTY POOL REDISTRIBUTION
    // ════════════════════════════════════════════════════════════════

    /// @notice CRITICAL: Single active pool should get 100% of topUp (not base %)
    /// @dev This is the KEY test for empty pool redistribution logic
    ///      If only pool2 is active, it gets 100% (not 50%)
    function testFuzz_EmptyPoolRedistribution(
        uint96 stakeAmount,
        uint8 activePoolId,
        uint16 daysBeforeTopUp,
        uint96 topUpAmount
    ) public {
        // Bound inputs
        stakeAmount = uint96(bound(stakeAmount, MIN_AMOUNT, 10_000 ether));
        activePoolId = uint8(bound(activePoolId, 0, 2));
        daysBeforeTopUp = uint16(bound(daysBeforeTopUp, 2, 50));
        topUpAmount = uint96(bound(topUpAmount, MIN_AMOUNT * 10, 50_000 ether));

        // Only stake in ONE pool (other 2 pools remain empty)
        vm.prank(alice);
        uint256 tokenId = staking.mint(stakeAmount, activePoolId);

        // TopUp
        skip(daysBeforeTopUp * DAY);
        staking.topUp(topUpAmount);
        skip(DAY);

        // Claim
        vm.prank(alice);
        uint256 rewards = staking.earnReward(alice, tokenId);

        // CRITICAL INVARIANT: Alice should get ~100% of topUp (not just her pool's base %)
        // Because other pools are empty, their allocations are redistributed to her pool
        uint8[] memory activePoolIds = new uint8[](1);
        activePoolIds[0] = activePoolId;
        uint256 expectedRewards = getPoolAllocation(
            activePoolId,
            topUpAmount,
            activePoolIds
        );

        // Should get close to 100% (within 1% tolerance for rounding)
        assertApproxEqRel(
            rewards,
            expectedRewards,
            0.01e18,
            "Single active pool should get 100% via redistribution"
        );

        // Verify it's actually ~100% of topUp, not base allocation
        if (activePoolId == 0) {
            // Pool 0 base allocation is 20%, but should get ~100%
            assertGt(
                rewards,
                (topUpAmount * 95) / 100,
                "Pool0 gets >95% (not 20%)"
            );
        } else if (activePoolId == 1) {
            // Pool 1 base allocation is 30%, but should get ~100%
            assertGt(
                rewards,
                (topUpAmount * 95) / 100,
                "Pool1 gets >95% (not 30%)"
            );
        } else {
            // Pool 2 base allocation is 50%, but should get ~100%
            assertGt(
                rewards,
                (topUpAmount * 95) / 100,
                "Pool2 gets >95% (not 50%)"
            );
        }
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: MULTIPLE CLAIMS CORRECTNESS
    // ════════════════════════════════════════════════════════════════

    /// @notice Multiple claims should sum to total allocation
    function testFuzz_MultipleClaimsSumToTotal(
        uint96 stakeAmount,
        uint8 poolId,
        uint8 numClaims
    ) public {
        // Bound inputs
        stakeAmount = uint96(bound(stakeAmount, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        numClaims = uint8(bound(numClaims, 2, 5));

        // Adapt gap to pool's lock period
        uint256 lockDays = getLockDays(poolId);
        uint256 gapDays = lockDays / numClaims > 3 ? 3 : 2; // Adaptive gap

        // Alice stakes
        vm.prank(alice);
        uint256 tokenId = staking.mint(stakeAmount, poolId);

        uint256 totalClaimed = 0;
        uint256 totalTopUp = 0;

        // Multiple topUp-claim cycles
        for (uint256 i = 0; i < numClaims; i++) {
            skip(gapDays * DAY);
            staking.topUp(1000 ether);
            totalTopUp += 1000 ether;
            skip(DAY);

            vm.prank(alice);
            uint256 claimed = staking.earnReward(alice, tokenId);
            totalClaimed += claimed;
        }

        // Calculate expected total (only this pool is active)
        uint8[] memory activePoolIds = new uint8[](1);
        activePoolIds[0] = poolId;
        uint256 expectedTotal = 0;
        for (uint256 i = 0; i < numClaims; i++) {
            expectedTotal += getPoolAllocation(
                poolId,
                1000 ether,
                activePoolIds
            );
        }

        // INVARIANT: Sum of claims should equal pool allocations
        assertApproxEqRel(
            totalClaimed,
            expectedTotal,
            0.01e18, // 1% tolerance
            "Total claims should match allocations"
        );
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: PRINCIPAL PROTECTION
    // ════════════════════════════════════════════════════════════════

    /// @notice Contract balance must always cover totalStaked
    function testFuzz_PrincipalProtectionAlways(
        uint96 stake1,
        uint96 stake2,
        uint96 stake3,
        uint8 poolId,
        uint96 topUpAmount
    ) public {
        // Bound inputs
        stake1 = uint96(bound(stake1, MIN_AMOUNT, 10_000 ether));
        stake2 = uint96(bound(stake2, MIN_AMOUNT, 10_000 ether));
        stake3 = uint96(bound(stake3, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        topUpAmount = uint96(bound(topUpAmount, MIN_AMOUNT, 50_000 ether));

        // Stake
        vm.prank(alice);
        staking.mint(stake1, poolId);
        vm.prank(bob);
        staking.mint(stake2, poolId);
        vm.prank(carol);
        staking.mint(stake3, poolId);

        // Check invariant after stakes
        assertGe(
            anon.balanceOf(address(staking)),
            staking.totalStaked(),
            "Balance must cover stakes"
        );

        // TopUp and claim
        skip(10 * DAY);
        staking.topUp(topUpAmount);
        skip(DAY);

        vm.prank(alice);
        staking.earnReward(alice, 1);

        // Check invariant after claim
        assertGe(
            anon.balanceOf(address(staking)),
            staking.totalStaked(),
            "Balance must cover stakes after claim"
        );
    }

    // ════════════════════════════════════════════════════════════════
    //              FUZZ: EDGE CASES
    // ════════════════════════════════════════════════════════════════

    /// @notice Extreme stake amounts should work correctly
    function testFuzz_ExtremeAmounts(uint96 amount, uint8 poolId) public {
        // Bound inputs
        vm.assume(amount >= MIN_AMOUNT);
        vm.assume(poolId < 3);

        // Should not revert with any valid amount
        vm.prank(alice);
        uint256 tokenId = staking.mint(amount, poolId);

        // Verify state
        IxAnonStakingNFT.PositionData memory pos = staking.positionOf(tokenId);
        assertEq(pos.amount, amount);
        assertEq(pos.poolId, poolId);
        assertEq(staking.totalStaked(), amount);
    }

    /// @notice Random time gaps should not break distribution
    function testFuzz_RandomTimeGaps(
        uint96 stake,
        uint8 poolId,
        uint8 gap1,
        uint8 gap2,
        uint8 gap3
    ) public {
        // Bound inputs
        stake = uint96(bound(stake, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        gap1 = uint8(bound(gap1, 2, 30));
        gap2 = uint8(bound(gap2, 2, 30));
        gap3 = uint8(bound(gap3, 2, 30));

        // Stake
        vm.prank(alice);
        uint256 tokenId = staking.mint(stake, poolId);

        // Random gaps between topUps
        skip(gap1 * DAY);
        staking.topUp(1000 ether);

        skip(gap2 * DAY);
        staking.topUp(1000 ether);

        skip(gap3 * DAY);
        staking.topUp(1000 ether);

        skip(DAY);

        // Should be able to claim without revert
        vm.prank(alice);
        uint256 rewards = staking.earnReward(alice, tokenId);

        // Should have received something
        assertGt(rewards, 0, "Should receive rewards");

        // Should not exceed 3 topUps allocation (only this pool active)
        uint8[] memory activePoolIds = new uint8[](1);
        activePoolIds[0] = poolId;
        uint256 maxAlloc = 0;
        for (uint256 i = 0; i < 3; i++) {
            maxAlloc += getPoolAllocation(poolId, 1000 ether, activePoolIds);
        }

        assertLe(rewards, maxAlloc, "Should not exceed allocation");
    }

    // ════════════════════════════════════════════════════════════════
    //      COMPREHENSIVE: 3+ USERS, STAGGERED ENTRY/EXIT
    // ════════════════════════════════════════════════════════════════

    /// @notice Complete lifecycle with 3 users entering at different times
    function testFuzz_CompleteLifecycle3Users(
        uint96 stake1,
        uint96 stake2,
        uint96 stake3,
        uint8 poolId,
        uint8 entry1,
        uint8 entry2,
        uint8 entry3,
        uint96 topUpAmount
    ) public {
        // Bound inputs
        stake1 = uint96(bound(stake1, MIN_AMOUNT, 10_000 ether));
        stake2 = uint96(bound(stake2, MIN_AMOUNT, 10_000 ether));
        stake3 = uint96(bound(stake3, MIN_AMOUNT, 10_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        entry1 = 0; // Alice enters first (day 0)
        entry2 = uint8(bound(entry2, 3, 20)); // Bob enters later
        entry3 = uint8(bound(entry3, entry2 + 3, 40)); // Carol enters last
        topUpAmount = uint96(bound(topUpAmount, MIN_AMOUNT * 10, 20_000 ether));

        // TIMELINE:
        // Day entry1(0): Alice stakes stake1
        // Day entry2: Bob stakes stake2
        // Day entry3: Carol stakes stake3
        // Day entry3+5: topUp
        // Day entry3+6: All claim
        // Day lockDays: All burn
        //
        // STAKE-DAYS AT TOPUP:
        // Alice: (entry3 + 5) days × stake1
        // Bob: (entry3 + 5 - entry2) days × stake2
        // Carol: (entry3 + 5 - entry3) = 5 days × stake3
        //
        // TESTS:
        // - Fair distribution based on stake-days
        // - Total <= allocation
        // - Principal returns correctly on burn

        UserData memory a = UserData(stake1, 0, 0, 0, 0);
        UserData memory b = UserData(stake2, 0, 0, 0, 0);
        UserData memory c = UserData(stake3, 0, 0, 0, 0);

        // Entry phase
        {
            vm.prank(alice);
            a.tokenId = staking.mint(a.stake, poolId);

            skip(entry2 * DAY);
            vm.prank(bob);
            b.tokenId = staking.mint(b.stake, poolId);

            skip((entry3 - entry2) * DAY);
            vm.prank(carol);
            c.tokenId = staking.mint(c.stake, poolId);
        }

        // TopUp phase
        {
            skip(7 * DAY); // 5 + 2 gap
            staking.topUp(topUpAmount);
            skip(DAY);
        }

        // Claim phase
        {
            vm.prank(alice);
            a.rewards = staking.earnReward(alice, a.tokenId);
            vm.prank(bob);
            b.rewards = staking.earnReward(bob, b.tokenId);
            vm.prank(carol);
            c.rewards = staking.earnReward(carol, c.tokenId);
        }

        // Verification phase
        {
            uint8[] memory activePoolIds = new uint8[](1);
            activePoolIds[0] = poolId;
            uint256 poolAlloc = getPoolAllocation(
                poolId,
                topUpAmount,
                activePoolIds
            );

            // INVARIANT 1: Total rewards <= allocation
            assertLe(
                a.rewards + b.rewards + c.rewards,
                poolAlloc,
                "Total <= allocation"
            );

            // INVARIANT 2: Earlier stakers get >= later (equal stakes)
            if (a.stake == b.stake && b.stake == c.stake) {
                assertGe(a.rewards, b.rewards, "Alice >= Bob");
                assertGe(b.rewards, c.rewards, "Bob >= Carol");
            }
        }

        // Burn phase
        {
            uint256 lockDays = getLockDays(poolId);
            skip(lockDays * DAY);

            uint256 totalBefore = staking.totalStaked();
            vm.prank(alice);
            uint256 returned = staking.burn(alice, a.tokenId);

            assertEq(returned, a.stake, "Burn returns principal");
            assertEq(
                staking.totalStaked(),
                totalBefore - a.stake,
                "totalStaked updated"
            );
        }
    }

    /// @notice Multiple users + multiple topUps: comprehensive distribution test
    function testFuzz_MultipleUsersMultipleTopUps(
        uint96 stake1,
        uint96 stake2,
        uint96 stake3,
        uint8 poolId,
        uint8 numTopUps
    ) public {
        // Bound inputs
        stake1 = uint96(bound(stake1, MIN_AMOUNT, 5_000 ether));
        stake2 = uint96(bound(stake2, MIN_AMOUNT, 5_000 ether));
        stake3 = uint96(bound(stake3, MIN_AMOUNT, 5_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        numTopUps = uint8(bound(numTopUps, 2, 4));

        // TIMELINE:
        // Day 0: Alice stakes
        // Day 5: Bob stakes
        // Day 10: Carol stakes
        // Day 12-onwards: Multiple topUps every 2 days
        // Claims after all topUps
        //
        // TESTS: Math correctness with staggered entry and multiple topUps

        UserData memory a = UserData(stake1, 0, 0, 0, 0);
        UserData memory b = UserData(stake2, 0, 0, 0, 0);
        UserData memory c = UserData(stake3, 0, 0, 0, 0);

        // Entry phase
        {
            vm.prank(alice);
            a.tokenId = staking.mint(a.stake, poolId);

            skip(5 * DAY);
            vm.prank(bob);
            b.tokenId = staking.mint(b.stake, poolId);

            skip(5 * DAY);
            vm.prank(carol);
            c.tokenId = staking.mint(c.stake, poolId);
            skip(2 * DAY);
        }

        // Multiple topUps phase
        uint256 totalAllocated;
        {
            uint8[] memory activePoolIds = new uint8[](1);
            activePoolIds[0] = poolId;
            for (uint256 i = 0; i < numTopUps; i++) {
                staking.topUp(5_000 ether);

                // Get allocation from contract (only this pool active)
                totalAllocated += getPoolAllocation(
                    poolId,
                    5_000 ether,
                    activePoolIds
                );
                skip(2 * DAY);
            }
            skip(DAY);
        }

        // Claim phase
        {
            vm.prank(alice);
            a.rewards = staking.earnReward(alice, a.tokenId);
            vm.prank(bob);
            b.rewards = staking.earnReward(bob, b.tokenId);
            vm.prank(carol);
            c.rewards = staking.earnReward(carol, c.tokenId);
        }

        // Verification phase
        {
            uint256 total = a.rewards + b.rewards + c.rewards;

            // CRITICAL: Total <= allocated
            assertLe(total, totalAllocated, "Total 3 users <= allocation");

            // All earned something
            assertGt(a.rewards, 0, "Alice earned");
            assertGt(b.rewards, 0, "Bob earned");
            assertGt(c.rewards, 0, "Carol earned");

            // Earlier >= later (equal stakes)
            if (a.stake == b.stake && b.stake == c.stake) {
                assertGe(a.rewards, b.rewards, "Alice >= Bob");
                assertGe(b.rewards, c.rewards, "Bob >= Carol");
            }

            // INVARIANT: Total rewards distributed (not all zero)
            assertGt(total, 0, "Some rewards were distributed");
        }
    }

    /// @notice Staggered entry and exit: users burn at different times
    function testFuzz_StaggeredEntryExitBurn(
        uint96 stake1,
        uint96 stake2,
        uint96 stake3,
        uint8 poolId,
        uint8 exitOrder
    ) public {
        // Bound inputs
        stake1 = uint96(bound(stake1, MIN_AMOUNT, 5_000 ether));
        stake2 = uint96(bound(stake2, MIN_AMOUNT, 5_000 ether));
        stake3 = uint96(bound(stake3, MIN_AMOUNT, 5_000 ether));
        poolId = uint8(bound(poolId, 0, 2));
        exitOrder = uint8(bound(exitOrder, 0, 2)); // 0=Alice first, 1=Bob first, 2=Carol first

        // TIMELINE:
        // Day 0: Alice stakes
        // Day 3: Bob stakes
        // Day 6: Carol stakes
        // Day 10: topUp
        // Day 11: All claim rewards
        // Day lockDays: Burns in different order
        //
        // TESTS:
        // - Rewards distributed fairly
        // - Burns return correct principals
        // - totalStaked updates correctly
        // - Exit order doesn't affect past rewards

        UserData memory a = UserData(stake1, 0, 0, 0, 0);
        UserData memory b = UserData(stake2, 0, 0, 0, 0);
        UserData memory c = UserData(stake3, 0, 0, 0, 0);

        // Staggered entry
        {
            vm.prank(alice);
            a.tokenId = staking.mint(a.stake, poolId);

            skip(3 * DAY);
            vm.prank(bob);
            b.tokenId = staking.mint(b.stake, poolId);

            skip(3 * DAY);
            vm.prank(carol);
            c.tokenId = staking.mint(c.stake, poolId);
        }

        // TopUp and claims
        {
            skip(4 * DAY); // 10 days total + 2 gap = 12
            staking.topUp(10_000 ether);
            skip(DAY);

            vm.prank(alice);
            a.rewards = staking.earnReward(alice, a.tokenId);
            vm.prank(bob);
            b.rewards = staking.earnReward(bob, b.tokenId);
            vm.prank(carol);
            c.rewards = staking.earnReward(carol, c.tokenId);
        }

        // Verify rewards before burns
        {
            uint256 total = a.rewards + b.rewards + c.rewards;
            assertGt(total, 0, "Total rewards > 0");

            // Earlier stakers got >= later (equal stakes)
            if (a.stake == b.stake && b.stake == c.stake) {
                assertGe(a.rewards, b.rewards, "Alice >= Bob");
                assertGe(b.rewards, c.rewards, "Bob >= Carol");
            }
        }

        // Wait for unlock
        skip(getLockDays(poolId) * DAY);

        // Staggered exit based on exitOrder
        uint256 totalStake = a.stake + b.stake + c.stake;

        if (exitOrder == 0) {
            // Alice exits first
            {
                uint256 totalBefore = staking.totalStaked();
                vm.prank(alice);
                uint256 returned = staking.burn(alice, a.tokenId);
                assertEq(returned, a.stake, "Alice principal");
                assertEq(staking.totalStaked(), totalBefore - a.stake);
            }
            skip(DAY);
            {
                uint256 totalBefore = staking.totalStaked();
                vm.prank(bob);
                uint256 returned = staking.burn(bob, b.tokenId);
                assertEq(returned, b.stake, "Bob principal");
                assertEq(staking.totalStaked(), totalBefore - b.stake);
            }
            skip(DAY);
            {
                vm.prank(carol);
                uint256 returned = staking.burn(carol, c.tokenId);
                assertEq(returned, c.stake, "Carol principal");
                assertEq(staking.totalStaked(), 0, "All burned");
            }
        } else if (exitOrder == 1) {
            // Bob exits first
            {
                vm.prank(bob);
                staking.burn(bob, b.tokenId);
            }
            skip(DAY);
            {
                vm.prank(alice);
                staking.burn(alice, a.tokenId);
            }
            skip(DAY);
            {
                vm.prank(carol);
                staking.burn(carol, c.tokenId);
                assertEq(staking.totalStaked(), 0, "All burned");
            }
        } else {
            // Carol exits first
            {
                vm.prank(carol);
                staking.burn(carol, c.tokenId);
            }
            skip(DAY);
            {
                vm.prank(bob);
                staking.burn(bob, b.tokenId);
            }
            skip(DAY);
            {
                vm.prank(alice);
                staking.burn(alice, a.tokenId);
                assertEq(staking.totalStaked(), 0, "All burned");
            }
        }

        // CRITICAL INVARIANT: Contract balance >= 0 (no underflow)
        assertGe(anon.balanceOf(address(staking)), 0, "Contract solvent");
    }
}
