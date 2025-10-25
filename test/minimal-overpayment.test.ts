import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { MockERC20, XAnonStakingNFT } from "../typechain-types";

describe("MINIMAL: Empty Pool Redistribution Test", function () {
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

  it("Test: 1 user, 2 topUps with gap", async function () {
    const { owner, alice, anon, xanonS } = await deploy();

    console.log("\nEmpty Pool Redistribution:");
    console.log("1 user, pool2 only, 2 topUps\n");

    // Alice stakes
    await xanonS.connect(alice).mint(ethers.parseEther("100"), 2);
    console.log("Day 0: Alice stakes 100 in pool2");
    console.log("       Pool0 and Pool1 are EMPTY");

    // TopUp #1
    await time.increase(5 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    console.log(
      "Day 5: topUp #1 (1000) → pool2 gets 1000 (100% due to redistribution)"
    );

    // TopUp #2
    await time.increase(3 * DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther("1000"));
    console.log(
      "Day 8: topUp #2 (1000) → pool2 gets 1000 (100% due to redistribution)\n"
    );

    // Claim
    await time.increase(DAY);
    const bal1 = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const bal2 = await anon.balanceOf(alice.address);
    const rewards = bal2 - bal1;

    console.log(`Alice claimed: ${ethers.formatEther(rewards)}`);
    console.log(`Expected: 2000 (1000 + 1000)`);
    console.log(
      `Reason: Pool0 and Pool1 are empty, so ALL rewards go to Pool2 (empty pool redistribution)`
    );
    console.log("");

    // Check - Pool2 is the ONLY active pool, so it gets 100% of topUps
    const expected = ethers.parseEther("2000");
    const tolerance = expected / 100n; // 1%

    if (rewards > expected + tolerance) {
      console.log(`❌ OVERPAYMENT: ${ethers.formatEther(rewards - expected)}`);
      expect(rewards).to.be.lte(expected + tolerance, "Overpayment detected");
    } else if (rewards < expected - tolerance) {
      console.log(
        `⚠️  UNDERPAYMENT: ${ethers.formatEther(expected - rewards)}`
      );
      expect(rewards).to.be.gte(expected - tolerance, "Underpayment detected");
    } else {
      console.log("✅ Correct distribution");
    }
  });
});
