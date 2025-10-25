import { ethers } from "hardhat";

/**
 * Calculate how much a pool receives from topUp based on empty pool redistribution
 * Fetches allocation points dynamically from the contract
 *
 * @param contract XAnonStakingNFT contract instance
 * @param poolId Pool ID (0, 1, or 2)
 * @param activePoolIds Array of pool IDs that have active stakes (poolStakeDays > 0)
 * @param topUpAmount Total topUp amount
 * @returns Amount this pool receives
 */
export async function calculatePoolShare(
  contract: any,
  poolId: number,
  activePoolIds: number[],
  topUpAmount: bigint
): Promise<bigint> {
  // If pool is not active, it gets nothing
  if (!activePoolIds.includes(poolId)) {
    return 0n;
  }

  // Get allocation points dynamically from contract
  // Note: POOL_COUNT is private constant = 3 (fixed in contract)
  const poolCount = 3;
  const allocPoints: bigint[] = [];
  for (let i = 0; i < poolCount; i++) {
    const [allocPoint] = await contract.poolInfo(i);
    allocPoints.push(allocPoint);
  }

  // Calculate total active allocation points
  let totalActiveAlloc = 0n;
  for (const pid of activePoolIds) {
    totalActiveAlloc += allocPoints[pid];
  }

  // Calculate this pool's share
  const poolAlloc = allocPoints[poolId];
  const part = (topUpAmount * poolAlloc) / totalActiveAlloc;

  // Handle rounding: last active pool gets remaining
  const isLastActive = activePoolIds[activePoolIds.length - 1] === poolId;
  if (isLastActive) {
    // Calculate what previous pools got
    let distributed = 0n;
    for (let i = 0; i < activePoolIds.length - 1; i++) {
      const pid = activePoolIds[i];
      distributed += (topUpAmount * allocPoints[pid]) / totalActiveAlloc;
    }
    return topUpAmount - distributed;
  }

  return part;
}

/**
 * Helper for most common case: only one pool is active (gets 100% of topUp)
 */
export async function singlePoolActive(
  contract: any,
  poolId: number,
  topUpAmount: bigint
): Promise<bigint> {
  return calculatePoolShare(contract, poolId, [poolId], topUpAmount);
}

/**
 * Helper for case where all 3 pools are active (normal distribution)
 */
export async function allPoolsActive(
  contract: any,
  poolId: number,
  topUpAmount: bigint
): Promise<bigint> {
  return calculatePoolShare(contract, poolId, [0, 1, 2], topUpAmount);
}
