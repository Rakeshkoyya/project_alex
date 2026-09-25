import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.js";
import { Vault } from "../src/library/vault.js";
import { coverage, researchCourse, researchReport } from "../src/library/research.js";
import { authority, sourceQuality } from "../src/library/sourceQuality.js";
import { newConcept } from "../src/learning/grading.js";

test("source quality: authority, cross-engine agreement and penalties", () => {
  assert.equal(authority("britannica.com"), 1);
  assert.equal(authority("cs.stanford.edu"), 1);
  assert.equal(authority("physics.ox.ac.uk"), 1);
  assert.ok(authority("dept.univ.edu") > authority("worldhistory.org") && authority("worldhistory.org") > authority("someblog.io"));
  const q = (domain: string, foundBy: string[], rank = 0) => sourceQuality({ domain, foundBy: foundBy as any, url: `https://${domain}/x` }, rank);
  assert.ok(q("britannica.com", ["brave", "tavily", "wikipedia"]) > q("britannica.com", ["brave"]), "agreement raises quality");
  assert.ok(q("britannica.com", ["brave"]) > q("someblog.io", ["brave", "tavily"]), "authority beats agreement between weak sites");
  assert.ok(q("reddit.com", ["brave", "tavily"]) < 0.35, "forums fall below the ingest threshold");
  assert.ok(q("chegg.com", ["brave"]) < 0.35, "answer farms are excluded");
});

const page = (title: string, extra = "") =>
  `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>${"<p>Photosynthesis converts light energy into chemical energy stored in glucose inside chloroplasts. ".repeat(12)}${extra}</p></article></body></html>`;

test("research engine: parallel multi-engine search, quality ranking, diversity and budget limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "alex-research-"));
  cpSync(join(import.meta.dirname, "../../data/vault"), join(root, "vault"), { recursive: true });
  const store = new Store(root);
  const vault = new Vault(join(root, "vault"));
  const c = store.createCourse({ studentId: "s", title: "Photosynthesis", goal: "Understand photosynthesis", hoursPerWeek: 3 });
  store.update(c.id, (course) => {
    course.research = {
      startedAt: new Date().toISOString(),
      requests: [],
      profile: { level: "grade 9", audience: "for high school students", depth: "standard", assumedKnowledge: [], suspectedGaps: [], notes: "" },
      topics: [
        { id: "t1", title: "Photosynthesis", kind: "core", queries: ["photosynthesis explained", "photosynthesis textbook chapter"], status: "planned", resourceIds: [] },
        { id: "t2", title: "Chloroplasts", kind: "foundation", queries: ["chloroplast structure"], status: "planned", resourceIds: [] },
      ],
    };
  });

  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  process.env.BRAVE_API_KEY = "b";
  process.env.TAVILY_API_KEY = "t";
  delete process.env.ALEX_SEARCH_ENGINES;
  const searched: string[] = [];
  const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.search.brave.com")) {
      searched.push(new URL(url).searchParams.get("q")!);
      return json({ web: { results: [
        { title: "Britannica", url: "https://www.britannica.com/science/photosynthesis", description: "encyclopedia" },
        { title: "Reddit thread", url: "https://www.reddit.com/r/biology/ps", description: "forum" },
        { title: "Broken page", url: "https://broken.edu/ps", description: "university page that fails to load" },
        { title: "Khan", url: "https://www.khanacademy.org/ps", description: "lesson" },
      ] } });
    }
    if (url.includes("api.tavily.com")) {
      searched.push(JSON.parse(String(init!.body)).query);
      return json({ results: [
        { title: "Britannica", url: "https://britannica.com/science/photosynthesis", content: "encyclopedia" },
        { title: "OpenStax", url: "https://openstax.org/books/biology/8-1", content: "textbook" },
        { title: "Chegg answers", url: "https://www.chegg.com/ps", content: "answers" },
      ] });
    }
    if (url.includes("list=search")) return json({ query: { search: [{ title: "Photosynthesis", snippet: "wiki" }] } });
    if (url.includes("prop=extracts")) return json({ query: { pages: { 1: { title: "Photosynthesis", extract: "Photosynthesis is how plants make food. ".repeat(40) } } } });
    if (url.includes("broken.edu")) return new Response("nope", { status: 500 });
    return new Response(page(new URL(url).hostname), { headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  try {
    const events: any[] = [];
    await researchCourse(store, vault, c.id, (e) => events.push(e), { maxPages: 4, perTopic: 2, perDomain: 1, concurrency: 2, minChars: 400 });
    const course = store.getCourse(c.id);
    const web = course.bag.resources.filter((r) => r.kind === "web");
    const domains = web.map((r) => new URL(r.source!).hostname.replace(/^www\./, ""));

    assert.ok(searched.every((q) => q.endsWith("for high school students")), "queries pitched at the learner's audience");
    assert.equal(web.length, 4, "total page budget used exactly (a failed read returns its slot)");
    assert.equal(new Set(domains).size, domains.length, "one page per domain (perDomain: 1)");
    assert.ok(!domains.some((d) => /reddit|chegg/.test(d)), "low-quality sites never ingested");
    assert.ok(domains.includes("britannica.com"), "top authority + agreement source ingested");
    assert.ok(web.every((r) => r.quality! >= 0.35 && r.foundBy!.length >= 1 && r.topicId));
    assert.ok(course.bag.resources.some((r) => r.kind === "vault"), "vault primer gathered too");
    for (const t of course.research!.topics) {
      assert.equal(t.status, "researched");
      assert.ok(t.resourceIds.length > 0);
      assert.match(t.searched!.engines, /brave/);
      assert.ok(course.bag.resources.filter((r) => r.topicId === t.id && r.kind === "web").length <= 2, "per-topic limit");
    }
    assert.ok(course.research!.topics.some((t) => t.searched!.errors.some((e) => /broken\.edu/.test(e))), "unreadable page recorded, next candidate used");
    assert.ok(events.filter((e) => e.type === "tool_start" && e.name === "research_topic").length === 2, "progress streamed per topic");
    assert.match(researchReport(course), /grade 9[\s\S]*Photosynthesis[\s\S]*Chloroplasts/);

    // Coverage: a concept the bag says nothing about is a GAP.
    store.update(c.id, (x) => {
      x.concepts = [newConcept({ id: "c_ps", title: "Photosynthesis", description: "light to glucose" }), newConcept({ id: "c_q", title: "Quantum tunnelling", description: "barrier penetration" })];
    });
    const cov = coverage(store, c.id);
    assert.notEqual(cov.find((x) => x.id === "c_ps")!.status, "GAP");
    assert.equal(cov.find((x) => x.id === "c_q")!.status, "GAP");
  } finally {
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
});
