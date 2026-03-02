# xAnonStakingNFT

Stake-days weighted NFT staking system with time-locked pools and proportional reward distribution.

## Deployed Contracts

| Chain     | Address | Explorer |
|----------|---------|----------|
| **Sonic**   | `0x780aE218A02A20b69aC3Da7Bf80c08A70A330a5e` | [Sonicscan](https://sonicscan.org/address/0x780aE218A02A20b69aC3Da7Bf80c08A70A330a5e) |
| **Ethereum** | `0xAc25dcA233DdBeE5D343d1358524D81e38000909` | [Etherscan](https://etherscan.io/address/0xAc25dcA233DdBeE5D343d1358524D81e38000909) |

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
> **Tests:** 116 passing  
> **Duration:** 10s  
> **Updated:** 2025-10-31

<details>
<summary>📋 Test Breakdown</summary>


**✅ ✅ CORRECT (empty pool redistribution working as expected)** (3/3 passed)

- ✓ Pool 0=46738, Pool 1=69902, Pool 2=136691 → topUp 2952 after 2 days
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
- ✓ getPoolAPR: averages all snapshots

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
|  xAnonStakingNFT  ·  approve            ·      29234  ·      48657  ·      46578  ·          381  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  burn               ·      87923  ·    1001635  ·     289191  ·           28  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  earnReward         ·      71236  ·     322695  ·      81799  ·          273  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  emergencyWithdraw  ·          -  ·          -  ·      75757  ·            3  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  mint               ·     217791  ·    1164893  ·     267731  ·          430  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  pause              ·          -  ·          -  ·      27759  ·            2  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  rescueTokens       ·          -  ·          -  ·      36481  ·            1  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  safeTransferFrom   ·          -  ·          -  ·      84012  ·            1  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  topUp              ·     126955  ·     664646  ·     170191  ·          165  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  xAnonStakingNFT  ·  unpause            ·          -  ·          -  ·      27752  ·            1  ·          -  │
····················|·····················|·············|·············|·············|···············|··············
|  Deployments                            ·                                         ·  % of limit   ·             │
··········································|·············|·············|·············|···············|··············
|  xAnonStakingNFT                        ·    3696145  ·    3696169  ·    3696167  ·       12.3 %  ·          -  │
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

### On-Chain APR (View Function)

```solidity
// Get average APR for pool 2 (Long pool, 365 days)
// Averages ALL historical topUps
uint256 aprBasisPoints = xAnonStaking.getPoolAPR(2);

// Convert to percentage
uint256 aprPercent = aprBasisPoints / 100;  // e.g., 23053 bp = 230.53%
```

### TypeScript Helper

```typescript
import { calculatePoolAPR } from './scripts/calculatePoolAPR';

// Calculate APR for a pool
const apr = await calculatePoolAPR(contract, 2);
console.log(`Pool 2 APR: ${apr.toFixed(2)}%`);

// Compare all pools
const aprs = await Promise.all([0, 1, 2].map((pid) => calculatePoolAPR(contract, pid)));
console.log(`Pool 0 (91d):  ${aprs[0].toFixed(2)}%`);
console.log(`Pool 1 (182d): ${aprs[1].toFixed(2)}%`);
console.log(`Pool 2 (365d): ${aprs[2].toFixed(2)}%`);
```

**Note:** APR is calculated by averaging perDayRate from ALL historical topUps.

### APR Calculation Formula

```
APR = (avgPerDayRate × 365 × 10000) / PRECISION / 100

Where:
- avgPerDayRate = average of all snapshot perDayRates
- 10000 = basis points (100%)
- Result in percentage (e.g., 230.53%)
```

### Important Notes

⚠️ **APR is a PROJECTION** - averages ALL historical topUps.

Actual returns depend on:

- Future topUp frequency and amounts
- Total active stake (dilution effect)
- **Empty pool redistribution**: If other pools are empty, your pool gets larger share

Example: If pool 2 received 100% of a topUp (due to pools 0 and 1 being empty).

## License

MIT
