// Copied from core/src/guard.ts by scripts/sync-core.mjs. Edit it there, then run npm run sync at the repo root.
// What a plan may do, checked here before anything is signed: whatever LoomDesk's server answers, the wallet only
// calls LoomDesk's own contracts (contracts.ts) with the calls in abis.ts, approves only them, pays only itself,
// credits only the referrer configured, and sends no more than was asked. A plan that fails any of it is refused whole.
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { erc20Abi, ladderAbi, openHookAbi, pilotGasAbi, priceSetterAbi, zapAbi } from "./abis.js";
import type { Plan } from "./api.js";
import { CHAIN_ID } from "./chain.js";
import { OPENING_HOOKS } from "./contracts.js";

export class GuardError extends Error {}

export type Role = "ladder" | "zap" | "pilot" | "openHook" | "setter" | "router";

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

const ABI_OF: Record<Exclude<Role, "router">, Abi> = { ladder: ladderAbi as Abi, zap: zapAbi as Abi, pilot: pilotGasAbi as Abi, openHook: openHookAbi as Abi, setter: priceSetterAbi as Abi };
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
