import { createModels, fauxProvider, type FauxResponseFactory, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { RoleName } from "./events.ts";

/**
 * Model selection per faculty role.
 *
 * - With ANTHROPIC_API_KEY set, every role runs on Claude through Pi's
 *   Anthropic provider (ALEX_MODEL, or ALEX_MODEL_<ROLE> for one role).
 * - Otherwise Alex runs in demo mode: the application's scripted "demo brain"
 *   is plugged into Pi's faux provider, so the whole harness runs for real
 *   and only the language model is simulated.
 */

export const DEFAULT_MODEL = "claude-sonnet-5";
const ROLES: RoleName[] = ["advisor", "librarian", "tutor", "editorial", "generations"];

export const isDemoMode = () => !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN && process.env.ALEX_DEMO !== "0";

/** The demo brain receives the faux request plus the course/role it is answering for. */
export type DemoBrain = (req: { role: RoleName; courseId: string; messages: Parameters<FauxResponseFactory>[0]["messages"] }) => ReturnType<FauxResponseFactory>;

export interface FacultyModels {
  models: MutableModels;
  modelFor(role: RoleName): Model<any>;
  demo: boolean;
}

export function createFacultyModels(brain?: DemoBrain): FacultyModels {
  const models = createModels();
  if (!isDemoMode()) {
    models.setProvider(anthropicProvider());
    return {
      models,
      demo: false,
      modelFor(role) {
        const id = process.env[`ALEX_MODEL_${role.toUpperCase()}`] ?? process.env.ALEX_MODEL ?? DEFAULT_MODEL;
        const m = models.getModel("anthropic", id);
        if (!m) throw new Error(`Unknown Anthropic model "${id}"`);
        return m;
      },
    };
  }
  if (!brain) throw new Error("Demo mode needs a demo brain (or set ANTHROPIC_API_KEY)");
  const faux = fauxProvider({
    provider: "alex-demo",
    api: "alex-demo",
    models: ROLES.map((r) => ({ id: `demo-${r}` })),
    tokensPerSecond: Number(process.env.ALEX_DEMO_TPS ?? 400),
  });
  // The brain is stateless per request (it reads the transcript + course state),
  // so one self-replenishing factory serves every concurrent run.
  const step: FauxResponseFactory = (context, options, _state, model) => {
    faux.appendResponses([step]);
    const courseId = String((options?.metadata as Record<string, unknown> | undefined)?.courseId ?? "");
    return brain({ role: model.id.replace("demo-", "") as RoleName, courseId, messages: context.messages });
  };
  faux.setResponses([step, step, step, step]);
  models.setProvider(faux.provider);
  return { models, demo: true, modelFor: (role) => faux.getModel(`demo-${role}`)! };
}
