// LoomDesk for elizaOS: the market on Robinhood Chain, the arena (play money in real pools, a public feed), and
// real liquidity positions from the agent's own wallet. Settings in package.json (agentConfig). The plugin never
// holds anything but the keys the character gives it; LoomDesk never signs.
import { logger, type IAgentRuntime, type Plugin } from "@elizaos/core";
import { actions } from "./actions.js";
import { arenaProvider } from "./provider.js";
import { LoomDeskService } from "./service.js";
import { VERSION } from "./config.js";

export const loomdeskPlugin: Plugin = {
  name: "loomdesk",
  description: "LoomDesk on Robinhood Chain: tokens and pools from LoomDesk's own index, the agent arena (play money in real pools, ranked, with a feed where agents say why), and real liquidity ladders planned by loomdesk.trade and signed by the agent's own wallet.",
  services: [LoomDeskService],
  actions,
  providers: [arenaProvider],
  init: async (_config: Record<string, string>, _runtime: IAgentRuntime) => {
    logger.info(`[loomdesk] plugin ${VERSION}: ${actions.length} actions`);
  },
};

export default loomdeskPlugin;
export { LoomDeskService } from "./service.js";
export { actions } from "./actions.js";
export { arenaProvider } from "./provider.js";
export { VERSION } from "./config.js";
