import type { Emit } from "@alex/harness";
import type { Store } from "../store/store.js";
import type { CourseState, ResearchTopic } from "../store/types.js";
import type { Vault } from "./vault.js";
import { ingestResource, searchBag } from "./service.js";
import { readPage, webSearch, type SearchHit } from "./webSearch.js";
import { MIN_QUALITY, sourceQuality } from "./sourceQuality.js";

/**
 * THE RESEARCH ENGINE — deterministic, parallel gathering for a research plan.
 *
 * For every topic in the Advisor's plan:
 *   1. vault: trusted primers/catalogue entries that match the topic
 *   2. web: each level-aware query on Brave + Tavily + Wikipedia at once
 *      (Wikipedia gets the short topic title), merged across queries
 *   3. score every candidate (authority × engine agreement × rank, minus
 *      penalties for unreadable / Q&A / answer-farm sites)
 *   4. read the best candidates with Readability; keep pages with real content,
 *      at most PER_TOPIC per topic, at most PER_DOMAIN per domain course-wide,
 *      at most MAX_PAGES overall — so the bag is broad, independent and deep
 *      enough, not ten copies of one site
 *
 * It runs in code (not in the model) so it is fast, parallel, repeatable and
 * cheap; the agents then do the judgment work on top of what it found.
 */

export interface ResearchLimits {
  maxPages: number;
  perTopic: number;
  perDomain: number;
  concurrency: number;
  minChars: number;
}

export const defaultLimits = (): ResearchLimits => ({
  maxPages: Number(process.env.ALEX_RESEARCH_MAX_PAGES ?? 14),
  perTopic: Number(process.env.ALEX_RESEARCH_PER_TOPIC ?? 2),
  perDomain: 3,
  concurrency: 3,
  minChars: 800,
});

export async function researchCourse(store: Store, vault: Vault, courseId: string, emit: Emit, limits = defaultLimits(), only?: string[]) {
  const c = store.getCourse(courseId);
  const topics = (c.research?.topics ?? []).filter((t) => (only ? only.includes(t.id) : t.status === "planned"));
  const audience = c.research?.profile?.audience ?? "";
  // Shared budget, reserved synchronously before each await so parallel topics can't overshoot.
  const domainCount = new Map<string, number>();
  for (const r of c.bag.resources) if (r.source?.startsWith("http")) bump(domainCount, domain(r.source));
  let pages = c.bag.resources.filter((r) => r.kind === "web").length;

  const researchOne = async (topic: ResearchTopic) => {
    const callId = `research-${topic.id}`;
    emit({ type: "tool_start", role: "librarian", id: callId, name: "research_topic", label: `Research: ${topic.title}`, args: { queries: topic.queries } });
    const errors = new Set<string>();
    const ingested: string[] = [];

    // 1. vault (trusted, offline)
    for (const e of vault.search(`${topic.title} ${c.title}`, 3).filter((e) => e.primer)) {
      const text = vault.primerText(e) ?? "";
      const r = ingestResource(store, courseId, { title: e.title, kind: "vault", source: e.url ?? `vault:${e.id}`, text, summary: e.description, addedBy: "librarian", topicId: topic.id });
      if (!ingested.includes(r.id)) ingested.push(r.id);
    }

    // 2. web, every query on every engine in parallel
    const queries = (topic.queries.length ? topic.queries : [topic.title]).slice(0, 3).map((q) => (audience && !q.toLowerCase().includes(audience.toLowerCase()) ? `${q} ${audience}` : q));
    const results = await Promise.all(queries.map((q) => webSearch(q, { count: 8, engineQueries: { wikipedia: topic.title } }).catch((e) => ({ hits: [] as SearchHit[], engines: [], provider: `error: ${(e as Error).message}` }))));
    const engines = new Set<string>();
    for (const r of results) {
      for (const e of r.engines) e.ok ? engines.add(e.engine) : errors.add(`${e.engine}: ${e.error}`);
    }
    const merged = new Map<string, SearchHit & { quality: number }>();
    for (const r of results) {
      r.hits.forEach((h, rank) => {
        const quality = sourceQuality(h, rank);
        const prev = merged.get(h.url);
        if (!prev || quality > prev.quality) merged.set(h.url, { ...h, quality, foundBy: [...new Set([...(prev?.foundBy ?? []), ...h.foundBy])] });
      });
    }
    const candidates = [...merged.values()].filter((h) => h.quality >= MIN_QUALITY).sort((a, b) => b.quality - a.quality);

    // 3–4. read the best, respecting diversity and budget
    let kept = 0;
    const usedHere = new Set<string>();
    for (const h of candidates) {
      if (kept >= limits.perTopic || pages >= limits.maxPages) break;
      if (usedHere.has(h.domain) || (domainCount.get(h.domain) ?? 0) >= limits.perDomain) continue;
      if (store.getCourse(courseId).bag.resources.some((r) => r.source === h.url)) continue;
      pages++;
      bump(domainCount, h.domain);
      usedHere.add(h.domain);
      try {
        const page = await readPage(h.url, 60_000);
        if (page.markdown.length < limits.minChars) throw new Error("too little readable text");
        const r = ingestResource(store, courseId, {
          title: page.title || h.title,
          kind: "web",
          source: h.url,
          text: page.title && !page.markdown.startsWith("#") ? `# ${page.title}\n\n${page.markdown}` : page.markdown,
          summary: `${h.snippet.slice(0, 200)}${h.snippet.length > 200 ? "…" : ""} (${h.domain}; found by ${h.foundBy.join(" + ")}; quality ${h.quality})`,
          addedBy: "librarian",
          topicId: topic.id,
          foundBy: h.foundBy,
          quality: h.quality,
        });
        ingested.push(r.id);
        kept++;
      } catch (e) {
        pages--; // budget returned: the page wasn't usable
        bump(domainCount, h.domain, -1);
        errors.add(`${h.domain}: ${(e as Error).message}`);
      }
    }

    store.update(courseId, (course) => {
      const t = course.research!.topics.find((x) => x.id === topic.id)!;
      t.resourceIds = [...new Set([...t.resourceIds, ...ingested])];
      t.status = t.notesId ? "noted" : "researched";
      t.searched = { engines: [...engines].join("+") || "none", candidates: candidates.length, ingested: kept, errors: [...errors].slice(0, 6) };
    });
    const summary = `${kept} web source${kept === 1 ? "" : "s"} + ${ingested.length - kept} vault · ${candidates.length} candidates · engines ${[...engines].join("+") || "none"}${errors.size ? ` · ${errors.size} issue(s)` : ""}`;
    emit({ type: "tool_end", role: "librarian", id: callId, name: "research_topic", isError: false, summary });
    store.log(courseId, "librarian", "tool", `research ${topic.title}: ${summary}`);
  };

  await pool(topics, limits.concurrency, researchOne);
  store.update(courseId, (course) => course.research && (course.research.finishedAt = new Date().toISOString()));
  emit({ type: "ui", role: "librarian", name: "bag_updated", payload: {} });
}

/** Text report of the research dossier for the agents' prompts. */
export function researchReport(c: CourseState): string {
  const r = c.research;
  if (!r) return "No research plan.";
  const title = (id: string) => c.bag.resources.find((x) => x.id === id);
  const lines = [
    r.profile ? `Learner profile: ${r.profile.level}; depth ${r.profile.depth}; assumes ${r.profile.assumedKnowledge.join(", ") || "nothing"}; suspected gaps ${r.profile.suspectedGaps.join(", ") || "none"}.` : "Learner profile: not set.",
    "",
  ];
  for (const t of r.topics) {
    const res = t.resourceIds.map(title).filter(Boolean);
    lines.push(`• [${t.id}] ${t.title} (${t.kind}) — ${res.length ? res.map((x) => `${x!.title} [${x!.kind}${x!.quality !== undefined ? `, q${x!.quality}` : ""}]`).join("; ") : "NO SOURCES FOUND"}${t.notesId ? " · lecture notes ✓" : " · lecture notes: missing"}`);
  }
  const uploads = c.bag.resources.filter((x) => x.addedBy === "student");
  if (uploads.length) lines.push("", `Student uploads: ${uploads.map((u) => `"${u.title}" (${u.id})`).join(", ")}`);
  return lines.join("\n");
}

/** Which concepts the bag actually supports: BM25 evidence per concept. */
export function coverage(store: Store, courseId: string) {
  const c = store.getCourse(courseId);
  return c.concepts.map((k) => {
    const hits = searchBag(store, courseId, `${k.title} ${k.description}`, 4);
    const resources = [...new Set(hits.map((h) => h.resource))];
    const strength = hits.reduce((s, h) => s + h.score, 0);
    return { id: k.id, title: k.title, depth: k.depth, resources, strength: Math.round(strength * 10) / 10, status: strength >= 8 && resources.length >= 2 ? "well covered" : strength >= 3 ? "thin" : "GAP" };
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const domain = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
