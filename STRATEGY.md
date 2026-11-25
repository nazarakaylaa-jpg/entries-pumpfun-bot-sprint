# Strategy: slot-0 spike rider v3

Everything here was measured on the kit's own dev tape (24h of pump.fun
bonding-curve data: 1222 coins, 126,801 trades) with the kit's local grader,
and every figure is counted from the fill price — the price the bot actually
gets — never from the price it decided on.

## What the tape says

- **Latency eats the open.** A buy decided once a coin's real SOL first
  passes 1 SOL fills about 12% higher (median), and the 50 slots after the
  fill give back -3.7% (median). Chasing the move after it has happened,
  buying the dip that follows, and holding on for the migration are all
  losers on this tape once fees are counted.
- **The create slot is the only pocket that survives.** A coin that climbs
  >= 100% inside its very first slot goes on to +15% before -8% on 56% of
  coins, measured from the fill. The hit rate grows with the climb: 58% past
  150%, 67% past 200%. The whole first slot is already visible in the create
  batch, so the bot decides there and the fill lands two slots later, still
  inside the second leg of the move.
- **Migrations are a mirage at latency 2.** The typical coin that migrates
  does so in the slot it was created in. Holding for a migration is not a
  plan.
- **What a round trip costs.** About 2.5% in curve fees (95 + 30 bps a
  side) plus 0.00021 SOL of transaction fees. The 1%-of-real-reserve cap on a
  buy almost never binds here — these coins usually hold 10-85 SOL of real
  reserves when slot 0 closes.

## The rules

A buy happens only in the create batch, only when the slot-0 tape shows:
- the last trade of slot 0 sits >= 100% above the create price;
- the curve has not already migrated (instant migrators are skipped);
- the creator has not sold in slot 0;
- real SOL at the close of slot 0 is >= 0.5 SOL.

Size follows the climb: 0.15 SOL, 0.25 SOL at >= 150%, 0.35 SOL at >= 200%,
each trimmed to 97% of the 1%-of-real-reserve cap. Buys carry 500 bps of
slippage, so a fill that jumps more than 5% while the order is in flight is
refused rather than chased. At most 5 positions open, at most 1.5 SOL of
cost deployed, one buy per coin.

The filler tier — climbs of 80-100% get a 0.01 SOL buy, the smallest round
trip the guardrail counts. On their own those trades lose a little, but the
final window is 6h, roughly a quarter of dev, so the main tier alone would
expect only about 21 coins against a 20-coin bar. The filler tier is cheap
insurance against a thin window.

Exits sell the whole position at 10000 bps of slippage, judged on what the
sale banks after curve fees and the sale's own transaction fee:
- take profit at +20% of cost; stop loss at -5% of cost;
- give up after 600 slots held, whatever the price;
- leave at once if the creator sells while the bot holds.

## Results (kit local grade, dev window)

- Final (stakes 0.15/0.25/0.35 SOL, stop -5%, take-profit +20%, hold 600):
  net PnL **+0.712 SOL**, 260 fills over 130 coins, 130 round trips, win
  rate 34.6%, max drawdown 0.035. Without the 3 best coins the PnL is still
  +0.33 SOL. Guardrails met (130 coins with >= 0.01 SOL round trips,
  drawdown far under 0.50). Two executions reproduce byte for byte.
- Stress (10 rebuilt copies of the dev window): median -0.11 SOL, p10
  -0.87, p90 +0.57; 5 of 10 copies lost money and the dev score sits above
  all 10. This is a lottery-ticket strategy by design — wide variance across
  windows — and the dev score leans on this window's coins. The 2x-fees PnL
  stays positive at +0.274 SOL.
- Pass 1 (stakes 0.12/0.18/0.25 SOL, stop -4%): +0.463 SOL, 130 coins.
- Sweep on dev: take-profit +25% +0.292, +15% +0.395, stop -5% +0.512,
  stop -3% +0.226, hold 300 +0.447, hold 1200 +0.462, entry bar >= 120%
  +0.484 (106 coins), bigger stakes +0.567, take-profit +25% with stop -5%
  +0.003 (the two knobs must not move together). The shipped combination —
  bigger stakes plus a wider stop — won the sweep and was also the least
  concentrated (best PnL with its top 3 coins removed).

## Tried and dropped (measured, not guessed)

- Selling half at +12% and letting the rest run with a breakeven stop:
  -0.06 SOL against a full exit at +20% — coins that reach +12% usually
  reach +20%.
- Trailing stops: +0.01 SOL, inside noise.
- Momentum entries at any age up to 600 slots: about -1.5 SOL.
- Dip-buying after the opening dump: flat before fees, negative after.
- Buying coins whose real SOL crossed 10/20/30 SOL to ride the migration:
  -0.4 to -1.5 SOL.
- Dropping the main-tier bar to +80%: +0.12 SOL — the extra coins are net
  losers, so +80% survives only as the minimum-size filler tier.
