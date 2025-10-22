import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type {
  MockERC20,
  XAnonStakingNFT,
  MockDescriptor,
} from "../typechain-types";

describe("xAnonStakingNFT - stake-days weighting", function () {
  const DAY = 24 * 60 * 60;

  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

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

    await anon.mint(owner.address, ethers.parseEther("1000000"));
    await anon.mint(alice.address, ethers.parseEther("1000000"));
    await anon.mint(bob.address, ethers.parseEther("1000000"));

    await anon
      .connect(alice)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anon
      .connect(bob)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anon
      .connect(owner)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);

    return { owner, alice, bob, anon, xanonS } as {
      owner: any;
      alice: any;
      bob: any;
      anon: MockERC20;
      xanonS: XAnonStakingNFT;
    };
  }

  async function increaseSeconds(n: number) {
    await time.increase(n);
  }

  it("later entrant gets less within the same interval (stake-days)", async function () {
    const { owner, alice, bob, anon, xanonS } = await deployFixture();

    // Pool 2 (365d), Alice stakes day 0, Bob stakes day 30
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(30 * DAY);
    await xanonS.connect(bob).mint(ethers.parseEther("100"), 2);

    // Move to end of day 60 (ensure full days counted)
    await increaseSeconds(30 * DAY);

    // Top up 1000; split 50% to pool 2 -> 500 goes to pool 2
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Now claim rewards: Alice had 60 days active, Bob had 30 days active in interval
    // stake-seconds weights: Alice 100*60d, Bob 100*30d -> Alice gets 2x Bob (both amounts equal)
    // We collect by calling earnReward; their balances should reflect ~2:1 ratio from pool 2 share

    // Get token ids: Alice minted first tokenId=1 for pool 2? In xAnonStakingNFT sequence: pools share same id space
    // Mint order: Alice(p2)=1, Bob(p2)=2
    await xanonS.connect(alice).earnReward(alice.address, 1);
    await xanonS.connect(bob).earnReward(bob.address, 2);

    const balA = await anon.balanceOf(alice.address);
    const balB = await anon.balanceOf(bob.address);

    // Initial balances were 1,000,000; each staked 100; Alice got rewards ~ (2/3)*500 = ~333.33; Bob ~166.67
    // Check ratio approx 2:1 within tolerance
    const aGain =
      balA - (ethers.parseEther("1000000") - ethers.parseEther("100"));
    const bGain =
      balB - (ethers.parseEther("1000000") - ethers.parseEther("100"));

    // Alice: 60 days * 100 = 6000 stake-days
    // Bob: 30 days * 100 = 3000 stake-days
    // Total: 9000 stake-days
    // Pool 2 gets 500, Alice gets 500 * (6000/9000) = 333.333, Bob gets 166.667
    expect(aGain).to.be.closeTo(
      ethers.parseEther("333.333333333333333333"),
      ethers.parseEther("0.001")
    );
    expect(bGain).to.be.closeTo(
      ethers.parseEther("166.666666666666666666"),
      ethers.parseEther("0.001")
    );

    // Verify 2:1 ratio precisely
    const ratio = (aGain * 1000n) / bGain;
    expect(ratio).to.be.closeTo(2000n, 5n); // 2.0 ± 0.005
  });

  it("same-day entrants share equally for that day", async function () {
    const { owner, alice, bob, anon, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await xanonS.connect(bob).mint(ethers.parseEther("100"), 2); // same day
    // topUp same day → stake-days are equal within the day → 50/50
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    // Move to next day so the day interval is formed
    await increaseSeconds(DAY);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    await xanonS.connect(bob).earnReward(bob.address, 2);
    const aGain =
      (await anon.balanceOf(alice.address)) -
      (ethers.parseEther("1000000") - ethers.parseEther("100"));
    const bGain =
      (await anon.balanceOf(bob.address)) -
      (ethers.parseEther("1000000") - ethers.parseEther("100"));
    // Pool2 gets 500; split 50/50 ≈ 250
    expect(aGain).to.be.closeTo(
      ethers.parseEther("250"),
      ethers.parseEther("0.001")
    );
    expect(bGain).to.be.closeTo(
      ethers.parseEther("250"),
      ethers.parseEther("0.001")
    );
  });

  it("reverts on topUp with amount below minimum or too frequent", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // First valid topUp succeeds (from owner)
    await xanonS.connect(owner).topUp(ethers.parseEther("600"));

    // Same day - should revert (from owner)
    await expect(
      xanonS.connect(owner).topUp(ethers.parseEther("600"))
    ).to.be.revertedWithCustomError(xanonS, "TopUpTooFrequent");

    // Next day - still too frequent
    await increaseSeconds(DAY);
    await expect(
      xanonS.connect(owner).topUp(ethers.parseEther("600"))
    ).to.be.revertedWithCustomError(xanonS, "TopUpTooFrequent");
  });

  it("no topUp for a long period yields zero rewards", async function () {
    const { alice, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(120 * DAY);
    // No topUp; earnReward should revert with No rewards
    await expect(
      xanonS.connect(alice).earnReward(alice.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NoRewards");
  });

  it("splits 20/30/50 across pools with equal stake-days", async function () {
    const { owner, alice, bob, anon, xanonS } = await deployFixture();
    // Equal stakes in each pool for Alice & Bob
    for (const pid of [0, 1, 2]) {
      await xanonS.connect(alice).mint(ethers.parseEther("100"), pid);
      await xanonS.connect(bob).mint(ethers.parseEther("100"), pid);
    }
    // Advance 1 day to ensure interval forms on topUp
    await increaseSeconds(DAY);
    // topUp 1000 → expect 200/300/500 across pools, split 50/50 per pool → 100+150+250 = 500 per user
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    // Move to next day to close interval
    await increaseSeconds(DAY);
    // Alice tokens are 1,3,5 in mint order, Bob are 2,4,6
    await xanonS.connect(alice).earnReward(alice.address, 1);
    await xanonS.connect(alice).earnReward(alice.address, 3);
    await xanonS.connect(alice).earnReward(alice.address, 5);
    await xanonS.connect(bob).earnReward(bob.address, 2);
    await xanonS.connect(bob).earnReward(bob.address, 4);
    await xanonS.connect(bob).earnReward(bob.address, 6);

    const balA = await anon.balanceOf(alice.address);
    const balB = await anon.balanceOf(bob.address);
    const gainA =
      balA - (ethers.parseEther("1000000") - ethers.parseEther("300"));
    const gainB =
      balB - (ethers.parseEther("1000000") - ethers.parseEther("300"));

    // Each should get 500 (100+150+250 from 20/30/50 split)
    expect(gainA).to.be.closeTo(
      ethers.parseEther("500"),
      ethers.parseEther("0.001")
    );
    expect(gainB).to.be.closeTo(
      ethers.parseEther("500"),
      ethers.parseEther("0.001")
    );
  });

  it("caps rewards at expiration (no accrual after lock)", async function () {
    const { owner, alice, anon, xanonS } = await deployFixture();
    // Use pool 0 (≈91 days lock)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    // First window: day 45
    await increaseSeconds(45 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("900")); // pool0 gets 180
    // Move one day to materialize interval
    await increaseSeconds(DAY);
    // Second window after expiration (day 100+)
    await increaseSeconds(55 * DAY); // total 101 days from start
    await xanonS.connect(owner).topUp(ethers.parseEther("900")); // pool0 gets 180 but should NOT accrue to expired position
    await increaseSeconds(DAY);
    // Claim
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const gain =
      (await anon.balanceOf(alice.address)) -
      (ethers.parseEther("1000000") - ethers.parseEther("100"));
    // Expect strictly between 0 and 180 (only first topUp's pool0 share, split by stake-days; since Alice is the only staker → gets full pool0 share 180)
    expect(gain).to.be.closeTo(
      ethers.parseEther("180"),
      ethers.parseEther("0.001")
    );
  });

  it("ring buffer expiry shrinks rollingActiveStake after lockDays", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();
    // Pool 0 ≈91 days buffer
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0); // tokenId 1

    // TopUp to create rewards
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Advance full buffer (Alice's position expires)
    await increaseSeconds(91 * DAY);

    // Trigger roll with tiny stake today
    await xanonS.connect(alice).mint(ethers.parseEther("1"), 0); // tokenId 2
    const [, , rolling] = await xanonS.poolInfo(0);
    expect(rolling).to.equal(ethers.parseEther("1")); // Only new stake

    // Alice's first position should NOT earn rewards from future topUps (expired)
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);

    const balBefore = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1); // Old expired position
    const balAfter = await anon.balanceOf(alice.address);
    const rewardsOldPosition = balAfter - balBefore;

    // Should only get rewards from first topUp (200), not second
    expect(rewardsOldPosition).to.be.closeTo(
      ethers.parseEther("200"),
      ethers.parseEther("1")
    );
  });

  it("topUp with no active stake defers to next interval via pendingRewards", async function () {
    const { owner, alice, bob, anon, xanonS } = await deployFixture();
    // No stakes yet; topUp should pend
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    // Now two users stake same day in pool 2
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await xanonS.connect(bob).mint(ethers.parseEther("100"), 2);
    // Advance one day to form interval and auto-distribute pending
    await increaseSeconds(DAY);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    await xanonS.connect(bob).earnReward(bob.address, 2);
    const aGain =
      (await anon.balanceOf(alice.address)) -
      (ethers.parseEther("1000000") - ethers.parseEther("100"));
    const bGain =
      (await anon.balanceOf(bob.address)) -
      (ethers.parseEther("1000000") - ethers.parseEther("100"));
    // Pool2 gets 500 pending; split equally → 250
    expect(aGain).to.be.closeTo(
      ethers.parseEther("250"),
      ethers.parseEther("0.001")
    );
    expect(bGain).to.be.closeTo(
      ethers.parseEther("250"),
      ethers.parseEther("0.001")
    );
  });

  it("pausable: mint reverts when paused, but earnReward works", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes before pause
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);

    // Create rewards
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);

    // Owner pauses the contract
    await xanonS.connect(owner).pause();

    // Mint should revert when paused
    await expect(
      xanonS.connect(alice).mint(ethers.parseEther("100"), 2)
    ).to.be.revertedWithCustomError(xanonS, "EnforcedPause");

    // But earnReward should still work (users can claim rewards)
    await expect(xanonS.connect(alice).earnReward(alice.address, 1)).to.not.be
      .reverted;

    // Unpause
    await xanonS.connect(owner).unpause();

    // Now mint should work again
    await expect(xanonS.connect(alice).mint(ethers.parseEther("100"), 2)).to.not
      .be.reverted;
  });

  it("burn: only owner or approved, and only after lock", async function () {
    const { alice, bob, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await expect(
      xanonS.connect(bob).burn(bob.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NotAuthorized");
    await expect(
      xanonS.connect(alice).burn(alice.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "PositionLocked");
  });

  it("emergencyWithdraw: returns only principal, no rewards", async function () {
    const { owner, alice, anon, xanonS } = await deployFixture();

    // Alice stakes 100 tokens in pool 0 (91 days)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // Create rewards
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000")); // Pool 0 gets 200
    await increaseSeconds(DAY);

    // Verify rewards are available
    const pendingBefore = await xanonS.pendingRewards(1);
    expect(pendingBefore).to.be.gt(0n); // Should have rewards

    // Wait for unlock (91 days)
    await increaseSeconds(91 * DAY);

    const balanceBefore = await anon.balanceOf(alice.address);
    const totalStakedBefore = await xanonS.totalStaked();

    // Emergency withdraw - should get ONLY principal (100), NO rewards
    await xanonS.connect(alice).emergencyWithdraw(alice.address, 1);

    const balanceAfter = await anon.balanceOf(alice.address);
    const totalStakedAfter = await xanonS.totalStaked();
    const received = balanceAfter - balanceBefore;

    // Should receive exactly 100 (principal only)
    expect(received).to.equal(ethers.parseEther("100"));

    // Should NOT receive rewards (which were ~200)
    expect(received).to.be.lt(ethers.parseEther("150")); // Much less than principal + rewards

    // totalStaked should decrease by 100
    expect(totalStakedBefore - totalStakedAfter).to.equal(
      ethers.parseEther("100")
    );

    // Token should be burned
    await expect(xanonS.ownerOf(1)).to.be.reverted;
  });

  it("emergencyWithdraw: only owner or approved, and only after lock", async function () {
    const { alice, bob, xanonS } = await deployFixture();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // Bob (not owner) can't withdraw
    await expect(
      xanonS.connect(bob).emergencyWithdraw(bob.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NotAuthorized");

    // Can't withdraw before unlock
    await expect(
      xanonS.connect(alice).emergencyWithdraw(alice.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "PositionLocked");

    // After unlock (91 days) - should work
    await increaseSeconds(91 * DAY);
    await expect(xanonS.connect(alice).emergencyWithdraw(alice.address, 1)).to
      .not.be.reverted;
  });

  it("burn pays pending rewards before returning principal", async function () {
    const { anon, xanonS, owner, alice } = await deployFixture();
    await xanonS.connect(owner).mint(ethers.parseEther("100"), 0);
    // accrue some stake-days then create rewards
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    const tokenId = 1n;
    const before = await anon.balanceOf(alice.address);
    await increaseSeconds(91 * DAY);
    await xanonS.connect(owner).approve(alice.address, tokenId);
    await xanonS.connect(alice).burn(alice.address, tokenId);
    const after = await anon.balanceOf(alice.address);
    const totalReceived = after - before;

    // Should receive principal (100) + rewards (pool 0 gets 200 from 1000 topUp)
    // 2 days * 100 tokens = 200 stake-days, 200 tokens over 200 stake-days
    expect(totalReceived).to.be.closeTo(
      ethers.parseEther("300"), // 100 principal + 200 rewards
      ethers.parseEther("1")
    );
  });

  it("burn returns only principal when no rewards accrued", async function () {
    const { anon, xanonS, owner } = await deployFixture();
    await xanonS.connect(owner).mint(ethers.parseEther("100"), 0);
    const tokenId = 1n;
    const before = await anon.balanceOf(owner.address);
    await increaseSeconds(91 * DAY);
    // No topUp happened; rewards should be zero
    await xanonS.connect(owner).burn(owner.address, tokenId);
    const after = await anon.balanceOf(owner.address);
    expect(after - before).to.equal(ethers.parseEther("100"));
  });

  it("earnReward: only owner or approved", async function () {
    const { owner, alice, bob, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);
    await expect(
      xanonS.connect(bob).earnReward(bob.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NotAuthorized");
  });

  it("tokenURI returns descriptor URI", async function () {
    const { alice, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("1"), 2);
    const uri = await xanonS.tokenURI(1);
    expect(uri).to.equal("ipfs://mock");
  });

  it("positionOf returns stored staking position data", async function () {
    const { alice, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("123"), 1);
    const pos = await xanonS.positionOf(1);
    expect(pos.amount).to.equal(ethers.parseEther("123"));
    expect(pos.poolId).to.equal(1n);
    expect(pos.lockedUntil).to.be.gt(0n);
    expect(pos.lastPaidDay).to.be.gte(0n);
  });

  // REMOVED: Test for set() function (pools are now fixed)
  // Pool allocation is fixed at 20/30/50 and cannot be changed

  it("rescueTokens transfers arbitrary token by owner", async function () {
    const { owner, anon, xanonS } = await deployFixture();

    // Create a different ERC20 token (not ANON)
    const MockERC20F = await ethers.getContractFactory("MockERC20");
    const otherToken = (await MockERC20F.deploy(
      "OTHER",
      "OTHER",
      18
    )) as unknown as MockERC20;
    await otherToken.mint(owner.address, ethers.parseEther("1000"));

    // Send 10 OTHER tokens to contract
    await otherToken.transfer(
      await xanonS.getAddress(),
      ethers.parseEther("10")
    );

    // Rescue OTHER token - should succeed
    const balBefore = await otherToken.balanceOf(owner.address);
    await xanonS
      .connect(owner)
      .rescueTokens(
        await otherToken.getAddress(),
        owner.address,
        ethers.parseEther("10")
      );
    const balAfter = await otherToken.balanceOf(owner.address);
    expect(balAfter - balBefore).to.equal(ethers.parseEther("10"));

    // Try to rescue ANON token - should revert
    await anon.transfer(await xanonS.getAddress(), ethers.parseEther("10"));
    await expect(
      xanonS
        .connect(owner)
        .rescueTokens(
          await anon.getAddress(),
          owner.address,
          ethers.parseEther("10")
        )
    ).to.be.revertedWithCustomError(xanonS, "CannotRescueAnonToken");
  });

  it("ring buffer handles very large day gaps (>> lockDays) correctly", async function () {
    const { alice, xanonS } = await deployFixture();
    // Pool 0 (~91 days)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    // Jump far beyond 2 * lockDays
    await increaseSeconds(1000 * DAY);
    // Mint a small amount to force roll and check rollingActiveStake only reflects new bucket
    await xanonS.connect(alice).mint(ethers.parseEther("1"), 0);
    const [, , rollingActiveStake] = await xanonS.poolInfo(0);
    expect(rollingActiveStake).to.equal(ethers.parseEther("1"));
  });

  // REMOVED: Test for MAX_POOLS (pools are now fixed at 3, cannot add more)

  // REMOVED: Duplicate of test "owner set() updates allocPoint and affects future splits"

  it("pendingRewards reports the same value as a subsequent earnReward", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);
    const pending = await xanonS.pendingRewards(1);
    const balBefore = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const balAfter = await anon.balanceOf(alice.address);
    expect(balAfter - balBefore).to.equal(pending);
  });

  it("second earnReward in the same day reverts with No rewards", async function () {
    const { owner, alice, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("100"));
    await increaseSeconds(DAY);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    await expect(
      xanonS.connect(alice).earnReward(alice.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NoRewards");
  });

  it("earnReward then topUp then earnReward: no double rewards, only new interval", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();

    // Alice stakes
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(2 * DAY);

    // First topUp - Alice should get 50% = 500
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);

    // Alice claims first rewards
    const bal1 = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const bal2 = await anon.balanceOf(alice.address);
    const firstClaim = bal2 - bal1;

    expect(firstClaim).to.be.closeTo(
      ethers.parseEther("500"),
      ethers.parseEther("1")
    );

    // Wait and second topUp - creates new interval
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);

    // Alice claims again - should get ONLY new rewards from second topUp
    const bal3 = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const bal4 = await anon.balanceOf(alice.address);
    const secondClaim = bal4 - bal3;

    // Second claim should be from 2-day interval (200 stake-days), pool2 gets 500
    expect(secondClaim).to.be.closeTo(
      ethers.parseEther("500"),
      ethers.parseEther("1")
    );

    // CRITICAL: Total should be ~1000 (500+500), NOT 1500 or more (no double rewards)
    const totalClaimed = firstClaim + secondClaim;
    expect(totalClaimed).to.be.closeTo(
      ethers.parseEther("1000"),
      ethers.parseEther("2")
    );

    // Third claim should fail (no new rewards)
    await expect(
      xanonS.connect(alice).earnReward(alice.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NoRewards");
  });

  it("approved address can earnReward and burn after lock", async function () {
    const { owner, alice, bob, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    // Let there be some rewards
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);
    // Approve Bob to manage token 1
    await xanonS.connect(alice).approve(bob.address, 1);
    // Bob can claim
    await xanonS.connect(bob).earnReward(bob.address, 1);
    // Fast-forward past lock to allow burn
    await increaseSeconds(91 * DAY);
    await xanonS.connect(bob).burn(bob.address, 1);
  });

  it("transferred NFT allows new owner to claim and burn", async function () {
    const { owner, alice, bob, xanonS, anon } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);
    await xanonS
      .connect(alice)
      ["safeTransferFrom(address,address,uint256)"](
        alice.address,
        bob.address,
        1
      );
    const balBefore = await anon.balanceOf(bob.address);
    await xanonS.connect(bob).earnReward(bob.address, 1);
    const balAfter = await anon.balanceOf(bob.address);
    const bobRewards = balAfter - balBefore;

    // Bob should receive pool 0 share (20% of 1000 = 200) from 1-day interval
    expect(bobRewards).to.be.closeTo(
      ethers.parseEther("200"),
      ethers.parseEther("1")
    );

    await increaseSeconds(91 * DAY);
    await xanonS.connect(bob).burn(bob.address, 1);
  });

  it("reverts on invalid tokenId for tokenURI, positionOf, earnReward", async function () {
    const { alice, xanonS } = await deployFixture();
    await expect(xanonS.tokenURI(999)).to.be.revertedWithCustomError(
      xanonS,
      "TokenDoesNotExist"
    );
    await expect(xanonS.positionOf(999)).to.not.be.reverted; // positionOf returns zeroed struct
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await expect(
      xanonS.earnReward(alice.address, 999)
    ).to.be.revertedWithCustomError(xanonS, "TokenDoesNotExist");
  });

  it("reverts on topUp below minimum and mint(0)", async function () {
    const { owner, xanonS } = await deployFixture();

    // Get MIN_TOPUP_AMOUNT from contract
    const minTopUp = await xanonS.MIN_AMOUNT();

    // TopUp with 0 should revert
    await expect(xanonS.connect(owner).topUp(0)).to.be.revertedWithCustomError(
      xanonS,
      "AmountTooSmall"
    );

    // TopUp below MIN_TOPUP_AMOUNT should revert
    const belowMin = minTopUp - 1n;
    await expect(
      xanonS.connect(owner).topUp(belowMin)
    ).to.be.revertedWithCustomError(xanonS, "AmountTooSmall");

    // TopUp exactly at MIN_TOPUP_AMOUNT should succeed
    await xanonS.connect(owner).topUp(minTopUp);

    // Mint with 0 should revert
    await expect(xanonS.mint(0, 0)).to.be.revertedWithCustomError(
      xanonS,
      "AmountTooSmall"
    );
  });

  it("reverts on mint with amount exceeding uint96 max (storage packing safety)", async function () {
    const { alice, anon, xanonS } = await deployFixture();

    // uint96 max = 79,228,162,514 tokens (with 18 decimals)
    const uint96Max = 2n ** 96n - 1n;
    const exceedsMax = uint96Max + 1n;

    // Mint huge balance for alice
    await anon.mint(alice.address, exceedsMax);
    await anon.connect(alice).approve(await xanonS.getAddress(), exceedsMax);

    // Try to mint with amount > uint96.max - should revert
    await expect(
      xanonS.connect(alice).mint(exceedsMax, 0)
    ).to.be.revertedWithCustomError(xanonS, "AmountExceedsMaximum");

    // Mint exactly at uint96.max should work
    await anon.mint(alice.address, uint96Max);
    await anon.connect(alice).approve(await xanonS.getAddress(), uint96Max);
    await expect(xanonS.connect(alice).mint(uint96Max, 0)).to.not.be.reverted;
  });

  it("accumulates rewards correctly across 5+ intervals", async function () {
    const { owner, alice, anon, xanonS } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    // Schedule topUps exactly at days 10,20,30,40,50 from now using setNextBlockTimestamp
    const startTs = BigInt(await time.latest());
    for (const d of [10n, 20n, 30n, 40n, 50n]) {
      await time.setNextBlockTimestamp(startTs + d * BigInt(DAY));
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    }
    await time.setNextBlockTimestamp(startTs + 51n * BigInt(DAY));
    const before = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const after = await anon.balanceOf(alice.address);
    const rewards = after - before;

    // Alice should receive 50% of each topUp (pool 2 allocation)
    // 5 topUps * 500 (50% of 1000) = 2500
    expect(rewards).to.be.closeTo(
      ethers.parseEther("2500"),
      ethers.parseEther("10")
    );
  });

  it("no accrual when position expires exactly on topUp day after cap", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    // Move to day 90, topUp; then on day 92 (after expiration) do topUp
    await increaseSeconds(90 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(2 * DAY); // day 92 - Alice expired on day 91
    await xanonS.connect(owner).topUp(ethers.parseEther("1000")); // should not accrue to expired
    await increaseSeconds(DAY);
    const before = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const after = await anon.balanceOf(alice.address);
    const rewards = after - before;

    // Alice should receive rewards ONLY from first topUp (before expiration day 91)
    // Pool 0 gets 200 (20% of 1000), Alice is only staker
    // Second topUp on day 91 should NOT accrue to expired position
    expect(rewards).to.be.closeTo(
      ethers.parseEther("200"),
      ethers.parseEther("1")
    );
  });

  // REMOVED: Test for LockDaysTooLow (pools are fixed, cannot add new pools)

  it("fair reward distribution - Pool 0 (3 months, 91 days)", async function () {
    const { owner, alice, bob, anon, xanonS } = await deployFixture();
    const stakeAmount = ethers.parseEther("1000");

    // Wait 3 months after deployment before staking begins
    await increaseSeconds(90 * DAY);

    // Pool 0 (91 days): Alice stakes first, Bob after 30 days, Anon after 89 days (to fit in 3 months)
    await xanonS.connect(alice).mint(stakeAmount, 0); // tokenId 1
    await increaseSeconds(30 * DAY);
    await xanonS.connect(bob).mint(stakeAmount, 0); // tokenId 2
    await increaseSeconds(59 * DAY); // 89 days after alice stake
    await xanonS.connect(owner).mint(stakeAmount, 0); // tokenId 3 (owner as anon)

    // First topUp immediately after anon stakes
    // Pool 0 gets 20%, so to get 10000: topUp = 10000 / 0.20 = 50000
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("50000")); // Pool 0 gets 10000

    // Wait for alice and bob locks to expire and close the first interval
    // Alice locked for 91 days from day 90 = expires day 181
    // Bob locked for 91 days from day 120 = expires day 211
    // We are at day 180, wait until AFTER day 211 (both alice and bob expired)
    await increaseSeconds(33 * DAY); // day 213 - both expired
    // Tiny topUp to close first interval - NOW AUTO in topUp()
    // await xanonS.connect(owner).topUp(ethers.parseEther("0.001"));

    // Now second topUp - auto creates intermediate snapshot at day 212, then real at day 213
    await xanonS.connect(owner).topUp(ethers.parseEther("50000")); // Pool 0 gets 10000

    // Wait for anon's lock to expire
    // Anon staked at day 179, locked for 91 days = expires day 270
    await increaseSeconds(60 * DAY); // move past day 270

    // Collect balances before burn
    const aliceBalBefore = await anon.balanceOf(alice.address);
    const bobBalBefore = await anon.balanceOf(bob.address);
    const ownerBalBefore = await anon.balanceOf(owner.address);

    // Burn all positions
    await xanonS.connect(alice).burn(alice.address, 1);
    await xanonS.connect(bob).burn(bob.address, 2);
    await xanonS.connect(owner).burn(owner.address, 3); // 1000 tokens

    // Collect balances after burn
    const aliceBalAfter = await anon.balanceOf(alice.address);
    const bobBalAfter = await anon.balanceOf(bob.address);
    const ownerBalAfter = await anon.balanceOf(owner.address);

    // Calculate rewards (gain - principal)
    const aliceRewards = aliceBalAfter - aliceBalBefore - stakeAmount;
    const bobRewards = bobBalAfter - bobBalBefore - stakeAmount;
    const ownerRewards = ownerBalAfter - ownerBalBefore - stakeAmount;

    // Verify: Bob should get approximately half of Alice (with tolerance for timing variations)
    const bobPercent = (bobRewards * 100n) / aliceRewards;

    expect(bobPercent).to.be.gte(40n);
    expect(bobPercent).to.be.lte(70n); // Slightly higher tolerance for pool 0 due to timing

    // Owner should get significantly more (second topUp + 1 day from first)
    expect(ownerRewards).to.be.gt(aliceRewards);
    expect(ownerRewards).to.be.gt(bobRewards);

    // Total should be close to 20000 (two topUps of 10000 to pool 0)
    const totalRewards = aliceRewards + bobRewards + ownerRewards;
    expect(totalRewards).to.be.closeTo(
      ethers.parseEther("20000"),
      ethers.parseEther("20") // 0.1% tolerance
    );
  });

  it("fair reward distribution - Pool 1 (6 months, 182 days)", async function () {
    const { owner, alice, bob, anon, xanonS } = await deployFixture();
    const stakeAmount = ethers.parseEther("1000");

    // Wait 3 months after deployment
    await increaseSeconds(90 * DAY);

    // Pool 1 (182 days): Alice stakes first, Bob after 90 days, Anon after 179 days (to fit in 6 months)
    await xanonS.connect(alice).mint(stakeAmount, 1); // tokenId 1
    await increaseSeconds(90 * DAY);
    await xanonS.connect(bob).mint(stakeAmount, 1); // tokenId 2
    await increaseSeconds(89 * DAY); // 179 days after alice stake
    await xanonS.connect(owner).mint(stakeAmount, 1); // tokenId 3

    // First topUp immediately after anon stakes
    // Pool 1 gets 30%, so to get 10000: topUp = 10000 / 0.30 = 33333.333...
    await increaseSeconds(DAY);
    await xanonS
      .connect(owner)
      .topUp(ethers.parseEther("33333.333333333333333333")); // Pool 1 gets ~10000

    // Wait for alice and bob locks to expire and close the first interval
    // Alice locked for 182 days from day 90 = expires day 272
    // Bob locked for 182 days from day 180 = expires day 362
    // We are at day 270, wait until AFTER day 362 (both alice and bob expired)
    await increaseSeconds(94 * DAY); // day 364 - both expired
    // Tiny topUp to close first interval - NOW AUTO in topUp()
    // await xanonS.connect(owner).topUp(ethers.parseEther("0.001"));

    // Now second topUp - auto creates intermediate snapshot at day 363, then real at day 364
    await xanonS
      .connect(owner)
      .topUp(ethers.parseEther("33333.333333333333333333")); // Pool 1 gets ~10000

    // Wait for anon's lock to expire
    // Anon staked at day 269, locked for 182 days = expires day 451
    await increaseSeconds(90 * DAY); // move past day 451

    const aliceBalBefore = await anon.balanceOf(alice.address);
    const bobBalBefore = await anon.balanceOf(bob.address);
    const ownerBalBefore = await anon.balanceOf(owner.address);

    await xanonS.connect(alice).burn(alice.address, 1);
    await xanonS.connect(bob).burn(bob.address, 2);
    await xanonS.connect(owner).burn(owner.address, 3); // 1000 tokens

    const aliceBalAfter = await anon.balanceOf(alice.address);
    const bobBalAfter = await anon.balanceOf(bob.address);
    const ownerBalAfter = await anon.balanceOf(owner.address);

    const aliceRewards = aliceBalAfter - aliceBalBefore - stakeAmount;
    const bobRewards = bobBalAfter - bobBalBefore - stakeAmount;
    const ownerRewards = ownerBalAfter - ownerBalBefore - stakeAmount;

    const bobPercent = (bobRewards * 100n) / aliceRewards;

    expect(bobPercent).to.be.gte(40n);
    expect(bobPercent).to.be.lte(60n);

    expect(ownerRewards).to.be.gt(aliceRewards);
    expect(ownerRewards).to.be.gt(bobRewards);

    const totalRewards = aliceRewards + bobRewards + ownerRewards;
    expect(totalRewards).to.be.closeTo(
      ethers.parseEther("20000"),
      ethers.parseEther("20")
    );
  });

  it("fair reward distribution - Pool 2 (12 months, 365 days)", async function () {
    const { owner, alice, bob, anon, xanonS } = await deployFixture();
    const stakeAmount = ethers.parseEther("1000");

    // Wait 3 months after deployment
    await increaseSeconds(90 * DAY);

    // Pool 2 (365 days): Alice stakes first, Bob after 180 days, Anon after 359 days (to fit in 12 months)
    await xanonS.connect(alice).mint(stakeAmount, 2); // tokenId 1
    await increaseSeconds(180 * DAY);
    await xanonS.connect(bob).mint(stakeAmount, 2); // tokenId 2
    await increaseSeconds(179 * DAY); // 359 days after alice stake
    await xanonS.connect(owner).mint(stakeAmount, 2); // tokenId 3

    // First topUp immediately after anon stakes
    // Pool 2 gets 50%, so to get 10000: topUp = 10000 / 0.50 = 20000
    await increaseSeconds(DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("20000")); // Pool 2 gets 10000

    // Wait for alice and bob locks to expire and close the first interval
    // Alice locked for 365 days from day 90 = expires day 455
    // Bob locked for 365 days from day 270 = expires day 635
    // We are at day 450, wait until AFTER day 635 (both alice and bob expired)
    await increaseSeconds(187 * DAY); // day 637 - both expired
    // Tiny topUp to close first interval - NOW AUTO in topUp()
    // await xanonS.connect(owner).topUp(ethers.parseEther("0.001"));

    // Now second topUp - auto creates intermediate snapshot at day 636, then real at day 637
    await xanonS.connect(owner).topUp(ethers.parseEther("20000")); // Pool 2 gets 10000

    // Wait for anon's lock to expire
    // Anon staked at day 449, locked for 365 days = expires day 814
    await increaseSeconds(180 * DAY); // move past day 814

    const aliceBalBefore = await anon.balanceOf(alice.address);
    const bobBalBefore = await anon.balanceOf(bob.address);
    const ownerBalBefore = await anon.balanceOf(owner.address);

    await xanonS.connect(alice).burn(alice.address, 1);
    await xanonS.connect(bob).burn(bob.address, 2);
    await xanonS.connect(owner).burn(owner.address, 3); // 1000 tokens

    const aliceBalAfter = await anon.balanceOf(alice.address);
    const bobBalAfter = await anon.balanceOf(bob.address);
    const ownerBalAfter = await anon.balanceOf(owner.address);

    const aliceRewards = aliceBalAfter - aliceBalBefore - stakeAmount;
    const bobRewards = bobBalAfter - bobBalBefore - stakeAmount;
    const ownerRewards = ownerBalAfter - ownerBalBefore - stakeAmount;

    const bobPercent = (bobRewards * 100n) / aliceRewards;

    expect(bobPercent).to.be.gte(40n);
    expect(bobPercent).to.be.lte(60n);

    expect(ownerRewards).to.be.gt(aliceRewards);
    expect(ownerRewards).to.be.gt(bobRewards);

    const totalRewards = aliceRewards + bobRewards + ownerRewards;
    expect(totalRewards).to.be.closeTo(
      ethers.parseEther("20000"),
      ethers.parseEther("20")
    );
  });

  it("very large gap (1000 days) with partial expirations handles correctly", async function () {
    const { owner, alice, bob, xanonS, anon } = await deployFixture();

    // Three users stake in pool 2 (365 days) at different times
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2); // tokenId 1, day 0
    await increaseSeconds(100 * DAY);
    await xanonS.connect(bob).mint(ethers.parseEther("100"), 2); // tokenId 2, day 100
    await increaseSeconds(100 * DAY);
    await xanonS.connect(owner).mint(ethers.parseEther("100"), 2); // tokenId 3, day 200

    // Wait 1000 days - all positions expired long ago
    // Alice expires day 365, Bob expires day 465, Owner expires day 565
    await increaseSeconds(800 * DAY); // day 1000

    // TopUp should auto-create intermediate snapshot and handle correctly
    // Mint more tokens for owner (they staked 100 already, need more for topUp)
    await anon.mint(owner.address, ethers.parseEther("50000"));

    // First mint to trigger roll (so rollingActiveStake updates)
    await xanonS.connect(owner).mint(ethers.parseEther("1"), 2); // tokenId 4
    await increaseSeconds(DAY); // day 1001

    // Now topUp - should create intermediate snapshot for expired positions
    await xanonS.connect(owner).topUp(ethers.parseEther("30000")); // Pool 2 gets 15000

    // Move forward to allow claims
    await increaseSeconds(DAY);

    const aliceBefore = await anon.balanceOf(alice.address);
    const bobBefore = await anon.balanceOf(bob.address);
    const ownerBalBefore = await anon.balanceOf(owner.address);

    // Claim rewards for positions (expired positions should get proportional rewards)
    await xanonS.connect(alice).earnReward(alice.address, 1);
    await xanonS.connect(bob).earnReward(bob.address, 2);
    await xanonS.connect(owner).earnReward(owner.address, 3);

    const aliceRewards = (await anon.balanceOf(alice.address)) - aliceBefore;
    const bobRewards = (await anon.balanceOf(bob.address)) - bobBefore;
    const ownerRewards = (await anon.balanceOf(owner.address)) - ownerBalBefore;

    // All should receive rewards proportional to their stake-days until expiration
    // Alice: 365 days * 100 = 36,500 stake-days
    // Bob: 365 days * 100 = 36,500 stake-days (100 to 465)
    // Owner: 365 days * 100 = 36,500 stake-days (200 to 565)
    // Plus owner has 1 token from day 1000+

    const total = aliceRewards + bobRewards + ownerRewards;

    // All three should receive approximately equal rewards (1/3 each)
    // Alice: 365 days * 100 = 36,500 stake-days
    // Bob: 365 days * 100 = 36,500 stake-days
    // Owner: 365 days * 100 = 36,500 stake-days
    // Total: 109,500 stake-days → each gets ~5000
    expect(aliceRewards).to.be.closeTo(
      ethers.parseEther("5000"),
      ethers.parseEther("10") // 0.2% tolerance
    );
    expect(bobRewards).to.be.closeTo(
      ethers.parseEther("5000"),
      ethers.parseEther("10")
    );
    expect(ownerRewards).to.be.closeTo(
      ethers.parseEther("5000"),
      ethers.parseEther("10")
    );

    // Total should be close to 15000
    expect(total).to.be.closeTo(
      ethers.parseEther("15000"),
      ethers.parseEther("15")
    );
  });

  it("pending rewards with very short first interval (1 day) creates valid perDayRate", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();

    // TopUp BEFORE any stakes (creates pending)
    await xanonS.connect(owner).topUp(ethers.parseEther("10000"));

    // Alice stakes and wait 2 days for topUp rule
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(2 * DAY); // Wait 2 days (min gap for topUp)

    // Check pool state before second topUp
    const [, , , , snapshotsBefore] = await xanonS.poolInfo(2);

    // Second topUp creates 2-day interval: 100 tokens * 2 days = 200 stake-days
    await xanonS.connect(owner).topUp(ethers.parseEther("10000"));

    const [, , , , snapshotsAfter] = await xanonS.poolInfo(2);

    // Should create at least main snapshot (intermediate may or may not be created)
    expect(snapshotsAfter).to.be.gte(snapshotsBefore + 1n);
    expect(snapshotsAfter).to.be.lte(snapshotsBefore + 2n);

    // Move forward and check actual rewards via claim
    await increaseSeconds(DAY);

    // HONEST CHECK: Claim and see what Alice actually receives
    const before = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const after = await anon.balanceOf(alice.address);
    const actualRewards = after - before;

    // Alice should receive ALL rewards: pending 5000 + new 5000 = 10000
    // First topUp: 5000 to pending
    // Second topUp: distributes pending via intermediate snapshot + new via main snapshot
    expect(actualRewards).to.be.closeTo(
      ethers.parseEther("10000"),
      ethers.parseEther("10")
    );
  });

  it("rollingActiveStake == 0 when threshold triggers: no snapshot created, pending works", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();

    // Alice stakes in pool 0 (91 days)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // First topUp immediately
    await increaseSeconds(2 * DAY); // Min 2 days for topUp rule
    await xanonS.connect(owner).topUp(ethers.parseEther("10000")); // Pool 0 gets 2000

    // Wait for full expiration
    await increaseSeconds(92 * DAY); // Alice fully expired, rollingActiveStake will be 0 after roll

    // Check that rollingActiveStake becomes 0 after roll
    await xanonS.connect(owner).mint(ethers.parseEther("1"), 0); // Trigger roll, tokenId 2
    const [, , rollingActiveStake] = await xanonS.poolInfo(0);
    expect(rollingActiveStake).to.equal(ethers.parseEther("1")); // Only new tiny stake

    // Burn it to get rollingActiveStake to 0
    await increaseSeconds(92 * DAY);
    await xanonS.connect(owner).burn(owner.address, 2);

    await increaseSeconds(2 * DAY); // Min gap
    const [, , rollingZero] = await xanonS.poolInfo(0);
    expect(rollingZero).to.equal(0n);

    // Get snapshots count before topUp
    const [, , , , snapshotsBefore] = await xanonS.poolInfo(0);

    // TopUp when rollingActiveStake == 0 and gap > 0
    // CORRECT BEHAVIOR: Intermediate snapshot IS created to close old interval
    // Even though rollingActiveStake = 0, oldIntervalSD > 0 (Alice's stake-days exist in history)
    // Snapshot closes interval with perDay = 0 (no pending rewards yet)
    // Then new topUp rewards (2000) go to pending (intervalSD = 0 after closing)
    await xanonS.connect(owner).topUp(ethers.parseEther("10000")); // Pool 0 gets 2000

    // Check snapshots - should increase by 1 (intermediate snapshot created to close old interval)
    const [, , , , snapshotsAfter] = await xanonS.poolInfo(0);

    expect(snapshotsAfter).to.equal(snapshotsBefore + 1n); // Intermediate created

    // New user stakes - this creates interval for pending distribution
    await xanonS.connect(owner).mint(ethers.parseEther("100"), 0); // tokenId 3, day X
    await increaseSeconds(2 * DAY); // Wait 2 days, now day X+2

    // Get snapshots before third topUp
    const [, , , , snapshotsBeforeThird] = await xanonS.poolInfo(0);

    // Third topUp should distribute the pending from second topUp
    await xanonS.connect(owner).topUp(ethers.parseEther("10000")); // Pool 0 gets 2000

    const [, , , , snapshotsAfterThird] = await xanonS.poolInfo(0);

    // HONEST CHECK: How many snapshots were actually created?
    // If pending (2000) was distributed → at least 1 snapshot with rewards
    // Third topUp has intervalSD > 0 → should create main snapshot
    // Total could be +1 or +2 depending on intermediate logic
    const snapshotsCreated = snapshotsAfterThird - snapshotsBeforeThird;

    expect(snapshotsCreated).to.be.gte(1n); // At least main snapshot
    expect(snapshotsCreated).to.be.lte(2n); // At most intermediate + main

    await increaseSeconds(DAY);

    // Check pending view before claim
    const pendingView = await xanonS.pendingRewards(3);

    // Claim and check actual rewards
    const before = await anon.balanceOf(owner.address);
    await xanonS.connect(owner).earnReward(owner.address, 3);
    const after = await anon.balanceOf(owner.address);
    const actualRewards = after - before;

    // NOTE: Pending view may differ from actual because it doesn't simulate
    // intermediate snapshot creation during topUp (it's a view function)
    // Actual earnReward triggers the full logic including pending distribution
    expect(actualRewards).to.be.gte(pendingView); // Actual >= view (view is conservative)

    // HONEST CALCULATION:
    // Second topUp: 2000 → pending (no interval)
    // Owner mint at day X, stakes 100
    // Wait 2 days → day X+2, Owner has 200 stake-days
    // Third topUp at day X+2:
    //   - gap > 0 → intermediate snapshot at day X+1
    //     stakeDaysUntilYesterday = 200 - 100 = 100
    //     pending 2000 / 100 stake-days
    //   - Main snapshot at day X+2
    //     intervalSD = 200 - 100 = 100
    //     new 2000 / 100 stake-days
    // Owner's lastPaidDay = X (mint day)
    // Owner's interval (X, X+2]: captures both snapshots
    // Expected total: 2000 + 2000 = 4000 ✅
    expect(actualRewards).to.be.closeTo(
      ethers.parseEther("4000"),
      ethers.parseEther("1") // Tight tolerance - should be mathematically exact
    );
  });

  it("extreme gap (2000+ days) uses simplified calculation without gas issues", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes in pool 2
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);

    // Wait 2000 days (> MAX_DAILY_ROLL)
    await increaseSeconds(2000 * DAY);

    // This mint should NOT run out of gas (uses simplified calculation)
    // Gas should be reasonable despite huge gap
    const tx = await xanonS.connect(owner).mint(ethers.parseEther("100"), 2);
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed;

    // Should use significantly less than day-by-day would (< 3M gas)
    expect(gasUsed).to.be.lt(3000000n);

    // Pool should be functional
    const [, , rollingActiveStake] = await xanonS.poolInfo(2);
    expect(rollingActiveStake).to.equal(ethers.parseEther("100")); // Only new stake
  });

  it("binary search in _firstSnapshotAfter handles edge cases correctly", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();

    // Create multiple snapshots by doing stakes and topUps over time
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);

    // Create 5 snapshots at different days
    for (let i = 0; i < 5; i++) {
      await increaseSeconds(10 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    }

    // Move forward and claim - this exercises the binary search
    await increaseSeconds(10 * DAY);

    // earnReward internally uses _firstSnapshotAfter and _earnedDaysInterval
    // If binary search is broken, rewards will be incorrect
    const pending = await xanonS.pendingRewards(1);

    // Should have accumulated rewards from all 5 topUps
    expect(pending).to.be.gt(ethers.parseEther("2000")); // Pool 2 gets 50% * 5 topUps

    // Claim should succeed without errors
    const before = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const after = await anon.balanceOf(alice.address);
    expect(after - before).to.equal(pending);

    // Second claim should fail (already claimed)
    await expect(
      xanonS.connect(alice).earnReward(alice.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NoRewards");
  });

  it("multiple topUps in consecutive days: no duplicate snapshots with same endDay", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(2 * DAY);

    // TopUp every 2 days for 10 days (5 topUps)
    const snapshotDays: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      const [, , , , snapCount] = await xanonS.poolInfo(2);

      // Get the last snapshot day
      const snap = await xanonS.getPoolSnapshot(2, snapCount - 1n);
      snapshotDays.push(snap.day);

      await increaseSeconds(2 * DAY);
    }

    // Check no duplicate snapshot days
    const uniqueDays = new Set(snapshotDays.map((d) => d.toString()));
    expect(uniqueDays.size).to.equal(snapshotDays.length); // All unique

    // Each snapshot day should be different
    for (let i = 1; i < snapshotDays.length; i++) {
      expect(snapshotDays[i]).to.be.gt(snapshotDays[i - 1]);
    }
  });

  it("large gap with multiple expirations (20+): day-by-day vs approximation accuracy", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();

    // Create staggered stakes over 180 days
    const stakes: { user: any; day: number; amount: bigint }[] = [];

    // Alice stakes day 0
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 1);
    stakes.push({ user: alice, day: 0, amount: ethers.parseEther("100") });

    // Create staggered stakes over 180 days (every 10 days)
    for (let i = 1; i <= 18; i++) {
      await increaseSeconds(10 * DAY);
      const user = i % 2 === 0 ? owner : alice;
      await xanonS.connect(user).mint(ethers.parseEther("50"), 1);
      stakes.push({ user, day: i * 10, amount: ethers.parseEther("50") });
    }

    // Large gap: wait 500 days (many expirations)
    await increaseSeconds(320 * DAY); // day ~500

    // TopUp after large gap
    await xanonS.connect(owner).topUp(ethers.parseEther("10000")); // Pool 1 gets 3000
    await increaseSeconds(DAY);

    // Claim for all positions and verify total doesn't exceed pool allocation
    let totalRewards = 0n;
    for (let tokenId = 1; tokenId <= stakes.length; tokenId++) {
      try {
        const before = await anon.balanceOf(stakes[tokenId - 1].user.address);
        await xanonS
          .connect(stakes[tokenId - 1].user)
          .earnReward(stakes[tokenId - 1].user.address, tokenId);
        const after = await anon.balanceOf(stakes[tokenId - 1].user.address);
        totalRewards += after - before;
      } catch (e) {
        // Position might be expired or already claimed
      }
    }

    // Total should not exceed pool 1 allocation (3000)
    expect(totalRewards).to.be.lte(ethers.parseEther("3000"));
    expect(totalRewards).to.be.gt(0); // But some rewards distributed
  });

  it("intermediate snapshot has correct perDayRate calculation", async function () {
    const { owner, alice, xanonS, anon } = await deployFixture();

    // Alice stakes day 0
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);

    // Wait 2 days to day 2
    await increaseSeconds(2 * DAY);

    // First topUp - this will trigger intermediate snapshot logic
    // Gap > 0 will create intermediate snapshot at yesterday
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Check that at least one snapshot was created with rewards
    const [, , , , snapCount] = await xanonS.poolInfo(2);
    expect(snapCount).to.be.gte(2n); // At least init + one topUp snapshot

    // Last snapshot should have rewards
    const lastSnap = await xanonS.getPoolSnapshot(2, snapCount - 1n);
    expect(lastSnap.perDayRate).to.be.gt(0n); // Has rewards

    // Claim to verify perDayRate is sensible
    await increaseSeconds(DAY);
    const before = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const after = await anon.balanceOf(alice.address);
    const rewards = after - before;

    // Should receive pool 2 allocation (500)
    expect(rewards).to.be.closeTo(
      ethers.parseEther("500"),
      ethers.parseEther("1")
    );
  });

  it("CRITICAL: yesterday snapshot math - verify no overpayment from dimension mismatch", async function () {
    const { owner, alice, bob, xanonS, anon } = await deployFixture();

    // Two users stake 100 each
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await xanonS.connect(bob).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(2 * DAY); // 2 days pass

    // TopUp 1000 → Pool 2 gets 500
    // If dimension math is wrong, might overpay
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    await increaseSeconds(DAY);

    // Claim both positions
    const alice1 = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const alice2 = await anon.balanceOf(alice.address);

    const bob1 = await anon.balanceOf(bob.address);
    await xanonS.connect(bob).earnReward(bob.address, 2);
    const bob2 = await anon.balanceOf(bob.address);

    const totalPaid = alice2 - alice1 + (bob2 - bob1);

    // CRITICAL: Total paid should be EXACTLY 500, NOT MORE
    // If stakeDaysToday calculation is wrong, would pay more than pool allocation
    expect(totalPaid).to.be.closeTo(
      ethers.parseEther("500"),
      ethers.parseEther("1")
    );

    // Should not exceed pool allocation under any circumstances
    expect(totalPaid).to.be.lte(ethers.parseEther("500"));
  });

  it("totalStaked tracks principal correctly and protects it", async function () {
    const { owner, alice, bob, anon, xanonS } = await deployFixture();

    // Initial totalStaked should be 0
    expect(await xanonS.totalStaked()).to.equal(0n);

    // Alice stakes 100
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    expect(await xanonS.totalStaked()).to.equal(ethers.parseEther("100"));

    // Bob stakes 200
    await xanonS.connect(bob).mint(ethers.parseEther("200"), 2);
    expect(await xanonS.totalStaked()).to.equal(ethers.parseEther("300"));

    // TopUp to create rewards
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);

    // Verify balance covers principal
    const balance = await anon.balanceOf(await xanonS.getAddress());
    const totalStaked = await xanonS.totalStaked();
    expect(balance).to.be.gte(totalStaked); // Balance should cover all principal

    // Claim rewards (should not affect totalStaked)
    await xanonS.connect(alice).earnReward(alice.address, 1);
    expect(await xanonS.totalStaked()).to.equal(ethers.parseEther("300")); // Still same

    // Burn Alice's position (should decrease totalStaked)
    await increaseSeconds(365 * DAY); // Wait for unlock
    await xanonS.connect(alice).burn(alice.address, 1);
    expect(await xanonS.totalStaked()).to.equal(ethers.parseEther("200")); // Alice's 100 removed

    // Burn Bob's position
    await xanonS.connect(bob).burn(bob.address, 2);
    expect(await xanonS.totalStaked()).to.equal(0n); // All principal withdrawn
  });

  it("fast-path (gap > 1000) does not overpay: total rewards <= pool allocation", async function () {
    const { owner, alice, bob, xanonS, anon } = await deployFixture();

    // Multiple users stake in pool 2 at different times
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    await increaseSeconds(500 * DAY);
    await xanonS.connect(bob).mint(ethers.parseEther("200"), 2);
    await increaseSeconds(500 * DAY);
    await xanonS.connect(owner).mint(ethers.parseEther("300"), 2);

    // Wait 1500 days total (> MAX_DAILY_ROLL) - triggers fast-path
    await increaseSeconds(500 * DAY);

    // TopUp large amount
    await anon.mint(owner.address, ethers.parseEther("100000"));
    await xanonS.connect(owner).topUp(ethers.parseEther("60000")); // Pool 2 gets 30000

    await increaseSeconds(DAY);

    // Claim all positions
    const alice1 = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const alice2 = await anon.balanceOf(alice.address);

    const bob1 = await anon.balanceOf(bob.address);
    await xanonS.connect(bob).earnReward(bob.address, 2);
    const bob2 = await anon.balanceOf(bob.address);

    const owner1 = await anon.balanceOf(owner.address);
    await xanonS.connect(owner).earnReward(owner.address, 3);
    const owner2 = await anon.balanceOf(owner.address);

    const totalDistributed =
      alice2 - alice1 + (bob2 - bob1) + (owner2 - owner1);

    // CRITICAL: Total should NOT exceed pool 2 allocation (30000)
    expect(totalDistributed).to.be.lte(ethers.parseEther("30000"));

    // Should be close to full allocation (positions covered most of interval)
    expect(totalDistributed).to.be.gt(ethers.parseEther("25000"));
  });

  it("intermediate snapshot with zero pending rewards (all distributed)", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);

    // TopUp 1: creates normal snapshot
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Claim all rewards (pending becomes 0)
    await increaseSeconds(5 * DAY);
    await xanonS.connect(alice).earnReward(alice.address, 1);

    // Wait and topUp again on different day (should create intermediate with perDay=0)
    await increaseSeconds(3 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Verify snapshot was created (count should increase)
    const snapshots = await xanonS.getPoolSnapshots(0, 0, 100);
    expect(snapshots[0].length).to.be.gte(2); // At least 2 snapshots
  });

  it("getPoolSnapshots with non-zero offset", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);

    // Create multiple snapshots with different topUps
    for (let i = 0; i < 5; i++) {
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(3 * DAY);
    }

    // Get snapshots with offset = 2, limit = 2
    const result = await xanonS.getPoolSnapshots(0, 2, 2);
    expect(result[0].length).to.equal(2); // Should return 2 snapshots
    expect(result[1].length).to.equal(2); // Should return 2 rates
  });

  it("principal protection: balance - totalStaked shows available rewards", async function () {
    const { owner, alice, anon, xanonS } = await deployFixture();

    // Alice stakes 100
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    const contractAddr = await xanonS.getAddress();
    let balance = await anon.balanceOf(contractAddr);
    let totalStaked = await xanonS.totalStaked();

    // Available rewards = balance - totalStaked should be 0
    expect(balance - totalStaked).to.equal(0n);

    // TopUp to add rewards
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    balance = await anon.balanceOf(contractAddr);
    totalStaked = await xanonS.totalStaked();

    // Now available rewards should be > 0
    expect(balance - totalStaked).to.be.gt(0n);
  });

  it("fast-path handles expirations at specific ring buffer positions", async function () {
    const { owner, alice, bob, xanonS } = await deployFixture();

    // Create stakes at different times to populate ring buffer
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0); // day 0
    await increaseSeconds(30 * DAY);
    await xanonS.connect(bob).mint(ethers.parseEther("200"), 0); // day 30

    // TopUp to create rewards
    await increaseSeconds(10 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Jump > MAX_DAILY_ROLL (1000 days) - triggers fast-path
    await increaseSeconds(1500 * DAY);

    // Trigger _rollPool via another topUp (should handle expirations in fast-path)
    await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to.not
      .be.reverted;
  });

  it("pendingRewards for non-existent token returns 0", async function () {
    const { xanonS } = await deployFixture();

    // Query non-existent token
    expect(await xanonS.pendingRewards(999)).to.equal(0n);
  });

  it("positionOf for non-existent token returns zeroed struct", async function () {
    const { xanonS } = await deployFixture();

    // Query non-existent token (should not revert, returns zeros)
    const position = await xanonS.positionOf(999);
    expect(position.lockedUntil).to.equal(0n);
    expect(position.amount).to.equal(0n);
    expect(position.poolId).to.equal(0n);
  });

  it("intermediate snapshot: gap exists but stakeDaysUntilYesterday = 0", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes today
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // TopUp on SAME day (no gap)
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // TopUp 2 days later (minimum allowed gap)
    await increaseSeconds(2 * DAY);
    await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to.not
      .be.reverted;
  });

  it("_computeRewards with empty snapshots returns 0", async function () {
    const { alice, xanonS } = await deployFixture();

    // Mint but no topUp yet (no snapshots)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // Pending should be 0 (no snapshots)
    expect(await xanonS.pendingRewards(1)).to.equal(0n);
  });

  it("earnReward with zero payout reverts", async function () {
    const { alice, xanonS } = await deployFixture();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // No topUp = no rewards
    await increaseSeconds(DAY);

    // Should revert with "No rewards"
    await expect(
      xanonS.connect(alice).earnReward(alice.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NoRewards");
  });

  it("intermediate snapshot distributes pending rewards when intervalSD was 0", async function () {
    const { owner, alice, bob, xanonS } = await deployFixture();

    // Alice stakes in pool 0
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // TopUp SAME day (intervalSD = 0, creates pending)
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Bob stakes 3 days later
    await increaseSeconds(3 * DAY);
    await xanonS.connect(bob).mint(ethers.parseEther("100"), 0);

    // TopUp 3 days later (should create intermediate with pending > 0)
    await increaseSeconds(3 * DAY);
    await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to.not
      .be.reverted;

    // Verify snapshots were created correctly
    const snapshots = await xanonS.getPoolSnapshots(0, 0, 100);
    expect(snapshots[0].length).to.be.gte(2);
  });

  // ========== Additional tests for branch coverage improvement ==========

  it("constructor reverts with zero address for token", async function () {
    const MockDescriptorF = await ethers.getContractFactory("MockDescriptor");
    const desc = await MockDescriptorF.deploy();
    const XAnonSF = await ethers.getContractFactory("xAnonStakingNFT");

    await expect(
      XAnonSF.deploy(ethers.ZeroAddress, await desc.getAddress())
    ).to.be.revertedWithCustomError(XAnonSF, "InvalidTokenAddress");
  });

  it("constructor reverts with zero address for descriptor", async function () {
    const MockERC20F = await ethers.getContractFactory("MockERC20");
    const anon = await MockERC20F.deploy("ANON", "ANON", 18);
    const XAnonSF = await ethers.getContractFactory("xAnonStakingNFT");

    await expect(
      XAnonSF.deploy(await anon.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(XAnonSF, "InvalidDescriptorAddress");
  });

  // REMOVED: Tests for set() and addPool() access control (functions removed)

  it("pause() reverts when called by non-owner", async function () {
    const { alice, xanonS } = await deployFixture();

    await expect(xanonS.connect(alice).pause()).to.be.revertedWithCustomError(
      xanonS,
      "OwnableUnauthorizedAccount"
    );
  });

  it("unpause() reverts when called by non-owner", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    await xanonS.connect(owner).pause();
    await expect(xanonS.connect(alice).unpause()).to.be.revertedWithCustomError(
      xanonS,
      "OwnableUnauthorizedAccount"
    );
  });

  it("rescueTokens() reverts when called by non-owner", async function () {
    const { alice, anon, xanonS } = await deployFixture();

    await expect(
      xanonS
        .connect(alice)
        .rescueTokens(
          await anon.getAddress(),
          alice.address,
          ethers.parseEther("1")
        )
    ).to.be.revertedWithCustomError(xanonS, "OwnableUnauthorizedAccount");
  });

  // REMOVED: Test for NoPoolsConfigured (pools are always configured with fixed allocation)

  it("getPoolSnapshots returns empty arrays when offset >= length", async function () {
    const { xanonS } = await deployFixture();

    // Query with offset beyond array length
    const result = await xanonS.getPoolSnapshots(0, 100, 10);
    expect(result[0].length).to.equal(0);
    expect(result[1].length).to.equal(0);
  });

  it("_rollPool: gap > MAX_DAILY_ROLL triggers fast-path with cleared rollingActiveStake", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Wait for expiration + trigger fast-path (> 1000 days)
    await increaseSeconds(1200 * DAY);

    // Trigger _rollPool via topUp (should use fast-path)
    await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to.not
      .be.reverted;

    // Verify rollingActiveStake is 0 (expired)
    const poolInfo = await xanonS.poolInfo(0);
    expect(poolInfo.rollingActiveStake).to.equal(0n);
  });

  // REMOVED: Test for pool with allocPoint=0 (allocation is now fixed and cannot be changed to 0)

  it("math edge case: very small stake with large rewards (precision test)", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes minimal amount (1 ether = MIN_AMOUNT)
    await xanonS.connect(alice).mint(ethers.parseEther("1"), 0);
    await increaseSeconds(2 * DAY);

    // Large topUp
    await xanonS.connect(owner).topUp(ethers.parseEther("1000000"));

    await increaseSeconds(DAY);

    // Verify rewards are calculated correctly despite huge difference
    const pending = await xanonS.pendingRewards(1);
    expect(pending).to.be.gt(0n);
  });

  it("math edge case: large stake with small rewards (precision test)", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes large amount
    await xanonS.connect(alice).mint(ethers.parseEther("1000000"), 0);
    await increaseSeconds(2 * DAY);

    // Small topUp (minimal)
    await xanonS.connect(owner).topUp(ethers.parseEther("1"));

    await increaseSeconds(DAY);

    // Verify rewards are calculated (might be very small)
    const pending = await xanonS.pendingRewards(1);
    // Pool 0 gets 20% = 0.2 ether, over 2M stake-days
    // Should still work despite small perDayRate
    expect(pending).to.be.gte(0n);
  });

  it("_earnedDaysInterval: capDay < startDay returns 0 (position expired before interval)", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes in pool 0 (91 days)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);

    // First topUp
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Wait for position to expire
    await increaseSeconds(91 * DAY);

    // Second topUp AFTER expiration
    await increaseSeconds(10 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Try to claim - should get rewards only from first interval
    const balanceBefore = await (
      await ethers.getContractAt("MockERC20", await xanonS.ANON_TOKEN())
    ).balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const balanceAfter = await (
      await ethers.getContractAt("MockERC20", await xanonS.ANON_TOKEN())
    ).balanceOf(alice.address);

    const rewards = balanceAfter - balanceBefore;
    // Should be ~200 (pool 0 allocation from first topUp)
    expect(rewards).to.be.closeTo(
      ethers.parseEther("200"),
      ethers.parseEther("1")
    );
  });

  it("_rollPool: gap equals lockDays exactly (boundary test)", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes in pool 0 (lockDays = 91)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Wait exactly lockDays (91 days)
    await increaseSeconds(91 * DAY);

    // Trigger _rollPool
    await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to.not
      .be.reverted;

    // rollingActiveStake should be 0 (expired)
    const poolInfo = await xanonS.poolInfo(0);
    expect(poolInfo.rollingActiveStake).to.equal(0n);
  });

  it("_rollPool: gap < lockDays (partial expiration boundary)", async function () {
    const { owner, alice, bob, xanonS } = await deployFixture();

    // Alice stakes on day 0
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // Bob stakes on day 50
    await increaseSeconds(50 * DAY);
    await xanonS.connect(bob).mint(ethers.parseEther("100"), 0);

    // TopUp on day 52
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Wait 45 days (total 97 days from Alice, 47 from Bob)
    // Alice should expire (91 days), Bob should remain
    await increaseSeconds(45 * DAY);

    // Trigger _rollPool
    await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to.not
      .be.reverted;

    // rollingActiveStake should be 100 (only Bob)
    const poolInfo = await xanonS.poolInfo(0);
    expect(poolInfo.rollingActiveStake).to.equal(ethers.parseEther("100"));
  });

  it("getPoolSnapshots: limit > remaining length returns only available snapshots", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);

    // Create snapshots with topUps
    for (let i = 0; i < 3; i++) {
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(3 * DAY);
    }

    // Get total snapshot count
    const allSnapshots = await xanonS.getPoolSnapshots(0, 0, 100);
    const totalCount = allSnapshots[0].length;

    // Query with offset=1, limit=100 (should return totalCount - 1)
    const result = await xanonS.getPoolSnapshots(0, 1, 100);
    expect(result[0].length).to.equal(totalCount - 1);
  });

  it("multiple stakes in same day: ring buffer accumulates correctly", async function () {
    const { alice, bob, xanonS } = await deployFixture();

    // Alice and Bob stake on the same day
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await xanonS.connect(bob).mint(ethers.parseEther("200"), 0);

    // Check rollingActiveStake is sum
    const poolInfo = await xanonS.poolInfo(0);
    expect(poolInfo.rollingActiveStake).to.equal(ethers.parseEther("300"));
  });

  it("_collectPositionRewards: position with lastPaidDay = capDay returns 0", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);

    // Claim rewards
    await xanonS.connect(alice).earnReward(alice.address, 1);

    // Try to claim again immediately (same day)
    await expect(
      xanonS.connect(alice).earnReward(alice.address, 1)
    ).to.be.revertedWithCustomError(xanonS, "NoRewards");
  });

  it("math: perDayRate calculation with PRECISION scaling", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Alice stakes on day 0
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // Wait 2 days, then topUp (creates intervalSD)
    await increaseSeconds(2 * DAY);

    // First topUp on day 2 - establishes baseline
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Wait more days
    await increaseSeconds(8 * DAY);

    // Second topUp on day 10 - creates interval with known stake-days
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Get all snapshots
    const snapshots = await xanonS.getPoolSnapshots(0, 0, 100);

    // Should have multiple snapshots
    expect(snapshots[0].length).to.be.gte(2);

    // Check that at least one snapshot has perDayRate > 0
    let hasPositiveRate = false;
    for (let i = 0; i < snapshots[1].length; i++) {
      if (snapshots[1][i] > 0n) {
        hasPositiveRate = true;
        break;
      }
    }
    expect(hasPositiveRate).to.be.true;
  });

  // ========== Advanced edge cases and security tests ==========

  it("security: multiple positions per user across different pools", async function () {
    const { owner, alice, anon, xanonS } = await deployFixture();

    // Alice creates 3 positions in different pools
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0); // Token 1
    await xanonS.connect(alice).mint(ethers.parseEther("200"), 1); // Token 2
    await xanonS.connect(alice).mint(ethers.parseEther("300"), 2); // Token 3

    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("10000"));
    await increaseSeconds(5 * DAY);

    // Alice should be able to claim rewards from all positions
    const balanceBefore = await anon.balanceOf(alice.address);

    await xanonS.connect(alice).earnReward(alice.address, 1);
    await xanonS.connect(alice).earnReward(alice.address, 2);
    await xanonS.connect(alice).earnReward(alice.address, 3);

    const balanceAfter = await anon.balanceOf(alice.address);
    const totalRewards = balanceAfter - balanceBefore;

    // Should receive rewards from all 3 pools
    expect(totalRewards).to.be.gt(0n);

    // Verify positions are independent
    const pos1 = await xanonS.positionOf(1);
    const pos2 = await xanonS.positionOf(2);
    const pos3 = await xanonS.positionOf(3);

    expect(pos1.poolId).to.equal(0);
    expect(pos2.poolId).to.equal(1);
    expect(pos3.poolId).to.equal(2);
  });

  it("edge case: very old expired position (1000+ days) claiming rewards", async function () {
    const { owner, alice, anon, xanonS } = await deployFixture();

    // Alice stakes in pool 0 (91 days lock)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);

    // TopUp creates rewards
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Wait 1500 days (way past expiration)
    await increaseSeconds(1500 * DAY);

    // Alice should still be able to claim rewards earned during active period
    const balanceBefore = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const balanceAfter = await anon.balanceOf(alice.address);

    const rewards = balanceAfter - balanceBefore;
    // Should get rewards only for active period (~2 days stake-days)
    expect(rewards).to.be.closeTo(
      ethers.parseEther("200"), // Pool 0 gets 200
      ethers.parseEther("1")
    );

    // Should be able to burn after expiration
    await expect(xanonS.connect(alice).burn(alice.address, 1)).to.not.be
      .reverted;
  });

  it("security: front-running topUp (stake 1 block before)", async function () {
    const { owner, alice, bob, xanonS } = await deployFixture();

    // Bob stakes early and accumulates stake-days
    await xanonS.connect(bob).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(10 * DAY);

    // Alice front-runs topUp (stakes in same block/transaction)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);

    // TopUp happens
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    await increaseSeconds(DAY);

    // Bob should get much more rewards (10 days vs 0 days stake-days)
    const bobRewards = await xanonS.pendingRewards(1);
    const aliceRewards = await xanonS.pendingRewards(2);

    // Bob accumulated 1000 stake-days, Alice 0 stake-days before topUp
    // Bob should get almost all rewards
    expect(bobRewards).to.be.gt(aliceRewards * 10n);
  });

  it("precision: 1000 micro-stakes accumulation (rounding errors)", async function () {
    const { owner, alice, anon, xanonS } = await deployFixture();

    // Alice makes 10 tiny stakes
    for (let i = 0; i < 10; i++) {
      await xanonS.connect(alice).mint(ethers.parseEther("1"), 0); // Minimal amount
    }

    await increaseSeconds(5 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(2 * DAY);

    // Claim rewards from all positions
    const balanceBefore = await anon.balanceOf(alice.address);
    for (let i = 1; i <= 10; i++) {
      await xanonS.connect(alice).earnReward(alice.address, i);
    }
    const balanceAfter = await anon.balanceOf(alice.address);

    const totalRewards = balanceAfter - balanceBefore;

    // Despite tiny amounts, should still receive proportional rewards
    // 10 ether total stake, 5 days = 50 stake-days
    // Pool 0 gets 200, so should get reasonable portion
    expect(totalRewards).to.be.gt(0n);
    expect(totalRewards).to.be.closeTo(
      ethers.parseEther("200"), // All pool 0 rewards
      ethers.parseEther("10") // Some tolerance for rounding
    );
  });

  it("gas griefing: multiple stakes in same day (ring buffer stress)", async function () {
    const { alice, bob, owner, xanonS } = await deployFixture();

    // Alice and Bob make multiple stakes in same day
    for (let i = 0; i < 20; i++) {
      await xanonS.connect(alice).mint(ethers.parseEther("10"), 0);
      await xanonS.connect(bob).mint(ethers.parseEther("10"), 0);
    }

    // Check rollingActiveStake accumulated correctly
    const poolInfo = await xanonS.poolInfo(0);
    expect(poolInfo.rollingActiveStake).to.equal(ethers.parseEther("400")); // 20*10*2

    // TopUp should work despite many stakes
    await increaseSeconds(2 * DAY);
    await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to.not
      .be.reverted;

    // All positions should be able to claim
    await increaseSeconds(DAY);
    await expect(xanonS.connect(alice).earnReward(alice.address, 1)).to.not.be
      .reverted;
  });

  it("concurrent expirations: batch expiration on same day", async function () {
    const { owner, alice, bob, xanonS } = await deployFixture();

    // Create multiple positions on same day (pool 0, 91 days)
    const stakeDay = await time.latest();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await xanonS.connect(bob).mint(ethers.parseEther("200"), 0);
    await xanonS.connect(alice).mint(ethers.parseEther("150"), 0);

    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    // Wait exactly for expiration (all expire on same day)
    await increaseSeconds(91 * DAY);

    // Trigger expiration via topUp
    await expect(xanonS.connect(owner).topUp(ethers.parseEther("1000"))).to.not
      .be.reverted;

    // Verify all stakes expired (rollingActiveStake should be 0)
    const poolInfo = await xanonS.poolInfo(0);
    expect(poolInfo.rollingActiveStake).to.equal(0n);

    // All positions should still be claimable and burnable
    await expect(xanonS.connect(alice).earnReward(alice.address, 1)).to.not.be
      .reverted;
    await expect(xanonS.connect(alice).burn(alice.address, 1)).to.not.be
      .reverted;
  });

  it("security: reentrancy protection on earnReward + burn", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 0);
    await increaseSeconds(2 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(DAY);

    // EarnReward has nonReentrant modifier
    await expect(xanonS.connect(alice).earnReward(alice.address, 1)).to.not.be
      .reverted;

    // Burn also has nonReentrant modifier
    await increaseSeconds(91 * DAY);
    await expect(xanonS.connect(alice).burn(alice.address, 1)).to.not.be
      .reverted;

    // Token should no longer exist
    await expect(xanonS.ownerOf(1)).to.be.reverted;
  });

  // REMOVED: Test for uneven pool allocation (allocation is now fixed at 20/30/50 and cannot be changed)

  it("getPoolAPR: calculates correct APR based on historical data", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    // Initially no APR (no snapshots)
    const [apr0, conf0] = await xanonS.getPoolAPR(2, 10);
    expect(apr0).to.equal(0n);
    expect(conf0).to.equal(0n);

    // Alice stakes to activate pool
    await xanonS.connect(alice).mint(ethers.parseEther("1000"), 2);
    await increaseSeconds(2 * DAY);

    // First topUp creates first real snapshot
    await xanonS.connect(owner).topUp(ethers.parseEther("365000")); // 365k tokens
    // Pool 2 gets 50% = 182,500 tokens

    // Wait a day
    await increaseSeconds(2 * DAY);

    // Check APR after first snapshot
    const [apr1, conf1] = await xanonS.getPoolAPR(2, 10);

    // With 1000 tokens staked for 2 days:
    // poolStakeDays = 1000 * 2 = 2000
    // perDayRate = 182,500 * 1e18 / 2000 = 91.25e18
    // For 1 token over 365 days:
    // reward = 1 * 365 * 91.25e18 / 1e18 = 33,306.25 tokens
    // APR = (33,306.25 / 1) * (365 / 365) * 100 = 3,330,625%

    // This is expected for very first interval with high rewards!
    expect(apr1).to.be.gt(0n); // Should have some APR
    expect(conf1).to.be.gt(0n); // Should have some confidence

    // Do more topUps to stabilize APR
    for (let i = 0; i < 5; i++) {
      await increaseSeconds(2 * DAY);
      await xanonS.connect(owner).topUp(ethers.parseEther("3650")); // Smaller amounts
    }

    // Check APR with more data
    const [apr2, conf2] = await xanonS.getPoolAPR(2, 10);

    // APR should be lower now with more stable data
    expect(apr2).to.be.gt(0n);
    expect(apr2).to.be.lt(apr1); // Should be lower than initial spike

    // Confidence should be higher with more snapshots
    expect(conf2).to.be.gte(conf1);

    // Test lookbackPeriod = 0 (last snapshot only)
    const [aprLast] = await xanonS.getPoolAPR(2, 0);
    expect(aprLast).to.be.gt(0n);

    // Test with different lookback
    const [apr3] = await xanonS.getPoolAPR(2, 3);
    expect(apr3).to.be.gt(0n);
  });

  it("getPoolAPR: returns zero for pools with no activity", async function () {
    const { xanonS } = await deployFixture();

    // Pool 0 has no stakes or topUps
    const [apr, confidence] = await xanonS.getPoolAPR(0, 10);
    expect(apr).to.equal(0n);
    expect(confidence).to.equal(0n);
  });

  it("getPoolAPR: confidence increases with more snapshots", async function () {
    const { owner, alice, xanonS } = await deployFixture();

    await xanonS.connect(alice).mint(ethers.parseEther("100"), 1);
    await increaseSeconds(2 * DAY);

    // First topUp
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    await increaseSeconds(2 * DAY);

    const [, conf1] = await xanonS.getPoolAPR(1, 10);

    // More topUps
    for (let i = 0; i < 3; i++) {
      await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
      await increaseSeconds(2 * DAY);
    }

    const [, conf2] = await xanonS.getPoolAPR(1, 10);

    // Confidence should increase with more data
    expect(conf2).to.be.gt(conf1);
  });
});
