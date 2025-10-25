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
