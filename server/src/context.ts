import type { TSchema } from "@earendil-works/pi-ai";
import { tool, type FacultyContext } from "@alex/harness";
import type { Store } from "./store/store.js";
import type { Vault } from "./library/vault.js";

/** The live context every Alex tool receives from the Pi harness for the current run. */
export interface AlexCtx extends FacultyContext {
  store: Store;
  vault: Vault;
  /** Set for Tutor runs (and roles delegated from them). */
  sessionId?: string;
}

/** `tool()` bound to Alex's context type. */
export const t = <T extends TSchema>(...args: Parameters<typeof tool<AlexCtx, T>>) => tool<AlexCtx, T>(...args);
