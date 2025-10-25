import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { MockERC20, XAnonStakingNFT } from "../typechain-types";

describe("DEBUG: poolStakeDays Analysis", function () {
  const DAY = 24 * 60 * 60;

  async function deploy() {
    const [owner, alice] = await ethers.getSigners();
    const MockERC20F = await ethers.getContractFactory("MockERC20");
    const anon = (await MockERC20F.deploy(
      "ANON",
      "ANON",
      18
    )) as unknown as MockERC20;
    const MockDescriptorF = await ethers.getContractFactory("MockDescriptor");
    const desc = await MockDescriptorF.deploy();
    const XAnonSF = await ethers.getContractFactory("xAnonStakingNFT");
    const xanonS = (await XAnonSF.deploy(
      await anon.getAddress(),
      await desc.getAddress()
    )) as unknown as XAnonStakingNFT;

    await anon.mint(owner.address, ethers.parseEther("100000"));
    await anon.mint(alice.address, ethers.parseEther("100000"));
    await anon
      .connect(alice)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anon
      .connect(owner)
      .approve(await xanonS.getAddress(), ethers.MaxUint256);

    return { owner, alice, anon, xanonS };
  }

  it("Analyze poolStakeDays accumulation", async function () {
    const { owner, alice, xanonS } = await deploy();

    const startDay = Math.floor((await time.latest()) / DAY);
    console.log(`\n=== START DAY: ${startDay} ===\n`);

    // Alice stakes 100 in pool2 ONLY (pool0 and pool1 are EMPTY)
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    console.log(`Day ${startDay}: Alice stakes 100 in pool2`);
    console.log(
      `  Pool0 and Pool1 are EMPTY → empty pool redistribution applies`
    );
    console.log(`  Position starts earning from day ${startDay + 1}`);

    // TopUp #1 after 5 days
    await time.increase(5 * DAY);
    const topUpDay1 = Math.floor((await time.latest()) / DAY);

    console.log(`\nDay ${topUpDay1}: TopUp #1 (1000 total)`);

    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    const snap1 = await xanonS.getPoolSnapshot(2, 1);
    console.log(`  Snapshot created: day=${snap1[0]}, perDayRate=${snap1[1]}`);

    // Calculate ACTUAL reward distributed to pool2 from perDayRate
    const days1 = Number(snap1[0]) - startDay;
    const reward1 = (snap1[1] * BigInt(days1) * 100n) / 10n ** 18n;
    console.log(
      `  Pool2 received: ${ethers.formatEther(
        reward1
      )} ANON (100% due to empty pool redistribution)`
    );
    console.log(`  Period: ${days1} days`);
    console.log(`  Expected poolStakeDays: 100 * ${days1} = ${100 * days1}`);

    // TopUp #2 after 3 more days
    await time.increase(3 * DAY);
    const topUpDay2 = Math.floor((await time.latest()) / DAY);

    console.log(`\nDay ${topUpDay2}: TopUp #2 (1000 total)`);

    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));

    const snap2 = await xanonS.getPoolSnapshot(2, 2);
    console.log(`  Snapshot created: day=${snap2[0]}, perDayRate=${snap2[1]}`);

    const days2 = Number(snap2[0]) - Number(snap1[0]);
    const reward2 = (snap2[1] * BigInt(days2) * 100n) / 10n ** 18n;
    console.log(
      `  Pool2 received: ${ethers.formatEther(
        reward2
      )} ANON (100% due to empty pool redistribution)`
    );
    console.log(`  Period: ${days2} days`);
    console.log(`  Expected poolStakeDays: 100 * ${days2} = ${100 * days2}`);

    // Calculate Alice's rewards manually
    console.log(`\n=== ALICE REWARDS CALCULATION ===`);

    const aliceReward1 = (100n * BigInt(days1) * snap1[1]) / 10n ** 18n;
    console.log(
      `Period 1: ${days1} days * 100 tokens * ${snap1[1]} / 1e18 = ${aliceReward1}`
    );

    const aliceReward2 = (100n * BigInt(days2) * snap2[1]) / 10n ** 18n;
    console.log(
      `Period 2: ${days2} days * 100 tokens * ${snap2[1]} / 1e18 = ${aliceReward2}`
    );

    const totalCalculated = aliceReward1 + aliceReward2;
    const totalDistributed = reward1 + reward2;
    console.log(`Total calculated (Alice): ${totalCalculated}`);
    console.log(`Total distributed (Pool2): ${totalDistributed}`);
    console.log(`Total topUps: 1000 + 1000 = 2000`);

    // With empty pool redistribution, pool2 should get 100% of both topUps
    const expectedTotal = 2000n;
    if (totalCalculated > expectedTotal) {
      console.log(
        `\n❌ OVERPAYMENT: ${totalCalculated - expectedTotal} (${
          ((totalCalculated - expectedTotal) * 100n) / expectedTotal
        }%)`
      );
    } else if (totalCalculated < expectedTotal - 10n) {
      // Allow small rounding
      console.log(`\n⚠️  UNDERPAYMENT: ${expectedTotal - totalCalculated}`);
    } else {
      console.log(
        `\n✅ CORRECT (empty pool redistribution working as expected)`
      );
    }
  });
});
