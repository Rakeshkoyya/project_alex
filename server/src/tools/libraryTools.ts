import { Type } from "@earendil-works/pi-ai";
import { json } from "@alex/harness";
import { t, type AlexCtx } from "../context.js";
import { fetchPageText, readPage, searchProvider, webSearch } from "../library/webSearch.js";
import { ingestResource } from "../library/service.js";

/** Librarian tools: find material on the internet or in the vault, and ingest it. */

export function libraryTools() {
  return [
    t(
      "vault_search",
      "Search resource vault",
      "Search Alex's curated vault of trusted open educational resources (OpenStax, Khan Academy, MIT OCW, built-in primers...). Prefer these over random web pages.",
      Type.Object({ query: Type.String() }),
      ({ query }, ctx) => {
        const hits = ctx.vault.search(query);
        if (!hits.length) return "No vault matches.";
        return json(hits.map((h) => ({ id: h.id, title: h.title, level: h.level, tags: h.tags, fullText: !!h.primer, url: h.url, description: h.description })));
      },
    ),
    t(
      "add_vault_resource",
      "Add vault resource to bag",
      "Put a vault entry into the student's bag. Entries with fullText=true are ingested in full; others are stored as a recommended link.",
      Type.Object({ id: Type.String(), whyUseful: Type.Optional(Type.String()) }),
      ({ id, whyUseful }, ctx) => {
        const e = ctx.vault.get(id);
        if (!e) throw new Error(`No vault entry ${id}`);
        const text = ctx.vault.primerText(e) ?? "";
        const r = ingestResource(ctx.store, ctx.courseId, {
          title: e.title,
          kind: text ? "vault" : "link",
          source: e.url ?? `vault:${e.id}`,
          text,
          summary: whyUseful ? `${e.description} — ${whyUseful}` : e.description,
          addedBy: "librarian",
        });
        ctx.emit({ type: "ui", role: "librarian", name: "bag_updated", payload: { resource: r.title } });
        return `Added "${r.title}" to the bag (${r.chunkCount} indexed passages).`;
      },
    ),
    ...webTools(),
    t(
      "fetch_and_ingest",
      "Read web page into bag",
      "Download a web page, extract its text and ingest it into the student's bag. Only use for pages that are genuinely good learning material.",
      Type.Object({ url: Type.String(), title: Type.String(), summary: Type.Optional(Type.String()) }),
      async ({ url, title, summary }, ctx) => {
        const text = await fetchPageText(url);
        if (text.length < 200) throw new Error("Page had too little readable text.");
        const r = ingestResource(ctx.store, ctx.courseId, { title, kind: "web", source: url, text, summary, addedBy: "librarian" });
        ctx.emit({ type: "ui", role: "librarian", name: "bag_updated", payload: { resource: r.title } });
        return `Ingested "${title}" (${r.chunkCount} passages).`;
      },
    ),
    t(
      "summarize_resource",
      "Summarize resource",
      "Record a short summary for a resource already in the bag (what it covers, level, how to use it).",
      Type.Object({ resourceId: Type.String(), summary: Type.String() }),
      ({ resourceId, summary }, ctx) => {
        ctx.store.update(ctx.courseId, (c) => {
          const r = c.bag.resources.find((x) => x.id === resourceId);
          if (!r) throw new Error(`Unknown resource ${resourceId}`);
          r.summary = summary;
        });
        return "Summary saved.";
      },
    ),
    t(
      "read_resource",
      "Read resource",
      "Read the ingested passages of one resource in the bag (paged).",
      Type.Object({ resourceId: Type.String(), fromPassage: Type.Optional(Type.Number()), count: Type.Optional(Type.Number()) }),
      ({ resourceId, fromPassage, count }, ctx) => {
        const all = ctx.store.getChunks(ctx.courseId).filter((c) => c.resourceId === resourceId);
        const from = fromPassage ?? 0;
        const slice = all.slice(from, from + (count ?? 6));
        if (!slice.length) return "No passages.";
        return `Passages ${from}–${from + slice.length - 1} of ${all.length}:\n\n` + slice.map((c) => c.text).join("\n\n---\n\n");
      },
    ),
  ];
}

/**
 * Web search + page reading (port of Pi's brave-search skill). Shared by the
 * Librarian (who also ingests) and the Tutor (read-only fact checks).
 */
export function webTools() {
  return [
    t(
      "web_search",
      "Search the internet",
      `Search the web (${searchProvider()}). Returns titles, urls, snippets and, with includeContent, each page's readable text as markdown. Prefer authoritative educational sources (textbooks, universities, encyclopedias, official docs).`,
      Type.Object({
        query: Type.String(),
        count: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Number of results (default 5)" })),
        includeContent: Type.Optional(Type.Boolean({ description: "Also fetch each result's readable content (slower)" })),
        freshness: Type.Optional(Type.String({ description: "Recency filter: pd (day), pw (week), pm (month), py (year) or YYYY-MM-DDtoYYYY-MM-DD" })),
        country: Type.Optional(Type.String({ description: "Two-letter country code (default US)" })),
      }),
      async ({ query, count, includeContent, freshness, country }) => {
        try {
          const { provider, hits } = await webSearch(query, { count, includeContent, freshness, country });
          if (!hits.length) return `No results (${provider}).`;
          return (
            `Provider: ${provider}\n\n` +
            hits
              .map((h, i) => [`--- Result ${i + 1} ---`, `Title: ${h.title}`, `Link: ${h.url}`, h.age ? `Age: ${h.age}` : "", `Snippet: ${h.snippet}`, h.content ? `Content:\n${h.content}` : ""].filter(Boolean).join("\n"))
              .join("\n\n")
          );
        } catch (e) {
          return `Web search unavailable (${(e as Error).message}). Use the vault instead.`;
        }
      },
    ),
    t(
      "read_webpage",
      "Read web page",
      "Fetch a URL (web page or PDF) and return its readable content as markdown, without adding it to the bag. Use it to check a source before ingesting it, or to verify a fact.",
      Type.Object({ url: Type.String(), maxChars: Type.Optional(Type.Number({ minimum: 500, maximum: 30000 })) }),
      async ({ url, maxChars }) => {
        const p = await readPage(url, maxChars ?? 12000);
        return `# ${p.title || url}\n\n${p.markdown}`;
      },
    ),
  ];
}
