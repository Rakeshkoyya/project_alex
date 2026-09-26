import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Faculty, type JsonlSessionMetadata } from "@alex/harness";
import type { Store } from "./store/store.js";
import type { Vault } from "./library/vault.js";
import type { AlexCtx } from "./context.js";
import { ROLES } from "./agents/roles.js";
import { demoBrain } from "./demo/demoBrain.js";

/** Process-wide singletons (set once by init()). */
export const app: { store?: Store; vault?: Vault; faculty?: Faculty<AlexCtx> } = {};

export function init(store: Store, vault: Vault) {
  app.store = store;
  app.vault = vault;
  app.faculty = new Faculty<AlexCtx>({
    demoBrain,
    makeContext: (base, extra) => ({
      ...base,
      // Every tool call a faculty member makes is also written to the course's activity log.
      emit: (e) => {
        if (e.type === "tool_end") store.log(base.courseId, e.role, e.isError ? "error" : "tool", `${e.name}: ${e.summary.split("\n")[0].slice(0, 160)}`);
        if (e.type === "error") store.log(base.courseId, e.role, "error", e.message.slice(0, 200));
        base.emit(e);
      },
      store,
      vault,
      sessionId: extra.sessionId as string | undefined,
    }),
    index: {
      get: (courseId, thread) => store.getCourse(courseId).threads[thread] as JsonlSessionMetadata | undefined,
      set: (courseId, thread, meta) => store.update(courseId, (c) => (c.threads[thread] = { ...meta })),
      sessionsDir: (courseId) => {
        const dir = join(store.courseDir(courseId), "pi-sessions");
        mkdirSync(dir, { recursive: true });
        return dir;
      },
    },
  });
  for (const role of ROLES) app.faculty.register(role);
  return app;
}
