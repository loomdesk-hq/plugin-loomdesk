// Copied from core/src/contracts.ts by scripts/sync-core.mjs. Edit it there, then run npm run sync at the repo root.
// The contracts a LoomDesk plan may send to, shipped with the plugin rather than read from the server at startup: a
// list the server hands over could be changed by whoever controls the server, so it could not be the check on what the
// server plans. Taken from https://loomdesk.trade/llms.txt ("Contracts (Robinhood Chain, 4663)") on 2026-10-06, with
// the earlier LoomLadder deployments the site still reads and closes. checkContractList() compares this list with the
// live llms.txt and says when a release is due; it never widens what the plugin sends to.
import { getAddress, type Address } from "viem";

const a = (x: string) => getAddress(x) as Address;

export const USDG = a("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const USDG_DECIMALS = 6;
/** WETH on Robinhood Chain (LoomZap.weth()): a WETH-quoted pool can be paid for in plain ETH. */
export const WETH = a("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");

export const LOOMDESK = {
  /** The current LoomLadder: every new ladder and limit order is opened here. */
  ladder: a("0xED7dcF8dFed7e25322809f4958052EabC5219CE4"),
  /** Earlier LoomLadder deployments: paused for new ladders, their ladders still collected and closed. */
  ladderLegacy: [
    "0xf6aA78Bf1524946412c127A7D7817D7803F25c9D", "0x8643E482303380DD4bb188A868d42b11DaA56412", "0x97650654737b410a6e09f3CE974106E2B393b3B2",
    "0x30Eb52b054C7EAd28f52176Ed5Dc9333e91e54a9", "0x970ADc65Ba854a9f0D8f0519959929DEbF2Bc25B", "0xe0218f7894C2493E32D377D002c818AcFc6549B4",
    "0x9042ef3A6d6A6ca03c81C14cc8EFf8065d26d8F2", "0xc9695D87792e3e10571c5cb1A14dd5C9026E4197", "0x751CA878767a71DE33F2beaB10276d76e33a2be1",
    "0xA80Ce686210b06bB9381f0f4C36981202f3d776d", "0x81b5aC3B68609810B99a213b9d7fea79917e7E59", "0x26727ce2767c7da910f8BE1841B1B1Aa58eBA930",
    "0x9f7e85061424A601ce994FD2770c7B252482BA8a", "0x7c4582738756444564369669a1d4DF157661cF42",
  ].map(a),
  /** LoomZap: one asset in, a whole ladder out. No owner, no settings. */
  zap: a("0x269aA9596B1185a038025F08C0f6a9B6637CC01D"),
  /** PilotGas: the gas tank the keeper closes a filled limit order from. */
  pilotGas: a("0x86B5776F64fF26943724C0E5117c0b1b58d15f90"),
  /** LoomOpenHookV2: pools anyone opens, any range. */
  openHook: a("0x809397880B3A31C4E88cf6Aba367a45509e320CC"),
  /** LoomFullHook: full-range pools, fees in the quote. A build may open one inside the zap; no plan calls it. */
  fullHook: a("0x3AD87F5b9cf8F17eD39d787Eef3d9D19053D28Cc"),
  /** PoolPriceSetter: puts an empty pool's price back at the market. Moves no tokens. */
  priceSetter: a("0xE1394FBDFaA0186EDA5a999f4076002179100d2B"),
} as const;

/** The swap router a plan_swap may name: Nordstern's, the same one LoomZap swaps through (LoomZap.router(), fixed). */
export const KNOWN_ROUTERS: Address[] = [a("0x603206D6105217DD972E4Ab30676A220CA393346")];

/** What LoomZap.zapBuild's `opening.hook` may name: nothing, the price setter (an empty pool put back at the market)
 *  or a LoomDesk hook (a pool opened in the same transaction). */
export const OPENING_HOOKS: Address[] = ["0x0000000000000000000000000000000000000000", LOOMDESK.priceSetter, LOOMDESK.openHook, LOOMDESK.fullHook].map(a);

/** A pool's opening fee is about a dollar (0.0004 ETH or 1 USDG); a plan asking for more than this is refused. */
export const OPEN_FEE_MAX = { ETH: "0.002", USDG: "2" } as const;

export const ALL_LADDERS: Address[] = [LOOMDESK.ladder, ...LOOMDESK.ladderLegacy];

/** Every address this plugin knows as LoomDesk's (and USDG and the router), lower case. */
export function knownAddresses(extraLadders: Address[] = []): Set<string> {
  return new Set([...ALL_LADDERS, ...extraLadders, LOOMDESK.zap, LOOMDESK.pilotGas, LOOMDESK.openHook, LOOMDESK.fullHook, LOOMDESK.priceSetter, USDG, ...KNOWN_ROUTERS].map((x) => x.toLowerCase()));
}

/** The addresses in llms.txt's contracts section. */
export function contractsInLlms(text: string): Address[] {
  const start = text.search(/^## Contracts/m);
  if (start < 0) return [];
  const rest = text.slice(start + 3);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  return Array.from(new Set((section.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((x) => x.toLowerCase()))).map(a);
}

/** Named in that section but never a plan's destination: Uniswap's PoolManager, StateView and PositionManager, and
 *  hooks a wallet never calls (the fee hooks, the book's pairs hook, the first open hook and the retired fee hook). */
const NEVER_SENT_TO = new Set([
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b", "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "0x60d31599d69cd9aa6644e6402857c5cbf7d7e0c4", "0x37c86e92a081ae0c1d3ad2ea5b0bb58f56546080", "0xe92bde61abdb4c7bbcfc94554033a74998c928cc",
  "0x49dbd99383649cb4e9a0838166cb3de59aa960cc",
]);

/** Contracts the live llms.txt lists that this release does not know: when there are any, a newer plugin is due. */
export function unknownContracts(live: Address[], extraLadders: Address[] = []): Address[] {
  const known = knownAddresses(extraLadders);
  return live.filter((x) => !known.has(x.toLowerCase()) && !NEVER_SENT_TO.has(x.toLowerCase()));
}
