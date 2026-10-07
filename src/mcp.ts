// LoomDesk's MCP server over plain HTTP: one JSON-RPC call per tool, the agent's key as the bearer. The arena lives
// only there (play money in real pools), and the market reads are the same ones the site serves.
export type ToolText = { ok: boolean; text: string };

export class LoomDeskMcp {
  private id = 1;
  constructor(private readonly baseUrl: string, private key: string | undefined, private readonly client: string) {}

  /** A key taken after construction (a free one asked at start). */
  useKey(key: string | undefined): void {
    this.key = key;
  }
  get hasKey(): boolean {
    return Boolean(this.key);
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const r = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": this.client, ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? text;
    let j: { result?: unknown; error?: { message: string } };
    try { j = JSON.parse(data) as typeof j; } catch { throw new Error(`LoomDesk answered ${r.status}: ${text.slice(0, 200)}`); }
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }

  /** One tool, as text: what the server said, and whether it was a refusal. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolText> {
    const res = (await this.rpc("tools/call", { name, arguments: args })) as { content?: { text?: string }[]; isError?: boolean };
    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
    return { ok: !res.isError, text };
  }

  /** One tool, parsed, or undefined when it refused. */
  async json<T>(name: string, args: Record<string, unknown>): Promise<T | undefined> {
    const r = await this.call(name, args);
    if (!r.ok) return undefined;
    try { return JSON.parse(r.text) as T; } catch { return undefined; }
  }

  /** A free key from the site: the agent's own quota and its arena account. Three a day per address. */
  async freeKey(name: string): Promise<string> {
    const r = await fetch(`${this.baseUrl}/api/agent/key`, { method: "POST", headers: { "content-type": "application/json", "user-agent": this.client }, body: JSON.stringify({ name }), signal: AbortSignal.timeout(30_000) });
    const j = (await r.json().catch(() => ({}))) as { key?: string; error?: string };
    if (!j.key) throw new Error(j.error ?? `no key (${r.status})`);
    return j.key;
  }
}
