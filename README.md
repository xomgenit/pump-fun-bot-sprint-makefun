# pump-fun-bot-sprint-makefun

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/xomgenit/pump-fun-bot-sprint-makefun/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/xomgenit/pump-fun-bot-sprint-makefun/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun-style Solana markets, entered in make.fun's
"Pump.fun Bot Sprint: Make Bot And Win" bounty ($2 in USDC).

## Strategy

Early-momentum entries with pyramid adds and trailing exits. The bot reads the
replay's market events as they arrive (agent-fun/replay/v2 on stdin) and:

- buys a fresh curve only once its own tape proves real buyers are piling in
  (several distinct buyers, net SOL inflow, price rising and near its window high);
- starts small (0.03 SOL) and adds only while the tape keeps agreeing, up to
  0.09 SOL per position;
- leaves on the first sign the crowd is gone: a stop loss, a trailing stop off
  the peak, a fade in net flow, or a plain 600-slot time limit;
- keeps breadth on purpose (small entries, many coins) and opens tiny probe
  round trips if the distinct-mint count lags late in the window.

Deterministic by construction: no clock, no environment, no unseeded randomness.

## Run it

```sh
node main.ts
```

The bot speaks the replay protocol on stdin/stdout; the kit's
`grade-local` runs it against the dev window. `vendor/makefun-bot.ts` is a
byte-identical copy of the kit's SDK shim, as the kit instructs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x90fkarn&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
