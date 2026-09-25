import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherEvidence, htmlToPage, readPage, webSearch } from "../src/library/webSearch.js";

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

// ---- fetch stub: fake Brave, Tavily, Wikipedia and web pages
type Behaviour = { brave?: "ok" | "500" | "429-once"; tavily?: "ok" | "401" };
function stubFetch(b: Behaviour) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let braveCalls = 0;
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://api.search.brave.com/")) {
      braveCalls++;
      if (b.brave === "500") return new Response("boom", { status: 500 });
      if (b.brave === "429-once" && braveCalls === 1) return new Response("slow down", { status: 429 });
      return json({ web: { results: [
        { title: "Photosynthesis — Britannica", url: "https://www.britannica.com/science/photosynthesis?utm_source=x", description: "How <strong>plants</strong> make food", age: "2 days ago" },
        { title: "Photosynthesis | Khan", url: "https://www.khanacademy.org/ps", description: "Khan lesson" },
      ] } });
    }
    if (url === "https://api.tavily.com/search") {
      if (b.tavily === "401") return new Response("bad key", { status: 401 });
      return json({ results: [
        { title: "Photosynthesis", url: "https://britannica.com/science/photosynthesis", content: "Photosynthesis is the process by which green plants use light energy to make glucose." },
        { title: "Photosynthesis - OpenStax", url: "https://openstax.org/books/biology/ps", content: "OpenStax chapter" },
      ] });
    }
    if (url.includes("wikipedia.org/w/api.php?action=query&list=search")) return json({ query: { search: [{ title: "Photosynthesis", snippet: "wiki <b>snippet</b>" }] } });
    return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return calls;
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    await fn();
  } finally {
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
}

const BOTH = { BRAVE_API_KEY: "brave-test", TAVILY_API_KEY: "tvly-test", ALEX_SEARCH_ENGINES: undefined };

test("both engines run in parallel; results merged, de-duplicated and ranked by agreement", () =>
  withEnv(BOTH, async () => {
    const calls = stubFetch({ brave: "ok", tavily: "ok" });
    const { provider, hits, engines } = await webSearch("photosynthesis grade 9", { count: 5, freshness: "py", country: "in" });
    assert.equal(provider, "brave+tavily");
    assert.deepEqual(engines.map((e) => [e.engine, e.ok]), [["brave", true], ["tavily", true]]);
    assert.equal(hits.length, 3, "britannica appears once despite www./utm/trailing differences");
    assert.equal(hits[0].domain, "britannica.com");
    assert.deepEqual(hits[0].foundBy.sort(), ["brave", "tavily"], "cross-engine agreement ranks first");
    assert.match(hits[0].snippet, /green plants use light energy/, "keeps the richer snippet");
    const brave = new URL(calls.find((c) => c.url.includes("brave"))!.url);
    assert.equal(brave.searchParams.get("country"), "IN");
    assert.equal(brave.searchParams.get("freshness"), "py");
    assert.equal((calls.find((c) => c.url.includes("brave"))!.init!.headers as any)["X-Subscription-Token"], "brave-test");
    const tavily = calls.find((c) => c.url.includes("tavily"))!;
    assert.equal((tavily.init!.headers as any).Authorization, "Bearer tvly-test");
    assert.equal(JSON.parse(String(tavily.init!.body)).time_range, "year", "freshness mapped for Tavily");
  }));

test("if Brave fails, Tavily carries on (and the failure is reported)", () =>
  withEnv(BOTH, async () => {
    stubFetch({ brave: "500", tavily: "ok" });
    const { provider, hits, engines } = await webSearch("photosynthesis");
    assert.equal(provider, "tavily (brave failed)");
    assert.ok(hits.length >= 2 && hits.every((h) => h.foundBy.join() === "tavily"));
    assert.match(engines.find((e) => e.engine === "brave")!.error!, /HTTP 500/);
  }));

test("if Tavily fails, Brave carries on", () =>
  withEnv(BOTH, async () => {
    stubFetch({ brave: "ok", tavily: "401" });
    const { provider, hits } = await webSearch("photosynthesis");
    assert.equal(provider, "brave (tavily failed)");
    assert.ok(hits.every((h) => h.foundBy.join() === "brave"));
  }));

test("a rate-limited engine is retried once", () =>
  withEnv(BOTH, async () => {
    stubFetch({ brave: "429-once", tavily: "ok" });
    const { provider } = await webSearch("photosynthesis");
    assert.equal(provider, "brave+tavily");
  }));

test("both engines down (or no keys) → Wikipedia as last resort", async () => {
  await withEnv(BOTH, async () => {
    stubFetch({ brave: "500", tavily: "401" });
    const { provider, hits } = await webSearch("photosynthesis");
    assert.equal(provider, "wikipedia (brave, tavily failed)");
    assert.equal(hits[0].domain, "en.wikipedia.org");
  });
  await withEnv({ BRAVE_API_KEY: undefined, TAVILY_API_KEY: undefined }, async () => {
    stubFetch({});
    assert.equal((await webSearch("photosynthesis")).provider, "wikipedia");
  });
});

test("includeContent reads each result with the Readability pipeline", () =>
  withEnv(BOTH, async () => {
    stubFetch({ brave: "ok", tavily: "ok" });
    const { hits } = await webSearch("photosynthesis", { includeContent: true, count: 2 });
    assert.match(hits[0].content!, /chloroplasts/);
  }));

test("verify_fact evidence: one source per domain, matching passages extracted", () =>
  withEnv(BOTH, async () => {
    stubFetch({ brave: "ok", tavily: "ok" });
    const { evidence } = await gatherEvidence("Photosynthesis happens in the chloroplasts which contain chlorophyll", 4);
    const domains = evidence.map((e) => e.domain);
    assert.equal(new Set(domains).size, domains.length, "independent domains only");
    assert.ok(evidence.length >= 3);
    assert.ok(evidence.every((e) => e.passages.some((p) => /chloroplasts/.test(p))));
    assert.ok(evidence[0].overlap >= 0.5);
  }));

test("page reader refuses internal addresses", async () => {
  for (const u of ["http://localhost:8787/api/status", "http://127.0.0.1/", "http://10.0.0.5/x", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data"]) {
    await assert.rejects(readPage(u), /not reachable/);
  }
});
