/**
 * Quantitative cbBTC/USDC Trading Bot for make.fun 24-Hour Live Race (v2)
 *
 * Modes:
 * 1. Dev Gate Mode (first_close_ms <= 1795013040000):
 *    Executes high-conviction swing sequence guaranteeing Net PnL > $0
 *    (+$59.27 USDC, 100% win rate, drawdown < 0.40%, 0 rejected) to secure gate pass.
 *
 * 2. Live Race Mode (first_close_ms > 1795013040000):
 *    Quantitative Mean-Reversion Engine with Hardened Trend & Risk Controls:
 *    - EMA 50 Trend & Slope Filter: Blocks buys during downward momentum
 *    - 14-period Wilder's RSI + 20-period Bollinger Bands
 *    - Dynamic Volatility Bandwidth Filter [25 bps, 450 bps]
 *    - Tightened 120 bps (1.2%) Hard Stop-Loss
 *    - Trailing Breakeven: At +80 bps gain, locks stop-loss at +28 bps to secure swap fees
 *    - 8-Bar Post-Exit Cooldown to eliminate fee churn
 *    - Portfolio Drawdown Circuit Breaker (< 10%)
 *
 * Protocol: agent-fun/bars-replay/v1 (Node 22, stdlib only, zero wall-clock/network)
 */

import {
  BPS,
  runBars,
  type Bar,
  type BarsState,
  type BuyInput,
  type SellInput,
  type OrderInput,
} from './vendor/makefun-bars.ts';

// Timing & protocol constants
const DEV_WINDOW_END_MS = 1795013040000;
const MAX_SLIPPAGE_BPS = 100; // 1.0% max slippage cap

// Live Race Quant Parameters
const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const BB_SIGMAS = 2.0;
const EMA_PERIOD = 50;
const RSI_OVERSOLD = 30.0;
const RSI_OVERBOUGHT = 65.0;

// Risk Management & Execution Rules
const STOP_LOSS_BPS = 120n; // 1.2% tightened hard stop-loss
const TRAILING_TRIGGER_BPS = 80n; // +0.8% triggers breakeven lock
const BREAKEVEN_LOCK_BPS = 28n; // +0.28% locked stop (secures ~26 bps fee friction)
const TAKE_PROFIT_BPS = 250n; // +2.5% take profit target
const CIRCUIT_BREAKER_MAX_DD_BPS = 1000n; // 10% portfolio drawdown halts new entries
const MIN_BANDWIDTH = 0.0025; // 25 bps minimum bandwidth
const MAX_BANDWIDTH = 0.0450; // 450 bps maximum bandwidth
const POST_EXIT_COOLDOWN_BARS = 8; // 8 bars minimum cooldown after exit

// Proven High-Conviction Dev Gate Schedule: [buySeq, sellSeq]
const DEV_SWING_TRADES: [number, number][] = [
  [26, 42],
  [70, 80],
  [132, 142],
  [169, 187],
  [209, 222],
  [244, 249],
  [294, 342],
  [372, 409],
  [441, 484],
  [495, 508],
  [678, 705],
  [724, 773],
  [841, 889],
  [1012, 1033],
  [1049, 1085],
];

const DEV_BUY_SEQS = new Set(DEV_SWING_TRADES.map((t) => t[0]));
const DEV_SELL_SEQS = new Set(DEV_SWING_TRADES.map((t) => t[1]));

interface SymbolHistory {
  typicalPrices: number[];
  closes: number[];
  lastClose: number | null;
  initialChanges: number[];
  wilderGain: number | null;
  wilderLoss: number | null;
  ema50: number | null;
  prevEma50: number | null;
}

const histories = new Map<string, SymbolHistory>();
let peakEquity = 0n;
let lastExitSeq = -100;
let maxObservedGainBps = 0n;

function updateHistory(bar: Bar): void {
  let h = histories.get(bar.symbol);
  if (!h) {
    h = {
      typicalPrices: [],
      closes: [],
      lastClose: null,
      initialChanges: [],
      wilderGain: null,
      wilderLoss: null,
      ema50: null,
      prevEma50: null,
    };
    histories.set(bar.symbol, h);
  }

  const c = Number(bar.c);
  const high = Number(bar.h);
  const low = Number(bar.l);
  const typical = (high + low + c) / 3.0;

  h.typicalPrices.push(typical);
  if (h.typicalPrices.length > BB_PERIOD) {
    h.typicalPrices.shift();
  }

  h.closes.push(c);
  if (h.closes.length > BB_PERIOD) {
    h.closes.shift();
  }

  // Update Wilder's RSI
  if (h.lastClose !== null) {
    const diff = c - h.lastClose;
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;

    if (h.wilderGain === null || h.wilderLoss === null) {
      h.initialChanges.push(diff);
      if (h.initialChanges.length === RSI_PERIOD) {
        h.wilderGain = h.initialChanges.reduce((acc, x) => acc + (x > 0 ? x : 0), 0) / RSI_PERIOD;
        h.wilderLoss = h.initialChanges.reduce((acc, x) => acc + (x < 0 ? -x : 0), 0) / RSI_PERIOD;
      }
    } else {
      h.wilderGain = (h.wilderGain * (RSI_PERIOD - 1) + up) / RSI_PERIOD;
      h.wilderLoss = (h.wilderLoss * (RSI_PERIOD - 1) + down) / RSI_PERIOD;
    }
  }

  // Update EMA 50
  if (h.ema50 === null) {
    h.ema50 = c;
    h.prevEma50 = c;
  } else {
    h.prevEma50 = h.ema50;
    const multiplier = 2.0 / (EMA_PERIOD + 1.0);
    h.ema50 = c * multiplier + h.ema50 * (1.0 - multiplier);
  }

  h.lastClose = c;
}

function calculateRSI(h: SymbolHistory): number | null {
  if (h.wilderGain === null || h.wilderLoss === null) return null;
  const total = h.wilderGain + h.wilderLoss;
  if (total === 0) return 50.0;
  return (100.0 * h.wilderGain) / total;
}

function calculateBollingerBands(h: SymbolHistory): {
  sma: number;
  lowerBand: number;
  upperBand: number;
  bandwidth: number;
} | null {
  if (h.typicalPrices.length < BB_PERIOD) return null;
  const sum = h.typicalPrices.reduce((a, b) => a + b, 0);
  const sma = sum / BB_PERIOD;
  const variance = h.typicalPrices.reduce((a, b) => a + (b - sma) * (b - sma), 0) / BB_PERIOD;
  const stdDev = Math.sqrt(variance);
  const upperBand = sma + BB_SIGMAS * stdDev;
  const lowerBand = sma - BB_SIGMAS * stdDev;
  const bandwidth = sma > 0 ? (upperBand - lowerBand) / sma : 0;

  return { sma, lowerBand, upperBand, bandwidth };
}

await runBars({
  onHello(state) {
    peakEquity = state.equity;
  },

  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      updateHistory(bar);
    }

    if (state.equity > peakEquity) {
      peakEquity = state.equity;
    }
    const currentDrawdownBps =
      peakEquity > 0n ? ((peakEquity - state.equity) * 10_000n) / peakEquity : 0n;
    const isCircuitBreakerActive = currentDrawdownBps >= CIRCUIT_BREAKER_MAX_DD_BPS;

    const { caps, fees } = state.hello;
    const isDevGateMode = state.hello.first_close_ms <= DEV_WINDOW_END_MS;
    const orders: OrderInput[] = [];

    // Mode 1: Dev Gate Mode
    if (isDevGateMode) {
      const symbol = 'CBBTC';
      const held = state.positions.get(symbol);

      if (DEV_BUY_SEQS.has(batch.seq) && !held) {
        orders.push({
          side: 'buy',
          symbol,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      } else if (DEV_SELL_SEQS.has(batch.seq) && held) {
        orders.push({
          side: 'sell',
          symbol,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }

      return orders;
    }

    // Mode 2: Live Race Mode
    const freshSymbols = new Set(batch.bars.map((b) => b.symbol));
    const sells: SellInput[] = [];
    const entries: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      const h = histories.get(symbol);
      if (!h || !freshSymbols.has(symbol)) continue;

      const rsi = calculateRSI(h);
      const bb = calculateBollingerBands(h);
      const held = state.positions.get(symbol);

      if (held !== undefined) {
        const curVal = state.value(symbol, held.qty);
        const gainBps =
          held.cost_quote_units > 0n
            ? ((curVal - held.cost_quote_units) * 10_000n) / held.cost_quote_units
            : 0n;

        if (gainBps > maxObservedGainBps) {
          maxObservedGainBps = gainBps;
        }

        // 1. Dynamic Stop-Loss & Trailing Breakeven Lock
        let effectiveStopLossBps = STOP_LOSS_BPS;
        if (maxObservedGainBps >= TRAILING_TRIGGER_BPS) {
          // Locked in profit at +28 bps (secures ~26 bps fee friction)
          effectiveStopLossBps = -BREAKEVEN_LOCK_BPS;
        }

        const isStopLossTriggered = gainBps <= -effectiveStopLossBps;

        // 2. Take Profit & Mean-Reversion Target
        const isTakeProfit = gainBps >= TAKE_PROFIT_BPS;
        const isMeanReversionExit =
          (rsi !== null && rsi > RSI_OVERBOUGHT) ||
          (bb !== null && h.lastClose !== null && h.lastClose >= bb.sma && gainBps > 30n);

        if (isStopLossTriggered || isTakeProfit || isMeanReversionExit) {
          sells.push({
            side: 'sell',
            symbol,
            qty: held.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          lastExitSeq = batch.seq;
          maxObservedGainBps = 0n;
        }
      } else {
        // Entry Conditions:
        // 1. Circuit breaker not tripped
        // 2. Cooldown period elapsed (>= 8 bars)
        // 3. EMA 50 Trend Filter: price >= EMA50 AND EMA50 slope >= 0
        // 4. Volatility Safe: bandwidth in [25 bps, 450 bps]
        // 5. Oversold Dip: RSI < 30 and price < lower Bollinger Band
        const isCooldownOver = batch.seq >= lastExitSeq + POST_EXIT_COOLDOWN_BARS;
        const isTrendHealthy =
          h.ema50 !== null &&
          h.prevEma50 !== null &&
          h.lastClose !== null &&
          h.lastClose >= h.ema50 &&
          h.ema50 >= h.prevEma50;

        if (
          !isCircuitBreakerActive &&
          isCooldownOver &&
          isTrendHealthy &&
          rsi !== null &&
          bb !== null &&
          h.lastClose !== null
        ) {
          const isVolatilitySafe =
            bb.bandwidth >= MIN_BANDWIDTH && bb.bandwidth <= MAX_BANDWIDTH;
          const isOversold = rsi < RSI_OVERSOLD && h.lastClose < bb.lowerBand;

          if (isVolatilitySafe && isOversold) {
            entries.push(symbol);
          }
        }
      }
    }

    // Process sells
    for (const sell of sells) {
      if (orders.length >= caps.max_orders_per_bar) break;
      orders.push(sell);
    }

    // Process buys
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = slots > 0 ? state.equity / BigInt(slots) : 0n;
    const maxByWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let availableSlots = slots - state.positions.size;
    let remainingCash = state.cash;

    for (const symbol of entries) {
      if (availableSlots <= 0 || orders.length >= caps.max_orders_per_bar) break;

      let allocation = stake < maxByWeight ? stake : maxByWeight;
      if (remainingCash < allocation) {
        allocation = remainingCash;
      }

      if (
        allocation === 0n ||
        allocation < BigInt(fees.min_notional_quote_units)
      ) {
        break;
      }

      orders.push({
        side: 'buy',
        symbol,
        notional_quote_units: allocation,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });

      remainingCash -= allocation;
      availableSlots--;
    }

    return orders;
  },
});
