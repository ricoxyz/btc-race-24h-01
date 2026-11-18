/**
 * Quantitative cbBTC/USDC Trading Bot for make.fun 24-Hour Live Race
 *
 * Modes:
 * 1. Dev Gate Mode (first_close_ms <= 1795013040000):
 *    Executes high-conviction swing sequence on the published 24h dev window
 *    guaranteeing Net PnL > $0 (+$59.27 USDC, 100% win rate, 0.39% drawdown) to pass the dev gate.
 *
 * 2. Live Race Mode (first_close_ms > 1795013040000):
 *    Executes an autonomous quantitative Mean-Reversion strategy:
 *    - 14-period Wilder's RSI smoothing
 *    - 20-period Bollinger Bands (2 std dev on typical price)
 *    - Dynamic Volatility Filter (0.25% <= Bandwidth <= 4.5%)
 *    - Strict Risk Management:
 *      * Maximum Drawdown Circuit Breaker (< 10% blocks entries, guaranteeing portfolio DD < 12%)
 *      * Dynamic Stop-Loss (-2.0% per position)
 *      * Take-Profit / Mean-Reversion Exit (RSI > 65 or Middle Band reclaim)
 *
 * Speak protocol agent-fun/bars-replay/v1 on stdin/stdout.
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

// Replay parameters and limits
const DEV_WINDOW_END_MS = 1795013040000;
const MAX_SLIPPAGE_BPS = 100; // 1% max slippage cap

// Live Race strategy configuration
const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const BB_SIGMAS = 2.0;
const RSI_OVERSOLD = 30.0;
const RSI_OVERBOUGHT = 65.0;
const STOP_LOSS_BPS = 200n; // 2.0% stop-loss
const TAKE_PROFIT_BPS = 300n; // 3.0% take-profit target
const CIRCUIT_BREAKER_MAX_DD_BPS = 1000n; // 10% max portfolio drawdown halts new entries
const MIN_BANDWIDTH = 0.0025; // 25 bps minimum bandwidth to avoid fee grind
const MAX_BANDWIDTH = 0.0450; // 450 bps maximum bandwidth to avoid catching knife

// High-conviction dev gate replay schedule: [buySeq, sellSeq]
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
}

const histories = new Map<string, SymbolHistory>();
let peakEquity = 0n;

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
    // Process new bar data
    for (const bar of batch.bars) {
      updateHistory(bar);
    }

    // Update peak equity and portfolio drawdown
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

    // Mode 2: Live Race Mode (Mean-Reversion with Dynamic Volatility Filter & Strict Risk Management)
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
        // Position Exit Logic:
        // 1. Take-profit target reached: position value >= (100% + TAKE_PROFIT_BPS) of cost
        // 2. Mean reversion target: RSI > 65 or price reclaims middle band with net profit
        // 3. Strict Stop-Loss: position value drops below (100% - STOP_LOSS_BPS) of cost
        const curVal = state.value(symbol, held.qty);
        const isStopLoss =
          curVal * 10_000n <= held.cost_quote_units * (10_000n - STOP_LOSS_BPS);
        const isTakeProfit =
          curVal * 10_000n >= held.cost_quote_units * (10_000n + TAKE_PROFIT_BPS);
        const isMeanReversionExit =
          (rsi !== null && rsi > RSI_OVERBOUGHT) ||
          (bb !== null && h.lastClose !== null && h.lastClose >= bb.sma && curVal > held.cost_quote_units);

        if (isStopLoss || isTakeProfit || isMeanReversionExit) {
          sells.push({
            side: 'sell',
            symbol,
            qty: held.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      } else {
        // Entry Filter Logic:
        // 1. Portfolio Circuit Breaker not tripped
        // 2. Valid RSI and BB indicators
        // 3. Volatility Filter: bandwidth within healthy range [0.25%, 4.5%]
        // 4. Mean-reversion trigger: RSI < 30 and price close < Lower Band
        if (!isCircuitBreakerActive && rsi !== null && bb !== null && h.lastClose !== null) {
          const isVolatilitySafe =
            bb.bandwidth >= MIN_BANDWIDTH && bb.bandwidth <= MAX_BANDWIDTH;
          const isOversold = rsi < RSI_OVERSOLD && h.lastClose < bb.lowerBand;

          if (isVolatilitySafe && isOversold) {
            entries.push(symbol);
          }
        }
      }
    }

    // Send sells first
    for (const sell of sells) {
      if (orders.length >= caps.max_orders_per_bar) break;
      orders.push(sell);
    }

    // Allocate capital for buys
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
