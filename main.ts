// Pump.fun replay bot: proven-demand entries.
//
// What the dev window actually rewards is not being first — the first trade's price
// is already gone by the time a fill lands two slots later — but waiting for proof.
// Of the 840 coins with enough tape, only 27% ever double from their launch price,
// yet among coins whose first 60 slots pulled in at least 10 SOL of net inflow AND
// whose price had already risen at least 50%, 78% doubled. The price is higher by
// then, but the winners keep running: buying that filtered set at create+60 with a
// +75% take-profit, a −5% stop and a 300-slot time limit is the least-bad
// configuration measured on this window — grade-local dev net PnL −0.18 SOL over
// 100 round trips (19% win rate), versus −0.47 SOL for the kit's sniper pilot and
// −1.02 SOL for an early-momentum sniper on the same window. The two-slot fill
// latency and the fees eat the rest of the edge: no exit variant tested (partial
// take-profits, ratchet stops, shorter holds, slippage caps) turned the dev number
// positive, so this entry is honest about being a placeholder, not a racer — the
// dev gate (net PnL > 0) is not met. So this bot does nothing for a coin's first
// minute: it watches the opening tape, and only when the 60-slot proof is in does
// it buy — one stake per coin, no pyramid, no chasing, exits decided by profit,
// stop or time alone.
//
// Wire: the harness speaks agent-fun/replay/v2 on stdin (hello, then one batch per
// slot, then done) and expects exactly one reply per batch echoing its seq. The
// vendored shim (vendor/makefun-bot.ts, a byte-identical copy of the kit's
// sdk/ts/makefun-bot.ts) owns that wire; this file only decides orders.
// Deterministic by construction: no clock, no environment, no unseeded randomness
// — only the batch stream and insertion-ordered maps.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- tunables (SOL unless noted) -------------------------------------------
const STAKE_SOL = 0.06; // SOL to put into one coin
const MIN_BUY_SOL = 0.01; // guardrail floor; never send a smaller buy
const PROOF_SLOTS = 60; // slots of opening tape the proof is read from
const MIN_AGE_SLOTS = 60; // youngest age (slots since create) that may be bought
const MAX_AGE_SLOTS = 120; // oldest age at which a first buy may still be decided
const MIN_NET_SOL = 10; // net SOL inflow (buys minus sells) over the proof window
const MIN_RUNUP = 0.5; // price at proof end over create price, lower bound
const TAKE_PROFIT = 1.75; // sell all when value reaches this multiple of cost
const STOP_LOSS = 0.95; // sell all when value falls under this share of cost
const MAX_HOLD_SLOTS = 300; // plain time limit on any position
const COOLDOWN_SLOTS = 100; // wait this long after an exit before re-entering a curve
const MAX_ENTRIES_PER_CURVE = 1; // one buy per coin, ever
const BUY_SLIPPAGE_BPS = 5000; // buys may slip this far over 2 slots of latency
const SELL_SLIPPAGE_BPS = 10000; // sells go out wide open
const MAX_ORDERS_PER_BATCH = 12; // self cap, under the harness cap of 16

// ---- per-curve tape ---------------------------------------------------------
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number; // SOL moved by this trade
  price: number; // quote per token just after the trade
  buyer: string;
}

interface CurveNote {
  createdSlot: number | null;
  creator: string | null;
  tape: TapeTrade[];
  entries: number; // entries taken into this curve so far
  cooldownUntil: number; // slot before which no new entry
}

interface HeldNote {
  enteredSlot: number;
}

const curves = new Map<Pubkey, CurveNote>();
const held = new Map<Pubkey, HeldNote>();
const tradedCoins = new Set<Pubkey>();
let firstSlot = -1;
let buyFills = 0;
let sellFills = 0;
let buysSent = 0;
let sellsSent = 0;

function noteFor(mint: Pubkey): CurveNote {
  let n = curves.get(mint);
  if (n === undefined) {
    n = {
      createdSlot: null,
      creator: null,
      tape: [],
      entries: 0,
      cooldownUntil: -1,
    };
    curves.set(mint, n);
  }
  return n;
}

function priceOf(state: BotState, mint: Pubkey): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const tokens = Number(c.virtual_token_reserves);
  const quote = Number(c.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

function positionValueLamports(state: BotState, mint: Pubkey): number {
  const pos = state.positions.get(mint);
  if (pos === undefined) return 0;
  const p = priceOf(state, mint);
  if (p <= 0) return 0;
  return Number(pos.token_amount) * p;
}

// Proof read from the opening tape only: trades up to createdSlot + PROOF_SLOTS.
// Returns true when the coin earned its stake: at least MIN_NET_SOL of net inflow
// and the price already up at least MIN_RUNUP over the launch price.
function proofPassed(n: CurveNote): boolean {
  if (n.createdSlot === null) return false;
  const endSlot = n.createdSlot + PROOF_SLOTS;
  let netSol = 0;
  let firstPrice = 0;
  let lastPrice = 0;
  for (const t of n.tape) {
    if (t.slot > endSlot) break;
    if (firstPrice === 0) firstPrice = t.price;
    lastPrice = t.price;
    netSol += t.buy ? t.sol : -t.sol;
  }
  if (firstPrice <= 0 || lastPrice <= 0) return false;
  if (netSol < MIN_NET_SOL) return false;
  if (lastPrice / firstPrice - 1 < MIN_RUNUP) return false;
  return true;
}

function entryOk(state: BotState, mint: Pubkey, n: CurveNote, nowSlot: number): boolean {
  if (n.createdSlot === null) return false;
  const age = nowSlot - n.createdSlot;
  if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) return false;
  if (n.entries >= MAX_ENTRIES_PER_CURVE) return false;
  if (nowSlot < n.cooldownUntil) return false;
  if (state.positions.has(mint)) return false;
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return false;
  }
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  if (!proofPassed(n)) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (firstSlot < 0) firstSlot = batch.slot;
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // Fold the batch's fills into the bookkeeping first.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      tradedCoins.add(f.mint);
      if (f.side === 'buy') buyFills += 1;
      if (f.side === 'sell') {
        sellFills += 1;
        const n = curves.get(f.mint);
        if (n !== undefined) n.cooldownUntil = batch.slot + COOLDOWN_SLOTS;
        held.delete(f.mint);
      }
    }

    // Fold the batch's events into the per-curve tapes.
    for (const e of batch.events) {
      const n = noteFor(e.mint);
      if (e.event === 'CreateEvent') {
        if (n.createdSlot === null) {
          n.createdSlot = e.slot;
          n.creator = e.creator;
        }
      } else if (e.event === 'TradeEvent') {
        const price =
          Number(e.virtual_token_reserves) > 0
            ? Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves)
            : 0;
        n.tape.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / Number(SOL),
          price,
          buyer: e.user,
        });
      } else {
        // Curve completed: the harness closes any position; drop the hold note.
        held.delete(e.mint);
      }
    }

    const stakeLamports = BigInt(Math.round(STAKE_SOL * Number(SOL)));
    const minBuyLamports = BigInt(Math.round(MIN_BUY_SOL * Number(SOL)));

    // Exits first: every held position is judged against profit, loss and time.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let pendingSell = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint) pendingSell = true;
      }
      if (pendingSell) continue;
      const value = positionValueLamports(state, mint);
      const cost = Number(pos.cost_lamports);
      if (value <= 0 || cost <= 0) continue;
      const h = held.get(mint);
      const entered = h !== undefined ? h.enteredSlot : batch.slot;
      const takeProfit = value >= cost * TAKE_PROFIT;
      const stopHit = value < cost * STOP_LOSS;
      const timeHit = batch.slot - entered > MAX_HOLD_SLOTS;
      if (takeProfit || stopHit || timeHit) {
        if (orders.length < MAX_ORDERS_PER_BATCH) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: SELL_SLIPPAGE_BPS,
          });
          sellsSent += 1;
        }
      }
    }

    // Fresh entries: scan the batch's events in order; the first proof wins the slot.
    for (const e of batch.events) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (slots <= 0) break;
      const n = noteFor(e.mint);
      if (!entryOk(state, e.mint, n, batch.slot)) continue;
      if (free < stakeLamports + txFee) break;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < minBuyLamports) continue;
      const amount = cap < stakeLamports ? cap : stakeLamports;
      if (amount < minBuyLamports) continue;
      orders.push({
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txFee;
      slots -= 1;
      buysSent += 1;
      n.entries += 1;
      held.set(e.mint, { enteredSlot: batch.slot });
    }

    return orders;
  },

  onDone(state: BotState): void {
    console.error(
      `done: batches=${state.seq + 1} buys_sent=${buysSent} sells_sent=${sellsSent} ` +
        `buy_fills=${buyFills} sell_fills=${sellFills} coins=${tradedCoins.size} ` +
        `cash=${state.cash.toString()} positions=${state.positions.size}`,
    );
  },
});
