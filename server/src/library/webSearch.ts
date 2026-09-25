import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Internet search for the faculty — a TypeScript port of Pi's `brave-search`
 * skill (github.com/badlogic/pi-skills, MIT, © Mario Zechner): Brave Search
 * API for results, then Mozilla Readability + Turndown to turn each page into
 * clean markdown. Pi's coding agent runs that skill as shell scripts; Alex's
 * agents have no shell, so the same logic runs here as native tools.
 *
 * Providers, in order of preference:
 *   BRAVE_API_KEY   Brave Search (what Pi uses; free "AI" tier available)
 *   TAVILY_API_KEY  Tavily
 *   (none)          Wikipedia's public API — no key, encyclopedic results only
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  age?: string;
  content?: string;
}

export interface SearchOptions {
  count?: number; // 1..20, default 5
  /** pd | pw | pm | py | YYYY-MM-DDtoYYYY-MM-DD (Brave only) */
  freshness?: string;
  country?: string; // two-letter code, default US (Brave only)
  /** Fetch each result and include its readable content as markdown. */
  includeContent?: boolean;
}

export type SearchProvider = "brave" | "tavily" | "wikipedia";

export function searchProvider(): SearchProvider {
  if (process.env.BRAVE_API_KEY) return "brave";
  if (process.env.TAVILY_API_KEY) return "tavily";
  return "wikipedia";
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BOT_UA = "ProjectAlex/0.3 (AI learning assistant)";

export async function webSearch(query: string, opts: SearchOptions = {}): Promise<{ provider: SearchProvider; hits: SearchHit[] }> {
  const count = Math.max(1, Math.min(20, opts.count ?? 5));
  const provider = searchProvider();
  let hits: SearchHit[];
  if (provider === "brave") hits = await braveSearch(query, count, opts);
  else if (provider === "tavily") hits = await tavilySearch(query, count);
  else hits = await wikipediaSearch(query, count);

  if (opts.includeContent) {
    // Same as the skill's --content flag, with a shorter per-page excerpt.
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
  return { provider, hits };
}

async function braveSearch(query: string, count: number, opts: SearchOptions): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, count: String(count), country: (opts.country ?? "US").toUpperCase() });
  if (opts.freshness) params.append("freshness", opts.freshness);
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": process.env.BRAVE_API_KEY! },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Brave search HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data: any = await r.json();
  return (data.web?.results ?? []).slice(0, count).map((x: any) => ({
    title: x.title ?? "",
    url: x.url ?? "",
    snippet: stripTags(x.description ?? ""),
    age: x.age || x.page_age || undefined,
  }));
}

async function tavilySearch(query: string, count: number): Promise<SearchHit[]> {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: count }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Tavily search HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "" }));
}

async function wikipediaSearch(query: string, count: number): Promise<SearchHit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${count}&srsearch=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { "User-Agent": BOT_UA }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Wikipedia search HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.query?.search ?? []).map((x: any) => ({
    title: x.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`,
    snippet: stripTags(x.snippet ?? ""),
  }));
}

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
