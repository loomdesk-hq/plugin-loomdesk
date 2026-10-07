// Settings, and who may make the agent sign.
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { isAddress, type Hex } from "viem";
import { PUBLIC_RPC, type LoomDeskOptions } from "./core/index.js";

export const VERSION = "0.1.0";

/** A setting from the character (secrets, settings) or, failing that, the process environment. */
export function setting(runtime: IAgentRuntime, key: string): string | undefined {
  const v = runtime.getSetting(key);
  if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  const e = typeof process !== "undefined" ? process.env[key] : undefined;
  return e && e.trim() !== "" ? e.trim() : undefined;
}

export type Config = {
  desk: LoomDeskOptions;
  rpcUrl: string;
  privateKey?: Hex;
  dryRun: boolean;
  sendPolicy: "agent" | "operators" | "anyone";
  operators: string[];
};

export function readConfig(runtime: IAgentRuntime): Config {
  const key = setting(runtime, "LOOMDESK_PRIVATE_KEY") ?? setting(runtime, "EVM_PRIVATE_KEY");
  if (key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("LOOMDESK_PRIVATE_KEY (or EVM_PRIVATE_KEY) must be 0x and 64 hex characters.");
  const referrer = setting(runtime, "LOOMDESK_REFERRER");
  if (referrer !== undefined && !isAddress(referrer, { strict: false })) throw new Error("LOOMDESK_REFERRER is not an address.");
  const policy = (setting(runtime, "LOOMDESK_SEND_POLICY") ?? "agent").toLowerCase();
  const amounts = (eth: string | undefined, usdg: string | undefined) => ({ ...(eth ? { ETH: eth } : {}), ...(usdg ? { USDG: usdg } : {}) });
  return {
    desk: {
      baseUrl: setting(runtime, "LOOMDESK_API_URL"),
      apiKey: setting(runtime, "LOOMDESK_API_KEY"),
      referrer,
      spendCap: amounts(setting(runtime, "LOOMDESK_MAX_ETH") ?? "0.01", setting(runtime, "LOOMDESK_MAX_USDG") ?? "25"),
      budget: amounts(setting(runtime, "LOOMDESK_BUDGET_ETH"), setting(runtime, "LOOMDESK_BUDGET_USDG")),
      client: `loomdesk-plugin-eliza/${VERSION}`,
    },
    rpcUrl: setting(runtime, "LOOMDESK_RPC_URL") ?? PUBLIC_RPC,
    privateKey: key as Hex | undefined,
    dryRun: /^(1|true|yes)$/i.test(setting(runtime, "LOOMDESK_DRY_RUN") ?? ""),
    sendPolicy: policy === "anyone" || policy === "operators" ? policy : "agent",
    operators: (setting(runtime, "LOOMDESK_OPERATORS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** May this message make the agent sign? Reads are open to anyone; a send follows LOOMDESK_SEND_POLICY, since anyone
 *  in a room can ask an agent for anything. */
export function maySend(runtime: IAgentRuntime, message: Memory, cfg: Config): boolean {
  if (cfg.sendPolicy === "anyone") return true;
  const meta = (message.content as { metadata?: { isAutonomous?: boolean } } | undefined)?.metadata;
  const fromAgent = message.entityId === runtime.agentId || meta?.isAutonomous === true;
  if (cfg.sendPolicy === "agent") return fromAgent;
  return fromAgent || cfg.operators.includes(String(message.entityId));
}
