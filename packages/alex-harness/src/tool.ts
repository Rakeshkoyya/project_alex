import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "@earendil-works/pi-ai";

/**
 * Define a faculty tool: a Pi `AgentHarnessTool` whose tool context is the
 * role's per-turn context (course, store, event channel, delegation).
 * Throwing reports an error to the model; returning text is the tool result.
 */

type ToolOut = string | { text: string; details?: unknown };

export type FacultyTool<C extends object> = AgentHarnessTool<C, any, any>;

export function tool<C extends object, T extends TSchema>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  run: (params: Static<T>, ctx: C) => Promise<ToolOut> | ToolOut,
): FacultyTool<C> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params, _onUpdate, ctx) {
      const out = await run(params as Static<T>, ctx);
      const res = typeof out === "string" ? { text: out } : out;
      return { content: [{ type: "text", text: res.text }], details: (res.details ?? {}) as never };
    },
  };
}

export const json = (x: unknown) => JSON.stringify(x, null, 1);
