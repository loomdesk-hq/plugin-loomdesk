// Copied from core/src/api.ts by scripts/sync-core.mjs. Edit it there, then run npm run sync at the repo root.
import type { Address, Hex } from "viem";

/** One unsigned transaction as POST /api/agent/ladder returns it. `value` is wei as a decimal string; `gas` is the
 *  limit LoomDesk set from its own simulation of the plan. */
export type PlanTx = { step: string; to: Address; data: Hex; value: string; gas?: string; note?: string };

/** How LoomDesk tried the plan before handing it over: simulated in order from the owner. */
export type PlanCheck = {
  simulated: boolean;
  ok?: boolean;
  simulatedAt?: string;
  block?: string;
  failedStep?: number;
  reason?: string;
  ethNeeded?: string;
  gasEthAtMost?: string;
  ethHeld?: string;
  note?: string;
};

export type Plan = {
  chainId?: number;
  transactions?: PlanTx[];
  check?: PlanCheck;
  sendWithin?: string;
  /** a ladder in a pool that is opened first: the opening must be mined before this plan can be checked */
  opensFirst?: string;
  /** revert selector -> what it means and what to do */
  ifItReverts?: Record<string, string>;
  warnings?: string[];
  [k: string]: unknown;
};

export class LoomDeskApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ApiOptions = {
  baseUrl?: string;
  /** An agent key (ldk_...): the agent's own quota at LoomDesk instead of the one it shares with its address. */
  apiKey?: string;
  /** Names the plugin to LoomDesk, e.g. "loomdesk-agentkit/0.1.0". */
  client: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/** A small client for LoomDesk's agent endpoints. Over quota (429) or busy (503), it waits once when the wait asked
 *  for is short, then gives the server's words back. */
export class LoomDeskApi {
  readonly baseUrl: string;
  private readonly key?: string;
  private readonly timeoutMs: number;
  private readonly f: typeof fetch;

  constructor(private readonly o: ApiOptions) {
    this.baseUrl = (o.baseUrl ?? "https://loomdesk.trade").replace(/\/+$/, "");
    const key = o.apiKey?.trim();
    if (key && !/^ldk_[fwp]_[0-9a-f]+_[0-9a-f]+$/.test(key)) throw new Error("loomdesk: the API key is not a LoomDesk key (ldk_...)");
    this.key = key || undefined;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.f = o.fetch ?? fetch;
  }

  private async call<T>(path: string, body: unknown, retried = false): Promise<T> {
    const res = await this.f(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        "user-agent": this.o.client,
        "x-loomdesk-client": this.o.client,
        ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if ((res.status === 429 || res.status === 503) && !retried) {
      const wait = Number(res.headers.get("retry-after") ?? "0");
      if (wait > 0 && wait <= 30) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        return this.call<T>(path, body, true);
      }
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LoomDeskApiError(`LoomDesk answered ${res.status} without JSON`, res.status);
    }
    if (!res.ok) throw new LoomDeskApiError(String((json as { error?: unknown })?.error ?? `LoomDesk answered ${res.status}`), res.status);
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.call<T>(path, undefined);
  }

  /** POST /api/agent/ladder: { plan: "pools" | "build" | "ladder" | "limit" | "action" | "swap" | "open_pool", ... } */
  plan(body: Record<string, unknown>): Promise<Plan> {
    return this.call<Plan>("/api/agent/ladder", body);
  }

  text(path: string): Promise<string> {
    return this.f(`${this.baseUrl}${path}`, { headers: { "user-agent": this.o.client }, signal: AbortSignal.timeout(this.timeoutMs) }).then((r) => {
      if (!r.ok) throw new LoomDeskApiError(`LoomDesk answered ${r.status}`, r.status);
      return r.text();
    });
  }
}
