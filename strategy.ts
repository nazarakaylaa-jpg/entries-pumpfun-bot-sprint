// Spike Rider v3 — a pump.fun launch-spike scalper for agent-fun/replay/v2.
//
// What the dev window taught (measured before this file was written, on the
// kit's 24h dev tape: 1222 coins, 126,801 trades):
// - The 2-slot fill latency eats the opening spike. From the moment a coin's
//   real SOL first crosses 1 SOL, the price moves +12% (median) before a buy
//   decided on that batch fills, and the forward 50-slot return from the fill
//   price is -3.7% (median). Chasing momentum after the spike, buying dips,
//   and riding to completion are all structurally negative on dev.
// - One pocket survives the latency. Coins whose price ran up >= 100% inside
//   their create slot hit +15% before -8% on 56% of coins (first passage from
//   the fill price). They are lottery tickets: most dump, a third spike again
//   — and a tight stop with a 5:1 payoff makes the trade positive. The edge
//   strengthens with the run-up: 58% win rate at >= 150%, 67% at >= 200%.
//   The full slot-0 tape is visible in the create batch, so the bot decides
//   on that batch and the fill lands 2 slots later, still inside the spike's
//   second leg.
// - Completions are a mirage for a latency-2 bot: the median completer
//   completes in the same slot it is created. Riding to completion is not a
//   strategy here.
// - Fees: a round trip costs ~2.5% in curve fees (95 + 30 bps per side) plus
//   0.00021 SOL of tx fees. The 1%-of-real-reserve buy cap rarely binds for
//   these coins (their real SOL at the close of slot 0 is usually 10-85 SOL).
//
// Rules: buy only on the create batch, size up with the run-up tier, cut
// every loser fast at -4% while letting winners run to +20%, never hold past
// 600 slots, leave at once when the creator sells. A small "filler" tier buys
// coins with a slot-0 run-up of 80-100% at the minimum 0.01 SOL: those trades
// lose a little on their own, but the final window is 6h (about a quarter of
// dev), so the main tier alone expects only ~21 coins against the 20-coin
// guardrail bar — the filler tier buys insurance against a thin window.
//
// Changes vs the v2 predecessor ("Spike Rider v2", +0.541 SOL local):
// - Exit valuation now nets out the sell tx fee as well as curve fees, so a
//   take-profit / stop-loss triggers on the SOL the bot actually banks.
// - Cash check reserves two tx fees per new buy (one to enter, one to exit)
//   instead of one, so a full book of positions can always afford its exits.
// - Everything else is the same measured rule set; the tuning pass after the
//   first local grade decides whether TP/SL/hold move.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O,
// no environment reads. Two runs on the same tape produce identical orders.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Minimum slot-0 run-up over the create price (bps) to buy. */
  minRunUpBps: number;
  /** Run-up tier boundaries (bps): mid and high. */
  midRunUpBps: number;
  hiRunUpBps: number;
  /** Lamports to spend per tier (each buy still capped at 1% of real SOL). */
  stakeBase: number;
  stakeMid: number;
  stakeHi: number;
  /** Bar insurance: coins in [fillerMinRunUpBps, minRunUpBps) get this small stake. */
  fillerMinRunUpBps: number;
  fillerStake: number;
  /** Minimum real SOL reserve at the end of slot 0. */
  minRealSol: number;
  /** Skip the coin when the creator sold in slot 0. */
  skipDevSold: boolean;
  /** Skip the coin when the creator's own slot-0 buys exceed this (lamports). */
  maxDevBuy: number;
  /** Buy slippage allowed (bps). */
  buySlipBps: number;
  /** Sell slippage allowed (bps). */
  sellSlipBps: number;
  /** Full exit: sell everything once the position is worth this over cost (bps). */
  tpBps: number;
  /** Full exit: sell everything once the position is worth this under cost (bps). */
  slBps: number;
  /** First take-profit: sell tp1PartBps of the position at this gain (bps). Huge = off. */
  tp1Bps: number;
  /** Share of the position sold at the first take-profit (bps). */
  tp1PartBps: number;
  /** After the first take-profit, exit the rest when it falls to this vs cost (bps). */
  slAfterTp1Bps: number;
  /** Trailing stop: once up at least this (bps), exit on a fall of trailBps from the best. Huge = off. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** No re-entry for this many slots after an exit. */
  cooldownSlots: number;
  /** Max buys per coin. */
  maxEntries: number;
  /** Max total cost deployed across open positions (lamports). */
  maxDeployed: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunUpBps: 10_000,
  midRunUpBps: 15_000,
  hiRunUpBps: 20_000,
  stakeBase: 120_000_000,
  stakeMid: 180_000_000,
  stakeHi: 250_000_000,
  fillerMinRunUpBps: 8_000,
  fillerStake: 10_000_000,
  minRealSol: 500_000_000,
  skipDevSold: true,
  maxDevBuy: 1_000_000_000_000,
  buySlipBps: 500,
  sellSlipBps: 10_000,
  tpBps: 2_000,
  slBps: 400,
  tp1Bps: 1_000_000,
  tp1PartBps: 5_000,
  slAfterTp1Bps: 0,
  trailArmBps: 1_000_000,
  trailBps: 1_000,
  maxHold: 600,
  cooldownSlots: 300,
  maxEntries: 1,
  maxDeployed: 1_500_000_000,
};

/** Curve fees on a sell: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) banks after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create price as a virtual-reserve pair. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  complete: boolean;
  entries: number;
  coolUntil: number;
}

interface Held {
  openedSlot: number;
  bestBps: number;
  tookTp1: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Strategy {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already decided and not yet filled: never send a second one. */
  const selling = new Set<Pubkey>();

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();

    // Fold this batch's fills: count entries, drop exited positions, arm cooldowns.
    for (const f of batch.fills) {
      if (f.side === 'sell') selling.delete(f.mint);
      if (f.status !== 'filled') continue;
      const c = coins.get(f.mint);
      if (f.side === 'buy' && c !== undefined) c.entries += 1;
      if (f.side === 'sell' && c !== undefined && !state.positions.has(f.mint)) {
        c.coolUntil = slot + p.cooldownSlots;
      }
    }

    // Read this batch's tape: creates, last trade per fresh mint, creator sells.
    const fresh = new Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint }>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          complete: false,
          entries: 0,
          coolUntil: -1,
        });
        fresh.set(e.mint, { vq: 0n, vt: 0n, rq: 0n });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          if (e.user === c.creator) {
            if (e.is_buy) c.devBuy += BigInt(e.sol_amount);
            else c.devSold = true;
          }
          if (fresh.has(e.mint)) {
            fresh.set(e.mint, {
              vq: BigInt(e.virtual_quote_reserves),
              vt: BigInt(e.virtual_token_reserves),
              rq: BigInt(e.real_quote_reserves),
            });
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }

    // --- entries: only on the create batch, only on a slot-0 spike. ---
    let deployed = 0n;
    for (const pos of state.positions.values()) deployed += pos.cost_lamports;
    let buysThisBatch = 0;
    const openCount = state.committedPositionCount();
    if (openCount < state.hello.caps.max_open_positions && deployed < BigInt(p.maxDeployed)) {
      for (const [mint, last] of fresh) {
        const c = coins.get(mint)!;
        if (c.complete) continue;
        if (last.vt === 0n || last.vq === 0n) continue;
        if (last.rq < BigInt(p.minRealSol)) continue;
        if (p.skipDevSold && c.devSold) continue;
        if (c.devBuy > BigInt(p.maxDevBuy)) continue;
        if (c.entries >= p.maxEntries) continue;
        if (slot < c.coolUntil) continue;
        // Run-up of the last slot-0 trade over the create price, in bps.
        const runUp = Number(((last.vq * c.vt0 - c.vq0 * last.vt) * 10_000n) / (c.vq0 * last.vt));
        let stake: bigint;
        if (runUp >= p.minRunUpBps) {
          stake =
            runUp >= p.hiRunUpBps ? BigInt(p.stakeHi) : runUp >= p.midRunUpBps ? BigInt(p.stakeMid) : BigInt(p.stakeBase);
        } else if (runUp >= p.fillerMinRunUpBps) {
          stake = BigInt(p.fillerStake);
        } else {
          continue;
        }
        const cap = (state.maxBuyLamports(mint) * 97n) / 100n;
        const size = stake < cap ? stake : cap;
        if (size < 10_000_000n) continue;
        if (deployed + size > BigInt(p.maxDeployed)) continue;
        if (state.freeCashLamports() < size + 2n * txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
        deployed += size;
        buysThisBatch += 1;
        if (openCount + buysThisBatch >= state.hello.caps.max_open_positions) break;
      }
    }

    // --- exits: whole or partial sells of held positions. ---
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (selling.has(mint)) continue;
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: slot, bestBps: 0, tookTp1: false };
        held.set(mint, h);
      }
      // Net of curve fees AND the tx fee the sell itself will pay.
      const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - txFee;
      if (pos.cost_lamports <= 0n) continue;
      const pnlBps = Number(((value - pos.cost_lamports) * 10_000n) / pos.cost_lamports);
      if (pnlBps > h.bestBps) h.bestBps = pnlBps;

      const c = coins.get(mint);
      const devSoldNow = c !== undefined && c.devSold;
      let sell: bigint | null = null;
      if (devSoldNow || slot - h.openedSlot >= p.maxHold) {
        sell = pos.token_amount;
      } else if (h.tookTp1 && pnlBps <= p.slAfterTp1Bps) {
        sell = pos.token_amount;
      } else if (!h.tookTp1 && pnlBps >= p.tp1Bps) {
        sell = (pos.token_amount * BigInt(p.tp1PartBps)) / 10_000n;
        h.tookTp1 = true;
      } else if (pnlBps >= p.tpBps) {
        sell = pos.token_amount;
      } else if (pnlBps <= -p.slBps) {
        sell = pos.token_amount;
      } else if (h.bestBps >= p.trailArmBps && pnlBps <= h.bestBps - p.trailBps) {
        sell = pos.token_amount;
      }
      if (sell !== null && sell > 0n) {
        if (sell > pos.token_amount) sell = pos.token_amount;
        orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: p.sellSlipBps });
        selling.add(mint);
      }
    }

    // Forget positions that are gone (sold, flattened, completed).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    return orders;
  }

  return { onBatch };
}
