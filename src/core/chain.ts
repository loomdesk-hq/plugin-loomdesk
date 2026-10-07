// Copied from core/src/chain.ts by scripts/sync-core.mjs. Edit it there, then run npm run sync at the repo root.
import { defineChain } from "viem";

export const CHAIN_ID = 4663;
/** Robinhood Chain's public RPC. Sign and send through it or your own node; LoomDesk's node is not for wallets. */
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

/** Robinhood Chain mainnet. viem 2.55 and later export the same chain as `robinhood` from "viem/chains"; it is defined
 *  here because the agent frameworks pin older viem releases that do not have it. */
export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
  contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } },
});

export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
