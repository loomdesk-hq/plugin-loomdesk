// Action parameters. elizaOS 2.x hands an action its parameters (Action.parameters -> options.parameters); 1.x does
// not, so the action asks the small text model for them, and checks every value itself either way.
import { ModelType, logger, type HandlerOptions, type IAgentRuntime, type Memory, type State } from "@elizaos/core";

export type Field = { name: string; description: string; required?: boolean; type: "string" | "number" | "boolean"; enum?: string[]; pattern?: RegExp };
export type Params = Record<string, string | number | boolean | undefined>;

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const DECIMAL = /^\d*\.?\d+$/;

/** The 2.x-style declaration of the same fields, set on each action (1.x ignores unknown keys on an Action). */
export function declare(fields: Field[]) {
  return fields.map((f) => ({ name: f.name, description: f.description, required: Boolean(f.required), schema: { type: f.type, ...(f.enum ? { enum: f.enum } : {}) } }));
}

function clean(fields: Field[], raw: Record<string, unknown>): Params {
  const out: Params = {};
  for (const f of fields) {
    let v = raw[f.name];
    if (v === undefined || v === null || v === "") continue;
    if (f.type === "number") v = typeof v === "number" ? v : Number(String(v).replace(/[%\s]/g, ""));
    else if (f.type === "boolean") v = typeof v === "boolean" ? v : /^(1|true|yes)$/i.test(String(v));
    else v = String(v).trim();
    if (f.type === "number" && !Number.isFinite(v as number)) continue;
    if (f.enum && !f.enum.includes(String(v))) continue;
    if (f.pattern && !f.pattern.test(String(v))) continue;
    out[f.name] = v as string | number | boolean;
  }
  return out;
}

export async function getParams(runtime: IAgentRuntime, message: Memory, state: State | undefined, options: HandlerOptions | undefined, fields: Field[]): Promise<Params> {
  const given = (options as { parameters?: Record<string, unknown> } | undefined)?.parameters;
  if (given && typeof given === "object") return clean(fields, given);
  const recent = typeof state?.values?.recentMessages === "string" ? state.values.recentMessages.slice(-3000) : "";
  const prompt = [
    "Extract the parameters for a LoomDesk action from the conversation. Answer with one JSON object only.",
    "Leave a field out when the conversation does not give it. Never invent addresses or amounts.",
    `Fields:\n${fields.map((f) => `- ${f.name} (${f.type}${f.enum ? `: one of ${f.enum.join(", ")}` : ""}${f.required ? ", required" : ""}): ${f.description}`).join("\n")}`,
    recent ? `Recent conversation:\n${recent}` : "",
    `Latest message:\n${message.content.text ?? ""}`,
  ].filter(Boolean).join("\n\n");
  try {
    // TEXT_SMALL exists in 1.x and 2.x (OBJECT_SMALL is gone in 2.x); the answer is parsed here
    const text = String(await runtime.useModel(ModelType.TEXT_SMALL, { prompt }));
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return clean(fields, json ? (JSON.parse(json) as Record<string, unknown>) : {});
  } catch (e) {
    logger.warn(`[loomdesk] parameter extraction failed: ${(e as Error).message}`);
    return {};
  }
}

export function missing(fields: Field[], p: Params): string[] {
  return fields.filter((f) => f.required && p[f.name] === undefined).map((f) => f.name);
}
