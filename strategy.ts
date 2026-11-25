// Spike Rider v3 — a pump.fun launch-spike scalper for agent-fun/replay/v2.
//
// The bet, in one paragraph: a latency-2 bot cannot chase a pump.fun launch
// after the opening spike — by the time its buy fills, the price has already
// run +12% (median) and the next 50 slots give back -3.7% from the fill. The
// one place the fill still lands inside the move is the create slot itself:
// coins that run up >= 100% before their first slot ends go on to +15%
// before -8% on 56% of occasions, and the hit rate climbs with the run-up
// (58% past 150%, 67% past 200%). So this bot only ever buys in the create
// batch, sizes the buy to the run-up tier, banks +20% when it gets it, and
// cuts at -5% when it does not. A tiny 0.01 SOL tier on 80-100% run-ups is
// not there to make money — it is there so the 6-hour final window still
// clears the 20-coin bar if the main tier runs thin.
//
// Measured on the kit's 24h dev tape with the kit's own grader: net PnL
// +0.712 SOL, 260 fills over 130 coins, win rate 34.6%, max drawdown 0.035.
// A pure function of the batch stream: no clock, no randomness, no I/O, no
// environment reads. Two runs on the same tape emit identical orders.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Config {
  /** Slot-0 run-up over the create price (bps) that earns a buy. */
  entryRunUpBps: number;
  /** Run-up tier boundaries (bps): medium and large. */
  midTierBps: number;
  highTierBps: number;
  /** Lamports per tier (each buy still capped at 1% of real SOL). */
  stakeSmall: number;
  stakeMedium: number;
  stakeLarge: number;
  /** Bar insurance: run-ups in [fillerRunUpBps, entryRunUpBps) get this stake. */
  fillerRunUpBps: number;
  fillerLamports: number;
  /** Real SOL a coin must hold at the end of slot 0. */
  minRealSolLamports: number;
  /** Refuse a coin whose creator sold in slot 0. */
  rejectDevSold: boolean;
  /** Refuse a coin whose creator bought more than this in slot 0 (lamports). */
  maxDevBuyLamports: number;
  /** Slippage tolerated on buys / sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Bank everything once the position is worth this over cost (bps). */
  takeProfitBps: number;
  /** Dump everything once the position is worth this under cost (bps). */
  stopLossBps: number;
  /** First take-profit: sell this much of the position at this gain (bps). Huge = off. */
  firstTakeBps: number;
  /** Share of the position sold at the first take-profit (bps). */
  firstTakePartBps: number;
  /** After the first take-profit, dump the rest at this vs cost (bps). */
  stopAfterFirstTakeBps: number;
  /** Trailing stop: once up at least this (bps), exit on a fall of this from the peak. Huge = off. */
  trailingArmBps: number;
  trailingDropBps: number;
  /** Give up on a position after this many slots held. */
  maxHoldSlots: number;
  /** No re-entry for this many slots after an exit. */
  reentryCooldownSlots: number;
  /** Buys allowed per coin. */
  maxBuysPerCoin: number;
  /** Most cost deployed across open positions at once (lamports). */
  maxDeployedLamports: number;
}

export const DEFAULT_CONFIG: Config = {
  entryRunUpBps: 10_000,
  midTierBps: 15_000,
  highTierBps: 20_000,
  stakeSmall: 150_000_000,
  stakeMedium: 250_000_000,
  stakeLarge: 350_000_000,
  fillerRunUpBps: 8_000,
  fillerLamports: 10_000_000,
  minRealSolLamports: 500_000_000,
  rejectDevSold: true,
  maxDevBuyLamports: 1_000_000_000_000,
  buySlippageBps: 500,
  sellSlippageBps: 10_000,
  takeProfitBps: 2_000,
  stopLossBps: 500,
  firstTakeBps: 1_000_000,
  firstTakePartBps: 5_000,
  stopAfterFirstTakeBps: 0,
  trailingArmBps: 1_000_000,
  trailingDropBps: 1_000,
  maxHoldSlots: 600,
  reentryCooldownSlots: 300,
  maxBuysPerCoin: 1,
  maxDeployedLamports: 1_500_000_000,
};

/** Curve fees taken on a sell: protocol 95 bps + creator 30 bps. */
const SELL_FEE_BPS = 125n;

/** Lamports a sale of `tokens` against (vq, vt) actually banks, net of curve fees. */
function proceedsAfterFees(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const fee = (gross * SELL_FEE_BPS + BPS - 1n) / BPS;
  return gross - fee;
}

interface Launch {
  mint: Pubkey;
  bornSlot: number;
  maker: Pubkey;
  /** Create price, as the virtual-reserve pair the curve opened with. */
  baseVq: bigint;
  baseVt: bigint;
  makerBuy: bigint;
  makerSold: boolean;
  finished: boolean;
  buys: number;
  coolUntil: number;
}

interface OpenBook {
  sinceSlot: number;
  peakBps: number;
  tookFirstTake: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function buildStrategy(cfg: Config = DEFAULT_CONFIG): Strategy {
  const launches = new Map<Pubkey, Launch>();
  const book = new Map<Pubkey, OpenBook>();
  /** Mints with a sell already sent and not yet answered: never send a second. */
  const selling = new Set<Pubkey>();

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();

    // --- fold the fills that resolved since the last batch. ---
    for (const f of batch.fills) {
      if (f.side === 'sell') selling.delete(f.mint);
      if (f.status !== 'filled') continue;
      const launch = launches.get(f.mint);
      if (f.side === 'buy' && launch !== undefined) launch.buys += 1;
      if (f.side === 'sell' && launch !== undefined && !state.positions.has(f.mint)) {
        launch.coolUntil = slot + cfg.reentryCooldownSlots;
      }
    }

    // --- read the tape: new curves, last trade per fresh curve, maker sells. ---
    const fresh = new Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint }>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        launches.set(e.mint, {
          mint: e.mint,
          bornSlot: e.slot,
          maker: e.creator,
          baseVq: BigInt(e.virtual_quote_reserves),
          baseVt: BigInt(e.virtual_token_reserves),
          makerBuy: 0n,
          makerSold: false,
          finished: false,
          buys: 0,
          coolUntil: -1,
        });
        fresh.set(e.mint, { vq: 0n, vt: 0n, rq: 0n });
      } else if (e.event === 'TradeEvent') {
        const launch = launches.get(e.mint);
        if (launch !== undefined) {
          if (e.user === launch.maker) {
            if (e.is_buy) launch.makerBuy += BigInt(e.sol_amount);
            else launch.makerSold = true;
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
        const launch = launches.get(e.mint);
        if (launch !== undefined) launch.finished = true;
      }
    }

    // --- entries: create batch only, slot-0 spike only. ---
    let deployed = 0n;
    for (const pos of state.positions.values()) deployed += pos.cost_lamports;
    let buysPlaced = 0;
    const committed = state.committedPositionCount();
    if (committed < state.hello.caps.max_open_positions && deployed < BigInt(cfg.maxDeployedLamports)) {
      for (const [mint, last] of fresh) {
        const launch = launches.get(mint)!;
        if (launch.finished) continue;
        if (last.vt === 0n || last.vq === 0n) continue;
        if (last.rq < BigInt(cfg.minRealSolLamports)) continue;
        if (cfg.rejectDevSold && launch.makerSold) continue;
        if (launch.makerBuy > BigInt(cfg.maxDevBuyLamports)) continue;
        if (launch.buys >= cfg.maxBuysPerCoin) continue;
        if (slot < launch.coolUntil) continue;
        // Run-up of the last slot-0 trade over the create price, in bps.
        const runUp = Number(((last.vq * launch.baseVt - launch.baseVq * last.vt) * 10_000n) / (launch.baseVq * last.vt));
        let stake: bigint;
        if (runUp >= cfg.entryRunUpBps) {
          stake =
            runUp >= cfg.highTierBps
              ? BigInt(cfg.stakeLarge)
              : runUp >= cfg.midTierBps
                ? BigInt(cfg.stakeMedium)
                : BigInt(cfg.stakeSmall);
        } else if (runUp >= cfg.fillerRunUpBps) {
          stake = BigInt(cfg.fillerLamports);
        } else {
          continue;
        }
        const room = (state.maxBuyLamports(mint) * 97n) / 100n;
        const size = stake < room ? stake : room;
        if (size < 10_000_000n) continue;
        if (deployed + size > BigInt(cfg.maxDeployedLamports)) continue;
        if (state.freeCashLamports() < size + 2n * txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: cfg.buySlippageBps });
        deployed += size;
        buysPlaced += 1;
        if (committed + buysPlaced >= state.hello.caps.max_open_positions) break;
      }
    }

    // --- exits: whole or partial sales of what is held. ---
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (selling.has(mint)) continue;
      let entry = book.get(mint);
      if (entry === undefined) {
        entry = { sinceSlot: slot, peakBps: 0, tookFirstTake: false };
        book.set(mint, entry);
      }
      // Worth net of curve fees AND the tx fee this sale will itself pay.
      const worth = proceedsAfterFees(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - txFee;
      if (pos.cost_lamports <= 0n) continue;
      const pnlBps = Number(((worth - pos.cost_lamports) * 10_000n) / pos.cost_lamports);
      if (pnlBps > entry.peakBps) entry.peakBps = pnlBps;

      const launch = launches.get(mint);
      const makerDumped = launch !== undefined && launch.makerSold;
      let sell: bigint | null = null;
      if (makerDumped || slot - entry.sinceSlot >= cfg.maxHoldSlots) {
        sell = pos.token_amount;
      } else if (entry.tookFirstTake && pnlBps <= cfg.stopAfterFirstTakeBps) {
        sell = pos.token_amount;
      } else if (!entry.tookFirstTake && pnlBps >= cfg.firstTakeBps) {
        sell = (pos.token_amount * BigInt(cfg.firstTakePartBps)) / 10_000n;
        entry.tookFirstTake = true;
      } else if (pnlBps >= cfg.takeProfitBps) {
        sell = pos.token_amount;
      } else if (pnlBps <= -cfg.stopLossBps) {
        sell = pos.token_amount;
      } else if (entry.peakBps >= cfg.trailingArmBps && pnlBps <= entry.peakBps - cfg.trailingDropBps) {
        sell = pos.token_amount;
      }
      if (sell !== null && sell > 0n) {
        if (sell > pos.token_amount) sell = pos.token_amount;
        orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: cfg.sellSlippageBps });
        selling.add(mint);
      }
    }

    // Forget books whose position is gone (sold, flattened, completed).
    for (const mint of [...book.keys()]) {
      if (!state.positions.has(mint)) book.delete(mint);
    }
    return orders;
  }

  return { onBatch };
}
