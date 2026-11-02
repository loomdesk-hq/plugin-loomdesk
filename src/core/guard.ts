// What a plan may do, checked here before anything is signed: whatever LoomDesk's server answers, the wallet only
// calls LoomDesk's own contracts (contracts.ts) with the calls in abis.ts, approves only them, pays only itself,
// credits only the referrer configured, and sends no more than was asked. A plan that fails any of it is refused whole.
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, parseAbi, parseAbiParameters, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { erc20Abi, ladderAbi, openHookAbi, permit2Abi, pilotGasAbi, priceSetterAbi, zapAbi } from "./abis.js";
import type { Plan } from "./api.js";
import { CHAIN_ID } from "./chain.js";
import { OPENING_HOOKS, WETH } from "./contracts.js";

export class GuardError extends Error {}

export type Role = "ladder" | "zap" | "pilot" | "openHook" | "setter" | "router" | "permit2";

/** A transaction that passed: the plan's own bytes, and the call they decode to (a wallet that sends by ABI encodes
 *  the very same bytes from it; for the router there is none, its route is opaque). */
export type CheckedTx = { step: string; to: Address; data: Hex; value: bigint; gas?: bigint; call?: { abi: Abi; functionName: string; args: readonly unknown[] } };

export type Rules = {
  owner: Address;
  /** the referrer configured: a ladder's credit names it or no one */
  referrer?: Address;
  /** the contracts this plan may call, lower case, with what each is */
  targets: Map<string, Role>;
  /** who an approval may name, lower case */
  spenders: Set<string>;
  /** the most each token may be approved for (raw units), lower case; a token not here is never approved */
  approve: Map<string, bigint>;
  /** the most ETH the plan may send, all its transactions together */
  eth: bigint;
  /** a build pays exactly this into the zap */
  build?: { payIn: Address; amountIn: bigint };
};

const ABI_OF: Record<Exclude<Role, "router">, Abi> = { ladder: ladderAbi as Abi, zap: zapAbi as Abi, pilot: pilotGasAbi as Abi, openHook: openHookAbi as Abi, setter: priceSetterAbi as Abi, permit2: permit2Abi as Abi };

// --- the Universal Router, command by command -------------------------------------------------------------------
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const NATIVE = zeroAddress as string;
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable", "function execute(bytes commands, bytes[] inputs) payable"]);
const CMD = { V3_SWAP_EXACT_IN: 0x00, PERMIT2_TRANSFER_FROM: 0x02, SWEEP: 0x04, V2_SWAP_EXACT_IN: 0x08, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, BALANCE_CHECK_ERC20: 0x0e, V4_SWAP: 0x10 } as const;
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const;
const L = {
  v3: parseAbiParameters("address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser, uint256[] minHopPriceX36"),
  v2: parseAbiParameters("address recipient, uint256 amountIn, uint256 amountOutMin, address[] path, bool payerIsUser, uint256[] minHopPriceX36"),
  wrap: parseAbiParameters("address recipient, uint256 amount"),
  unwrap: parseAbiParameters("address recipient, uint256 amountMin"),
  sweep: parseAbiParameters("address token, address recipient, uint256 amountMin"),
  pull: parseAbiParameters("address token, address recipient, uint160 amount"),
  v4: parseAbiParameters("bytes actions, bytes[] params"),
  take: parseAbiParameters("address currency, address recipient, uint256 amount"),
  settle: parseAbiParameters("address currency, uint256 amount"),
  permit: [{ type: "tuple", components: [{ name: "details", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }] }, { type: "bytes" }] as const,
};
/** Why a router execute pays anyone but the wallet, leaves anything in the router, or runs a command LoomDesk's swaps
 *  never use (Hey Research Lab, 2026-11-02: the route was sent undecoded before). Commands are read with the router's
 *  own mask (0x7f); whatever is routed to the router itself must leave it by the end, swept or unwrapped to the wallet,
 *  since the router keeps no balances and anyone sweeps what is left; ETH sent must be spent inside (a wrap, a v4
 *  settle); a permit inside names only the router. Undefined when the execute is clean. */
export function routerProblem(data: Hex, value: bigint, owner: Address, router: Address): string | undefined {
  let commands: Hex, inputs: readonly Hex[];
  try { const d = decodeFunctionData({ abi: routerAbi, data }); commands = d.args[0] as Hex; inputs = d.args[1] as readonly Hex[]; } catch { return "a call to the swap router that cannot be read"; }
  const bytes = commands.slice(2).match(/.{2}/g) ?? [];
  if (bytes.length !== inputs.length) return "a swap whose commands and inputs do not match";
  const low = (a: string) => a.toLowerCase();
  const ok = (a: string) => { const x = low(a); return x === MSG_SENDER || x === ADDRESS_THIS || x === low(owner); };
  const toRouter = (a: string) => low(a) === ADDRESS_THIS;
  const held = new Set<string>();
  let spentValue = value === 0n;
  const v3Ends = (path: Hex): [string, string] | undefined => { const h = path.slice(2); return h.length >= 86 ? [low(`0x${h.slice(0, 40)}`), low(`0x${h.slice(h.length - 40)}`)] : undefined; };
  for (const [i, b] of bytes.entries()) {
    const byte = parseInt(b, 16);
    if (byte & 0x80) return `command ${i + 1} is allowed to revert, which LoomDesk's swaps never are`;
    const cmd = byte & 0x7f;
    const input = inputs[i];
    try {
      switch (cmd) {
        case CMD.V3_SWAP_EXACT_IN: { const [r, , , path, payerIsUser] = decodeAbiParameters(L.v3, input); if (!ok(r)) return `a swap leg pays ${r}`; const ends = v3Ends(path as Hex); if (!ends) return "a v3 swap leg whose path cannot be read"; if (!payerIsUser) held.delete(ends[0]); if (toRouter(r)) held.add(ends[1]); break; }
        case CMD.V2_SWAP_EXACT_IN: { const [r, , , path, payerIsUser] = decodeAbiParameters(L.v2, input); if (!ok(r)) return `a swap leg pays ${r}`; const p = path as readonly string[]; if (p.length < 2) return "a v2 swap leg whose path cannot be read"; if (!payerIsUser) held.delete(low(p[0])); if (toRouter(r)) held.add(low(p[p.length - 1])); break; }
        case CMD.WRAP_ETH: { const [r] = decodeAbiParameters(L.wrap, input); if (!ok(r)) return `wrapping pays ${r}`; spentValue = true; if (toRouter(r)) held.add(low(WETH)); break; }
        case CMD.UNWRAP_WETH: { const [r] = decodeAbiParameters(L.unwrap, input); if (!ok(r)) return `unwrapping pays ${r}`; held.delete(low(WETH)); if (toRouter(r)) held.add(NATIVE); break; }
        case CMD.SWEEP: { const [token, r] = decodeAbiParameters(L.sweep, input); if (!ok(r)) return `the sweep pays ${r}`; if (!toRouter(r)) held.delete(low(token)); break; }
        case CMD.PERMIT2_TRANSFER_FROM: { const [token, r] = decodeAbiParameters(L.pull, input); if (!ok(r)) return `the swap pulls your tokens to ${r}`; if (toRouter(r)) held.add(low(token)); break; }
        case CMD.BALANCE_CHECK_ERC20: break;
        case CMD.PERMIT2_PERMIT: { const [p] = decodeAbiParameters(L.permit, input); const s = (p as { spender: string }).spender; if (low(s) !== low(router)) return `the permit names ${s} as spender, not the router`; break; }
        case CMD.V4_SWAP: {
          const [actions, params] = decodeAbiParameters(L.v4, input);
          const acts = (actions as Hex).slice(2).match(/.{2}/g) ?? [];
          const ps = params as readonly Hex[];
          if (acts.length !== ps.length) return "a v4 swap whose actions and params do not match";
          for (const [j, a] of acts.entries()) {
            const act = parseInt(a, 16);
            if (act === ACT.TAKE) { const [cur, r] = decodeAbiParameters(L.take, ps[j]); if (!ok(r)) return `a v4 take pays ${r}`; if (toRouter(r)) held.add(low(cur)); else held.delete(low(cur)); }
            else if (act === ACT.SETTLE || act === ACT.SETTLE_ALL) { const [cur] = decodeAbiParameters(L.settle, ps[j]); if (low(cur) === NATIVE) spentValue = true; held.delete(low(cur)); }
            else if (act === ACT.TAKE_ALL) { const [cur] = decodeAbiParameters(L.settle, ps[j]); held.delete(low(cur)); }
            else if (![ACT.SWAP_EXACT_IN_SINGLE, ACT.SWAP_EXACT_IN].includes(act as never)) return `a v4 action LoomDesk's swaps never use (0x${a})`;
          }
          break;
        }
        default: return `a router command LoomDesk's swaps never use (0x${b})`;
      }
    } catch { return `a router command that cannot be read (0x${b})`; }
  }
  if (!spentValue) return "a swap sent with ETH that nothing in it spends (no wrap, no v4 settle): it would stay in the router for anyone to sweep";
  if (held.size) return `a swap that leaves ${[...held].map((c) => (c === NATIVE ? "ETH" : c === low(WETH) ? "WETH" : c)).join(" and ")} in the router, where anyone can sweep it`;
  return undefined;
}
/** Calls that pay out of a ladder: the recipient (second argument) must be the owner. */
const PAYS_OUT = new Set(["close", "closePart", "collect", "withdraw"]);
/** Calls that take no ETH. */
const NO_VALUE = new Set(["close", "closePart", "collect", "withdraw", "setAuto", "setPrice", "approve"]);

const APPROVE = "0x095ea7b3";
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

function decode(abi: Abi, data: Hex, at: string) {
  let d: { functionName: string; args?: readonly unknown[] };
  try {
    d = decodeFunctionData({ abi, data }) as typeof d;
  } catch {
    throw new GuardError(`${at} is a call this plugin does not know. Nothing was sent; a newer plugin may know it.`);
  }
  const args = d.args ?? [];
  // the bytes must be exactly that call: nothing appended that a wallet sending raw data would pass along
  if (encodeFunctionData({ abi, functionName: d.functionName, args } as never).toLowerCase() !== data.toLowerCase()) throw new GuardError(`${at} carries bytes that are not part of its call. Nothing was sent.`);
  return { functionName: d.functionName, args };
}

function credit(args: readonly unknown[], rules: Rules, at: string) {
  const c = args[args.length - 1] as { referrer?: string } | undefined;
  const ref = c?.referrer ?? zeroAddress;
  if (!same(ref, zeroAddress) && !(rules.referrer && same(ref, rules.referrer))) throw new GuardError(`${at} credits referrer ${ref}, not the one configured. Nothing was sent.`);
}

/** The plan's transactions, each checked against the rules, in order. Throws GuardError at the first that breaks one. */
export function vetPlan(plan: Plan, rules: Rules): CheckedTx[] {
  if (plan.chainId !== undefined && Number(plan.chainId) !== CHAIN_ID) throw new GuardError(`The plan is for chain ${plan.chainId}, not Robinhood Chain (${CHAIN_ID}). Nothing was sent.`);
  const txs = plan.transactions ?? [];
  const out: CheckedTx[] = [];
  let total = 0n;
  txs.forEach((tx, i) => {
    const at = `Step ${i + 1} (${String(tx.step ?? "").slice(0, 80)})`;
    if (typeof tx.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new GuardError(`${at} has no address to send to.`);
    if (typeof tx.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data)) throw new GuardError(`${at} has no call data.`);
    if (!/^\d+$/.test(String(tx.value ?? "0"))) throw new GuardError(`${at} has a value that is not a number of wei.`);
    const to = getAddress(tx.to) as Address;
    const data = tx.data as Hex;
    const value = BigInt(tx.value || "0");
    const gas = tx.gas && /^\d+$/.test(tx.gas) ? BigInt(tx.gas) : undefined;
    total += value;
    const role = rules.targets.get(to.toLowerCase());

    if (role === "router") {
      const why = routerProblem(data, value, rules.owner, to);
      if (why) throw new GuardError(`${at} is ${why}. Nothing was sent.`);
      out.push({ step: tx.step, to, data, value, gas });
      return;
    }
    if (!role) {
      // anything else may only be a token approval, of a token and an amount the ask allows, for a LoomDesk spender
      if (data.slice(0, 10).toLowerCase() !== APPROVE) throw new GuardError(`${at} goes to ${to}, which is not a LoomDesk contract this plan may use. Nothing was sent.`);
      const d = decode(erc20Abi as Abi, data, at);
      const [spender, amount] = d.args as readonly [Address, bigint];
      if (!rules.spenders.has(spender.toLowerCase())) throw new GuardError(`${at} approves ${spender}, which is not a LoomDesk contract. Nothing was sent.`);
      const most = rules.approve.get(to.toLowerCase());
      if (most === undefined) throw new GuardError(`${at} approves a token (${to}) this ask does not spend. Nothing was sent.`);
      if (amount > most) throw new GuardError(`${at} approves more than was asked for. Nothing was sent.`);
      if (value !== 0n) throw new GuardError(`${at} sends ETH with an approval. Nothing was sent.`);
      out.push({ step: tx.step, to, data, value, gas, call: { abi: erc20Abi as Abi, functionName: "approve", args: d.args } });
      return;
    }

    const abi = ABI_OF[role];
    const d = decode(abi, data, at);
    const fn = d.functionName;
    if (role === "permit2") {
      // the allowance Permit2 gives the router: the token and amount the ask swaps, the router as the only spender
      if (fn !== "approve") throw new GuardError(`${at} calls Permit2's ${fn}, which a swap never does. Nothing was sent.`);
      const [token, spender, amount] = d.args as readonly [Address, Address, bigint, number];
      if (rules.targets.get(spender.toLowerCase()) !== "router") throw new GuardError(`${at} lets ${spender} pull through Permit2, which is not the swap's router. Nothing was sent.`);
      const most = rules.approve.get(token.toLowerCase());
      if (most === undefined) throw new GuardError(`${at} lets the router pull a token (${token}) this ask does not swap. Nothing was sent.`);
      if (amount > most) throw new GuardError(`${at} lets the router pull more than was asked for. Nothing was sent.`);
      if (value !== 0n) throw new GuardError(`${at} sends ETH with a Permit2 approval. Nothing was sent.`);
      out.push({ step: tx.step, to, data, value, gas, call: { abi, functionName: fn, args: d.args } });
      return;
    }
    if (NO_VALUE.has(fn) && value !== 0n) throw new GuardError(`${at} sends ETH with ${fn}, which takes none. Nothing was sent.`);
    if (role === "ladder") {
      if (PAYS_OUT.has(fn) && !same(d.args[1], rules.owner)) throw new GuardError(`${at} pays ${String(d.args[1])}, not this wallet. Nothing was sent.`);
      if (fn === "openV4For" || fn === "openV3For") {
        if (!same(d.args[0], rules.owner)) throw new GuardError(`${at} opens the ladder for ${String(d.args[0])}, not this wallet. Nothing was sent.`);
        credit(d.args, rules, at);
      }
    } else if (role === "zap") {
      if (fn === "zapBuild") {
        if (!rules.build) throw new GuardError(`${at} is a one-asset build, which this ask is not. Nothing was sent.`);
        const [payIn, amountIn] = d.args as readonly [Address, bigint];
        if (!same(payIn, rules.build.payIn) || amountIn !== rules.build.amountIn) throw new GuardError(`${at} pays in something other than what was asked. Nothing was sent.`);
        if (value !== (same(payIn, zeroAddress) ? amountIn : 0n)) throw new GuardError(`${at} sends ${value} wei, not what the build pays. Nothing was sent.`);
        const opening = d.args[3] as { hook?: string };
        if (!OPENING_HOOKS.some((h) => same(opening?.hook, h))) throw new GuardError(`${at} opens a pool on ${String(opening?.hook)}, which is not a LoomDesk hook. Nothing was sent.`);
      }
      credit(d.args, rules, at);
    }
    out.push({ step: tx.step, to, data, value, gas, call: { abi, functionName: fn, args: d.args } });
  });
  if (total > rules.eth) throw new GuardError(`The plan sends ${total} wei of ETH, more than the ${rules.eth} this ask allows. Nothing was sent.`);
  return out;
}

/** The four bytes a failed call reverted with, from an error's revert data (never from its text, where an address
 *  would pass for one), else from viem's "reverted with the following signature" line; undefined when there is none. */
export function revertSelector(e: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number): Hex | undefined => {
    if (!x || typeof x !== "object" || seen.has(x) || depth > 8) return undefined;
    seen.add(x);
    const o = x as Record<string, unknown>;
    for (const k of ["raw", "signature", "data"]) {
      const v = o[k];
      if (typeof v === "string" && /^0x[0-9a-fA-F]{8}/.test(v)) return v.slice(0, 10).toLowerCase() as Hex;
    }
    for (const k of ["cause", "error", "data"]) {
      const r = walk(o[k], depth + 1);
      if (r) return r;
    }
    return undefined;
  };
  const found = walk(e, 0);
  if (found) return found;
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const m = /following signature:?\s*(0x[0-9a-fA-F]{8})\b/.exec(text);
  return m ? (m[1].toLowerCase() as Hex) : undefined;
}

/** What a revert means, in the plan's own words (its ifItReverts, by selector). */
export function reasonOf(selector: string | undefined, ifItReverts: Record<string, string> | undefined): string | undefined {
  if (!selector) return undefined;
  const said = ifItReverts?.[selector.toLowerCase()];
  return said ? said : `it reverted with ${selector}`;
}
