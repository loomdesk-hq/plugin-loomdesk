// Copied from core/src/viem-sender.ts by scripts/sync-core.mjs. Edit it there, then run npm run sync at the repo root.
import { publicActions, type Account, type Address, type Chain, type Hex, type Transport, type WalletClient } from "viem";
import { erc20Abi } from "./abis.js";
import { revertSelector, type CheckedTx } from "./guard.js";
import type { Sender, SendResult } from "./loomdesk.js";

/** A Sender for a viem WalletClient with an account (a private key, or any account viem can sign with): sends each
 *  transaction with the gas LoomDesk set and waits for it through the wallet's own RPC. */
export function viemSender(wallet: WalletClient<Transport, Chain | undefined, Account | undefined>): Sender {
  const account = wallet.account;
  if (!account) throw new Error("loomdesk: the wallet client has no account");
  const reader = wallet.extend(publicActions);
  return {
    address: account.address as Address,
    chainId: async () => wallet.chain?.id ?? (await reader.getChainId()),
    balance: () => reader.getBalance({ address: account.address }),
    decimals: async (token) => Number(await reader.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
    async send(tx: CheckedTx): Promise<SendResult> {
      const hash = await wallet.sendTransaction({ account, chain: wallet.chain, to: tx.to, data: tx.data, value: tx.value, ...(tx.gas ? { gas: tx.gas } : {}) } as never);
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status === "success") return { hash, status: "success" };
      return { hash, status: "reverted", revert: await replay(reader, account.address as Address, tx, receipt.blockNumber) };
    },
  };
}

/** Why a mined transaction reverted: the same call replayed on the state just before its block (best effort; another
 *  transaction earlier in that block can make the replay differ). */
export async function replay(reader: { call: (a: never) => Promise<unknown> }, from: Address, tx: CheckedTx, block: bigint): Promise<Hex | undefined> {
  try {
    await reader.call({ account: from, to: tx.to, data: tx.data, value: tx.value, ...(tx.gas ? { gas: tx.gas } : {}), blockNumber: block > 0n ? block - 1n : block } as never);
    return undefined;
  } catch (e) {
    return revertSelector(e);
  }
}
