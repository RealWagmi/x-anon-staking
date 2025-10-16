import hardhat, { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = hardhat.network.name;

  console.log(`\n[${network}] Deploying from: ${deployer.address}`);

  // Get ANON token from env
  const anonToken = "";
  const descriptor = "";
  if (!anonToken || !descriptor)
    throw new Error("Set ANON_TOKEN_ADDRESS and DESCRIPTOR_ADDRESS");

  // Deploy staking
  const Staking = await ethers.getContractFactory("xAnonStakingNFT");
  const staking = await Staking.deploy(anonToken, descriptor);
  await staking.waitForDeployment();
  console.log(`xAnonStakingNFT: ${await staking.getAddress()}`);

  // Show pools
  console.log("\nPools:");
  for (let i = 0; i < 3; i++) {
    const [alloc, days] = await staking.poolInfo(i);
    console.log(`  ${i}: ${alloc / 100}% / ${days}d`);
  }
  console.log();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
