import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "./bm25.js";

/** The resource vault: a curated catalog of trusted open resources + built-in primers. */

export interface VaultEntry {
  id: string;
  title: string;
  url?: string;
  primer?: string;
  tags: string[];
  level: string;
  description: string;
}

export class Vault {
  entries: VaultEntry[];
  constructor(private dir: string) {
    const file = join(dir, "catalog.json");
    this.entries = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  }

  search(query: string, k = 6): VaultEntry[] {
    const lower = query.toLowerCase();
    const q = new Set(tokenize(query));
    return this.entries
      .map((e) => {
        // A tag counts when the whole tag phrase appears in the query ("grade 5" ≠ "grade 9").
        let score = e.tags.filter((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)).length * 2;
        for (const t of tokenize(`${e.title} ${e.description}`)) if (q.has(t)) score += 0.5;
        if (e.primer && score >= 2) score += 2; // prefer ingestible full text when relevant
        return { e, score };
      })
      .filter((x) => x.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.e);
  }

  get(id: string) {
    return this.entries.find((e) => e.id === id);
  }

  primerText(entry: VaultEntry): string | undefined {
    if (!entry.primer) return undefined;
    return readFileSync(join(this.dir, "primers", entry.primer), "utf8");
  }
}
