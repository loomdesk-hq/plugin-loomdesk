// LoomDeskService: one per agent. Holds the LoomDesk client (reads, plans, the sending rules in core/) and the agent's
// own viem wallet on Robinhood Chain. LoomDesk returns unsigned transactions; they are signed here, by the agent's
// key, and sent through the agent's RPC, never LoomDesk's.
import { Service, logger, type IAgentRuntime } from "@elizaos/core";
import { createWalletClient, formatEther, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LoomDesk, robinhoodChain, viemSender, type Sender } from "./core/index.js";
import { readConfig, setting, VERSION, type Config } from "./config.js";
import { LoomDeskMcp } from "./mcp.js";

export class LoomDeskService extends Service {
  static serviceType = "loomdesk";
  capabilityDescription = "LoomDesk on Robinhood Chain: the market, ladder plans from loomdesk.trade, checked, signed and sent from the agent's wallet.";

  cfg!: Config;
  desk!: LoomDesk;
  /** the MCP server: the arena and the reads, with the agent's key */
  mcp!: LoomDeskMcp;
  sender?: Sender;

  static async start(runtime: IAgentRuntime): Promise<LoomDeskService> {
    const s = new LoomDeskService(runtime);
    s.cfg = readConfig(runtime);
    s.desk = new LoomDesk(s.cfg.desk);
    const base = (s.cfg.desk.baseUrl ?? "https://loomdesk.trade").replace(/\/+$/, "");
    s.mcp = new LoomDeskMcp(base, s.cfg.desk.apiKey, `loomdesk-plugin-eliza/${VERSION}`);
    // no key: a free one for this run, so the arena works at once; the operator keeps it to keep the account
    if (!s.mcp.hasKey && !/^(0|false|no)$/i.test(setting(runtime, "LOOMDESK_FREE_KEY") ?? "")) {
      try {
        const key = await s.mcp.freeKey(runtime.character?.name ?? "eliza");
        s.mcp.useKey(key);
        logger.warn(`[loomdesk] no LOOMDESK_API_KEY: took a free key for this run. Set LOOMDESK_API_KEY=${key} to keep this arena account.`);
      } catch (e) {
        logger.warn(`[loomdesk] no key and none to be had (${(e as Error).message}): the arena is off, reads work`);
      }
    }
    if (s.cfg.privateKey) {
      const chain = { ...robinhoodChain, rpcUrls: { default: { http: [s.cfg.rpcUrl] } } };
      s.sender = viemSender(createWalletClient({ account: privateKeyToAccount(s.cfg.privateKey), chain, transport: http(s.cfg.rpcUrl) }));
    }
    logger.info(`[loomdesk] ready${s.sender ? ` for ${s.sender.address}` : " (read-only: no key)"}${s.desk.referrer ? `, referrer ${s.desk.referrer}` : ""}${s.cfg.dryRun ? ", dry run" : ""}`);
    return s;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    await runtime.getService<LoomDeskService>(LoomDeskService.serviceType)?.stop();
  }

  async stop(): Promise<void> {}

  get address(): Address | undefined {
    return this.sender?.address;
  }

  async ethBalance(): Promise<string | undefined> {
    return this.sender ? formatEther(await this.sender.balance()) : undefined;
  }
}

export function serviceOf(runtime: IAgentRuntime): LoomDeskService {
  const s = runtime.getService<LoomDeskService>(LoomDeskService.serviceType);
  if (!s) throw new Error("The LoomDesk service is not running.");
  return s;
}
