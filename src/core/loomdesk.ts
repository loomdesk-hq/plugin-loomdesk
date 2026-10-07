// Copied from core/src/loomdesk.ts by scripts/sync-core.mjs. Edit it there, then run npm run sync at the repo root.
// LoomDesk for an agent framework: reads the market, asks loomdesk.trade for plans, and sends them from the agent's own
// wallet by the rules every LoomDesk plugin keeps:
//   - nothing is sent unless LoomDesk's own simulation of the plan passed (check.ok); a plan it could not simulate is
//     made again once, and a ladder in a pool that is still to be opened waits for the opening to be mined;
//   - every transaction goes to a LoomDesk contract (contracts.ts), the router the swap plan names, or approves one of
//     them, and nothing pays anyone but the wallet (guard.ts);
//   - the transactions go in order, each with the gas LoomDesk set, each after the one before is mined; one that
//     reverts is read in the plan's ifItReverts and the plan is made again once;
//   - never more than was asked for, and never over the spending cap.
// The owner is always the wallet itself and the referrer comes only from the configuration, never from the model.
import { formatEther, formatUnits, getAddress, isAddress, parseEther, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { LoomDeskApi, type ApiOptions, type Plan } from "./api.js";
import { CHAIN_ID, explorerTx } from "./chain.js";
import { ALL_LADDERS, KNOWN_ROUTERS, LOOMDESK, OPEN_FEE_MAX, USDG, USDG_DECIMALS, WETH, contractsInLlms, unknownContracts } from "./contracts.js";
import { GuardError, reasonOf, revertSelector, vetPlan, type CheckedTx, type Role, type Rules } from "./guard.js";

/** The agent's wallet, as each framework gives it. */
export interface Sender {
  readonly address: Address;
  chainId(): Promise<number>;
  /** ETH held, in wei */
  balance(): Promise<bigint>;
  decimals(token: Address): Promise<number>;
  /** Sends one checked transaction with its gas and waits for it to be mined. A revert is a result, not a throw. */
  send(tx: CheckedTx): Promise<SendResult>;
  /** Why this wallet cannot send a transaction of the plan, if it cannot: asked of every one before the first goes. */
  cannotSend?(tx: CheckedTx): string | undefined;
}
export type SendResult = { hash?: Hex; status: "success" | "reverted"; revert?: Hex; error?: string };

export type Amounts = { ETH?: string; USDG?: string };

export type LoomDeskOptions = Omit<ApiOptions, "client"> & {
  /** The builder's wallet: paid 0.1% of what goes into every ladder opened through this agent, out of LoomDesk's
   *  0.25% opening fee (not on top of it). The ladder contract keeps an owner's first referrer for good. */
  referrer?: string;
  /** The most one plan may spend, per asset (WETH counts as ETH). */
  spendCap?: Amounts;
  /** The most all plans together may spend while this process runs. */
  budget?: Amounts;
  /** The most a "close once filled" may put in the keeper's gas tank. Default 0.005 ETH. */
  maxGasTankEth?: string;
  /** LoomLadder contracts deployed after this release, so their ladders can be closed. */
  extraLadderContracts?: string[];
  /** Names the plugin to LoomDesk ("loomdesk-agentkit/0.1.0"). Set by each plugin. */
  client?: string;
};

export type Sent = { step: string; hash?: string; status: "success" | "reverted"; explorer?: string };
export type Outcome = {
  /** everything asked was done; on a dry run, the plan passed every check */
  ok: boolean;
  /** anything was sent */
  sent: boolean;
  dryRun?: boolean;
  /** why nothing (more) was sent */
  refused?: string;
  reverted?: { step: string; reason: string };
  replanned?: string;
  transactions?: Sent[];
  plan?: Record<string, unknown>;
  next?: string;
  [k: string]: unknown;
};

type Spend = { ETH: bigint; USDG: bigint };
type Ruled = Rules & { spend: Spend };

export type BuildAsk = { token: string; payIn: "ETH" | "USDG"; amount: string; quote?: string; pool?: string; lowPct?: number; highPct?: number; rungs?: number; shape?: string; fullRange?: boolean; feePct?: number; slippagePct?: number; copyOf?: string };
export type LadderAsk = { token: string; pool?: string; lowPct: number; highPct: number; rungs?: number; shape?: string; amountToken?: string; amountQuote?: string; fullRange?: boolean; split?: boolean; payWithEth?: boolean; slippagePct?: number; copyOf?: string; openPool?: { quote: string; feePct: number } };
export type LimitAsk = { token: string; side: "buy" | "sell"; price: number; priceTo?: number; unit?: "usd" | "quote"; amount: string; pool?: string; rungs?: number; shape?: string; acceptBuilt?: boolean; payWithEth?: boolean; closeOnceFilled?: boolean; copyOf?: string };
export type ActionAsk = { ladderId: string; contract?: string; action: "collect" | "close" | "close_part" | "take_nfts" | "close_once_filled"; on?: boolean; sharePct?: number; slippagePct?: number };
export type SwapAsk = { from: string; to: string; amount: string; slippagePct?: number };
export type OpenPoolAsk = { token: string; quote: string; feePct: number };
type Run = { dryRun?: boolean };

const low = (a: string) => a.toLowerCase();
const isEthLike = (a: string | undefined) => !!a && (same(a, zeroAddress) || same(a, WETH));
const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const DECIMAL = /^\d*\.?\d+$/;
const UNSAFE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

/** Strings from LoomDesk come from the chain and from users (token names, theses): kept as data, with the characters
 *  that hide text taken out, and long ones cut. */
function clean<T>(x: T, depth = 0): T {
  if (typeof x === "string") return x.replace(UNSAFE, "").slice(0, 2000) as T;
  if (depth > 8 || !x || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map((v) => clean(v, depth + 1)) as T;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clean(v, depth + 1)])) as T;
}

/** A plan as the model reads it: what it does and how it was checked, without the call data. */
export function summarize(plan: Plan): Record<string, unknown> {
  const { transactions, ifItReverts: _r, preview: _p, howToSend: _h, ...rest } = plan;
  return clean({ ...rest, steps: (transactions ?? []).map((t) => ({ step: t.step, to: t.to, ...(t.value && t.value !== "0" ? { sendsEth: formatEther(BigInt(t.value)) } : {}), ...(t.gas ? { gas: t.gas } : {}) })) });
}

export class LoomDesk {
  readonly api: LoomDeskApi;
  readonly referrer?: Address;
  private readonly cap: Partial<Spend>;
  private readonly budget: Partial<Spend>;
  private readonly spent: Spend = { ETH: 0n, USDG: 0n };
  private readonly tankMax: bigint;
  readonly ladders: Address[];

  constructor(o: LoomDeskOptions = {}) {
    if (o.referrer !== undefined && o.referrer !== "" && !isAddress(o.referrer, { strict: false })) throw new Error("loomdesk: referrer is not an address");
    for (const x of o.extraLadderContracts ?? []) if (!isAddress(x, { strict: false })) throw new Error(`loomdesk: ${x} is not an address`);
    this.api = new LoomDeskApi({ ...o, client: o.client ?? "loomdesk-agent/0.1.0" });
    this.referrer = o.referrer ? (getAddress(o.referrer.toLowerCase()) as Address) : undefined;
    const amounts = (x: Amounts | undefined): Partial<Spend> => ({ ...(x?.ETH !== undefined ? { ETH: parseEther(x.ETH) } : {}), ...(x?.USDG !== undefined ? { USDG: parseUnits(x.USDG, USDG_DECIMALS) } : {}) });
    this.cap = amounts(o.spendCap);
    this.budget = amounts(o.budget);
    this.tankMax = parseEther(o.maxGasTankEth ?? "0.005");
    this.ladders = [...ALL_LADDERS, ...(o.extraLadderContracts ?? []).map((x) => getAddress(x.toLowerCase()) as Address)];
  }

  // --- reading ----------------------------------------------------------------------------------------------------

  /** Tokens that trade on Robinhood Chain, from LoomDesk's index of every swap: a search, the leaders over a window,
   *  or the whole list. Flagged tokens (failed a sell test, owner can freeze, ...) are left out. */
  async market(a: { query?: string; leadersWindowSeconds?: number; limit?: number } = {}) {
    const n = Math.max(1, Math.min(100, a.limit ?? 20));
    type T = Record<string, unknown> & { tier?: string; volumeUsd?: number; windowTrades?: number; windowVolumeUsd?: number };
    const slim = (t: T) => ({ address: t.address, symbol: t.symbol, name: t.name, priceUsd: t.priceUsd, marketCapUsd: t.marketCapUsd, volume24hUsd: typeof t.volumeUsd === "number" ? Math.round(t.volumeUsd) : t.volumeUsd, change24hPct: t.changePct, tier: t.tier, ...(t.depthUsd !== undefined ? { usdToMovePrice2Pct: t.depthUsd } : {}), ...(t.keep !== undefined ? { keep: t.keep } : {}), ...(t.ageDays !== undefined ? { ageDays: t.ageDays } : {}) });
    const ok = (t: T) => t.tier !== "flagged";
    if (a.leadersWindowSeconds) {
      const w = Math.max(300, Math.min(604_800, Math.round(a.leadersWindowSeconds)));
      const l = await this.api.get<{ byTrades?: T[]; byVolume?: T[] }>(`/api/index/leaders?window=${w}`);
      return clean({ windowSeconds: w, mostTraded: (l.byTrades ?? []).filter(ok).slice(0, n).map((t) => ({ ...slim(t), trades: t.windowTrades })), highestVolume: (l.byVolume ?? []).filter(ok).slice(0, n).map((t) => ({ ...slim(t), volumeUsd: Math.round(t.windowVolumeUsd ?? 0) })) });
    }
    const r = a.query ? await this.api.get<{ tokens?: T[] }>(`/api/index/search?q=${encodeURIComponent(a.query.slice(0, 64))}`) : await this.api.get<{ tokens?: T[] }>("/api/index/tokens");
    return clean({ tokens: (r.tokens ?? []).filter(ok).slice(0, n).map(slim), note: "tier: prefer established; untested means nobody has checked a stranger can sell it. keep near 1: fees from ordinary traders; near 0: mostly arbitrage." });
  }

  /** The pools of a token a ladder can go in, the site's default first. */
  async pools(token: string) {
    if (!isAddress(token, { strict: false })) throw new GuardError("token is not an address");
    return clean(await this.api.plan({ plan: "pools", token }));
  }

  /** A wallet's live ladders. */
  async myLadders(address: string) {
    if (!isAddress(address, { strict: false })) throw new GuardError("address is not an address");
    type L = Record<string, any>;
    const r = await this.api.get<{ ladders?: L[] }>(`/api/ladders?address=${getAddress(address.toLowerCase())}`);
    return clean({
      address: getAddress(address.toLowerCase()),
      ladders: (r.ladders ?? []).map((l) => ({
        ladderId: l.id, contract: l.contract, pair: `${l.token0?.symbol}/${l.token1?.symbol}`, rungs: Array.isArray(l.rungs) ? l.rungs.length : undefined, inRange: l.inRange,
        valueUsd: l.valueUsd, feesWaitingUsd: l.feesUsd, feesCollectedUsd: l.claimedUsd, pnlUsd: l.pnlUsd, ...(l.limit ? { limit: { side: l.limit.side, status: l.limit.status, filledPct: l.limit.filledPct } } : {}),
        band: { lowUsd: l.priceLowUsd, highUsd: l.priceHighUsd, nowUsd: l.priceNowUsd },
      })),
    });
  }

  /** Contracts the live llms.txt lists that this release does not know. Informational: the list a plan is checked
   *  against is the one shipped (contracts.ts), never the server's. */
  async checkContractList(): Promise<{ known: number; unknown: Address[]; note: string }> {
    const live = contractsInLlms(await this.api.text("/llms.txt"));
    const unknown = unknownContracts(live, this.ladders);
    return { known: live.length - unknown.length, unknown, note: unknown.length ? "LoomDesk lists contracts this plugin does not know: plans that use them are refused until the plugin is updated." : "This plugin knows every contract LoomDesk lists." };
  }

  // --- planning and sending ---------------------------------------------------------------------------------------

  /** A ladder from one asset (ETH or USDG) in one transaction (two for USDG: its approval first): the zap swaps for
   *  the sides it needs and opens a LoomDesk pool on the way when the pair has none. Given neither a pool nor a quote,
   *  it builds in the token's first v4 pool, the site's default; given no band, -30% to +40% around the price. */
  async build(s: Sender, a: BuildAsk & Run): Promise<Outcome> {
    if (a.payIn !== "ETH" && a.payIn !== "USDG") return refusal('payIn is "ETH" or "USDG".');
    if (!DECIMAL.test(a.amount)) return refusal("amount is a decimal string, such as 0.01.");
    if (!isAddress(a.token, { strict: false })) return refusal("token is not an address.");
    const pay = a.payIn === "ETH" ? parseEther(a.amount) : parseUnits(a.amount, USDG_DECIMALS);
    if (pay <= 0n) return refusal("amount must be above zero.");
    const spend: Spend = a.payIn === "ETH" ? { ETH: pay, USDG: 0n } : { ETH: 0n, USDG: pay };
    const over = this.overCap(spend);
    if (over) return refusal(over);
    let pool = a.pool;
    if (!pool && !a.quote) pool = await this.defaultPool(a.token, Boolean(a.fullRange));
    const { dryRun, ...ask } = a;
    // the band the site starts a ladder with, when none is asked for
    const band = a.fullRange ? {} : { lowPct: a.lowPct ?? -30, highPct: a.highPct ?? 40 };
    const body = { plan: "build", ...ask, ...band, ...(pool ? { pool } : {}), ...(!pool && !a.quote ? { quote: a.payIn } : {}), ...this.ref(s) };
    const payIn = (a.payIn === "ETH" ? zeroAddress : USDG) as Address;
    return this.run(s, body, async () => ({
      ...this.base(s, [[LOOMDESK.zap, "zap"]], [LOOMDESK.zap]),
      approve: new Map(a.payIn === "USDG" ? [[low(USDG), pay]] : []),
      eth: a.payIn === "ETH" ? pay : 0n,
      build: { payIn, amountIn: pay },
      spend,
    }), { dryRun });
  }

  /** A ladder from the token, the quote or both, in a pool of the token. With openPool, the pool is opened first
   *  (plan_open_pool), and the ladder is planned in it once the opening is mined. */
  async ladder(s: Sender, a: LadderAsk & Run): Promise<Outcome> {
    if (!isAddress(a.token, { strict: false })) return refusal("token is not an address.");
    if (!a.amountToken && !a.amountQuote) return refusal("Give amountToken, amountQuote or both.");
    for (const v of [a.amountToken, a.amountQuote]) if (v !== undefined && !DECIMAL.test(v)) return refusal("Amounts are decimal strings, such as 0.01.");
    const { dryRun, openPool, ...ask } = a;
    let pool = a.pool;
    let opened: Outcome | undefined;
    if (openPool) {
      opened = await this.openPool(s, { token: a.token, quote: openPool.quote, feePct: openPool.feePct, dryRun });
      if (!opened.ok) return { ...opened, next: "The pool was not opened, so no ladder was planned." };
      pool = String((opened.plan as { pool?: string } | undefined)?.pool ?? "");
      if (dryRun && !opened.alreadyOpen) return { ...opened, next: "Sent for real, the opening goes first; once it is mined the ladder is planned in the new pool and checked before it is sent." };
    }
    const body = { plan: "ladder", ...ask, ...(pool ? { pool } : {}), ...this.ref(s) };
    const out = await this.run(s, body, async (plan) => {
      const quote = String((plan.pool as { quoteAddress?: string } | undefined)?.quoteAddress ?? "");
      const approve = new Map<string, bigint>();
      if (a.amountToken) approve.set(low(a.token), parseUnits(a.amountToken, await s.decimals(getAddress(a.token.toLowerCase()) as Address)));
      if (a.amountQuote && isAddress(quote, { strict: false }) && !same(quote, zeroAddress)) approve.set(low(quote), parseUnits(a.amountQuote, same(quote, USDG) ? USDG_DECIMALS : await s.decimals(getAddress(low(quote)) as Address)));
      const eth = a.amountQuote && isEthLike(quote) ? parseEther(a.amountQuote) : 0n;
      return {
        ...this.base(s, [[LOOMDESK.ladder, "ladder"], [LOOMDESK.zap, "zap"], [LOOMDESK.priceSetter, "setter"]], [LOOMDESK.ladder, LOOMDESK.zap]),
        approve, eth,
        spend: { ETH: eth, USDG: a.amountQuote && same(quote, USDG) ? parseUnits(a.amountQuote, USDG_DECIMALS) : 0n },
      };
    }, { dryRun });
    return opened ? { ...out, opened: { transactions: opened.transactions, pool } } : out;
  }

  /** A limit order: a ladder on one side of the price that sells the token (sell) or buys it (buy) as the price
   *  passes through it, closed by the keeper once filled unless closeOnceFilled is false. */
  async limit(s: Sender, a: LimitAsk & Run): Promise<Outcome> {
    if (!isAddress(a.token, { strict: false })) return refusal("token is not an address.");
    if (a.side !== "buy" && a.side !== "sell") return refusal('side is "buy" or "sell".');
    if (!DECIMAL.test(a.amount)) return refusal("amount is a decimal string, such as 0.01.");
    const { dryRun, ...ask } = a;
    return this.run(s, { plan: "limit", ...ask, ...this.ref(s) }, async (plan) => {
      const quote = String((plan.pool as { quoteAddress?: string } | undefined)?.quoteAddress ?? "");
      const held = a.side === "sell" ? a.token : quote;
      const approve = new Map<string, bigint>();
      if (isAddress(held, { strict: false }) && !same(held, zeroAddress)) approve.set(low(held), parseUnits(a.amount, same(held, USDG) ? USDG_DECIMALS : await s.decimals(getAddress(low(held)) as Address)));
      const eth = a.side === "buy" && isEthLike(quote) ? parseEther(a.amount) : 0n;
      return {
        ...this.base(s, [[LOOMDESK.ladder, "ladder"], [LOOMDESK.zap, "zap"], [LOOMDESK.priceSetter, "setter"]], [LOOMDESK.ladder, LOOMDESK.zap]),
        approve, eth,
        spend: { ETH: eth, USDG: a.side === "buy" && same(quote, USDG) ? parseUnits(a.amount, USDG_DECIMALS) : 0n },
      };
    }, { dryRun });
  }

  /** collect (fees only), close (everything out), close_part (sharePct of every rung), take_nfts (the positions
   *  themselves, 5% of the value to LoomDesk), close_once_filled (the keeper closes a filled limit order; may fill
   *  the gas tank). What comes out is paid to this wallet only. */
  async action(s: Sender, a: ActionAsk & Run): Promise<Outcome> {
    if (!/^\d+$/.test(String(a.ladderId))) return refusal("ladderId is a number, from my_ladders.");
    const contract = getAddress(low(a.contract ?? LOOMDESK.ladder)) as Address;
    if (!this.ladders.some((l) => same(l, contract))) return refusal(`${contract} is not a LoomLadder this plugin knows. Nothing was planned.`);
    const { dryRun, ...ask } = a;
    const tank = a.action === "close_once_filled";
    return this.run(s, { plan: "action", ...ask, contract }, async () => ({
      ...this.base(s, [[contract, "ladder"], ...(tank ? ([[LOOMDESK.pilotGas, "pilot"]] as [Address, Role][]) : [])], []),
      approve: new Map(),
      eth: tank ? this.tankMax : 0n,
      spend: { ETH: 0n, USDG: 0n },
    }), { dryRun });
  }

  /** A swap through the router LoomDesk's zap uses, for a side a ladder needs and the wallet does not hold. */
  async swap(s: Sender, a: SwapAsk & Run): Promise<Outcome> {
    if (!DECIMAL.test(a.amount)) return refusal("amount is a decimal string, such as 0.01.");
    const { dryRun, ...ask } = a;
    const fromEth = a.from.toUpperCase() === "ETH";
    const fromUsdg = a.from.toUpperCase() === "USDG";
    const early: Spend = { ETH: fromEth ? parseEther(a.amount) : 0n, USDG: fromUsdg ? parseUnits(a.amount, USDG_DECIMALS) : 0n };
    const over = this.overCap(early);
    if (over) return refusal(over);
    return this.run(s, { plan: "swap", ...ask, from: fromEth ? "ETH" : fromUsdg ? "USDG" : a.from, to: a.to.toUpperCase() === "ETH" ? "ETH" : a.to.toUpperCase() === "USDG" ? "USDG" : a.to }, async (plan) => {
      const router = String(plan.router ?? "");
      if (!KNOWN_ROUTERS.some((r) => same(router, r))) throw new GuardError(`The swap goes through ${router || "an unnamed router"}, not the router LoomDesk's zap uses. Nothing was sent.`);
      const src = String((plan.from as { address?: string } | undefined)?.address ?? "");
      const approve = new Map<string, bigint>();
      if (!fromEth && isAddress(src, { strict: false })) approve.set(low(src), parseUnits(a.amount, same(src, USDG) ? USDG_DECIMALS : await s.decimals(getAddress(low(src)) as Address)));
      return {
        ...this.base(s, [[getAddress(low(router)) as Address, "router"]], [router]),
        approve,
        eth: fromEth ? parseEther(a.amount) : 0n,
        spend: { ETH: fromEth || same(src, WETH) ? parseUnits(a.amount, 18) : 0n, USDG: same(src, USDG) ? parseUnits(a.amount, USDG_DECIMALS) : 0n },
      };
    }, { dryRun });
  }

  /** Opens a pool for the token on LoomDesk's hook against ETH, USDG or another token: about a dollar, once. */
  async openPool(s: Sender, a: OpenPoolAsk & Run): Promise<Outcome> {
    if (!isAddress(a.token, { strict: false })) return refusal("token is not an address.");
    const { dryRun, ...ask } = a;
    const out = await this.run(s, { plan: "open_pool", ...ask }, async () => ({
      ...this.base(s, [[LOOMDESK.openHook, "openHook"]], [LOOMDESK.openHook]),
      approve: new Map([[low(USDG), parseUnits(OPEN_FEE_MAX.USDG, USDG_DECIMALS)]]),
      eth: parseEther(OPEN_FEE_MAX.ETH),
      spend: { ETH: 0n, USDG: 0n },
    }), { dryRun });
    const plan = out.plan as { alreadyOpen?: boolean } | undefined;
    return plan?.alreadyOpen ? { ...out, ok: true, alreadyOpen: true } : out;
  }

  // --- the rules ----------------------------------------------------------------------------------------------------

  private base(s: Sender, targets: [string, Role][], spenders: string[]): Pick<Rules, "owner" | "referrer" | "targets" | "spenders"> {
    return { owner: s.address, referrer: this.referrer, targets: new Map(targets.map(([x, r]) => [low(x), r])), spenders: new Set(spenders.map(low)) };
  }

  /** The referrer for a plan: the one configured, unless it is the wallet itself. */
  private ref(s: Sender) {
    return this.referrer && !same(this.referrer, s.address) ? { referrer: this.referrer } : {};
  }

  private overCap(spend: Spend): string | undefined {
    for (const k of ["ETH", "USDG"] as const) {
      const fmt = (v: bigint) => (k === "ETH" ? formatEther(v) : formatUnits(v, USDG_DECIMALS));
      const cap = this.cap[k];
      if (cap !== undefined && spend[k] > cap) return `${fmt(spend[k])} ${k} is over this agent's limit of ${fmt(cap)} ${k} for one plan.`;
      const budget = this.budget[k];
      if (budget !== undefined && this.spent[k] + spend[k] > budget) return `${fmt(spend[k])} ${k} would take this agent past its budget (${fmt(this.spent[k])} of ${fmt(budget)} ${k} spent).`;
    }
    return undefined;
  }

  /** The token's first Uniswap v4 pool in the site's order (a build goes only in v4 pools), when it has one. */
  private async defaultPool(token: string, fullRange: boolean): Promise<string | undefined> {
    const p = (await this.api.plan({ plan: "pools", token }).catch(() => undefined)) as { pools?: { pool?: string; version?: number; fullRangeOnly?: boolean }[] } | undefined;
    return (p?.pools ?? []).find((x) => x.version === 4 && (fullRange || !x.fullRangeOnly) && typeof x.pool === "string")?.pool;
  }

  /** Plan, check, send; plan again once when the plan could not be simulated or a transaction reverted. */
  private async run(s: Sender, body: Record<string, unknown>, rulesFor: (plan: Plan) => Promise<Ruled>, o: Run): Promise<Outcome> {
    const chain = await s.chainId();
    if (chain !== CHAIN_ID) return refusal(`The wallet is on chain ${chain}; LoomDesk is on Robinhood Chain (${CHAIN_ID}).`);
    const sent: Sent[] = [];
    let replanned: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let plan: Plan;
      let txs: CheckedTx[];
      let rules: Ruled;
      try {
        plan = await this.api.plan({ ...body, owner: s.address });
        rules = await rulesFor(plan);
        txs = vetPlan(plan, rules);
      } catch (e) {
        if (e instanceof GuardError) return { ...refusal(e.message), ...(sent.length ? { sent: true, transactions: sent } : {}), ...(replanned ? { replanned } : {}) };
        throw e;
      }
      const summary = summarize(plan);
      const done = (x: Outcome): Outcome => ({ ...x, ...(sent.length ? { transactions: sent, sent: true } : {}), ...(replanned ? { replanned } : {}), plan: summary });
      if (plan.opensFirst) return done(refusal(`This ladder goes in a pool that is still to be opened: send the opening first (open_pool), then plan the ladder again. ${plan.opensFirst}`));
      if (!txs.length) return done({ ok: true, sent: false, note: "Nothing to send." });
      const cannot = txs.map((t) => s.cannotSend?.(t)).find(Boolean);
      if (cannot) return done(refusal(cannot));
      const c = plan.check;
      if (!c || c.simulated !== true) {
        if (attempt === 0) {
          replanned = `LoomDesk could not simulate the first plan (${c?.note ?? "no check came with it"}), so it was planned again.`;
          continue;
        }
        return done(refusal(`LoomDesk could not simulate the plan just now${c?.note ? ` (${c.note})` : ""}. Nothing was sent; try again in a minute.`));
      }
      if (c.ok !== true) return done(refusal(`The plan fails in LoomDesk's simulation${c.failedStep ? ` at step ${c.failedStep}` : ""}: ${c.reason ?? "no reason given"}. Nothing was sent.${c.note ? ` ${c.note}` : ""}`));
      // what the plan spends: the ETH it sends and the USDG it approves, or what was asked when that is more
      const value = txs.reduce((t, x) => t + x.value, 0n);
      const usdg = txs.reduce((t, x) => t + (same(x.to, USDG) && x.call?.functionName === "approve" ? (x.call.args[1] as bigint) : 0n), 0n);
      const spend: Spend = { ETH: value > rules.spend.ETH ? value : rules.spend.ETH, USDG: usdg > rules.spend.USDG ? usdg : rules.spend.USDG };
      const over = this.overCap(spend);
      if (over) return done(refusal(over));
      if (o.dryRun) return done({ ok: true, sent: false, dryRun: true, next: "Dry run: planned and checked, nothing signed. Plans are priced at a block: plan again right before sending." });
      const gasMost = c.gasEthAtMost && DECIMAL.test(c.gasEthAtMost) ? parseEther(c.gasEthAtMost) : 0n;
      const held = await s.balance();
      if (held < value + gasMost) return done(refusal(`The wallet holds ${formatEther(held)} ETH; the plan needs ${formatEther(value + gasMost)} (${value > 0n ? `${formatEther(value)} sent, ` : ""}up to ${formatEther(gasMost)} for gas). Nothing was sent.`));
      let failed: { step: string; reason: string } | undefined;
      let paid = 0n;
      for (const tx of txs) {
        let r: SendResult;
        try {
          r = await s.send(tx);
        } catch (e) {
          // a wallet that estimates gas itself throws on a call that would revert, before sending anything
          const sel = revertSelector(e);
          if (!sel && !/revert/i.test(String((e as Error)?.message ?? e))) return done({ ok: false, sent: sent.length > 0, refused: `The wallet could not send "${tx.step}": ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300)}` });
          r = { status: "reverted", revert: sel, error: String((e as Error)?.message ?? e).split("\n")[0] };
        }
        if (r.hash) sent.push({ step: tx.step, hash: r.hash, status: r.status, explorer: explorerTx(r.hash) });
        if (r.status !== "success") {
          failed = { step: tx.step, reason: reasonOf(r.revert, plan.ifItReverts) ?? "it reverted without a reason the wallet could read" };
          break;
        }
        paid += tx.value;
      }
      this.spent.ETH += paid;
      if (!failed) {
        this.spent.USDG += spend.USDG;
        return done({ ok: true, sent: true });
      }
      if (attempt === 0) {
        replanned = `"${failed.step}" reverted (${failed.reason}), so it was planned again.`;
        continue;
      }
      return done({ ok: false, sent: sent.length > 0, reverted: failed, next: "It reverted twice. Wait for the price to settle, then plan again." });
    }
    return refusal("Nothing was sent.");
  }
}

function refusal(why: string): Outcome {
  return { ok: false, sent: false, refused: why };
}
