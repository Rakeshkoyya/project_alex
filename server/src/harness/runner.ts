import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Static, TSchema } from "@mariozechner/pi-ai";
import type { Store } from "../store/store.js";
import type { RoleName } from "../store/types.js";
import type { Vault } from "../library/vault.js";
import { modelFor } from "./model.js";

/**
 * The Alex harness: a thin layer over Pi's `Agent` that turns it into a
 * multi-role faculty. Each role (Advisor, Librarian, Tutor, Editorial,
 * Generations) is a RoleSpec — a system prompt plus a toolset bound to one
 * course. The runner creates a Pi Agent per run, streams its events to the UI,
 * logs tool activity to the course record and lets roles delegate to each
 * other (e.g. the Tutor asks Editorial to write the end-of-session quiz).
 */

export type HarnessEvent =
  | { type: "agent_start"; role: RoleName }
  | { type: "text"; role: RoleName; delta: string }
  | { type: "tool_start"; role: RoleName; id: string; name: string; label: string; args: unknown }
  | { type: "tool_end"; role: RoleName; id: string; name: string; isError: boolean; summary: string }
  /** Structured UI instruction, e.g. show an artifact, refresh the plan, open a quiz. */
  | { type: "ui"; role: RoleName; name: string; payload: unknown }
  | { type: "agent_end"; role: RoleName; text: string }
  | { type: "error"; role: RoleName; message: string };

export interface RoleContext {
  store: Store;
  vault: Vault;
  courseId: string;
  sessionId?: string;
  emit: (e: HarnessEvent) => void;
  /** Delegate a task to another role (runs to completion, streams into the same channel). */
  delegate: (role: RoleName, prompt: string) => Promise<string>;
}

export interface RoleSpec {
  role: RoleName;
  systemPrompt: (ctx: RoleContext) => string;
  tools: (ctx: RoleContext) => AgentTool<any>[];
}

export interface RunResult {
  text: string;
  messages: AgentMessage[];
}

const registry = new Map<RoleName, RoleSpec>();
export const registerRole = (spec: RoleSpec) => registry.set(spec.role, spec);
export const getRole = (role: RoleName) => {
  const spec = registry.get(role);
  if (!spec) throw new Error(`Role ${role} is not registered`);
  return spec;
};

export async function runRole(
  role: RoleName,
  base: Omit<RoleContext, "delegate">,
  prompt: string,
  opts: { messages?: AgentMessage[] } = {},
): Promise<RunResult> {
  const spec = getRole(role);
  const ctx: RoleContext = {
    ...base,
    delegate: async (other, p) => (await runRole(other, base, p)).text,
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: spec.systemPrompt(ctx),
      model: modelFor(role),
      thinkingLevel: "off",
      tools: spec.tools(ctx),
      messages: opts.messages ?? [],
    },
    toolExecution: "sequential",
    sessionId: base.sessionId ?? base.courseId,
  });

  let text = "";
  agent.subscribe((ev) => {
    switch (ev.type) {
      case "message_update":
        if (ev.assistantMessageEvent.type === "text_delta") {
          text += ev.assistantMessageEvent.delta;
          base.emit({ type: "text", role, delta: ev.assistantMessageEvent.delta });
        }
        break;
      case "message_start":
        if (ev.message.role === "assistant" && text) {
          text += "\n\n";
          base.emit({ type: "text", role, delta: "\n\n" });
        }
        break;
      case "tool_execution_start": {
        const label = spec.tools(ctx).find((t) => t.name === ev.toolName)?.label ?? ev.toolName;
        base.emit({ type: "tool_start", role, id: ev.toolCallId, name: ev.toolName, label, args: ev.args });
        break;
      }
      case "tool_execution_end": {
        const first = ev.result?.content?.find((c: any) => c.type === "text") as { text: string } | undefined;
        const summary = (first?.text ?? "").slice(0, 240);
        base.emit({ type: "tool_end", role, id: ev.toolCallId, name: ev.toolName, isError: ev.isError, summary });
        base.store.log(base.courseId, role, ev.isError ? "error" : "tool", `${ev.toolName}: ${summary.split("\n")[0]}`);
        break;
      }
    }
  });

  base.emit({ type: "agent_start", role });
  await agent.prompt(prompt);
  const err = agent.state.errorMessage;
  if (err) {
    base.emit({ type: "error", role, message: err });
    throw new Error(`${role} failed: ${err}`);
  }
  base.emit({ type: "agent_end", role, text });
  return { text, messages: agent.state.messages };
}

// ------------------------------------------------------------------ tool helper

type ToolOut = string | { text: string; details?: unknown };

/** Define a Pi AgentTool with less boilerplate. Throwing reports an error to the model. */
export function tool<T extends TSchema>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  run: (params: Static<T>) => Promise<ToolOut> | ToolOut,
): AgentTool<T> {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_id, params) => {
      const out = await run(params as Static<T>);
      const res = typeof out === "string" ? { text: out } : out;
      return { content: [{ type: "text", text: res.text }], details: res.details ?? {} };
    },
  };
}

export const json = (x: unknown) => JSON.stringify(x, null, 1);
