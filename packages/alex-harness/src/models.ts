import { createModels, fauxProvider, type FauxResponseFactory, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { RoleName } from "./events.ts";

/**
 * Model selection per faculty role, through Pi's provider registry.
 *
 *   ALEX_PROVIDER      openrouter | anthropic | demo. Auto-detected when unset:
 *                      OPENROUTER_API_KEY → openrouter, ANTHROPIC_API_KEY → anthropic,
 *                      neither → demo.
 *   ALEX_MODEL         model id for every role (default per provider below).
 *   ALEX_MODEL_<ROLE>  override one role, e.g. ALEX_MODEL_TUTOR.
 *   ALEX_BASE_URL      optional API base-URL override (proxies, self-hosted gateways).
 *   ALEX_MAX_OUTPUT_TOKENS  cap on tokens per model reply (default 16000).
 *   ALEX_THINKING      reasoning level: off (default) | low | medium | high.
 *
 * Demo mode plugs the application's scripted "demo brain" into Pi's faux
 * provider: the whole harness runs for real and only the model is simulated.
 */

export type ProviderName = "openrouter" | "anthropic" | "demo";

export const DEFAULT_MODELS: Record<Exclude<ProviderName, "demo">, string> = {
  openrouter: "deepseek/deepseek-v4-flash",
  anthropic: "claude-sonnet-5",
};

const ROLES: RoleName[] = ["advisor", "librarian", "tutor", "editorial", "generations"];

export function selectedProvider(): ProviderName {
  const explicit = process.env.ALEX_PROVIDER?.trim().toLowerCase();
  if (explicit === "openrouter" || explicit === "anthropic" || explicit === "demo") return explicit;
  if (explicit) throw new Error(`ALEX_PROVIDER must be openrouter, anthropic or demo (got "${explicit}")`);
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN) return "anthropic";
  return "demo";
}

export const isDemoMode = () => selectedProvider() === "demo";

/** The demo brain receives the faux request plus the course/role it is answering for. */
export type DemoBrain = (req: { role: RoleName; courseId: string; messages: Parameters<FauxResponseFactory>[0]["messages"] }) => ReturnType<FauxResponseFactory>;

export interface FacultyModels {
  models: MutableModels;
  modelFor(role: RoleName): Model<any>;
  provider: ProviderName;
  demo: boolean;
}

export function createFacultyModels(brain?: DemoBrain): FacultyModels {
  const models = createModels();
  const provider = selectedProvider();

  if (provider !== "demo") {
    const keyVar = provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
    if (provider === "openrouter" && !process.env.OPENROUTER_API_KEY) throw new Error("ALEX_PROVIDER=openrouter needs OPENROUTER_API_KEY");
    const base = provider === "openrouter" ? openrouterProvider() : anthropicProvider();
    const baseUrl = process.env.ALEX_BASE_URL?.trim();
    const maxOut = Number(process.env.ALEX_MAX_OUTPUT_TOKENS ?? 16000);
    // Pi's harness re-resolves {provider, modelId} through the registry on every
    // request, so request-shaping overrides live in the provider's model list:
    // an optional base URL, and a sane output cap (catalogue maxima such as 384k
    // are rejected by some OpenRouter upstreams and reserve needless credit).
    models.setProvider({
      ...base,
      getModels: () => base.getModels().map((m) => ({ ...m, maxTokens: Math.min(m.maxTokens, maxOut), ...(baseUrl ? { baseUrl } : {}) })),
    });
    const cache = new Map<string, Model<any>>();
    const modelFor = (role: RoleName) => {
      const id = process.env[`ALEX_MODEL_${role.toUpperCase()}`] ?? process.env.ALEX_MODEL ?? DEFAULT_MODELS[provider];
      let m = cache.get(id);
      if (!m) {
        const found = models.getModel(provider, id);
        if (!found) throw new Error(`Unknown ${provider} model "${id}" (set ALEX_MODEL to an id from Pi's ${provider} catalogue; ${keyVar} must be set)`);
        m = found;
        cache.set(id, m);
      }
      return m;
    };
    for (const r of ROLES) modelFor(r); // fail fast at startup on a bad model id
    return { models, provider, demo: false, modelFor };
  }

  if (!brain) throw new Error("Demo mode needs a demo brain (or set OPENROUTER_API_KEY / ANTHROPIC_API_KEY)");
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
  return { models, provider, demo: true, modelFor: (role) => faux.getModel(`demo-${role}`)! };
}
