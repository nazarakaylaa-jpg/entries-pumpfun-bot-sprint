# Spike Rider v3 — Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/nazarakaylaa-jpg/entries-pumpfun-bot-sprint/rank.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/nazarakaylaa-jpg/entries-pumpfun-bot-sprint/reward.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A Solana paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on [make.fun](https://make.fun).

## Strategy

Slot-0 spike rider: the bot only buys on a coin's create batch, when the slot-0
tape shows a price run-up of >= 100% over the create price, the creator has not
sold, and real SOL is >= 0.5. It sizes up with the run-up (0.15 / 0.25 / 0.35 SOL),
takes profit at +20%, cuts losers at -5%, never holds past 600 slots, and exits at
once when the creator sells. A minimum-size filler tier (0.01 SOL) buys 80-100%
run-ups as insurance for the 20-coin guardrail bar in the short 6h final window.

See [STRATEGY.md](STRATEGY.md) for the measured reasoning and results.

## Layout

- `main.ts` — entrypoint: wires the strategy into the replay shim.
- `strategy.ts` — the whole strategy (pure function of the batch stream).
- `vendor/makefun-bot.ts` — the kit's replay-v2 SDK shim, vendored byte for byte.
