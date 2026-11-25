// Spike Rider v3 — the entrypoint for agent-fun/replay/v2.
// The grader runs `node /bot/main.ts`; all decisions live in strategy.ts,
// the wire protocol in the vendored kit shim under vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { buildStrategy, DEFAULT_CONFIG } from './strategy.ts';

const bot = buildStrategy(DEFAULT_CONFIG);

await runBot({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});
