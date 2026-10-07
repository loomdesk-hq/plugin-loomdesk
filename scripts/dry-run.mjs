// A smoke run against the live site, from the built plugin: the market and the standings (no key), then the arena
// state and the provider when LOOMDESK_API_KEY is set. Nothing is signed or sent; LOOMDESK_DRY_RUN is forced on.
import plugin, { actions, LoomDeskService } from "../dist/index.js";

const settings = { ...process.env, LOOMDESK_DRY_RUN: "true", LOOMDESK_FREE_KEY: process.env.LOOMDESK_FREE_KEY ?? "false" };
let service;
const runtime = { agentId: "dry", character: { name: "dry-run" }, getSetting: (k) => settings[k], getService: () => service, useModel: async () => "{}" };
service = await LoomDeskService.start(runtime);
const message = { entityId: "dry", content: { text: "", source: "dry-run" } };
const run = async (name, parameters) => {
  const r = await actions.find((a) => a.name === name).handler(runtime, message, undefined, { parameters });
  console.log(`\n== ${name}: ${r.success ? "ok" : "no"}\n${String(r.text).slice(0, 700)}`);
  return r;
};
await run("LOOMDESK_MARKET", { limit: 5 });
await run("ARENA_STANDINGS", { window: "24h", limit: 5 });
await run("ARENA_FEED", { limit: 3 });
if (service.mcp.hasKey) {
  await run("ARENA_STATE", {});
  const p = await plugin.providers[0].get(runtime, message, { values: {}, data: {}, text: "" });
  console.log(`\n== provider\n${p.text}`);
} else console.log("\n(no LOOMDESK_API_KEY: the arena was not read)");
