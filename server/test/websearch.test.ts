import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToPage, readPage, webSearch } from "../src/library/webSearch.js";

const ARTICLE = `<html><head><title>Photosynthesis explained</title></head><body>
<nav>Home | About | Login</nav>
<article><h1>Photosynthesis explained</h1>
<p>Photosynthesis is the process by which green plants use light energy to make glucose from carbon dioxide and water.</p>
<p>It happens in the <strong>chloroplasts</strong>, which contain the pigment chlorophyll. Oxygen is released as a by-product.</p>
<ul><li>Light-dependent reactions</li><li>Calvin cycle</li></ul>
<table><tr><th>Input</th><th>Output</th></tr><tr><td>CO2 + H2O</td><td>Glucose + O2</td></tr></table>
</article><footer>© 2026 cookie banner</footer><script>track()</script></body></html>`;

test("Readability + Turndown extract clean markdown (Pi brave-search content.js port)", () => {
  const p = htmlToPage(ARTICLE, "https://example.org/ps");
  assert.equal(p.title, "Photosynthesis explained");
  assert.match(p.markdown, /\*\*chloroplasts\*\*/);
  assert.match(p.markdown, /- Light-dependent reactions/);
  assert.match(p.markdown, /\| Input \| Output \|/, "GFM tables survive");
  assert.doesNotMatch(p.markdown, /cookie banner|track\(\)|Login/);
});

test("Brave search: query params, auth header, result shape and --content", async () => {
  const saved = { fetch: globalThis.fetch, brave: process.env.BRAVE_API_KEY, tavily: process.env.TAVILY_API_KEY };
  process.env.BRAVE_API_KEY = "brave-test";
  delete process.env.TAVILY_API_KEY;
  const calls: { url: string; headers: any }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers });
    if (String(url).startsWith("https://api.search.brave.com/")) {
      return new Response(JSON.stringify({ web: { results: [{ title: "Photosynthesis", url: "https://example.org/ps", description: "How <strong>plants</strong> make food", age: "2 days ago" }] } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    const { provider, hits } = await webSearch("photosynthesis grade 9", { count: 3, freshness: "py", country: "in", includeContent: true });
    assert.equal(provider, "brave");
    const q = new URL(calls[0].url);
    assert.equal(q.searchParams.get("q"), "photosynthesis grade 9");
    assert.equal(q.searchParams.get("count"), "3");
    assert.equal(q.searchParams.get("country"), "IN");
    assert.equal(q.searchParams.get("freshness"), "py");
    assert.equal(calls[0].headers["X-Subscription-Token"], "brave-test");
    assert.equal(hits[0].snippet, "How plants make food");
    assert.equal(hits[0].age, "2 days ago");
    assert.match(hits[0].content!, /chloroplasts/);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.brave === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = saved.brave;
    if (saved.tavily !== undefined) process.env.TAVILY_API_KEY = saved.tavily;
  }
});

test("page reader refuses internal addresses", async () => {
  for (const u of ["http://localhost:8787/api/status", "http://127.0.0.1/", "http://10.0.0.5/x", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data"]) {
    await assert.rejects(readPage(u), /not reachable/);
  }
});
