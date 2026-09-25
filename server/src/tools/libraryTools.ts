import { Type } from "@mariozechner/pi-ai";
import { json, tool, type RoleContext } from "../harness/runner.js";
import { fetchPageText, webSearch } from "../library/webSearch.js";
import { ingestResource } from "../library/service.js";

/** Librarian tools: find material on the internet or in the vault, and ingest it. */

export function libraryTools(ctx: RoleContext) {
  return [
    tool(
      "vault_search",
      "Search resource vault",
      "Search Alex's curated vault of trusted open educational resources (OpenStax, Khan Academy, MIT OCW, built-in primers...). Prefer these over random web pages.",
      Type.Object({ query: Type.String() }),
      ({ query }) => {
        const hits = ctx.vault.search(query);
        if (!hits.length) return "No vault matches.";
        return json(hits.map((h) => ({ id: h.id, title: h.title, level: h.level, tags: h.tags, fullText: !!h.primer, url: h.url, description: h.description })));
      },
    ),
    tool(
      "add_vault_resource",
      "Add vault resource to bag",
      "Put a vault entry into the student's bag. Entries with fullText=true are ingested in full; others are stored as a recommended link.",
      Type.Object({ id: Type.String(), whyUseful: Type.Optional(Type.String()) }),
      ({ id, whyUseful }) => {
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
    tool(
      "web_search",
      "Search the internet",
      "Search the web for learning material. Returns titles, urls and snippets.",
      Type.Object({ query: Type.String() }),
      async ({ query }) => {
        try {
          const { provider, hits } = await webSearch(query);
          if (!hits.length) return `No results (${provider}).`;
          return `Provider: ${provider}\n` + json(hits);
        } catch (e) {
          return `Web search unavailable (${(e as Error).message}). Use the vault instead.`;
        }
      },
    ),
    tool(
      "fetch_and_ingest",
      "Read web page into bag",
      "Download a web page, extract its text and ingest it into the student's bag. Only use for pages that are genuinely good learning material.",
      Type.Object({ url: Type.String(), title: Type.String(), summary: Type.Optional(Type.String()) }),
      async ({ url, title, summary }) => {
        const text = await fetchPageText(url);
        if (text.length < 200) throw new Error("Page had too little readable text.");
        const r = ingestResource(ctx.store, ctx.courseId, { title, kind: "web", source: url, text, summary, addedBy: "librarian" });
        ctx.emit({ type: "ui", role: "librarian", name: "bag_updated", payload: { resource: r.title } });
        return `Ingested "${title}" (${r.chunkCount} passages).`;
      },
    ),
    tool(
      "summarize_resource",
      "Summarize resource",
      "Record a short summary for a resource already in the bag (what it covers, level, how to use it).",
      Type.Object({ resourceId: Type.String(), summary: Type.String() }),
      ({ resourceId, summary }) => {
        ctx.store.update(ctx.courseId, (c) => {
          const r = c.bag.resources.find((x) => x.id === resourceId);
          if (!r) throw new Error(`Unknown resource ${resourceId}`);
          r.summary = summary;
        });
        return "Summary saved.";
      },
    ),
    tool(
      "read_resource",
      "Read resource",
      "Read the ingested passages of one resource in the bag (paged).",
      Type.Object({ resourceId: Type.String(), fromPassage: Type.Optional(Type.Number()), count: Type.Optional(Type.Number()) }),
      ({ resourceId, fromPassage, count }) => {
        const all = ctx.store.getChunks(ctx.courseId).filter((c) => c.resourceId === resourceId);
        const from = fromPassage ?? 0;
        const slice = all.slice(from, from + (count ?? 6));
        if (!slice.length) return "No passages.";
        return `Passages ${from}–${from + slice.length - 1} of ${all.length}:\n\n` + slice.map((c) => c.text).join("\n\n---\n\n");
      },
    ),
  ];
}
