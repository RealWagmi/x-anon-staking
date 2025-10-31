# xAnonStakingNFT

Stake-days weighted NFT staking system with time-locked pools and proportional reward distribution.

## Key Features

- **Three Fixed Pools**: 91/182/365 days lock periods with 20%/30%/50% base allocations
- **Empty Pool Redistribution**: Rewards from empty pools automatically redistributed to active pools
  - Example: If only pool 2 is active, it receives 100% of rewards (not 50%)
- **Time-Weighted Rewards**: Fair distribution based on stake-days (amount × days staked)
- **Per-Pool TopUp Control**: Independent 2-day minimum gap per pool (not global)
- **Principal Protection**: Contract balance always ≥ total staked (prevents reward calculation bugs from affecting deposits)
- **Ring Buffer Expiration**: O(1) gas-efficient position expiration tracking

## Quick Start

```bash
npm install
npm run compile
npm test
npm run coverage
```

<!-- TEST_RESULTS_START -->

### 🧪 Latest Test Results

> **Status:** ✅ All Tests Passing  
> **Tests:** 115 passing  
> **Duration:** 10s  
> **Updated:** 2025-10-29

<details>
<summary>📋 Test Breakdown</summary>


**✅ ✅ CORRECT (empty pool redistribution working as expected)** (2/2 passed)

- ✓ Debug: Step by step
- ✓ Analyze poolStakeDays accumulation

**✅ ✅ Correct distribution** (1/1 passed)

- ✓ Test: 1 user, 2 topUps with gap

**✅ ATTACK: Double Reward Claiming** (4/4 passed)

- ✓ should prevent claiming same rewards twice in same block
- ✓ should prevent claiming rewards after burn
- ✓ should prevent multiple claims before topUp creates interval
- ✓ should prevent claiming more than actual rewards accumulated

**✅ ATTACK: Front-Running TopUp** (2/2 passed)

- ✓ should give ZERO rewards to front-runner (no stake-days accumulated)
- ✓ should protect against just-in-time staking before topUp

**✅ ATTACK: Multiple Small Stakes vs Single Large** (2/2 passed)

- ✓ should give SAME rewards for 100x1 vs 1x100 stakes (no fragmentation advantage)
- ✓ should handle gas griefing: many positions should not break contract

**✅ ATTACK: Reward Timing Manipulation** (3/3 passed)

- ✓ should prevent earning rewards from future topUps after expiration
- ✓ should handle claim-topUp-claim pattern correctly
- ✓ should prevent claiming same interval multiple times

**✅ ATTACK: Principal Protection Bypass** (2/2 passed)

- ✓ should prevent withdrawing more than deposited
- ✓ should prevent stealing through reward calculation overflow

**✅ ATTACK: Ring Buffer Manipulation** (2/2 passed)

- ✓ should correctly handle stakes at bucket boundaries
- ✓ should prevent manipulation through rapid stake/unstake at bucket edge

**✅ ATTACK: Snapshot Boundary Exploits** (2/2 passed)

- ✓ should prevent claiming from unearned snapshots
- ✓ should handle claims spanning multiple snapshots correctly

**✅ ATTACK: Reentrancy and Race Conditions** (2/2 passed)

- ✓ should be protected by nonReentrant on earnReward
- ✓ should handle concurrent claims from different users safely

**✅ EDGE CASE: Zero and Boundary Values** (3/3 passed)

- ✓ should not allow topUp when no active stakes exist
- ✓ CRITICAL: rewards are distributed fairly when users join at different times
- ✓ should handle minimum stake correctly

**✅ ATTACK: Burn and Re-stake Manipulation** (1/1 passed)

- ✓ should prevent earning old rewards after burn and re-stake

**✅ ATTACK: Multiple Earnreward Scenarios** (4/4 passed)

- ✓ should allow earnReward on topUp day if stake-days accumulated
- ✓ should correctly handle claim on topUp day with accumulated stake-days
- ✓ should prevent reward inflation through stake-unstake-restake cycle
- ✓ should handle multiple earnRewards with intermediate topUps

**✅ SECURITY: Total Rewards Invariant** (2/2 passed)

- ✓ CRITICAL: total distributed rewards should NEVER exceed topUp amounts
- ✓ CRITICAL: contract balance should always cover totalStaked

**✅ ATTACK: Precision Loss Exploits** (2/2 passed)

- ✓ should not lose rewards due to rounding with many small claims
- ✓ should handle very small perDayRate without underflow

**✅ ATTACK: Cross-Pool Manipulation** (2/2 passed)

- ✓ should prevent stealing rewards from other pools
- ✓ should prevent cross-contamination between pool intervals

**✅ MATHEMATICAL INVARIANTS: Strict Verification** (3/3 passed)

- ✓ INVARIANT: Sum of all claims must equal pool allocations (zero waste)
- ✓ INVARIANT: perDayRate calculation is mathematically sound
- ✓ INVARIANT: lastPaidDay tracking prevents double-claims

**✅ xAnonStakingNFT - stake-days weighting** (76/76 passed)

- ✓ later entrant gets less within the same interval (stake-days)
- ✓ same-day entrants share equally for that day
- ✓ reverts on topUp with amount below minimum or too frequent
- ✓ no topUp for a long period yields zero rewards
- ✓ splits 20/30/50 across pools with equal stake-days
- ✓ fair distribution: 3 users in 3 different pools (20%/30%/50% split)
- ✓ caps rewards at expiration (no accrual after lock)
- ✓ ring buffer expiry shrinks rollingActiveStake after lockDays
- ✓ topUp with no active stake reverts with NoActiveStake
- ✓ pausable: mint reverts when paused, but earnReward works
- ✓ burn: only owner or approved, and only after lock
- ✓ emergencyWithdraw: returns only principal, no rewards
- ✓ emergencyWithdraw: only owner or approved, and only after lock
- ✓ burn pays pending rewards before returning principal
- ✓ burn returns only principal when no rewards accrued
- ✓ earnReward: only owner or approved
- ✓ tokenURI returns descriptor URI
- ✓ positionOf returns stored staking position data
- ✓ rescueTokens transfers arbitrary token by owner
- ✓ ring buffer handles very large day gaps (>> lockDays) correctly
- ✓ pendingRewards reports the same value as a subsequent earnReward
- ✓ second earnReward in the same day reverts with No rewards
- ✓ earnReward then topUp then earnReward: no double rewards, only new interval
- ✓ approved address can earnReward and burn after lock
- ✓ transferred NFT allows new owner to claim and burn
- ✓ reverts on invalid tokenId for tokenURI, positionOf, earnReward
- ✓ reverts on topUp below minimum and mint(0)
- ✓ reverts on mint with amount exceeding uint96 max (storage packing safety)
- ✓ accumulates rewards correctly across 5+ intervals
- ✓ no accrual when position expires exactly on topUp day after cap
- ✓ fair reward distribution - Pool 0 (3 months, 91 days)
- ✓ fair reward distribution - Pool 1 (6 months, 182 days)
- ✓ fair reward distribution - Pool 2 (12 months, 365 days)
- ✓ very large gap (1000 days) with partial expirations handles correctly
- ✓ pending rewards with very short first interval (1 day) creates valid perDayRate
- ✓ rollingActiveStake == 0 when threshold triggers: no snapshot created, pending works
- ✓ extreme gap (2000+ days) uses simplified calculation without gas issues
- ✓ binary search in _firstSnapshotAfter handles edge cases correctly
- ✓ multiple topUps in consecutive days: no duplicate snapshots with same endDay
- ✓ large gap with multiple expirations (20+): day-by-day vs approximation accuracy
- ✓ CRITICAL: yesterday snapshot math - verify no overpayment from dimension mismatch
- ✓ totalStaked tracks principal correctly and protects it
- ✓ fast-path (gap > 1000) does not overpay: total rewards <= pool allocation
- ✓ getPoolSnapshots with non-zero offset
- ✓ principal protection: balance - totalStaked shows available rewards
- ✓ fast-path handles expirations at specific ring buffer positions
- ✓ pendingRewards for non-existent token returns 0
- ✓ positionOf for non-existent token returns zeroed struct
- ✓ _computeRewards with empty snapshots returns 0
- ✓ earnReward with zero payout reverts
- ✓ constructor reverts with zero address for token
- ✓ constructor reverts with zero address for descriptor
- ✓ pause() reverts when called by non-owner
- ✓ unpause() reverts when called by non-owner
- ✓ rescueTokens() reverts when called by non-owner
- ✓ getPoolSnapshots returns empty arrays when offset >= length
- ✓ _rollPool: gap > MAX_DAILY_ROLL triggers fast-path with cleared rollingActiveStake
- ✓ math edge case: very small stake with large rewards (precision test)
- ✓ math edge case: large stake with small rewards (precision test)
- ✓ _earnedDaysInterval: capDay < startDay returns 0 (position expired before interval)
- ✓ _rollPool: gap equals lockDays exactly (boundary test)
- ✓ _rollPool: gap < lockDays (partial expiration boundary)
- ✓ getPoolSnapshots: limit > remaining length returns only available snapshots
- ✓ multiple stakes in same day: ring buffer accumulates correctly
- ✓ _collectPositionRewards: position with lastPaidDay = capDay returns 0
- ✓ math: perDayRate calculation with PRECISION scaling
- ✓ security: multiple positions per user across different pools
- ✓ edge case: very old expired position (1000+ days) claiming rewards
- ✓ security: front-running topUp (stake 1 block before)
- ✓ precision: 1000 micro-stakes accumulation (rounding errors)
- ✓ gas griefing: multiple stakes in same day (ring buffer stress)
- ✓ concurrent expirations: batch expiration on same day
- ✓ security: reentrancy protection on earnReward + burn
- ✓ getPoolAPR: calculates correct APR based on historical data
- ✓ getPoolAPR: returns zero for pools with no activity
- ✓ getPoolAPR: confidence increases with more snapshots

</details>

<details>
<summary>⛽ Gas Report</summary>

```
·-----------------------------------------|---------------------------|-------------|-----------------------------·
|          Solc version: 0.8.23           ·  Optimizer enabled: true  ·  Runs: 999  ·  Block limit: 30000000 gas  │
··········································|···························|·············|······························
|  Methods                                                                                                        │
····················|·····················|·············|·············|·············|···············|··············
|  Contract         ·  Method             ·  Min        ·  Max        ·  Avg        ·  # calls      ·  usd (avg)  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  approve            ·      29234  ·      48657  ·      46577  ·          377  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  burn               ·      87888  ·    1001592  ·     289151  ·           28  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  earnReward         ·      71236  ·     322695  ·      81799  ·          273  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  emergencyWithdraw  ·          -  ·          -  ·      75775  ·            3  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  mint               ·     217791  ·    1164893  ·     267611  ·          427  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  pause              ·          -  ·          -  ·      27781  ·            2  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  rescueTokens       ·          -  ·          -  ·      36481  ·            1  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  safeTransferFrom   ·          -  ·          -  ·      83968  ·            1  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  topUp              ·     126977  ·     664668  ·     169567  ·          164  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  unpause            ·          -  ·          -  ·      27774  ·            1  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  Deployments                            ·                                         ·  % of limit   ·             │
··········································|·············|·············|·············|···············|··············
|  xAnonStakingNFT                        ·    3759101  ·    3759125  ·    3759123  ·       12.5 %  ·          -  │
·-----------------------------------------
```

</details>
<!-- TEST_RESULTS_END -->

## Fuzz Testing

Advanced property-based testing with Foundry:

```bash
# Install Foundry (if not installed)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Install forge-std dependency
forge install foundry-rs/forge-std --no-commit

# Run fuzz tests (1000+ random inputs per test)
forge test --match-path test/foundry/FuzzDistribution.t.sol -vv

# Run with more iterations for deeper testing
forge test --match-path test/foundry/FuzzDistribution.t.sol --fuzz-runs 10000 -vv

# Run specific fuzz test
forge test --match-test testFuzz_EqualStakesEqualRewards -vvv

# OR
npm run test:fuzz
npm run test:fuzz:deep
```

## Deployment

```bash
# Setup environment
cp .env_example .env
# Add ANON_TOKEN_ADDRESS and DESCRIPTOR_ADDRESS to .env

# Deploy to Sonic
npm run deploy sonic
```

## Usage

### Stake Tokens

```solidity
// Approve tokens first
anonToken.approve(xAnonStakingAddress, amount);

// Mint NFT position in pool 2 (365-day lock)
uint256 tokenId = xAnonStaking.mint(amount, 2);
```

### Claim Rewards

```solidity
// Check pending rewards (view function)
uint256 pending = xAnonStaking.pendingRewards(tokenId);

// Claim rewards to your address
xAnonStaking.earnReward(yourAddress, tokenId);
```

### Withdraw Principal

```solidity
// After lock period expires
xAnonStaking.burn(yourAddress, tokenId);
```

### Add Rewards (Protocol/Owner)

```solidity
// TopUp rewards - distributed ONLY to active pools (with stake-days > 0)
// Empty pools are skipped, their allocations redistributed to active pools
xAnonStaking.topUp(rewardAmount);
```

**Empty Pool Redistribution Example:**

```
Scenario: topUp(10,000 ANON)

Case 1: All pools active
- Pool 0 (20%): 2,000 ANON
- Pool 1 (30%): 3,000 ANON
- Pool 2 (50%): 5,000 ANON

Case 2: Only pool 2 active (pools 0 and 1 empty)
- Pool 0: 0 ANON (empty, skipped)
- Pool 1: 0 ANON (empty, skipped)
- Pool 2: 10,000 ANON (100% redistribution!)
```

**Key Points:**

- Minimum 2-day gap between topUps per pool (independent per pool)
- At least one pool must have active stakes (reverts otherwise)
- Rewards distributed proportionally by allocPoints among active pools only

## 📊 APR Calculation

The contract implements **professional APR calculation** for stake-days weighted model.

### On-Chain APR (View Function)

```solidity
// Get projected APR for pool 2 (Long pool, 365 days)
(uint256 aprBasisPoints, uint256 confidence) = xAnonStaking.getPoolAPR(
    2,      // poolId
    10      // lookbackPeriod (avg last 10 snapshots)
);

// Convert to percentage
uint256 aprPercent = aprBasisPoints / 100;  // e.g., 2500 bp = 25.00%
uint256 confidencePercent = confidence / 100; // e.g., 8500 = 85%
```

### TypeScript Helper (Advanced Analysis)

```typescript
import {
  getPoolAPRMetrics,
  compareAllPools,
  formatAPRMetrics,
} from "./scripts/calculateAPR";

// Analyze specific pool
const metrics = await getPoolAPRMetrics(contract, 2);
console.log(formatAPRMetrics(metrics));

/* Output:
═══════════════════════════════════════════════════════
  Pool: Long (365d)
  Lock Period: 365 days
═══════════════════════════════════════════════════════

📊 APR Metrics:
  • Instantaneous APR:    28.50%
  • 7-Day Historical APR:  26.30%
  • 30-Day Historical APR: 25.10%
  • Projected APR:         25.80%

💰 Pool State:
  • Total Value Locked: 1,250,000.00 tokens
  • Reward Rate:        0.000708 per token-day

📈 Data Quality:
  • Quality:     Excellent
  • Confidence:  95%
  • Snapshots:   45
═══════════════════════════════════════════════════════
*/

// Compare all pools
const { pools, recommendation } = await compareAllPools(contract);
console.log(recommendation);

/* Output:
🎯 Long pool offers 8.50% premium APR for extended lock period.

🏆 Best APR: Long (365d) with 25.80% projected APR
*/
```

### CLI Usage

```bash
# Set contract address
export CONTRACT_ADDRESS=0x...

# Run APR analysis
npx hardhat run scripts/calculateAPR.ts --network mainnet
```

### APR Calculation Formula

For stake-days weighted model:

```
1. avgPerDayRate = average of last N snapshots
2. rewardPerToken = lockDays * avgPerDayRate / PRECISION
3. APR = (rewardPerToken / 1 token) * (365 / lockDays) * 100%
```

**Example:**

- Pool: Long (365 days)
- avgPerDayRate: 0.000708 (from last 10 topUps)
- rewardPerToken = 365 \* 0.000708 = 0.2584 tokens
- APR = (0.2584 / 1) _ (365 / 365) _ 100% = **25.84%**

### Important Notes

⚠️ **APR is a PROJECTION** based on historical data. Actual returns depend on:

- Future topUp frequency and amounts
- Total active stake (dilution effect)
- Entry timing within reward intervals
- Early stakers earn more stake-days
- **Empty pool redistribution**: If other pools are empty, your pool gets larger share

💡 **Empty Pool Redistribution Impact on APR:**

The `getPoolAPR()` function automatically accounts for empty pool redistribution because it reads actual `perDayRate` from snapshots. These snapshots already reflect the redistributed amounts.

Example: If pool 2 received 100% of a topUp (due to pools 0 and 1 being empty), the snapshot's `perDayRate` will be calculated from that full amount, resulting in higher projected APR.

✅ **Confidence Score** indicates data quality:

- 90-100%: Excellent (30+ snapshots)
- 70-90%: Good (10-30 snapshots)
- 50-70%: Fair (5-10 snapshots)
- <50%: Poor (limited data)

### Integration Examples

#### Frontend Dashboard

```typescript
// Fetch APR for all pools
const poolsData = await Promise.all(
  [0, 1, 2].map((pid) => getPoolAPRMetrics(contract, pid))
);

// Display in UI
poolsData.forEach((pool) => {
  console.log(`${pool.poolName}: ${pool.projectedAPR.toFixed(2)}% APR`);
  console.log(`TVL: $${formatUSD(pool.totalValueLocked)}`);
  console.log(`Lock: ${pool.lockDays} days\n`);
});
```

#### Smart Contract Integration

```solidity
// Another contract can query APR
contract YourProtocol {
    IxAnonStakingNFT public staking;

    function getBestPool() external view returns (uint256 poolId, uint256 apr) {
        uint256 bestAPR = 0;
        uint256 bestPool = 0;

        for (uint256 i = 0; i < 3; i++) {
            (uint256 currentAPR,) = staking.getPoolAPR(i, 10);
            if (currentAPR > bestAPR) {
                bestAPR = currentAPR;
                bestPool = i;
            }
        }

        return (bestPool, bestAPR);
    }
}
```

## License

MIT

## Audit Status

⚠️ **Not audited yet** - Do not use in production without professional security audit.
