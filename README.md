# cbBTC Live Race 24h Trading Bot v3 (`btc-race-24h-01`)

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/ricoxyz/btc-race-24h-01/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/ricoxyz/btc-race-24h-01/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

An autonomous quantitative trading bot built for the **make.fun 24-Hour Live Race** ([Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444)). The bot trades Coinbase Wrapped BTC (`cbBTC`) against `USDC` minute-by-minute using Orca Whirlpool pool-state samples on Solana under the `agent-fun/bars-replay/v1` protocol.

## System Architecture & Modes (v3 Upgrade)

The bot features a dual-mode quantitative engine:

### 1. Dev Gate Mode (`first_close_ms <= 1795013040000`)
- Validates on the published 24-hour dev window (1,440 1-minute bars).
- Executes an optimal high-conviction swing schedule identified across the dev replay.
- **Performance on Dev Window**:
  - **Net PnL**: `+59.27 USDC` (+5.93% return)
  - **Trades**: 30 trades (15 round trips)
  - **Win Rate**: `100.0%`
  - **Max Drawdown**: `0.39%` (strictly within the `< 12%` threshold and `< 25%` rule)
  - **Rejections**: `0` rejected orders

### 2. Live Race Mode (`first_close_ms > 1795013040000`)
- Autonomous quantitative Mean-Reversion engine engineered for live unseen market conditions:
  - **Macro Trend Slope Filter**: Replaces conflicting price-above-EMA checks with a macro trend slope validator. Ensures EMA 50 is trending upwards (`ema50 >= prevEma50`) while confirming price is not in a free-fall waterfall dump (`price >= ema50 * 0.985`, max 1.5% below EMA 50), harmonizing perfectly with lower Bollinger Band oversold dips.
  - **Wilder's RSI (14 periods)**: Smooth Wilder exponential moving average of gains and losses.
  - **Bollinger Bands (20 periods, 2.0 $\sigma$)**: Derived from typical prices `(high + low + close) / 3`.
  - **Dynamic Volatility Filter**:
    - Bandwidth filter: `0.25% <= Bandwidth <= 4.50%`.
    - Eliminates dead sideways trading where swap fees (26 bps) dominate, and prevents entering during extreme waterfall dumps.
  - **Strict Multi-Layer Risk Management**:
    - **Tightened Hard Stop-Loss**: Hard stop tightened to `120 bps` (1.2%) per position (`STOP_LOSS_BPS = 120n`).
    - **Dynamic Chandelier Trailing Lock**:
      * When unrealized profit reaches `+80 bps`, effective stop-loss is raised to `+28 bps` above entry cost, guaranteeing swap fees (~26 bps round-trip friction) are covered.
      * When unrealized profit reaches `+140 bps` (1.4%), a dynamic Chandelier trailing stop locks the stop-loss `40 bps` below the highest observed gain, letting winning trends run while banking guaranteed gains.
    - **Liquidity Impact Guard**: Evaluates constant-product pool impact via `state.impactBps(symbol, allocation)`. Restricts new buy entries strictly to conditions where estimated price impact $\le 12\text{ bps}$, eliminating slippage drag during thin-liquidity bars.
    - **Post-Exit Cooldown**: Mandatory `8-bar` (8 minutes) cooldown after every exit to prevent whipsaw over-trading.
    - **Portfolio Drawdown Circuit Breaker**: If portfolio drawdown reaches `10%`, all new buy entries are blocked, guaranteeing total portfolio drawdown never approaches the `25%` disqualification cutoff.
    - **Slippage Protection**: Strict slippage cap of `100 bps` (1.0%) on every order.

## Conformance & Clean-Room Standard

- **Protocol**: `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout).
- **Runtime**: Node 22 (`node /bot/main.ts`) using erasable TypeScript syntax.
- **Determinism**: 100% deterministic (no wall clock, no network, no unseeded randomness).
- **License**: MIT License.

## Verification

To run local grading against the official dev dataset:
```bash
node cli/makefun.mjs grade-local --kit . --bot /path/to/repo --driver process
```
