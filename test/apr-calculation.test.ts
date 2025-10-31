import { expect } from 'chai';
import { ethers } from 'hardhat';
import { calculatePoolAPR } from '../scripts/calculatePoolAPR';
import type { MockERC20, XAnonStakingNFT, MockDescriptor } from '../typechain-types';

const DAY = 24 * 60 * 60;

describe('APR Calculation Test', function () {
  it('Pool 0=46738, Pool 1=69902, Pool 2=136691 → topUp 2952 after 2 days', async function () {
    const [owner, alice, bob, carol] = await ethers.getSigners();

    // Deploy contracts
    const MockERC20F = await ethers.getContractFactory('MockERC20');
    const anonToken = (await MockERC20F.deploy('ANON', 'ANON', 18)) as unknown as MockERC20;

    const MockDescF = await ethers.getContractFactory('MockDescriptor');
    const descriptor = (await MockDescF.deploy()) as unknown as MockDescriptor;

    const XAnonSF = await ethers.getContractFactory('xAnonStakingNFT');
    const xanonS = (await XAnonSF.deploy(
      await anonToken.getAddress(),
      await descriptor.getAddress(),
    )) as unknown as XAnonStakingNFT;

    // Setup
    const amount = ethers.parseEther('1000000');
    await anonToken.mint(owner.address, amount);
    await anonToken.mint(alice.address, amount);
    await anonToken.mint(bob.address, amount);
    await anonToken.mint(carol.address, amount);
    await anonToken.connect(owner).approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anonToken.connect(alice).approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anonToken.connect(bob).approve(await xanonS.getAddress(), ethers.MaxUint256);
    await anonToken.connect(carol).approve(await xanonS.getAddress(), ethers.MaxUint256);

    // Stake in pools
    await xanonS.connect(alice).mint(ethers.parseEther('46738'), 0);
    await xanonS.connect(bob).mint(ethers.parseEther('69902'), 1);
    await xanonS.connect(carol).mint(ethers.parseEther('136691'), 2);

    // Wait 2 days and topUp
    await ethers.provider.send('evm_increaseTime', [2 * DAY]);
    await ethers.provider.send('evm_mine', []);
    await xanonS.connect(owner).topUp(ethers.parseEther('2952'));

    // Calculate APR using TypeScript helper (same logic as contract now)
    const apr0 = await calculatePoolAPR(xanonS, 0);
    const apr1 = await calculatePoolAPR(xanonS, 1);
    const apr2 = await calculatePoolAPR(xanonS, 2);

    // Also get from contract to compare
    const contractAPR0 = await xanonS.getPoolAPR(0);
    const contractAPR1 = await xanonS.getPoolAPR(1);
    const contractAPR2 = await xanonS.getPoolAPR(2);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 APR RESULTS:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`   Pool 0 (91d):   ${apr0.toFixed(2)}% (contract: ${(Number(contractAPR0) / 100).toFixed(2)}%)`);
    console.log(`   Pool 1 (182d):  ${apr1.toFixed(2)}% (contract: ${(Number(contractAPR1) / 100).toFixed(2)}%)`);
    console.log(`   Pool 2 (365d):  ${apr2.toFixed(2)}% (contract: ${(Number(contractAPR2) / 100).toFixed(2)}%)`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n💡 EXPLANATION:');
    console.log('   Pool 0 & 1: ~230% (stake matches allocation)');
    console.log('   Pool 2: ~197% (stake > allocation → lower APR)');
    console.log('   ✅ TypeScript and Solidity give IDENTICAL results!');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Verify both methods give same results
    expect(apr0).to.equal(Number(contractAPR0) / 100);
    expect(apr1).to.equal(Number(contractAPR1) / 100);
    expect(apr2).to.equal(Number(contractAPR2) / 100);
  });
});
