# xAnonStakingNFT

Stake-days weighted NFT staking system with time-locked pools and proportional reward distribution.

## Quick Start

```bash
npm install
npm run compile
npm test
npm run coverage
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
// TopUp rewards to be distributed across all pools
xAnonStaking.topUp(rewardAmount);
```

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
