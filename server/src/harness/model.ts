import { getModel, registerFauxProvider, type Model } from "@mariozechner/pi-ai";
import type { RoleName } from "../store/types.js";
import { demoBrain } from "./demoBrain.js";

/**
 * Model selection for each role.
 *
 * - With ANTHROPIC_API_KEY set, every role runs on a real Claude model
 *   (ALEX_MODEL, or ALEX_MODEL_<ROLE> to override one role).
 * - Without a key, Alex runs in *demo mode*: a scripted "demo brain" plugs into
 *   Pi's faux provider, so the full harness (agent loop, tool calls, streaming,
 *   state updates) runs for real — only the language model is simulated.
 */

const DEFAULT_MODEL = "claude-sonnet-5";

export const isDemoMode = () => !process.env.ANTHROPIC_API_KEY && process.env.ALEX_DEMO !== "0";

let faux: ReturnType<typeof registerFauxProvider> | undefined;

function demoModel(role: RoleName): Model<any> {
  if (!faux) {
    faux = registerFauxProvider({
      api: "alex-demo",
      provider: "alex-demo",
      models: (["advisor", "librarian", "tutor", "editorial", "generations"] as RoleName[]).map((r) => ({ id: `demo-${r}` })),
      tokensPerSecond: Number(process.env.ALEX_DEMO_TPS ?? 400),
    });
    // The brain is stateless (it reads the transcript + course state), so one
    // self-replenishing factory serves every concurrent run.
    const step = async (...args: Parameters<typeof demoBrain>) => {
      faux!.appendResponses([step]);
      return demoBrain(...args);
    };
    faux.setResponses([step, step, step, step]);
  }
  return faux.getModel(`demo-${role}`)!;
}

function claudeModel(id: string): Model<any> {
  const known = getModel("anthropic", id as any);
  if (known) return known;
  // Newer models may not be in pi-ai's generated registry yet: clone a recent
  // Claude entry and swap the id (same API surface).
  const template = getModel("anthropic", "claude-opus-4-7" as any) ?? getModel("anthropic", "claude-sonnet-4-5" as any);
  if (!template) throw new Error(`No Anthropic model template available for ${id}`);
  return { ...template, id, name: id };
}

export function modelFor(role: RoleName): Model<any> {
  if (isDemoMode()) return demoModel(role);
  const id = process.env[`ALEX_MODEL_${role.toUpperCase()}`] ?? process.env.ALEX_MODEL ?? DEFAULT_MODEL;
  return claudeModel(id);
}
