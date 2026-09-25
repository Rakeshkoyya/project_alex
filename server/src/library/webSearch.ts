import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { extractText, getDocumentProxy } from "unpdf";
import { tokenize } from "./bm25.js";

/**
 * Internet search for the faculty.
 *
 * Page reading is a TypeScript port of Pi's `brave-search` skill
 * (github.com/badlogic/pi-skills, MIT, (c) Mario Zechner): Mozilla
 * Readability + Turndown turn a page into clean markdown. Pi's coding agent
 * runs that skill as shell scripts; Alex's agents have no shell, so the logic
 * runs here as native tools.
 *
 * Search runs every configured engine IN PARALLEL and fuses the results:
 *   BRAVE_API_KEY   Brave Search (what Pi uses)
 *   TAVILY_API_KEY  Tavily
 * Results are de-duplicated by URL, tagged with the engines that found them,
 * and ranked with reciprocal-rank fusion, so pages both engines agree on rise
 * to the top: a cheap first cross-check. If one engine fails (quota, outage,
 * bad key), the other's results are used; if all fail or none is configured,
 * Wikipedia's public API is the last resort.
 *
 *   ALEX_SEARCH_ENGINES   comma list to restrict/order engines, e.g. "tavily,brave"
 *   ALEX_TAVILY_DEPTH     basic (default) | advanced
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Engines that returned this URL (cross-engine agreement). */
  foundBy: EngineName[];
  domain: string;
  score: number;
  age?: string;
  content?: string;
}

export interface SearchOptions {
  count?: number; // 1..20, default 5
  /** pd | pw | pm | py | YYYY-MM-DDtoYYYY-MM-DD */
  freshness?: string;
  country?: string; // two-letter code, default US (Brave)
  /** Fetch each result and include its readable content as markdown. */
  includeContent?: boolean;
}

export type EngineName = "brave" | "tavily" | "wikipedia";

export interface EngineReport {
  engine: EngineName;
  ok: boolean;
  results: number;
  error?: string;
  ms: number;
}

export interface SearchResult {
  hits: SearchHit[];
  engines: EngineReport[];
  /** Human-readable engine summary, e.g. "brave+tavily" or "tavily (brave failed)". */
  provider: string;
}

/** Keyed engines that are configured, in preference order. */
export function configuredEngines(): EngineName[] {
  const has: Record<string, boolean> = { brave: !!process.env.BRAVE_API_KEY, tavily: !!process.env.TAVILY_API_KEY };
  const order = (process.env.ALEX_SEARCH_ENGINES ?? "brave,tavily").split(",").map((x) => x.trim().toLowerCase());
  return order.filter((e): e is EngineName => (e === "brave" || e === "tavily") && has[e]);
}

/** Short label for status/logging: "brave+tavily", "tavily" or "wikipedia". */
export function searchProvider(): string {
  const e = configuredEngines();
  return e.length ? e.join("+") : "wikipedia";
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BOT_UA = "ProjectAlex/0.3 (AI learning assistant)";

interface RawHit {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

const ENGINES: Record<EngineName, (q: string, n: number, o: SearchOptions) => Promise<RawHit[]>> = {
  brave: braveSearch,
  tavily: tavilySearch,
  wikipedia: (q, n) => wikipediaSearch(q, n),
};

export async function webSearch(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const count = Math.max(1, Math.min(20, opts.count ?? 5));
  const engines = configuredEngines();
  const runs = await Promise.all(engines.map((e) => runEngine(e, query, count, opts)));
  if (!runs.some((r) => r.report.ok && r.hits.length)) runs.push(await runEngine("wikipedia", query, count, opts));

  const hits = fuse(runs.filter((r) => r.report.ok).map((r) => ({ engine: r.report.engine, hits: r.hits }))).slice(0, count);
  if (opts.includeContent) await attachContent(hits);

  const reports = runs.map((r) => r.report);
  const ok = reports.filter((r) => r.ok).map((r) => r.engine);
  const failed = reports.filter((r) => !r.ok).map((r) => r.engine);
  const provider = (ok.join("+") || "none") + (failed.length ? ` (${failed.join(", ")} failed)` : "");
  return { hits, engines: reports, provider };
}

async function runEngine(engine: EngineName, query: string, count: number, opts: SearchOptions) {
  const t0 = Date.now();
  // One retry on transient failures (rate limit, 5xx, network) before giving up on this engine.
  for (let attempt = 0; ; attempt++) {
    try {
      const hits = (await ENGINES[engine](query, count, opts)).filter((h) => /^https?:\/\//.test(h.url));
      return { hits, report: { engine, ok: true, results: hits.length, ms: Date.now() - t0 } as EngineReport };
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt === 0 && /HTTP (429|5\d\d)|fetch failed|timeout|ECONN/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      return { hits: [] as RawHit[], report: { engine, ok: false, results: 0, error: msg.slice(0, 200), ms: Date.now() - t0 } as EngineReport };
    }
  }
}

/** Reciprocal-rank fusion across engines, merging duplicates by normalized URL. */
function fuse(lists: { engine: EngineName; hits: RawHit[] }[]): SearchHit[] {
  const K = 60;
  const byUrl = new Map<string, SearchHit>();
  for (const { engine, hits } of lists) {
    hits.forEach((h, rank) => {
      const key = normalizeUrl(h.url);
      const existing = byUrl.get(key);
      const add = 1 / (K + rank + 1);
      if (existing) {
        existing.score += add;
        if (!existing.foundBy.includes(engine)) existing.foundBy.push(engine);
        if (h.snippet.length > existing.snippet.length) existing.snippet = h.snippet;
        existing.age ??= h.age;
      } else {
        byUrl.set(key, { title: h.title, url: h.url, snippet: h.snippet, age: h.age, foundBy: [engine], domain: domainOf(h.url), score: add });
      }
    });
  }
  return [...byUrl.values()].sort((a, b) => b.foundBy.length - a.foundBy.length || b.score - a.score);
}

async function attachContent(hits: SearchHit[]) {
  await Promise.all(
    hits.map(async (h) => {
      try {
        h.content = (await readPage(h.url)).markdown.slice(0, 5000);
      } catch (e) {
        h.content = `(Could not read page: ${(e as Error).message})`;
      }
    }),
  );
}

export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const p of [...x.searchParams.keys()]) if (/^(utm_|ref$|fbclid$|gclid$)/i.test(p)) x.searchParams.delete(p);
    const host = x.hostname.replace(/^(www\.|m\.)/, "").toLowerCase();
    return `${host}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return u;
  }
}

export const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return u;
  }
};

// ------------------------------------------------------------------ engines

async function braveSearch(query: string, count: number, opts: SearchOptions): Promise<RawHit[]> {
  const params = new URLSearchParams({ q: query, count: String(count), country: (opts.country ?? "US").toUpperCase() });
  if (opts.freshness) params.append("freshness", opts.freshness);
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": process.env.BRAVE_API_KEY! },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Brave HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const data: any = await r.json();
  return (data.web?.results ?? []).slice(0, count).map((x: any) => ({
    title: x.title ?? "",
    url: x.url ?? "",
    snippet: stripTags(x.description ?? ""),
    age: x.age || x.page_age || undefined,
  }));
}

const TAVILY_TIME: Record<string, string> = { pd: "day", pw: "week", pm: "month", py: "year" };

async function tavilySearch(query: string, count: number, opts: SearchOptions): Promise<RawHit[]> {
  const body: Record<string, unknown> = { query, max_results: count, search_depth: process.env.ALEX_TAVILY_DEPTH === "advanced" ? "advanced" : "basic" };
  if (opts.freshness && TAVILY_TIME[opts.freshness]) body.time_range = TAVILY_TIME[opts.freshness];
  const range = opts.freshness?.match(/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/);
  if (range) Object.assign(body, { start_date: range[1], end_date: range[2] });
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j: any = await r.json();
  return (j.results ?? []).map((x: any) => ({ title: x.title ?? "", url: x.url ?? "", snippet: String(x.content ?? "").slice(0, 600), age: x.published_date || undefined }));
}

async function wikipediaSearch(query: string, count: number): Promise<RawHit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${count}&srsearch=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { "User-Agent": BOT_UA }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Wikipedia HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.query?.search ?? []).map((x: any) => ({
    title: x.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`,
    snippet: stripTags(x.snippet ?? ""),
  }));
}

// ------------------------------------------------------------------ cross-verification

export interface Evidence {
  title: string;
  url: string;
  domain: string;
  foundBy: EngineName[];
  /** Sentences from the page that best match the claim (empty if unreadable). */
  passages: string[];
  /** Share of the claim's key terms found in the best passage, 0..1. */
  overlap: number;
  error?: string;
}

/**
 * Gather independent evidence for a claim: search every engine, keep at most
 * one page per domain, read the pages, and pull the passages that best match
 * the claim. The agent then judges agreement; the numbers are a guide only.
 */
export async function gatherEvidence(claim: string, maxSources = 4): Promise<{ provider: string; engines: EngineReport[]; evidence: Evidence[] }> {
  const { hits, engines, provider } = await webSearch(claim, { count: 10 });
  const seen = new Set<string>();
  const picked = hits.filter((h) => (seen.has(h.domain) ? false : (seen.add(h.domain), true))).slice(0, maxSources);
  const terms = new Set(tokenize(claim).filter((t) => t.length > 2));
  const evidence = await Promise.all(
    picked.map(async (h): Promise<Evidence> => {
      const base = { title: h.title, url: h.url, domain: h.domain, foundBy: h.foundBy };
      let text = h.snippet;
      let error: string | undefined;
      try {
        text = (await readPage(h.url, 40_000)).markdown;
      } catch (e) {
        error = (e as Error).message;
      }
      const ranked = splitSentences(text)
        .map((s) => ({ s, hit: tokenize(s).filter((t) => terms.has(t)).length }))
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit)
        .slice(0, 2);
      const best = ranked[0]?.hit ?? 0;
      return { ...base, passages: ranked.map((x) => x.s), overlap: terms.size ? Math.round((best / terms.size) * 100) / 100 : 0, ...(error ? { error } : {}) };
    }),
  );
  return { provider, engines, evidence };
}

const splitSentences = (t: string) =>
  t
    .replace(/[#>*_`|]+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 30 && s.length <= 400);

// ------------------------------------------------------------------ reading pages

export interface Page {
  title: string;
  markdown: string;
}

/**
 * Fetch a URL and extract its readable content as markdown (the skill's
 * content.js): Readability first, then a main-content fallback. PDFs are
 * handled too; Wikipedia pages use the plain-text extract API.
 */
export async function readPage(url: string, maxChars = 60_000): Promise<Page> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be read");
  assertPublicHost(url);

  const wiki = url.match(/^https?:\/\/(\w+)\.wikipedia\.org\/wiki\/([^#?]+)/);
  if (wiki) {
    const api = `https://${wiki[1]}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${wiki[2]}`;
    const r = await fetch(api, { headers: { "User-Agent": BOT_UA }, signal: AbortSignal.timeout(15_000) });
    const j: any = await r.json();
    const page: any = Object.values(j.query?.pages ?? {})[0];
    const text = String(page?.extract ?? "").replace(/^(=+)\s*(.+?)\s*\1$/gm, (_m, eq: string, h: string) => `${"#".repeat(Math.min(6, eq.length))} ${h}`);
    return { title: page?.title ?? decodeURIComponent(wiki[2]), markdown: text.slice(0, maxChars) };
  }

  const r = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > 25 * 1024 * 1024) throw new Error("Page is too large (over 25 MB)");

  if (type.includes("pdf") || /\.pdf($|\?)/i.test(url)) {
    const pdf = await getDocumentProxy(new Uint8Array(await r.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    const body = Array.isArray(text) ? text.join("\n\n") : text;
    return { title: url.split("/").pop() ?? url, markdown: body.slice(0, maxChars) };
  }

  const html = await r.text();
  if (!type.includes("html") && !/^\s*</.test(html)) return { title: url, markdown: html.slice(0, maxChars) };
  const page = htmlToPage(html, url);
  return { ...page, markdown: page.markdown.slice(0, maxChars) };
}

export function htmlToPage(html: string, url = "https://example.invalid/"): Page {
  const virtualConsole = new VirtualConsole(); // silence CSS/script parse noise from arbitrary pages
  const dom = new JSDOM(html, { url, virtualConsole });
  const article = new Readability(dom.window.document).parse();
  if (article?.content) return { title: article.title ?? "", markdown: htmlToMarkdown(article.content) };

  // Fallback: main content without page chrome.
  const doc = new JSDOM(html, { url, virtualConsole }).window.document;
  doc.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((el) => el.remove());
  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  const main = doc.querySelector("main, article, [role='main'], .content, #content") ?? doc.body;
  const inner = main?.innerHTML ?? "";
  if (inner.trim().length > 100) return { title, markdown: htmlToMarkdown(inner) };
  throw new Error("Could not extract readable content from this page");
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  turndown.use(gfm);
  turndown.addRule("removeEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  turndown.remove(["script", "style", "iframe", "form"]);
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
    .replace(/ +/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Back-compat helper used by ingestion: page text as markdown. */
export async function fetchPageText(url: string, maxChars = 60_000): Promise<string> {
  const p = await readPage(url, maxChars);
  return p.title && !p.markdown.startsWith("#") ? `# ${p.title}\n\n${p.markdown}` : p.markdown;
}

/** Refuse obvious internal targets so agents/students can't make the server fetch its own network. */
function assertPublicHost(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1" ||
    host.startsWith("[")
  ) {
    throw new Error("That address is not reachable from Alex");
  }
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
