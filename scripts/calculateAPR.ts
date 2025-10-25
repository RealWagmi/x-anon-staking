/* eslint-disable @typescript-eslint/no-floating-promises, unicorn/prefer-top-level-await */
import { ethers } from "hardhat";
import { XAnonStakingNFT } from "../typechain-types";

/**
 * Professional APR Calculator for xAnonStakingNFT
 *
 * Calculates multiple APR metrics for stake-days weighted pools:
 * 1. Instantaneous APR (based on latest snapshot)
 * 2. Historical APR (weighted average over period)
 * 3. Projected APR (for new staker entering now)
 * 4. Pool comparison metrics
 *
 * IMPORTANT: APR automatically accounts for Empty Pool Redistribution!
 * The perDayRate from snapshots already reflects redistributed amounts.
 * Example: If pool 2 was the only active pool, its snapshot perDayRate
 * will be calculated from 100% of topUp (not 50%), resulting in higher APR.
 */

// Type for contract with getPoolAPR method
type IXAnonStakingNFTWithAPR = XAnonStakingNFT;

interface APRMetrics {
  poolId: number;
  poolName: string;
  lockDays: number;

  // APR values (in %, e.g. 25.5 = 25.5%)
  instantaneousAPR: number;
  historicalAPR_7d: number;
  historicalAPR_30d: number;
  projectedAPR: number;

  // Pool state
  totalValueLocked: bigint;
  activeStakers: number;
  rewardRate: bigint; // Current perDayRate

  // Confidence metrics
  dataQuality: string; // "Excellent" | "Good" | "Fair" | "Poor"
  confidence: number; // 0-100%
  snapshotCount: number;
}

/**
 * Get comprehensive APR metrics for a pool
 */
export async function getPoolAPRMetrics(
  contract: IXAnonStakingNFTWithAPR,
  poolId: number
): Promise<APRMetrics> {
  // Fetch pool info
  const [, lockDays, rollingActiveStake, , snapshotsCount] =
    await contract.poolInfo(poolId);

  // Get on-chain APR calculation
  const [aprBasisPoints, confidenceBasisPoints] = await contract.getPoolAPR(
    poolId,
    10
  );

  // Convert basis points to percentage
  const projectedAPR = Number(aprBasisPoints) / 100; // 10000 bp = 100%
  const confidence = Number(confidenceBasisPoints) / 100;

  // Calculate instantaneous APR (last snapshot only)
  const [instantAPR] = await contract.getPoolAPR(poolId, 0);
  const instantaneousAPR = Number(instantAPR) / 100;

  // Get historical snapshots for deeper analysis
  const recentSnapshots = await getRecentSnapshots(contract, poolId, 30);

  // Calculate historical APRs
  const historicalAPR_7d = calculateHistoricalAPR(
    recentSnapshots.slice(-7),
    Number(lockDays)
  );
  const historicalAPR_30d = calculateHistoricalAPR(
    recentSnapshots,
    Number(lockDays)
  );

  // Get latest reward rate
  const latestSnapshot = recentSnapshots.at(-1);
  const rewardRate = latestSnapshot?.rate || 0n;

  // Determine data quality
  const dataQuality = getDataQuality(snapshotsCount, confidence);

  // Get pool name
  const poolNames = ["Short (91d)", "Medium (182d)", "Long (365d)"];

  return {
    poolId,
    poolName: poolNames[poolId] || `Pool ${poolId}`,
    lockDays: Number(lockDays),
    instantaneousAPR,
    historicalAPR_7d,
    historicalAPR_30d,
    projectedAPR,
    totalValueLocked: rollingActiveStake,
    activeStakers: 0, // Would need to track separately or via events
    rewardRate,
    dataQuality,
    confidence,
    snapshotCount: Number(snapshotsCount),
  };
}

/**
 * Get recent snapshots from contract
 */
async function getRecentSnapshots(
  contract: IXAnonStakingNFTWithAPR,
  poolId: number,
  count: number
): Promise<Array<{ day: bigint; rate: bigint }>> {
  const [, , , , snapshotsCount] = await contract.poolInfo(poolId);
  const total = Number(snapshotsCount);

  if (total === 0) return [];

  const offset = Math.max(0, total - count);
  const limit = Math.min(count, total - offset);

  const [days, rates] = await contract.getPoolSnapshots(poolId, offset, limit);

  return days.map((day, i) => ({
    day,
    rate: rates[i],
  }));
}

/**
 * Calculate historical APR from snapshots
 *
 * NOTE: This function automatically accounts for empty pool redistribution
 * because it reads perDayRate from actual snapshots. Each snapshot's perDayRate
 * was calculated from the actual reward amount allocated to that pool
 * (after empty pool redistribution was applied).
 */
function calculateHistoricalAPR(
  snapshots: Array<{ day: bigint; rate: bigint }>,
  lockDays: number
): number {
  if (snapshots.length === 0) return 0;

  // Skip first snapshot if it's init (rate = 0)
  const validSnapshots = snapshots.filter((s) => s.rate > 0n);
  if (validSnapshots.length === 0) return 0;

  // Calculate average perDayRate
  const sumRates = validSnapshots.reduce((sum, s) => sum + s.rate, 0n);
  const avgRate = sumRates / BigInt(validSnapshots.length);

  // Convert to number for calculation (PRECISION = 1e18)
  const avgRateNum = Number(avgRate) / 1e18;

  // APR = (lockDays * avgRate) * (365 / lockDays) * 100
  // APR = avgRate * 365 * 100
  return avgRateNum * 365 * 100;
}

/**
 * Determine data quality based on snapshots and confidence
 */
function getDataQuality(snapshotCount: bigint, confidence: number): string {
  const count = Number(snapshotCount);

  if (count >= 30 && confidence >= 90) return "Excellent";
  if (count >= 10 && confidence >= 70) return "Good";
  if (count >= 5 && confidence >= 50) return "Fair";
  return "Poor";
}

/**
 * Compare all pools and recommend best option
 */
export async function compareAllPools(
  contract: IXAnonStakingNFTWithAPR
): Promise<{
  pools: APRMetrics[];
  recommendation: string;
}> {
  const pools: APRMetrics[] = [];

  // Analyze all 3 pools
  for (let pid = 0; pid < 3; pid++) {
    try {
      const metrics = await getPoolAPRMetrics(contract, pid);
      pools.push(metrics);
    } catch (error) {
      console.error(`Error analyzing pool ${pid}:`, error);
    }
  }

  // Sort by projected APR
  pools.sort((a, b) => b.projectedAPR - a.projectedAPR);

  // Generate recommendation
  const recommendation = generateRecommendation(pools);

  return { pools, recommendation };
}

/**
 * Generate smart recommendation based on metrics
 */
function generateRecommendation(pools: APRMetrics[]): string {
  if (pools.length === 0) return "No data available";

  const best = pools[0];
  const recommendations: string[] = [];

  // Check data quality
  if (best.dataQuality === "Poor" || best.dataQuality === "Fair") {
    recommendations.push(
      `⚠️ Data quality is ${best.dataQuality}. APR estimates may be unreliable.`
    );
  }

  // Compare risk vs reward
  const shortPool = pools.find((p) => p.poolId === 0);
  const longPool = pools.find((p) => p.poolId === 2);

  if (shortPool && longPool) {
    const riskPremium = longPool.projectedAPR - shortPool.projectedAPR;

    if (riskPremium < 5) {
      recommendations.push(
        `💡 Short pool (${shortPool.projectedAPR.toFixed(
          2
        )}% APR) offers similar returns ` +
          `with ${shortPool.lockDays} days lock vs ${longPool.lockDays} days.`
      );
    } else {
      recommendations.push(
        `🎯 Long pool offers ${riskPremium.toFixed(
          2
        )}% premium APR for extended lock period.`
      );
    }
  }

  // Best pool recommendation
  recommendations.push(
    `\n🏆 Best APR: ${best.poolName} with ${best.projectedAPR.toFixed(
      2
    )}% projected APR`
  );

  if (best.confidence < 70) {
    recommendations.push(
      `\n⚠️ Confidence: ${best.confidence.toFixed(
        0
      )}% - Based on limited historical data`
    );
  }

  return recommendations.join("\n");
}

/**
 * Format APR metrics for display
 */
export function formatAPRMetrics(metrics: APRMetrics): string {
  const tvl = ethers.formatEther(metrics.totalValueLocked);
  const rate = ethers.formatUnits(metrics.rewardRate, 18);

  return `
═══════════════════════════════════════════════════════
  Pool: ${metrics.poolName}
  Lock Period: ${metrics.lockDays} days
═══════════════════════════════════════════════════════

📊 APR Metrics:
  • Instantaneous APR:    ${metrics.instantaneousAPR.toFixed(2)}%
  • 7-Day Historical APR:  ${metrics.historicalAPR_7d.toFixed(2)}%
  • 30-Day Historical APR: ${metrics.historicalAPR_30d.toFixed(2)}%
  • Projected APR:         ${metrics.projectedAPR.toFixed(2)}%

💰 Pool State:
  • Total Value Locked: ${Number.parseFloat(tvl).toFixed(2)} tokens
  • Reward Rate:        ${Number.parseFloat(rate).toFixed(6)} per token-day

📈 Data Quality:
  • Quality:     ${metrics.dataQuality}
  • Confidence:  ${metrics.confidence.toFixed(0)}%
  • Snapshots:   ${metrics.snapshotCount}

═══════════════════════════════════════════════════════
`;
}

/**
 * Main function for CLI usage
 */
async function main() {
  console.log("🔍 Analyzing xAnonStakingNFT APR Metrics...\n");

  // Get contract
  const contractAddress = process.env.CONTRACT_ADDRESS || "";
  if (!contractAddress) {
    throw new Error("Please set CONTRACT_ADDRESS environment variable");
  }

  const contract = (await ethers.getContractAt(
    "xAnonStakingNFT",
    contractAddress
  )) as unknown as IXAnonStakingNFTWithAPR;

  // Analyze all pools
  const { pools, recommendation } = await compareAllPools(contract);

  // Display results
  for (const pool of pools) {
    console.log(formatAPRMetrics(pool));
  }

  console.log("\n📌 Recommendation:\n");
  console.log(recommendation);
}

// Run if called directly
if (require.main === module) {
  (async () => {
    try {
      await main();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  })();
}

export default {
  getPoolAPRMetrics,
  compareAllPools,
  formatAPRMetrics,
};
