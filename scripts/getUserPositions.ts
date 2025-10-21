import hardhat, { ethers } from 'hardhat';
import { Wallet } from 'ethers';

async function main() {
    const provider = new ethers.JsonRpcProvider('https://rpc.soniclabs.com');

    const anonStaking = await ethers.getContractAt('xAnonStakingNFT', '0xC685F576843bB0cBa8da98a2f2b2Ad5D1Faa47EC');

    const user = '0xFc7E872950CF28b98eaBE02d3292448744eC45Ef';

    const userLength = await anonStaking.balanceOf(user);
    console.log(`User ${user} has ${userLength} positions`);

    for (let i = 0; i < userLength; i++) {
        const tokenId = await anonStaking.tokenOfOwnerByIndex(user, i);
        const position = await anonStaking.positionOf(tokenId);
        console.log(`Token ID: ${tokenId}`);
        console.log(`Amount: ${position.amount}`);
        console.log(`Pool ID: ${position.poolId}`);
        console.log(`Locked Until: ${position.lockedUntil}`);
        console.log(`Last Paid Day: ${position.lastPaidDay}`);
        console.log(`Accrued Rewards: ${position.accruedRewards}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
