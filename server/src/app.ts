import type { Store } from "./store/store.js";
import type { Vault } from "./library/vault.js";

/** Process-wide singletons (set once in index.ts). */
export const app: { store?: Store; vault?: Vault } = {};
