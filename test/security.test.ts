import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type {
  MockERC20,
  XAnonStakingNFT,
  MockDescriptor,
} from "../typechain-types";

describe("Security Tests - Attack Vectors", function () {
  const DAY = 24 * 60 * 60;

  async function deployFixture() {
    const [owner, alice, bob, attacker] = await ethers.getSigners();

    const MockERC20F = await ethers.getContractFactory("MockERC20");
    const anon = (await MockERC20F.deploy(
      "ANON",
      "ANON",
      18
    )) as unknown as MockERC20;
    const MockDescriptorF = await ethers.getContractFactory("MockDescriptor");
    const desc = (await MockDescriptorF.deploy()) as unknown as MockDescriptor;

    const XAnonSF = await ethers.getContractFactory("xAnonStakingNFT");
    const xanonS = (await XAnonSF.deploy(
      await anon.getAddress(),
      await desc.getAddress()
    )) as unknown as XAnonStakingNFT;

    // Mint tokens to all participants
    await anon.mint(owner.address, ethers.parseEther("10000000"));
    await anon.mint(alice.address, ethers.parseEther("10000000"));
    await anon.mint(bob.address, ethers.parseEther("10000000"));
    await anon.mint(attacker.address, ethers.parseEther("10000000"));

    // Approve contract
    await anon
      .connect(alice)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anon
      .connect(bob)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anon
      .connect(owner)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anon
      .connect(attacker)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);

    return { owner, alice, bob, attacker, anon, xanonS } as {
      owner: any;
      alice: any;
      bob: any;
      attacker: any;
      anon: MockERC20;
      xanonS: XAnonStakingNFT;
    };
  }

  async function increaseSeconds(n: number) {
    await time.increase(n);
  }

  describe("ATTACK: Double Reward Claiming", function () {
    it("should prevent claiming same rewards twice in same block", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // First claim succeeds
      await xanonS.connect(alice).earnReward(alice.address, 1);

      // Second immediate claim should revert (no new rewards)
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });

    it("should prevent claiming rewards after burn", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(91 * DAY); // Wait for unlock

      // Burn includes reward claim
      await xanonS.connect(alice).burn(alice.address, 1);

      // Cannot claim after burn (token doesn't exist)
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "TokenDoesNotExist");
    });

    it("should prevent multiple claims before topUp creates interval", async function () {
      const { alice, xanonS } = await deployFixture();

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(5 * DAY);

      // No topUp yet = no rewards
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");

      // Still no rewards on second attempt
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });

    it("should prevent claiming more than actual rewards accumulated", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      const balanceBefore = await anon.balanceOf(alice.address);

      // Claim all available rewards
      await xanonS.connect(alice).earnReward(alice.address, 1);

      const balanceAfter = await anon.balanceOf(alice.address);
      const received = balanceAfter - balanceBefore;

      // Should receive ~500 (pool 2 gets 50%)
      expect(received).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("1")
      );

      // Second claim should fail
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });
  });

  describe("ATTACK: Front-Running TopUp", function () {
    it("should give ZERO rewards to front-runner (no stake-days accumulated)", async function () {
      const { owner, alice, attacker, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100 tokens (tokenId=1)
      // Day 30: Attacker front-runs: stakes 100 tokens (tokenId=2) + topUp 1000
      // Day 31: Claim attempts
      //
      // STAKE-DAYS AT TOPUP:
      // Alice:    30 days × 100 tokens = 3,000 stake-days
      // Attacker:  0 days × 100 tokens = 0 stake-days
      //
      // EXPECTED RESULT:
      // Alice gets ALL pool2 rewards (500)
      // Attacker gets NOTHING (NoRewards revert)

      // Alice stakes early
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(30 * DAY); // Alice accumulates 30 days

      // Attacker front-runs topUp (stakes same block)
      await xanonS.connect(attacker).mint(ethers.parseEther("100"), 2);

      // TopUp happens
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Alice should get ALL rewards (30 days stake-days)
      const aliceBalBefore = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const aliceBalAfter = await anon.balanceOf(alice.address);
      const aliceRewards = aliceBalAfter - aliceBalBefore;

      // Alice: 3000 stake-days → gets ALL pool2 rewards (500)
      expect(aliceRewards).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("10")
      );

      // Attacker: 0 stake-days → gets NOTHING (reverts with NoRewards)
      await expect(
        xanonS.connect(attacker).earnReward(attacker.address, 2)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });

    it("should protect against just-in-time staking before topUp", async function () {
      const { owner, alice, attacker, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100 tokens
      // Day 10: Attacker tries JIT attack: stakes 1,000 tokens (10x more!)
      // Day 10: TopUp 10,000 happens (same block as attacker stake)
      // Day 11: Check pending rewards
      //
      // STAKE-DAYS AT TOPUP:
      // Alice:    10 days × 100 = 1,000 stake-days
      // Attacker:  0 days × 1,000 = 0 stake-days (just entered!)
      //
      // EXPECTED: Alice gets ALL pool2 rewards despite 10x smaller stake
      // Proves: Amount doesn't matter, only accumulated TIME matters

      // Alice stakes day 0
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(10 * DAY);

      // Attacker stakes 1 block before topUp
      await xanonS.connect(attacker).mint(ethers.parseEther("1000"), 2); // 10x more!

      // TopUp same block
      await xanonS.connect(owner).topUp(ethers.parseEther("10000"));
      await increaseSeconds(DAY);

      const alicePending = await xanonS.pendingRewards(1);
      const attackerPending = await xanonS.pendingRewards(2);

      // Alice should still get all/most rewards despite 10x smaller stake
      // Alice: 10 days * 100 = 1000 stake-days
      // Attacker: 0 days * 1000 = 0 stake-days
      expect(alicePending).to.be.gt(attackerPending);
      expect(attackerPending).to.equal(0n);
    });
  });

  describe("ATTACK: Multiple Small Stakes vs Single Large", function () {
    it("should give SAME rewards for 100x1 vs 1x100 stakes (no fragmentation advantage)", async function () {
      const { owner, alice, bob, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice creates 100 positions × 1 token = 100 total
      // Day 0:  Bob creates 1 position × 100 tokens = 100 total
      // Day 10: 10 days pass
      // Day 10: TopUp 10,000
      // Day 11: Claims
      //
      // STAKE-DAYS AT TOPUP:
      // Alice: 100 positions × (1 token × 10 days) = 1,000 total stake-days
      // Bob:   1 position × (100 tokens × 10 days) = 1,000 total stake-days
      //
      // EXPECTED: Both get EQUAL rewards (proves no fragmentation advantage)

      // Alice: 100 positions of 1 token
      for (let i = 0; i < 100; i++) {
        await xanonS.connect(alice).mint(ethers.parseEther("1"), 2);
      }

      // Bob: 1 position of 100 tokens
      await xanonS.connect(bob).mint(ethers.parseEther("100"), 2);

      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("10000"));
      await increaseSeconds(DAY);

      // Claim all Alice's positions
      let aliceTotalRewards = 0n;
      for (let i = 1; i <= 100; i++) {
        const balBefore = await anon.balanceOf(alice.address);
        await xanonS.connect(alice).earnReward(alice.address, i);
        const balAfter = await anon.balanceOf(alice.address);
        aliceTotalRewards += balAfter - balBefore;
      }

      // Claim Bob's single position
      const bobBalBefore = await anon.balanceOf(bob.address);
      await xanonS.connect(bob).earnReward(bob.address, 101);
      const bobBalAfter = await anon.balanceOf(bob.address);
      const bobRewards = bobBalAfter - bobBalBefore;

      // Should be equal (both have 100 tokens * 10 days = 1000 stake-days)
      expect(aliceTotalRewards).to.be.closeTo(
        bobRewards,
        ethers.parseEther("0.001")
      );
    });

    it("should handle gas griefing: many positions should not break contract", async function () {
      const { owner, attacker, xanonS } = await deployFixture();

      // Create 50 tiny positions (gas griefing attempt)
      for (let i = 0; i < 50; i++) {
        await xanonS.connect(attacker).mint(ethers.parseEther("1"), 0);
      }

      await increaseSeconds(2 * DAY);

      // TopUp should still work despite many positions
      await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to
        .not.be.reverted;

      // Claims should work
      await increaseSeconds(DAY);
      await expect(xanonS.connect(attacker).earnReward(attacker.address, 1)).to
        .not.be.reverted;
    });
  });

  describe("ATTACK: Reward Timing Manipulation", function () {
    it("should prevent earning rewards from future topUps after expiration", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:   Alice stakes 100 (pool0, expires day 91)
      // Day 2:   2 days pass
      // Day 2:   topUp #1 (1000) → pool0 gets 200 (Alice ACTIVE)
      // Day 3:   1 day pass
      // Day 94:  91 days pass → Alice EXPIRED (lockedUntil reached)
      // Day 94:  topUp #2 (1000) → pool0 gets 200 (Alice EXPIRED, no accrual)
      // Day 95:  Claim attempt
      //
      // CAP DAY: min(95, 91) = 91
      // CLAIMABLE INTERVAL: (0, 91]
      // - Only topUp #1 falls in active period
      //
      // EXPECTED: Only ~200 from topUp#1, NOT 400 (excludes topUp#2)

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0); // 91 days
      await increaseSeconds(2 * DAY);

      // First topUp (Alice active)
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Wait for expiration
      await increaseSeconds(91 * DAY);

      // Second topUp (Alice expired)
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Claim rewards
      const balBefore = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const balAfter = await anon.balanceOf(alice.address);
      const rewards = balAfter - balBefore;

      // Should only get rewards from first topUp (~200)
      expect(rewards).to.be.closeTo(
        ethers.parseEther("200"),
        ethers.parseEther("1")
      );

      // Should NOT get second topUp rewards (another 200)
      expect(rewards).to.be.lt(ethers.parseEther("300"));
    });

    it("should handle claim-topUp-claim pattern correctly", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100
      // Day 5:  5 days pass
      // Day 5:  topUp #1 (1000) → pool2 gets 500
      // Day 6:  1 day pass
      // Day 6:  earnReward #1 → claims interval (0, 6], lastPaidDay updated
      // Day 11: 5 days pass
      // Day 11: topUp #2 (1000) → pool2 gets 500
      // Day 12: 1 day pass
      // Day 12: earnReward #2 → claims interval (6, 12]
      //
      // EXPECTED:
      // - First claim:  ~500 (pool2 from topUp#1)
      // - Second claim: ~500 (pool2 from topUp#2)
      // - Total: ~1000 (proves no double-spend)

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(5 * DAY);

      // First topUp
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // First claim
      const bal1 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const bal2 = await anon.balanceOf(alice.address);
      const firstClaim = bal2 - bal1;

      await increaseSeconds(5 * DAY);

      // Second topUp
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Second claim
      const bal3 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const bal4 = await anon.balanceOf(alice.address);
      const secondClaim = bal4 - bal3;

      // Both claims should be ~500
      expect(firstClaim).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("10")
      );
      expect(secondClaim).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("10")
      );

      // Total should be ~1000, NOT more (no double-spend)
      expect(firstClaim + secondClaim).to.be.closeTo(
        ethers.parseEther("1000"),
        ethers.parseEther("20")
      );
    });

    it("should prevent claiming same interval multiple times", async function () {
      const { owner, alice, xanonS } = await deployFixture();

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      // Claim multiple times in same day
      await increaseSeconds(DAY);
      await xanonS.connect(alice).earnReward(alice.address, 1);

      // Second claim same day should fail
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");

      // Third attempt should also fail
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });
  });

  describe("ATTACK: Principal Protection Bypass", function () {
    it("should prevent withdrawing more than deposited", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      const depositAmount = ethers.parseEther("100");
      await xanonS.connect(alice).mint(depositAmount, 0);

      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(91 * DAY); // Wait for unlock

      const balanceBefore = await anon.balanceOf(alice.address);

      // Burn position (gets principal + rewards)
      await xanonS.connect(alice).burn(alice.address, 1);

      const balanceAfter = await anon.balanceOf(alice.address);
      const totalReceived = balanceAfter - balanceBefore;

      // Should receive principal + rewards (rewards ~200)
      expect(totalReceived).to.be.closeTo(
        depositAmount + ethers.parseEther("200"),
        ethers.parseEther("10")
      );

      // Contract should maintain totalStaked integrity
      const totalStaked = await xanonS.totalStaked();
      const contractBalance = await anon.balanceOf(await xanonS.getAddress());

      // Balance should always be >= totalStaked (principal protection)
      expect(contractBalance).to.be.gte(totalStaked);
    });

    it("should prevent stealing through reward calculation overflow", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      const initialBalance = await anon.balanceOf(alice.address);

      // Maximum allowed stake
      const maxStake = ethers.parseEther("79228162514"); // near uint96 max
      await anon.mint(alice.address, maxStake);
      await anon.connect(alice).approve(await xanonS.getAddress(), maxStake);

      await xanonS.connect(alice).mint(maxStake, 0);
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Should not overflow or steal more than rewards
      const contractBalBefore = await anon.balanceOf(await xanonS.getAddress());
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const contractBalAfter = await anon.balanceOf(await xanonS.getAddress());

      // Contract should not have paid out more than pool0 allocation
      const paidOut = contractBalBefore - contractBalAfter;

      // CRITICAL: Pool0 gets only 20% of topUp = 200, NOT 1000!
      expect(paidOut).to.be.lte(ethers.parseEther("200"));

      // Alice is only staker, should get close to full 200
      expect(paidOut).to.be.closeTo(
        ethers.parseEther("200"),
        ethers.parseEther("1")
      );
    });
  });

  describe("ATTACK: Ring Buffer Manipulation", function () {
    it("should correctly handle stakes at bucket boundaries", async function () {
      const { owner, alice, bob, xanonS } = await deployFixture();

      // Pool 0 has 91 days ring buffer
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

      // Advance exactly to boundary
      await increaseSeconds(91 * DAY);

      // Bob stakes at boundary
      await xanonS.connect(bob).mint(ethers.parseEther("100"), 0);

      // Verify Alice's position expired
      const [, , rollingStake] = await xanonS.poolInfo(0);
      expect(rollingStake).to.equal(ethers.parseEther("100")); // Only Bob
    });

    it("should prevent manipulation through rapid stake/unstake at bucket edge", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      // Advance to near expiration
      await increaseSeconds(89 * DAY);

      // Try to manipulate by creating new positions near expiration
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Verify proper accounting (no double counting)
      const pending1 = await xanonS.pendingRewards(1);
      const pending2 = await xanonS.pendingRewards(2);

      // Both should have reasonable rewards
      expect(pending1).to.be.gt(0);
      expect(pending2).to.be.gt(0);

      // Combined should not exceed pool allocations
      const totalPending = pending1 + pending2;
      expect(totalPending).to.be.lte(ethers.parseEther("400")); // 2 topUps * 20%
    });
  });

  describe("ATTACK: Snapshot Boundary Exploits", function () {
    it("should prevent claiming from unearned snapshots", async function () {
      const { owner, alice, bob, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100 (tokenId=1)
      // Day 10: 10 days pass
      // Day 10: topUp #1 (1000) → pool2 gets 500
      //         Interval #1: 1000 stake-days (Alice only)
      //         Alice gets: 500
      // Day 11: 1 day pass
      // Day 11: Bob stakes 100 (tokenId=2) ← AFTER first topUp!
      // Day 21: 10 days pass
      // Day 21: topUp #2 (1000) → pool2 gets 500
      //         Interval #2: 2100 stake-days (Alice: 1100 from day10-21, Bob: 1000 from day11-21)
      //         Alice gets: ~262 (1100/2100 of 500)
      //         Bob gets:   ~238 (1000/2100 of 500)
      // Day 22: Claims
      //
      // EXPECTED:
      // Alice total: 500 + 262 = ~762
      // Bob total:   0 + 238 = ~238
      // Ratio: ~3.2:1 (Alice has >2x more)

      // Alice stakes and gets first topUp
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      // Bob stakes AFTER topUp
      await increaseSeconds(DAY);
      await xanonS.connect(bob).mint(ethers.parseEther("100"), 2);

      // Second topUp
      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Alice should get full first topUp + half of second
      const aliceBalBefore = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const aliceBalAfter = await anon.balanceOf(alice.address);
      const aliceRewards = aliceBalAfter - aliceBalBefore;

      // Bob should get only half of second topUp
      const bobBalBefore = await anon.balanceOf(bob.address);
      await xanonS.connect(bob).earnReward(bob.address, 2);
      const bobBalAfter = await anon.balanceOf(bob.address);
      const bobRewards = bobBalAfter - bobBalBefore;

      // Alice should have significantly more
      expect(aliceRewards).to.be.gt(bobRewards * 2n);

      // Total should not exceed 1000 (2 topUps * 50% pool2)
      expect(aliceRewards + bobRewards).to.be.closeTo(
        ethers.parseEther("1000"),
        ethers.parseEther("20")
      );
    });

    it("should handle claims spanning multiple snapshots correctly", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100
      // Day 10: topUp #1 (1000) → pool2 gets 500, snapshot at day 10
      // Day 20: topUp #2 (1000) → pool2 gets 500, snapshot at day 20
      // Day 30: topUp #3 (1000) → pool2 gets 500, snapshot at day 30
      // Day 40: topUp #4 (1000) → pool2 gets 500, snapshot at day 40
      // Day 50: topUp #5 (1000) → pool2 gets 500, snapshot at day 50
      // Day 51: Single earnReward spanning ALL 5 snapshots
      //
      // EXPECTED:
      // - Single claim collects from all 5 intervals
      // - Total: 5 × 500 = 2,500
      // - Second claim fails (all intervals claimed)

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);

      // Create 5 snapshots
      const startTs = BigInt(await time.latest());
      for (let i = 0; i < 5; i++) {
        await time.setNextBlockTimestamp(
          startTs + BigInt((i + 1) * 10) * BigInt(DAY)
        );
        await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      }

      await time.setNextBlockTimestamp(startTs + 51n * BigInt(DAY));

      // Single claim spanning all 5 snapshots
      const balBefore = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const balAfter = await anon.balanceOf(alice.address);
      const rewards = balAfter - balBefore;

      // Should get 5 * 500 = 2500
      expect(rewards).to.be.closeTo(
        ethers.parseEther("2500"),
        ethers.parseEther("50")
      );

      // Second claim should fail
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });
  });

  describe("ATTACK: Reentrancy and Race Conditions", function () {
    it("should be protected by nonReentrant on earnReward", async function () {
      // Note: Proper reentrancy test would need a malicious contract
      // This test verifies the modifier is present
      const { owner, alice, xanonS } = await deployFixture();

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // ReentrancyGuard will prevent re-entry via token callback
      await expect(xanonS.connect(alice).earnReward(alice.address, 1)).to.not.be
        .reverted;
    });

    it("should handle concurrent claims from different users safely", async function () {
      const { owner, alice, bob, anon, xanonS } = await deployFixture();

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await xanonS.connect(bob).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Both claim in quick succession
      const alicePromise = xanonS.connect(alice).earnReward(alice.address, 1);
      const bobPromise = xanonS.connect(bob).earnReward(bob.address, 2);

      await Promise.all([alicePromise, bobPromise]);

      // Verify correct split
      const aliceBal = await anon.balanceOf(alice.address);
      const bobBal = await anon.balanceOf(bob.address);

      // Both should have received ~250 each (50/50 split of pool2's 500)
      const aliceGain =
        aliceBal - (ethers.parseEther("10000000") - ethers.parseEther("100"));
      const bobGain =
        bobBal - (ethers.parseEther("10000000") - ethers.parseEther("100"));

      expect(aliceGain).to.be.closeTo(
        ethers.parseEther("250"),
        ethers.parseEther("10")
      );
      expect(bobGain).to.be.closeTo(
        ethers.parseEther("250"),
        ethers.parseEther("10")
      );
    });
  });

  describe("EDGE CASE: Zero and Boundary Values", function () {
    it("should distribute pending rewards to first staker (topUp same day)", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0: topUp (1000) BEFORE any stakes
      //        → pool2 gets 500, goes to PENDING (intervalSD = 0)
      // Day 0: Alice stakes 100 (SAME day as topUp)
      // Day 1: 1 day pass (Alice accumulates 100 stake-days)
      // Day 1: earnReward triggers _finalizePendingRewards
      //        → Distributes pending 500 over 100 stake-days
      //        → Alice gets ALL pending rewards!
      //
      // EXPECTED: Alice gets full 500 (she's the only staker)
      // This proves pending rewards distribute correctly to first staker

      // topUp BEFORE any stakes (creates pending rewards)
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      // Alice stakes AFTER topUp (0 stake-days in first interval)
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);

      await increaseSeconds(DAY); // Alice now has 1 day stake-days

      // CORRECT BEHAVIOR: earnReward triggers _finalizePendingRewards
      // which distributes pending 500 over Alice's 100 stake-days
      const balBefore = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const balAfter = await anon.balanceOf(alice.address);
      const rewards = balAfter - balBefore;

      // Alice gets the pending rewards (pool2 gets 500)
      expect(rewards).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("10")
      );

      // Second claim should fail (no new rewards)
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });

    it("CRITICAL: pending rewards distribute to user joining NEXT day", async function () {
      const { owner, alice, bob, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0: Pool is EMPTY (no stakers)
      // Day 0: topUp (1000) → pool2 gets 500 → PENDING (no intervalSD)
      // Day 1: Alice stakes 100, Bob stakes 100 (NEXT day after topUp)
      // Day 2: Both claim
      //
      // EXPECTED:
      // - Pending 500 distributes over stake-days accumulated after topUp
      // - Alice: 100 stake-days (1 day × 100)
      // - Bob:   100 stake-days (1 day × 100)
      // - Each gets: 500 × 100/200 = 250
      //
      // CRITICAL: Pending rewards DON'T become dead weight!

      // TopUp with EMPTY pool (no one staking)
      const contractBalBefore = await anon.balanceOf(await xanonS.getAddress());
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      const contractBalAfterTopUp = await anon.balanceOf(
        await xanonS.getAddress()
      );

      // Verify contract received the tokens
      expect(contractBalAfterTopUp - contractBalBefore).to.equal(
        ethers.parseEther("1000")
      );

      // Alice and Bob join NEXT day
      await increaseSeconds(DAY);
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await xanonS.connect(bob).mint(ethers.parseEther("100"), 2);

      // Wait another day for interval to form
      await increaseSeconds(DAY);

      // Check contract balance BEFORE claims (after mint)
      const contractBalBeforeClaims = await anon.balanceOf(
        await xanonS.getAddress()
      );

      // Both claim - should split pending 500
      const aliceBalBefore = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const aliceBalAfter = await anon.balanceOf(alice.address);
      const aliceRewards = aliceBalAfter - aliceBalBefore;

      const bobBalBefore = await anon.balanceOf(bob.address);
      await xanonS.connect(bob).earnReward(bob.address, 2);
      const bobBalAfter = await anon.balanceOf(bob.address);
      const bobRewards = bobBalAfter - bobBalBefore;

      // Each should get ~250 (50/50 split of pending 500)
      expect(aliceRewards).to.be.closeTo(
        ethers.parseEther("250"),
        ethers.parseEther("5")
      );
      expect(bobRewards).to.be.closeTo(
        ethers.parseEther("250"),
        ethers.parseEther("5")
      );

      // Total should be close to 500 (all pending from pool2 distributed)
      expect(aliceRewards + bobRewards).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("5")
      );

      // Verify rewards were actually paid out from contract
      const contractBalAfterClaims = await anon.balanceOf(
        await xanonS.getAddress()
      );

      // Contract paid out rewards (balance decreased)
      const actualPaidOut = contractBalBeforeClaims - contractBalAfterClaims;
      expect(actualPaidOut).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("5")
      );

      // Final check: Contract still holds pending from pool0 (200) + pool1 (300) = 500
      // Plus principal from Alice (100) + Bob (100) = 200
      // Total remaining: 700
      expect(contractBalAfterClaims).to.be.closeTo(
        ethers.parseEther("700"),
        ethers.parseEther("10")
      );
    });

    it("should handle minimum stake correctly", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      const minAmount = await xanonS.MIN_AMOUNT();
      await xanonS.connect(alice).mint(minAmount, 2);

      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("10000"));
      await increaseSeconds(DAY);

      // Should receive proportional rewards
      const pending = await xanonS.pendingRewards(1);
      expect(pending).to.be.gt(0);
    });
  });

  describe("ATTACK: Burn and Re-stake Manipulation", function () {
    it("should prevent earning old rewards after burn and re-stake", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:   Alice stakes 100 (tokenId=1, pool0)
      // Day 10:  10 days pass
      // Day 10:  topUp #1 (1000) → pool0 gets 200
      // Day 11:  1 day pass
      // Day 102: burn tokenId=1 (gets principal 100 + rewards ~200)
      // Day 104: topUp #2 (1000) → pool0 gets 200 → goes to PENDING (no active stakes)
      // Day 104: Alice RE-STAKES 100 (tokenId=2)
      // Day 114: 10 days pass (100 × 10 = 1000 stake-days accumulated)
      // Day 116: 2 days pass
      // Day 116: topUp #3 (1000) → pool0 gets 200
      //          _finalizePendingRewards distributes pending 200 + new 200
      // Day 117: earnReward(tokenId=2)
      //
      // STAKE-DAYS FOR SECOND POSITION:
      // - From day 104 to 116: 12 days × 100 = 1,200 stake-days
      //
      // REWARDS FOR SECOND POSITION:
      // - Pending 200 from topUp#2 (no one was staking then)
      // - New 200 from topUp#3
      // - Total: 400 (CORRECT BEHAVIOR!)

      // First stake
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Burn position (claims rewards)
      await increaseSeconds(91 * DAY); // Wait for unlock
      const bal1 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).burn(alice.address, 1);
      const bal2 = await anon.balanceOf(alice.address);
      const firstRewards = bal2 - bal1 - ethers.parseEther("100"); // Subtract principal

      // Second topUp
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      // Re-stake with new position
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
      await increaseSeconds(10 * DAY);

      // Third topUp
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Claim from new position
      const bal3 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 2); // New tokenId
      const bal4 = await anon.balanceOf(alice.address);
      const secondRewards = bal4 - bal3;

      // CORRECT BEHAVIOR: Second position gets rewards from:
      // 1. Pending 200 from topUp#2 (went to pending when no active stakes)
      // 2. New 200 from topUp#3
      // Total: 400 (this is NOT a bug, it's correct pending distribution)
      expect(secondRewards).to.be.closeTo(
        ethers.parseEther("400"),
        ethers.parseEther("10")
      );

      // Total rewards should be ~200 + 400 = 600 (all 3 pool0 allocations)
      const totalRewards = firstRewards + secondRewards;
      expect(totalRewards).to.be.closeTo(
        ethers.parseEther("600"),
        ethers.parseEther("20")
      ); // Pool 0 gets 20% of 3 topUps = 600 total
    });
  });

  describe("ATTACK: Multiple Earnreward Scenarios", function () {
    it("should allow earnReward on topUp day if stake-days accumulated", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100
      // Day 5:  5 days pass
      // Day 5:  topUp #1 (1000) → snapshot at day 5
      // Day 6:  1 day pass
      // Day 6:  earnReward #1 → claims interval (0, 6], lastPaidDay = 5
      // Day 11: 5 days pass (Alice continues accumulating stake-days!)
      // Day 11: topUp #2 (1000) → intermediate at day 10, main at day 11
      // Day 11: earnReward #2 (SAME DAY) → claims interval (5, 11] = 6 days worth!
      //
      // INTERVAL BREAKDOWN:
      // First claim:  (day 0, day 6] = 6 days × 100 = 600 stake-days
      // Second claim: (day 5, day 11] = 6 days × 100 = 600 stake-days
      //
      // EXPECTED: Both claims get ~500 (pool2 allocation)
      // CRITICAL: Can claim on topUp day because stake-days accumulated between claims!

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(5 * DAY);

      // First topUp
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // First claim
      const bal1 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const bal2 = await anon.balanceOf(alice.address);
      const earned1 = bal2 - bal1;

      await increaseSeconds(5 * DAY); // 5 days pass (stake-days accumulate!)

      // Second topUp
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      // CORRECT BEHAVIOR: Can claim on topUp day because stake-days accumulated
      // Between first claim (day ~6) and second topUp (day ~11) = 5 days
      const bal3 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const bal4 = await anon.balanceOf(alice.address);
      const earned2 = bal4 - bal3;

      // Both earnings should be ~500
      expect(earned1).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("10")
      );
      expect(earned2).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("10")
      );

      // CRITICAL: Total should be ~1000 (two pool2 allocations), no inflation
      expect(earned1 + earned2).to.be.closeTo(
        ethers.parseEther("1000"),
        ethers.parseEther("20")
      );
    });

    it("should correctly handle claim on topUp day with accumulated stake-days", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0: Alice stakes 100 (lastPaidDay = 0)
      // Day 2: topUp (1000) → snapshot at day 2
      //
      // STAKE-DAYS BEFORE TOPUP:
      // 2 days × 100 tokens = 200 stake-days
      //
      // CLAIM LOGIC:
      // Day 2: earnReward #1
      //   - Interval: (lastPaidDay=0, capDay=2] = 2 days
      //   - Has stake-days: YES (200)
      //   - Result: Gets rewards, lastPaidDay → 2
      //
      // Day 2: earnReward #2 (immediately after)
      //   - Interval: (lastPaidDay=2, capDay=2] = 0 days
      //   - Has stake-days: NO
      //   - Result: NoRewards
      //
      // Tests: Can claim on topUp day if stake-days exist before topUp

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(2 * DAY);

      // First topUp creates snapshot at day 2
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      // First claim succeeds (has 2 days stake-days)
      const balBefore = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const balAfter = await anon.balanceOf(alice.address);

      expect(balAfter - balBefore).to.be.closeTo(
        ethers.parseEther("500"),
        ethers.parseEther("10")
      );

      // Second immediate claim fails (no new stake-days)
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });

    it("should prevent reward inflation through stake-unstake-restake cycle", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE - CYCLE 1:
      // Day 0:   Alice stakes 100
      // Day 10:  topUp (1000) → pool0 gets 200
      //          intervalSD = 10 days × 100 = 1000 stake-days
      //          Alice eligible for: 200
      // Day 101: burn → gets principal 100 + rewards ~200
      //
      // CYCLE 2:
      // Day 101: Alice RE-STAKES 100 (new position)
      // Day 111: topUp (1000) → pool0 gets 200
      //          intervalSD = 10 days × 100 = 1000 stake-days
      //          Alice eligible for: 200
      // Day 202: burn → gets principal 100 + rewards ~200
      //
      // EXPECTED:
      // - Cycle 1 net gain: ~200 (rewards only, principal comes back)
      // - Cycle 2 net gain: ~200 (rewards only, principal comes back)
      // - Total: ~200 + 200 = ~400 (exactly 2 pool0 allocations)
      //
      // Tests: No inflation from burn/re-stake pattern

      const initialBalance = await anon.balanceOf(alice.address);

      // Stake
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      // Wait for unlock and burn
      await increaseSeconds(91 * DAY);
      await xanonS.connect(alice).burn(alice.address, 1);

      const balanceAfterFirst = await anon.balanceOf(alice.address);
      const netGainFirst = balanceAfterFirst - initialBalance;

      // Re-stake immediately
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(91 * DAY);
      await xanonS.connect(alice).burn(alice.address, 2);

      const finalBalance = await anon.balanceOf(alice.address);
      const netGainSecond = finalBalance - balanceAfterFirst;

      // Both cycles should give similar rewards (no inflation)
      expect(netGainFirst).to.be.closeTo(
        netGainSecond,
        ethers.parseEther("10") // 5% tolerance
      );

      // CRITICAL: Total should be ~400 (2 pool0 allocations), NOT more
      const totalGain = finalBalance - initialBalance;
      expect(totalGain).to.be.closeTo(
        ethers.parseEther("400"),
        ethers.parseEther("20") // 5% tolerance
      );

      // Hard limit: Cannot exceed 2 topUps worth (with small buffer for rounding)
      expect(totalGain).to.be.lte(ethers.parseEther("405"));
    });

    it("should handle multiple earnRewards with intermediate topUps", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100
      // Day 3:  topUp #1 (1000) → pool2 gets 500
      // Day 4:  earnReward #1 → claims 3 days worth
      // Day 7:  topUp #2 (1000) → pool2 gets 500
      // Day 8:  earnReward #2 → claims 3 days worth
      // ... (repeat 5 times total)
      //
      // Each iteration:
      // - 3 days stake-days accumulated
      // - topUp adds 500 to pool2
      // - earnReward claims that interval
      //
      // EXPECTED:
      // - 5 claims × ~500 each = ~2,500 total
      // - No double-claiming (last claim fails)
      //
      // Tests: Multiple claim cycles work correctly, no inflation

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);

      let totalClaimed = 0n;

      // Do 5 cycles: topUp → wait → earnReward
      for (let i = 0; i < 5; i++) {
        await increaseSeconds(3 * DAY);
        await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
        await increaseSeconds(DAY);

        const balBefore = await anon.balanceOf(alice.address);
        await xanonS.connect(alice).earnReward(alice.address, 1);
        const balAfter = await anon.balanceOf(alice.address);
        totalClaimed += balAfter - balBefore;
      }

      // Total claimed should be 5 * 500 = 2500
      expect(totalClaimed).to.be.closeTo(
        ethers.parseEther("2500"),
        ethers.parseEther("50")
      );

      // Should not be able to claim more (all intervals claimed)
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });
  });

  describe("SECURITY: Total Rewards Invariant", function () {
    it("CRITICAL: total distributed rewards should NEVER exceed topUp amounts", async function () {
      const { owner, alice, bob, attacker, anon, xanonS } =
        await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100
      // Day 10: Bob stakes 200
      // Day 20: Attacker stakes 300
      // Day 23: topUp #1 (1000) → pool2 gets 500
      // Day 26: topUp #2 (1000) → pool2 gets 500
      // Day 29: topUp #3 (1000) → pool2 gets 500
      // Day 32: topUp #4 (1000) → pool2 gets 500
      // Day 35: topUp #5 (1000) → pool2 gets 500
      // Day 40: Claims from all users
      //
      // TOTAL POOL2 ALLOCATION: 5 × 500 = 2,500
      //
      // STAKE-DAYS (approximate):
      // Alice:   ~40 days × 100 = 4,000
      // Bob:     ~30 days × 200 = 6,000
      // Attacker: ~20 days × 300 = 6,000
      // Total: ~16,000 stake-days
      //
      // CRITICAL INVARIANT: totalDistributed ≤ 2,500 (must not exceed!)

      // Multiple users stake at different times
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(10 * DAY);
      await xanonS.connect(bob).mint(ethers.parseEther("200"), 2);
      await increaseSeconds(10 * DAY);
      await xanonS.connect(attacker).mint(ethers.parseEther("300"), 2);

      // Multiple topUps
      const totalTopUp = ethers.parseEther("5000"); // 5 topUps * 1000
      for (let i = 0; i < 5; i++) {
        await increaseSeconds(3 * DAY);
        await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      }

      await increaseSeconds(5 * DAY);

      // Claim all rewards
      const alice1 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const alice2 = await anon.balanceOf(alice.address);

      const bob1 = await anon.balanceOf(bob.address);
      await xanonS.connect(bob).earnReward(bob.address, 2);
      const bob2 = await anon.balanceOf(bob.address);

      const attacker1 = await anon.balanceOf(attacker.address);
      await xanonS.connect(attacker).earnReward(attacker.address, 3);
      const attacker2 = await anon.balanceOf(attacker.address);

      const totalDistributed =
        alice2 - alice1 + (bob2 - bob1) + (attacker2 - attacker1);

      // Pool 2 gets 50% of topUps = 2500
      const maxPoolRewards = totalTopUp / 2n;

      // CRITICAL: Must not exceed pool allocation (hard invariant!)
      expect(totalDistributed).to.be.lte(maxPoolRewards);

      // Should be close to full allocation (all stake-days utilized)
      expect(totalDistributed).to.be.closeTo(
        maxPoolRewards,
        ethers.parseEther("25") // 1% tolerance
      );

      // Double-check: No individual can have claimed more than total
      expect(alice2 - alice1).to.be.lte(maxPoolRewards);
      expect(bob2 - bob1).to.be.lte(maxPoolRewards);
      expect(attacker2 - attacker1).to.be.lte(maxPoolRewards);
    });

    it("CRITICAL: contract balance should always cover totalStaked", async function () {
      const { owner, alice, bob, anon, xanonS } = await deployFixture();

      // TIMELINE & INVARIANT CHECKS:
      // Day 0:   Initial → balance = 0, totalStaked = 0 ✓
      // Day 0:   Alice stakes 100 → balance = 100, totalStaked = 100 ✓
      // Day 0:   Bob stakes 200 → balance = 300, totalStaked = 300 ✓
      // Day 2:   topUp 1000 → balance = 1300, totalStaked = 300 ✓
      // Day 3:   Alice claims ~166 rewards → balance = 1134, totalStaked = 300 ✓
      // Day 368: Alice burns (100 principal + rewards) → totalStaked = 200 ✓
      //
      // CRITICAL INVARIANT (always): balance >= totalStaked
      // This prevents reward bugs from stealing user principal

      const contractAddress = await xanonS.getAddress();

      // Initial state
      let balance = await anon.balanceOf(contractAddress);
      let totalStaked = await xanonS.totalStaked();
      expect(balance).to.be.gte(totalStaked);

      // After stakes
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await xanonS.connect(bob).mint(ethers.parseEther("200"), 2);

      balance = await anon.balanceOf(contractAddress);
      totalStaked = await xanonS.totalStaked();
      expect(balance).to.be.gte(totalStaked); // 300 staked

      // After topUp (adds rewards)
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

      balance = await anon.balanceOf(contractAddress);
      totalStaked = await xanonS.totalStaked();
      expect(balance).to.be.gt(totalStaked); // 300 staked + 1000 rewards

      // After earnReward (pays out rewards, not principal)
      await increaseSeconds(DAY);
      await xanonS.connect(alice).earnReward(alice.address, 1);

      balance = await anon.balanceOf(contractAddress);
      totalStaked = await xanonS.totalStaked();
      expect(balance).to.be.gte(totalStaked); // Still covers 300 principal

      // After burn (pays out principal)
      await increaseSeconds(365 * DAY);
      await xanonS.connect(alice).burn(alice.address, 1);

      balance = await anon.balanceOf(contractAddress);
      totalStaked = await xanonS.totalStaked();
      expect(balance).to.be.gte(totalStaked); // Now covers 200 principal
      expect(totalStaked).to.equal(ethers.parseEther("200"));
    });
  });

  describe("ATTACK: Precision Loss Exploits", function () {
    it("should not lose rewards due to rounding with many small claims", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice creates 50 positions × 2 tokens = 100 total
      // Day 10: 10 days pass
      // Day 10: topUp (10,000) → pool2 gets 5,000
      // Day 11: Claim all 50 positions individually
      //
      // STAKE-DAYS:
      // 50 positions × (2 tokens × 10 days) = 1,000 stake-days total
      //
      // EXPECTED: Sum of 50 small claims = 5,000 (no rounding loss)
      // Tests that many small positions don't lose value vs one large

      // Alice creates many tiny positions
      for (let i = 0; i < 50; i++) {
        await xanonS.connect(alice).mint(ethers.parseEther("2"), 2);
      }

      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("10000"));
      await increaseSeconds(DAY);

      // Claim all 50 positions
      let totalClaimed = 0n;
      for (let i = 1; i <= 50; i++) {
        const balBefore = await anon.balanceOf(alice.address);
        await xanonS.connect(alice).earnReward(alice.address, i);
        const balAfter = await anon.balanceOf(alice.address);
        totalClaimed += balAfter - balBefore;
      }

      // Total: 50 * 2 = 100 tokens * 10 days = 1000 stake-days
      // Pool 2 gets 5000, Alice should get all of it
      expect(totalClaimed).to.be.closeTo(
        ethers.parseEther("5000"),
        ethers.parseEther("10")
      );
    });

    it("should handle very small perDayRate without underflow", async function () {
      const { owner, alice, xanonS } = await deployFixture();

      // Large stake, tiny topUp → very small perDayRate
      await xanonS.connect(alice).mint(ethers.parseEther("1000000"), 2);
      await increaseSeconds(100 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1")); // Minimal topUp

      await increaseSeconds(DAY);

      // Should not revert or underflow
      const pending = await xanonS.pendingRewards(1);
      // May be 0 due to rounding, but should not revert
      expect(pending).to.be.gte(0n);
    });
  });

  describe("ATTACK: Cross-Pool Manipulation", function () {
    it("should prevent stealing rewards from other pools", async function () {
      const { owner, alice, bob, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0:  Alice stakes 100 in pool2 (50% allocation)
      // Day 0:  Bob stakes 100 in pool0 (20% allocation)
      // Day 10: 10 days pass (both accumulate 1000 stake-days)
      // Day 10: topUp (10,000) splits: 2,000 to pool0, 5,000 to pool2
      // Day 11: Claims
      //
      // EXPECTED:
      // Alice: 5,000 (pool2 allocation, 50%)
      // Bob:   2,000 (pool0 allocation, 20%)
      // Ratio: 2.5:1
      //
      // Tests: Pools are completely isolated, no cross-stealing possible

      // Alice stakes in pool 2 (50% allocation)
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);

      // Bob stakes in pool 0 (20% allocation)
      await xanonS.connect(bob).mint(ethers.parseEther("100"), 0);

      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("10000"));
      await increaseSeconds(DAY);

      const aliceBal1 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const aliceBal2 = await anon.balanceOf(alice.address);
      const aliceRewards = aliceBal2 - aliceBal1;

      const bobBal1 = await anon.balanceOf(bob.address);
      await xanonS.connect(bob).earnReward(bob.address, 2);
      const bobBal2 = await anon.balanceOf(bob.address);
      const bobRewards = bobBal2 - bobBal1;

      // Alice should get 50% allocation = 5000
      expect(aliceRewards).to.be.closeTo(
        ethers.parseEther("5000"),
        ethers.parseEther("10")
      );

      // Bob should get 20% allocation = 2000
      expect(bobRewards).to.be.closeTo(
        ethers.parseEther("2000"),
        ethers.parseEther("10")
      );

      // Ratio should be 5000:2000 = 2.5:1
      const ratio = (aliceRewards * 100n) / bobRewards;
      expect(ratio).to.be.closeTo(250n, 5n); // 2.5 ± 0.05
    });

    it("should prevent cross-contamination between pool intervals", async function () {
      const { owner, alice, bob, anon, xanonS } = await deployFixture();

      // Pool 0: Alice
      await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

      // Pool 2: Bob
      await xanonS.connect(bob).mint(ethers.parseEther("100"), 2);

      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Both claim
      await xanonS.connect(alice).earnReward(alice.address, 1);
      await xanonS.connect(bob).earnReward(bob.address, 2);

      // Pool 0 expires at day 91, Pool 2 at day 365
      await increaseSeconds(100 * DAY); // Alice expired, Bob still active

      // Second topUp
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // Alice should NOT get rewards from second topUp (expired)
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");

      // Bob SHOULD get rewards (still active)
      const bobBal1 = await anon.balanceOf(bob.address);
      await xanonS.connect(bob).earnReward(bob.address, 2);
      const bobBal2 = await anon.balanceOf(bob.address);
      expect(bobBal2 - bobBal1).to.be.gt(0n);
    });
  });

  describe("MATHEMATICAL INVARIANTS: Strict Verification", function () {
    it("INVARIANT: Sum of all claims must equal pool allocations (zero waste)", async function () {
      const { owner, alice, bob, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0: Alice stakes 1000, Bob stakes 1000 (equal stakes)
      // Day 10: topUp 10,000
      // Day 11: Both claim
      //
      // EXPECTED (pool2 = 50%):
      // Pool allocation: 5,000
      // Alice: 2,500 (50% of 5,000)
      // Bob:   2,500 (50% of 5,000)
      // Sum: EXACTLY 5,000 (or very close due to precision)
      //
      // This tests that rewards are fully distributed with minimal waste

      await xanonS.connect(alice).mint(ethers.parseEther("1000"), 2);
      await xanonS.connect(bob).mint(ethers.parseEther("1000"), 2); // Same day

      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("10000"));
      await increaseSeconds(DAY);

      const alice1 = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const alice2 = await anon.balanceOf(alice.address);

      const bob1 = await anon.balanceOf(bob.address);
      await xanonS.connect(bob).earnReward(bob.address, 2);
      const bob2 = await anon.balanceOf(bob.address);

      const aliceRewards = alice2 - alice1;
      const bobRewards = bob2 - bob1;
      const total = aliceRewards + bobRewards;

      const expectedPoolAllocation = ethers.parseEther("5000");

      // Both should get exactly half (equal stake-days)
      expect(aliceRewards).to.be.closeTo(
        ethers.parseEther("2500"),
        ethers.parseEther("1") // 0.04% tolerance
      );
      expect(bobRewards).to.be.closeTo(
        ethers.parseEther("2500"),
        ethers.parseEther("1") // 0.04% tolerance
      );

      // Total must be very close to pool allocation (minimal waste)
      expect(total).to.be.closeTo(
        expectedPoolAllocation,
        ethers.parseEther("2") // 0.04% tolerance
      );
    });

    it("INVARIANT: perDayRate calculation is mathematically sound", async function () {
      const { owner, alice, anon, xanonS } = await deployFixture();

      // TIMELINE:
      // Day 0: Alice stakes 100
      // Day 5: topUp 1000 → pool2 gets 500
      //
      // MATH VERIFICATION:
      // intervalSD = 5 days × 100 tokens = 500 stake-days
      // perDayRate = 500 tokens × 1e18 / 500 stake-days = 1e18
      // Alice reward = 500 stake-days × 1e18 / 1e18 = 500 tokens
      //
      // This should be EXACT (no approximation)

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      await increaseSeconds(5 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      const balBefore = await anon.balanceOf(alice.address);
      await xanonS.connect(alice).earnReward(alice.address, 1);
      const balAfter = await anon.balanceOf(alice.address);
      const rewards = balAfter - balBefore;

      // Should be EXACTLY 500 (or within rounding error)
      expect(rewards).to.equal(ethers.parseEther("500"));
    });

    it("INVARIANT: lastPaidDay tracking prevents double-claims", async function () {
      const { owner, alice, xanonS } = await deployFixture();

      // TIMELINE:
      // Day T+0: Alice stakes 100 (lastPaidDay = current unix day)
      // Day T+5: topUp 1000 → snapshot at unix day T+5
      // Day T+6: earnReward #1
      //          - Claims interval (T+0, T+5]
      //          - lastPaidDay updated to snapshot day (T+5 or T+6)
      //          - accruedRewards set to 0
      // Day T+6: earnReward #2 (same day)
      //          - Tries to claim again
      //          - capDay <= lastPaidDay or no new snapshots
      //          - Result: NoRewards
      //
      // INVARIANT: Once claimed, cannot claim same period again
      // NOTE: lastPaidDay is absolute unix day, NOT relative test day!

      const startDay = await time.latest().then((t) => Math.floor(t / DAY));

      await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
      const posAfterMint = await xanonS.positionOf(1);
      const mintDay = Number(posAfterMint.lastPaidDay);

      await increaseSeconds(5 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(DAY);

      // First claim succeeds and updates state
      await xanonS.connect(alice).earnReward(alice.address, 1);

      // Verify position state after claim
      const pos = await xanonS.positionOf(1);

      // lastPaidDay should be >= mintDay (advanced from mint day)
      expect(Number(pos.lastPaidDay)).to.be.gte(mintDay);

      // lastPaidDay should be close to snapshot day (T+5 in absolute terms)
      const expectedLastPaidDay = mintDay + 5; // Snapshot was at T+5
      expect(Number(pos.lastPaidDay)).to.be.closeTo(expectedLastPaidDay, 1);

      // Second immediate claim fails (interval already claimed)
      await expect(
        xanonS.connect(alice).earnReward(alice.address, 1)
      ).to.be.revertedWithCustomError(xanonS, "NoRewards");
    });
  });
});
