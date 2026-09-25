import { htmlToText } from "./ingest.js";

/**
 * Internet search for the Librarian. Uses Tavily or Brave when a key is
 * configured, otherwise falls back to Wikipedia's public API.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const UA = { "User-Agent": "ProjectAlex/0.1 (learning assistant)" };

export async function webSearch(query: string, limit = 5): Promise<{ provider: string; hits: SearchHit[] }> {
  if (process.env.TAVILY_API_KEY) {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: limit }),
    });
    if (!r.ok) throw new Error(`Tavily search failed: ${r.status}`);
    const j: any = await r.json();
    return { provider: "tavily", hits: (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content })) };
  }
  if (process.env.BRAVE_API_KEY) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY },
    });
    if (!r.ok) throw new Error(`Brave search failed: ${r.status}`);
    const j: any = await r.json();
    return { provider: "brave", hits: (j.web?.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: htmlToText(x.description ?? "") })) };
  }
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Wikipedia search failed: ${r.status}`);
  const j: any = await r.json();
  return {
    provider: "wikipedia",
    hits: (j.query?.search ?? []).map((x: any) => ({
      title: x.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`,
      snippet: htmlToText(x.snippet ?? ""),
    })),
  };
}

/** Fetch a page as plain text (Wikipedia pages use the plain-text extract API). */
export async function fetchPageText(url: string, maxChars = 60_000): Promise<string> {
  const wiki = url.match(/^https?:\/\/(\w+)\.wikipedia\.org\/wiki\/([^#?]+)/);
  if (wiki) {
    const api = `https://${wiki[1]}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${wiki[2]}`;
    const r = await fetch(api, { headers: UA, signal: AbortSignal.timeout(15_000) });
    const j: any = await r.json();
    const page: any = Object.values(j.query?.pages ?? {})[0];
    return String(page?.extract ?? "").replace(/^(=+)\s*(.+?)\s*\1$/gm, "## $2").slice(0, maxChars);
  }
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  const body = await r.text();
  return (type.includes("html") ? htmlToText(body) : body).slice(0, maxChars);
}
