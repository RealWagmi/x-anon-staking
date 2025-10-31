import { ethers } from 'ethers';
import type { XAnonStakingNFT } from '../typechain-types';

/**
 * Calculate average APR for a pool based on ALL historical topUps
 *
 * @param contract XAnonStakingNFT contract instance
 * @param poolId Pool ID (0, 1, or 2)
 * @returns APR as percentage (e.g., 230.5 = 230.5%)
 *
 * This shows what APR you would get on average if you keep restaking
 * Formula: APR = (avgPerDayRate × 365 × 10000) / PRECISION / 100
 */
export async function calculatePoolAPR(contract: XAnonStakingNFT, poolId: number): Promise<number> {
  const [, , , , snapshotsCount] = await contract.poolInfo(poolId);
  if (snapshotsCount < 2n) return 0;

  const [, rates] = await contract.getPoolSnapshots(poolId, 0, Number(snapshotsCount));
  const dataRates = rates.slice(1); // Skip init snapshot (perDayRate=0)
  if (dataRates.length === 0) return 0;

  // Average ALL snapshots
  const avgPerDayRate = dataRates.reduce((sum: bigint, rate: bigint) => sum + rate, 0n) / BigInt(dataRates.length);
  if (avgPerDayRate === 0n) return 0;

  // APR = (avgPerDayRate × 365 × 10000) / PRECISION
  const PRECISION = ethers.parseEther('1');
  const aprBasisPoints = (avgPerDayRate * 365n * 10000n) / PRECISION;

  return Number(aprBasisPoints) / 100;
}
