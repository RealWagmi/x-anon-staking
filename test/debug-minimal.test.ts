import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { MockERC20, XAnonStakingNFT } from '../typechain-types';

describe('DEBUG: Minimal Test', function () {
  const DAY = 24 * 60 * 60;

  async function deploy() {
    const [owner, alice] = await ethers.getSigners();
    const MockERC20F = await ethers.getContractFactory('MockERC20');
    const anon = (await MockERC20F.deploy('ANON', 'ANON', 18)) as unknown as MockERC20;
    const MockDescriptorF = await ethers.getContractFactory('MockDescriptor');
    const desc = await MockDescriptorF.deploy();
    const XAnonSF = await ethers.getContractFactory('xAnonStakingNFT');
    const xanonS = (await XAnonSF.deploy(
      await anon.getAddress(),
      await desc.getAddress(),
    )) as unknown as XAnonStakingNFT;

    await anon.mint(owner.address, ethers.parseEther('100000'));
    await anon.mint(alice.address, ethers.parseEther('100000'));
    await anon.connect(alice).approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anon.connect(owner).approve(await xanonS.getAddress(), ethers.MaxUint256);

    return { owner, alice, anon, xanonS };
  }

  it('Debug: Step by step', async function () {
    const { owner, alice, anon, xanonS } = await deploy();

    const startDay = Math.floor((await time.latest()) / DAY);
    console.log(`\n=== START DAY: ${startDay} ===\n`);

    // Alice stakes
    await xanonS.connect(alice).mint(ethers.parseEther('100'), 2);
    let [, lockDays, rolling, lastUpd, snapsCount] = await xanonS.poolInfo(2);
    console.log(`Day ${startDay}: Alice stakes 100`);
    console.log(`  rollingActiveStake: ${ethers.formatEther(rolling)}`);
    console.log(`  lastUpdatedDay: ${lastUpd}`);
    console.log(`  snapshots: ${snapsCount}\n`);

    // TopUp #1
    await time.increase(5 * DAY);
    const day1 = Math.floor((await time.latest()) / DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther('1000'));
    [, , rolling, lastUpd, snapsCount] = await xanonS.poolInfo(2);

    console.log(`Day ${day1}: topUp #1 (1000)`);
    console.log(`  rollingActiveStake: ${ethers.formatEther(rolling)}`);
    console.log(`  lastUpdatedDay: ${lastUpd}`);
    console.log(`  snapshots: ${snapsCount}`);

    let snap = await xanonS.getPoolSnapshot(2, snapsCount - 1n);
    console.log(`  snapshot[${snapsCount - 1n}]: day=${snap[0]}, perDayRate=${snap[1]}`);

    let pending = await xanonS.pendingRewards(1);
    console.log(`  Alice pending: ${ethers.formatEther(pending)}\n`);

    // TopUp #2
    await time.increase(3 * DAY);
    const day2 = Math.floor((await time.latest()) / DAY);
    await xanonS.connect(owner).topUp(ethers.parseEther('1000'));
    [, , rolling, lastUpd, snapsCount] = await xanonS.poolInfo(2);

    console.log(`Day ${day2}: topUp #2 (1000)`);
    console.log(`  rollingActiveStake: ${ethers.formatEther(rolling)}`);
    console.log(`  lastUpdatedDay: ${lastUpd}`);
    console.log(`  snapshots: ${snapsCount}`);

    snap = await xanonS.getPoolSnapshot(2, snapsCount - 1n);
    console.log(`  snapshot[${snapsCount - 1n}]: day=${snap[0]}, perDayRate=${snap[1]}`);

    pending = await xanonS.pendingRewards(1);
    console.log(`  Alice pending: ${ethers.formatEther(pending)}\n`);

    // Claim
    await time.increase(DAY);
    const day3 = Math.floor((await time.latest()) / DAY);
    const bal1 = await anon.balanceOf(alice.address);
    await xanonS.connect(alice).earnReward(alice.address, 1);
    const bal2 = await anon.balanceOf(alice.address);
    const rewards = bal2 - bal1;

    console.log(`Day ${day3}: Alice claims`);
    console.log(`  Received: ${ethers.formatEther(rewards)}`);
    console.log(`  Expected: 1000 (500+500)`);

    // Calculate manually
    const snapshot1 = await xanonS.getPoolSnapshot(2, 1);
    const snapshot2 = await xanonS.getPoolSnapshot(2, 2);
    console.log(`\n=== MANUAL CALCULATION ===`);
    console.log(`Snapshot 1: day=${snapshot1[0]}, rate=${snapshot1[1]}`);
    console.log(`Snapshot 2: day=${snapshot2[0]}, rate=${snapshot2[1]}`);

    // Period 1: from startDay to snapshot1.day
    const days1 = Number(snapshot1[0]) - startDay;
    const reward1 = (100n * BigInt(days1) * snapshot1[1]) / 10n ** 18n;
    console.log(`Period 1: ${days1} days * 100 * ${snapshot1[1]} / 1e18 = ${reward1}`);

    // Period 2: from snapshot1.day to snapshot2.day
    const days2 = Number(snapshot2[0]) - Number(snapshot1[0]);
    const reward2 = (100n * BigInt(days2) * snapshot2[1]) / 10n ** 18n;
    console.log(`Period 2: ${days2} days * 100 * ${snapshot2[1]} / 1e18 = ${reward2}`);

    console.log(`Total calculated: ${reward1 + reward2}\n`);
  });
});
