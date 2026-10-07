// Copied from core/test/core.suite.mjs by scripts/sync-core.mjs. Edit it there, then run npm run sync at the repo root.
// The sending rules, tested the same way in every package against its own build of the shared code: LoomDesk's API
// is a fake fetch that answers with plans made here, and the wallet is a fake Sender that records what it was asked
// to send. Nothing touches a network or a chain.
import { encodeFunctionData, parseEther, parseUnits, zeroAddress } from "viem";

export const OWNER = "0x1111111111111111111111111111111111111111";
export const REFERRER = "0x2222222222222222222222222222222222222222";
export const STRANGER = "0x3333333333333333333333333333333333333333";
export const TOKEN = "0x4444444444444444444444444444444444444444";
export const KEY = `ldk_f_${"a".repeat(32)}_${"b".repeat(32)}`;
const POOL_ID = `0x${"5".repeat(64)}`;
const TOO_LITTLE = "0x0be75048";

/** A fake LoomDesk: `plans` answers POST /api/agent/ladder in order (a function gets the body), `gets` answers GETs
 *  by path prefix. Every request is recorded. */
export function fakeApi({ plans = [], gets = {}, status } = {}) {
  const calls = [];
  const queue = [...plans];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: u.pathname + u.search, body, headers: init.headers ?? {} });
    const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...h } });
    if (status) { const r = status(calls.length); if (r) return json(r.body ?? { error: "x" }, r.status, r.headers); }
    if (!body) {
      const hit = Object.keys(gets).find((p) => u.pathname.startsWith(p));
      if (u.pathname === "/llms.txt") return new Response(gets["/llms.txt"] ?? "", { status: 200 });
      return hit ? json(gets[hit]) : json({ error: "not found" }, 404);
    }
    if (body.plan === "pools" && gets.pools) return json(gets.pools);
    const next = queue.shift();
    if (!next) return json({ error: "no plan queued" }, 500);
    return json(typeof next === "function" ? next(body) : next);
  };
  return { fetch: f, calls, plansAsked: () => calls.filter((c) => c.body && c.body.plan !== "pools") };
}

/** A fake wallet on Robinhood Chain. `revert(i)` makes the i-th send (0 based) revert with TooLittleOut. */
export function fakeSender({ address = OWNER, chain = 4663, balance = parseEther("1"), decimals = 18, revert = () => false } = {}) {
  const sent = [];
  return {
    sent,
    address,
    chainId: async () => chain,
    balance: async () => balance,
    decimals: async () => decimals,
    send: async (tx) => {
      const i = sent.length;
      sent.push(tx);
      const hash = `0x${String(i + 1).padStart(64, "0")}`;
      return revert(i) ? { hash, status: "reverted", revert: TOO_LITTLE } : { hash, status: "success" };
    },
  };
}

const ok = (extra = {}) => ({ simulated: true, ok: true, simulatedAt: new Date().toISOString(), block: "1", gasEthAtMost: "0.0001", ...extra });
const ifItReverts = { [TOO_LITTLE]: "TooLittleOut: the price moved past the slippage. Plan again and send at once." };
const key = { currency0: zeroAddress, currency1: TOKEN, fee: 0x800000, tickSpacing: 200, hooks: "0x809397880B3A31C4E88cf6Aba367a45509e320CC" };
const noKey = { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress };

export function zapBuildTx(core, { payIn = zeroAddress, amount = parseEther("0.01"), value, referrer = REFERRER, hook = zeroAddress, to = core.LOOMDESK.zap } = {}) {
  const data = encodeFunctionData({ abi: core.zapAbi, functionName: "zapBuild", args: [payIn, amount, [], { hook, token: zeroAddress, quote: zeroAddress, fee: 0, sqrtPriceX96: 0n, refKey: noKey }, key, [{ tickLower: -600, tickUpper: 600, weight: 1000000 }], 9999999999n, "0x", { referrer, copyOf: 0n }] });
  return { step: "ETH in: build the ladder", to, data, value: String(value ?? (payIn === zeroAddress ? amount : 0n)), gas: "900000" };
}
export const approveTx = (core, token, spender, amount) => ({ step: "approve", to: token, data: encodeFunctionData({ abi: core.erc20Abi, functionName: "approve", args: [spender, amount] }), value: "0", gas: "80000" });
const closeTx = (core, contract, to = OWNER) => ({ step: "close the ladder", to: contract, data: encodeFunctionData({ abi: core.ladderAbi, functionName: "close", args: [7n, to, 1n, 1n, 9999999999n, "0x"] }), value: "0", gas: "700000" });
const openV4Tx = (core, owner = OWNER, referrer = REFERRER) => ({ step: "open the ladder", to: core.LOOMDESK.ladder, data: encodeFunctionData({ abi: core.ladderAbi, functionName: "openV4For", args: [owner, key, [{ tickLower: -600, tickUpper: 0, amount0: 0n, amount1: 5n }], 1n, 2n ** 150n, 9999999999n, "0x", { referrer, copyOf: 0n }] }), value: "0", gas: "800000" });
const createPoolTx = (core, value = parseEther("0.0004")) => ({ step: "open the pool", to: core.LOOMDESK.openHook, data: encodeFunctionData({ abi: core.openHookAbi, functionName: "createPool", args: [TOKEN, zeroAddress, 10000, 2n ** 96n, noKey] }), value: String(value), gas: "500000" });

const buildPlan = (core, txs, check = ok()) => ({ chainId: 4663, pair: "TKN/ETH", transactions: txs, check, sendWithin: "at once", ifItReverts });

export function coreSuite(test, assert, core) {
  const desk = (api, o = {}) => new core.LoomDesk({ fetch: api.fetch, referrer: REFERRER, client: "loomdesk-test/0", ...o });
  const build = { token: TOKEN, payIn: "ETH", amount: "0.01", quote: "ETH" };

  test("a checked build is sent in order with its gas, owner and referrer from the configuration", async () => {
    const api = fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)])] });
    const s = fakeSender();
    const out = await desk(api, { apiKey: KEY }).build(s, build);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].gas, 900000n);
    assert.equal(s.sent[0].value, parseEther("0.01"));
    const req = api.plansAsked()[0];
    assert.equal(req.body.owner, OWNER);
    assert.equal(req.body.referrer.toLowerCase(), REFERRER.toLowerCase());
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers["user-agent"], "loomdesk-test/0");
    assert.match(out.transactions[0].explorer, /blockscout/);
    assert.equal(out.plan.steps.length, 1);
    assert.equal(out.plan.transactions, undefined);
  });

  test("no key: no authorization header; a malformed key is refused at startup", async () => {
    const api = fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)])] });
    await desk(api).build(fakeSender(), build);
    assert.equal(api.plansAsked()[0].headers.authorization, undefined);
    assert.throws(() => desk(api, { apiKey: "sk-not-ours" }), /not a LoomDesk key/);
  });

  test("a build with neither pool nor quote goes in the token's first v4 pool", async () => {
    const api = fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)])], gets: { pools: { pools: [{ pool: "0xv3", version: 3 }, { pool: POOL_ID, version: 4 }] } } });
    await desk(api).build(fakeSender(), { token: TOKEN, payIn: "ETH", amount: "0.01" });
    assert.equal(api.plansAsked()[0].body.pool, POOL_ID);
  });

  test("refused, nothing sent: a transaction to a contract that is not LoomDesk's", async () => {
    const s = fakeSender();
    const out = await desk(fakeApi({ plans: [buildPlan(core, [zapBuildTx(core, { to: STRANGER })])] })).build(s, build);
    assert.equal(out.ok, false);
    assert.match(out.refused, /not a LoomDesk contract|does not know/);
    assert.equal(s.sent.length, 0);
  });

  test("refused: more ETH than asked, the wrong referrer, a foreign opening hook, bytes appended", async () => {
    const bad = [
      [zapBuildTx(core, { value: parseEther("0.02") }), /sends|ETH/],
      [zapBuildTx(core, { amount: parseEther("0.02") }), /other than what was asked/],
      [zapBuildTx(core, { referrer: STRANGER }), /referrer/],
      [zapBuildTx(core, { hook: STRANGER }), /not a LoomDesk hook/],
      [{ ...zapBuildTx(core), data: `${zapBuildTx(core).data}00000000` }, /not part of its call|does not know/],
    ];
    for (const [tx, why] of bad) {
      const s = fakeSender();
      const out = await desk(fakeApi({ plans: [buildPlan(core, [tx])] })).build(s, build);
      assert.equal(out.ok, false);
      assert.match(out.refused, why);
      assert.equal(s.sent.length, 0);
    }
  });

  test("a referrer of nobody is fine (the server names none for a wallet already active)", async () => {
    const s = fakeSender();
    const out = await desk(fakeApi({ plans: [buildPlan(core, [zapBuildTx(core, { referrer: zeroAddress })])] })).build(s, build);
    assert.equal(out.ok, true, JSON.stringify(out));
  });

  test("USDG: the approval goes to the zap for no more than asked; a stranger or more is refused", async () => {
    const amt = parseUnits("25", 6);
    const usdg = { token: TOKEN, payIn: "USDG", amount: "25", quote: "USDG" };
    const good = [approveTx(core, core.USDG, core.LOOMDESK.zap, amt), zapBuildTx(core, { payIn: core.USDG, amount: amt })];
    const s = fakeSender();
    assert.equal((await desk(fakeApi({ plans: [buildPlan(core, good)] })).build(s, usdg)).ok, true);
    assert.equal(s.sent.length, 2);
    for (const first of [approveTx(core, core.USDG, STRANGER, amt), approveTx(core, core.USDG, core.LOOMDESK.zap, amt + 1n)]) {
      const s2 = fakeSender();
      const out = await desk(fakeApi({ plans: [buildPlan(core, [first, good[1]])] })).build(s2, usdg);
      assert.equal(out.ok, false);
      assert.equal(s2.sent.length, 0);
    }
  });

  test("check.ok false: refused with LoomDesk's reason, nothing sent", async () => {
    const s = fakeSender();
    const out = await desk(fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)], { simulated: true, ok: false, failedStep: 1, reason: "NothingToBuild: too small" })] })).build(s, build);
    assert.equal(out.ok, false);
    assert.match(out.refused, /NothingToBuild/);
    assert.equal(s.sent.length, 0);
  });

  test("check.simulated false: planned again once; sent when the second is checked, refused when it is not", async () => {
    const notTried = buildPlan(core, [zapBuildTx(core)], { simulated: false, note: "node busy" });
    let api = fakeApi({ plans: [notTried, buildPlan(core, [zapBuildTx(core)])] });
    let s = fakeSender();
    let out = await desk(api).build(s, build);
    assert.equal(out.ok, true);
    assert.equal(api.plansAsked().length, 2);
    assert.match(out.replanned, /could not simulate/);
    api = fakeApi({ plans: [notTried, notTried] });
    s = fakeSender();
    out = await desk(api).build(s, build);
    assert.equal(out.ok, false);
    assert.equal(api.plansAsked().length, 2);
    assert.equal(s.sent.length, 0);
  });

  test("a plan that waits for a pool to be opened is not sent", async () => {
    const s = fakeSender();
    const plan = { ...buildPlan(core, [openV4Tx(core)], { simulated: false }), opensFirst: "send the opening first" };
    const out = await desk(fakeApi({ plans: [plan] })).ladder(s, { token: TOKEN, lowPct: -20, highPct: 20, amountQuote: "0.01" });
    assert.equal(out.ok, false);
    assert.match(out.refused, /opening first/);
    assert.equal(s.sent.length, 0);
  });

  test("a revert is read in ifItReverts and planned again once; twice stops", async () => {
    let s = fakeSender({ revert: (i) => i === 0 });
    let api = fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)]), buildPlan(core, [zapBuildTx(core)])] });
    let out = await desk(api).build(s, build);
    assert.equal(out.ok, true);
    assert.match(out.replanned, /TooLittleOut/);
    assert.equal(s.sent.length, 2);
    assert.equal(out.transactions.length, 2);
    s = fakeSender({ revert: () => true });
    api = fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)]), buildPlan(core, [zapBuildTx(core)])] });
    out = await desk(api).build(s, build);
    assert.equal(out.ok, false);
    assert.match(out.reverted.reason, /TooLittleOut/);
    assert.equal(api.plansAsked().length, 2);
  });

  test("a wallet that throws on a call that would revert counts it as a revert", async () => {
    let n = 0;
    const s = { ...fakeSender(), send: async () => { if (n++ === 0) { const e = new Error("execution reverted"); e.cause = { data: `${TOO_LITTLE}` }; throw e; } return { hash: `0x${"9".repeat(64)}`, status: "success" }; } };
    const out = await desk(fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)]), buildPlan(core, [zapBuildTx(core)])] })).build(s, build);
    assert.equal(out.ok, true);
    assert.match(out.replanned, /TooLittleOut/);
  });

  test("spending cap and budget: over either, refused before LoomDesk is asked", async () => {
    let api = fakeApi({ plans: [] });
    let out = await desk(api, { spendCap: { ETH: "0.005" } }).build(fakeSender(), build);
    assert.equal(out.ok, false);
    assert.match(out.refused, /limit/);
    assert.equal(api.calls.length, 0);
    api = fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)]), buildPlan(core, [zapBuildTx(core)])] });
    const d = desk(api, { budget: { ETH: "0.015" } });
    assert.equal((await d.build(fakeSender(), build)).ok, true);
    out = await d.build(fakeSender(), build);
    assert.equal(out.ok, false);
    assert.match(out.refused, /budget/);
    assert.equal(api.plansAsked().length, 1);
  });

  test("dry run: planned and checked, nothing sent", async () => {
    const s = fakeSender();
    const out = await desk(fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)])] })).build(s, { ...build, dryRun: true });
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.equal(out.plan.check.ok, true);
    assert.equal(s.sent.length, 0);
  });

  test("a wallet short of ETH or on another chain sends nothing", async () => {
    let s = fakeSender({ balance: parseEther("0.001") });
    let out = await desk(fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)])] })).build(s, build);
    assert.match(out.refused, /holds/);
    assert.equal(s.sent.length, 0);
    s = fakeSender({ chain: 1 });
    const api = fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)])] });
    out = await desk(api).build(s, build);
    assert.match(out.refused, /chain 1/);
    assert.equal(api.calls.length, 0);
    out = await desk(fakeApi({ plans: [{ ...buildPlan(core, [zapBuildTx(core)]), chainId: 1 }] })).build(fakeSender(), build);
    assert.match(out.refused, /chain 1/);
  });

  test("close: only to the ladder named, paying this wallet; an unknown ladder is not even planned", async () => {
    const legacy = core.LOOMDESK.ladderLegacy[0];
    let s = fakeSender();
    let out = await desk(fakeApi({ plans: [{ transactions: [closeTx(core, legacy)], check: ok(), ifItReverts }] })).action(s, { ladderId: "7", contract: legacy, action: "close" });
    assert.equal(out.ok, true, JSON.stringify(out));
    s = fakeSender();
    out = await desk(fakeApi({ plans: [{ transactions: [closeTx(core, legacy, STRANGER)], check: ok() }] })).action(s, { ladderId: "7", contract: legacy, action: "close" });
    assert.match(out.refused, /pays/);
    assert.equal(s.sent.length, 0);
    s = fakeSender();
    out = await desk(fakeApi({ plans: [{ transactions: [closeTx(core, core.LOOMDESK.ladder)], check: ok() }] })).action(s, { ladderId: "7", contract: legacy, action: "close" });
    assert.match(out.refused, /not a LoomDesk contract/);
    const api = fakeApi({ plans: [] });
    out = await desk(api).action(fakeSender(), { ladderId: "7", contract: STRANGER, action: "close" });
    assert.match(out.refused, /not a LoomLadder/);
    assert.equal(api.calls.length, 0);
    out = await desk(fakeApi({ plans: [{ transactions: [closeTx(core, STRANGER)], check: ok() }] }), { extraLadderContracts: [STRANGER] }).action(fakeSender(), { ladderId: "7", contract: STRANGER, action: "close" });
    assert.equal(out.ok, true);
  });

  test("ladder: approvals of the token and the quote for no more than asked, opened for this wallet", async () => {
    const plan = (txs) => ({ chainId: 4663, pool: { pool: POOL_ID, quoteAddress: core.USDG }, transactions: txs, check: ok(), ifItReverts });
    const ask = { token: TOKEN, lowPct: -20, highPct: 20, amountToken: "100", amountQuote: "10" };
    const good = [approveTx(core, TOKEN, core.LOOMDESK.ladder, parseUnits("100", 18)), approveTx(core, core.USDG, core.LOOMDESK.ladder, parseUnits("10", 6)), openV4Tx(core)];
    let s = fakeSender();
    assert.equal((await desk(fakeApi({ plans: [plan(good)] })).ladder(s, ask)).ok, true);
    assert.equal(s.sent.length, 3);
    for (const txs of [[approveTx(core, TOKEN, core.LOOMDESK.ladder, parseUnits("101", 18)), good[2]], [approveTx(core, STRANGER, core.LOOMDESK.ladder, 1n), good[2]], [openV4Tx(core, STRANGER)], [openV4Tx(core, OWNER, STRANGER)]]) {
      s = fakeSender();
      const out = await desk(fakeApi({ plans: [plan(txs)] })).ladder(s, ask);
      assert.equal(out.ok, false, JSON.stringify(txs.map((t) => t.step)));
      assert.equal(s.sent.length, 0);
    }
  });

  test("ladder in a new pool: the opening is sent first, then the ladder is planned in it", async () => {
    const api = fakeApi({ plans: [
      { chainId: 4663, pool: POOL_ID, transactions: [createPoolTx(core)], check: ok() },
      (body) => ({ chainId: 4663, pool: { pool: body.pool, quoteAddress: zeroAddress }, transactions: [openV4Tx(core)], check: ok() }),
    ] });
    const s = fakeSender();
    const out = await desk(api).ladder(s, { token: TOKEN, lowPct: -20, highPct: 0, amountQuote: "0.01", openPool: { quote: "ETH", feePct: 1 } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(s.sent.length, 2);
    const asked = api.plansAsked();
    assert.equal(asked[0].body.plan, "open_pool");
    assert.equal(asked[1].body.plan, "ladder");
    assert.equal(asked[1].body.pool, POOL_ID);
    assert.equal(asked[1].body.newPool, undefined);
  });

  test("open pool: the fee is capped; a pool that exists sends nothing", async () => {
    let s = fakeSender();
    let out = await desk(fakeApi({ plans: [{ chainId: 4663, pool: POOL_ID, transactions: [createPoolTx(core, parseEther("0.01"))], check: ok() }] })).openPool(s, { token: TOKEN, quote: "ETH", feePct: 1 });
    assert.equal(out.ok, false);
    assert.equal(s.sent.length, 0);
    out = await desk(fakeApi({ plans: [{ alreadyOpen: true, pool: POOL_ID, note: "exists" }] })).openPool(fakeSender(), { token: TOKEN, quote: "ETH", feePct: 1 });
    assert.equal(out.ok, true);
    assert.equal(out.alreadyOpen, true);
  });

  test("swap: only through the router LoomDesk's zap uses, approving it for no more than asked", async () => {
    const router = core.KNOWN_ROUTERS[0];
    const plan = (r, txs) => ({ chainId: 4663, router: r, from: { address: core.USDG, symbol: "USDG", decimals: 6 }, transactions: txs, check: ok(), ifItReverts });
    const route = (to) => ({ step: "swap", to, data: "0x12345678", value: "0", gas: "400000" });
    let s = fakeSender();
    let out = await desk(fakeApi({ plans: [plan(router, [approveTx(core, core.USDG, router, parseUnits("5", 6)), route(router)])] })).swap(s, { from: "USDG", to: "ETH", amount: "5" });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(s.sent.length, 2);
    s = fakeSender();
    out = await desk(fakeApi({ plans: [plan(STRANGER, [route(STRANGER)])] })).swap(s, { from: "USDG", to: "ETH", amount: "5" });
    assert.match(out.refused, /router/);
    assert.equal(s.sent.length, 0);
  });

  test("API: one wait on 429 with a short Retry-After, then the server's words", async () => {
    const api = fakeApi({ plans: [buildPlan(core, [zapBuildTx(core)])], status: (n) => (n === 1 ? { status: 429, headers: { "retry-after": "1" }, body: { error: "slow down" } } : undefined) });
    const out = await desk(api).build(fakeSender(), build);
    assert.equal(out.ok, true);
    assert.equal(api.calls.length, 2);
    const api2 = fakeApi({ status: () => ({ status: 429, headers: { "retry-after": "600" }, body: { error: "Daily quota used." } }) });
    await assert.rejects(desk(api2).build(fakeSender(), build), /Daily quota/);
  });

  test("market: flagged tokens are left out; contracts list compared with llms.txt", async () => {
    const api = fakeApi({ gets: {
      "/api/index/search": { tokens: [{ address: TOKEN, symbol: "OK", tier: "established", volumeUsd: 10.4 }, { address: STRANGER, symbol: "BAD", tier: "flagged" }] },
      "/llms.txt": `# x\n## Contracts (Robinhood Chain, 4663)\n- LoomZap: ${core.LOOMDESK.zap}\n- New thing: ${STRANGER}\n- USDG: ${core.USDG}\n## Documents\n- ${TOKEN}\n`,
    } });
    const m = await desk(api).market({ query: "ok" });
    assert.deepEqual(m.tokens.map((t) => t.symbol), ["OK"]);
    const c = await desk(api).checkContractList();
    assert.deepEqual(c.unknown.map((x) => x.toLowerCase()), [STRANGER]);
  });
}
