import { Type } from "@earendil-works/pi-ai";
import { json } from "@alex/harness";
import { t } from "../context.js";
import { newId, now } from "../store/store.js";
import { ingestResource } from "../library/service.js";
import { coverage, researchReport } from "../library/research.js";
import type { LearnerProfile } from "../store/types.js";

const MAX_REQUESTS_PER_RUN = 4;

// ------------------------------------------------------------------ Advisor

export function advisorResearchTools() {
  return [
    t(
      "set_learner_profile",
      "Profile the learner",
      "Record your read of the student BEFORE research starts: their level, how deep to go, what they probably already know (the ZPD anchor) and which foundations may be missing. The Librarian pitches every search and every note to this profile.",
      Type.Object({
        level: Type.String({ description: 'e.g. "grade 9", "first-year undergraduate", "complete beginner", "working professional"' }),
        audience: Type.String({ description: 'Short phrase appended to web searches, e.g. "for high school students", "for beginners". Empty for expert level.' }),
        depth: Type.Union([Type.Literal("intro"), Type.Literal("standard"), Type.Literal("deep")]),
        assumedKnowledge: Type.Array(Type.String()),
        suspectedGaps: Type.Array(Type.String()),
        notes: Type.String({ description: "One or two sentences on how to teach this student." }),
      }),
      (p, ctx) => {
        ctx.store.update(ctx.courseId, (c) => {
          c.research ??= { topics: [], requests: [], startedAt: now() };
          c.research.profile = p as LearnerProfile;
        });
        ctx.emit({ type: "ui", role: "advisor", name: "research_updated", payload: {} });
        return `Learner profile saved: ${p.level}, ${p.depth}.`;
      },
    ),
    t(
      "set_research_plan",
      "Plan the research",
      "Break the goal into 5–12 research topics the Librarian will source material for: the target topics (core) AND the foundations beneath them (foundation), ordered from most basic to most advanced. Give each 1–3 web queries phrased for this student's level (a textbook-chapter query, an explainer query, and for foundations a basics query).",
      Type.Object({
        topics: Type.Array(
          Type.Object({
            title: Type.String(),
            kind: Type.Union([Type.Literal("core"), Type.Literal("foundation")]),
            queries: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
          }),
          { minItems: 2, maxItems: 14 },
        ),
      }),
      ({ topics }, ctx) => {
        const saved = ctx.store.update(ctx.courseId, (c) => {
          c.research ??= { topics: [], requests: [], startedAt: now() };
          const existing = new Map(c.research.topics.map((x) => [x.title.toLowerCase(), x]));
          c.research.topics = topics.map((x) => existing.get(x.title.toLowerCase()) ?? { id: newId("topic"), title: x.title, kind: x.kind, queries: x.queries, status: "planned", resourceIds: [] });
          return c.research.topics;
        });
        ctx.emit({ type: "ui", role: "advisor", name: "research_updated", payload: {} });
        return `Research plan saved with ${saved.length} topics: ${saved.map((x) => `${x.id} ${x.title}`).join("; ")}`;
      },
    ),
    t(
      "coverage_report",
      "Check material coverage",
      "For every concept in the current concept map, how well the student bag supports it (resources that cover it, and GAP / thin / well covered). Use it after drafting the map; request material for GAPs before finalising.",
      Type.Object({}),
      (_p, ctx) => json(coverage(ctx.store, ctx.courseId)),
    ),
    t(
      "request_material",
      "Ask the Librarian",
      `Ask the Librarian to find and write material for a concept the bag doesn't cover well (a GAP or thin concept). The Librarian researches it on the web, writes lecture notes and reports back. At most ${MAX_REQUESTS_PER_RUN} requests per planning step: use them on the most important gaps.`,
      Type.Object({ concept: Type.String(), need: Type.String({ description: "What exactly is missing, at what level" }) }),
      async ({ concept, need }, ctx) => {
        const r0 = ctx.store.getCourse(ctx.courseId).research;
        const since = r0?.windowStart ?? r0?.startedAt ?? "";
        const used = ctx.store.getCourse(ctx.courseId).research?.requests.filter((r) => r.at >= since).length ?? 0;
        if (used >= MAX_REQUESTS_PER_RUN) throw new Error(`Request limit reached (${MAX_REQUESTS_PER_RUN}). Finalise the map with what you have.`);
        const at = now();
        ctx.store.update(ctx.courseId, (c) => {
          c.research ??= { topics: [], requests: [], startedAt: at };
          c.research.requests.push({ concept, need, at });
        });
        const reply = await ctx.delegate(
          "librarian",
          `PHASE: fill-gap. The Advisor needs material for the concept "${concept}": ${need}. Research it (web_search with the learner's level in mind, read_webpage, fetch_and_ingest the best 1–2 sources), then write_lecture_notes for it (topicId "${concept}" is fine if no topic matches). Reply with one short paragraph on what you added.`,
          { thread: "librarian" },
        );
        ctx.store.update(ctx.courseId, (c) => {
          const r = c.research!.requests.find((x) => x.at === at && x.concept === concept);
          if (r) r.result = reply.slice(0, 500);
        });
        return `Librarian: ${reply.slice(0, 1200)}`;
      },
    ),
  ];
}

// ------------------------------------------------------------------ Librarian

export function librarianResearchTools() {
  return [
    t("get_research_report", "Read research dossier", "The learner profile, the research plan, and for each topic the sources already gathered (with quality scores) and whether lecture notes exist.", Type.Object({}), (_p, ctx) =>
      researchReport(ctx.store.getCourse(ctx.courseId)),
    ),
    t(
      "write_lecture_notes",
      "Write lecture notes",
      "Write lecture notes for one research topic from your own knowledge, pitched at the learner profile, in markdown: a plain-language explanation, key definitions, a worked example, common misconceptions, and how it connects to the other topics. Use the gathered sources (search_bag) to stay consistent with them; where you are not sure of a fact, verify_fact it or leave it out. Notes are stored in the bag, marked as AI-written.",
      Type.Object({
        topicId: Type.String({ description: "Topic id from the research report (or a concept title for gap notes)" }),
        title: Type.String(),
        markdown: Type.String({ minLength: 200 }),
        verifiedClaims: Type.Optional(Type.Array(Type.String(), { description: "Key facts you cross-checked with verify_fact or the gathered sources" })),
      }),
      ({ topicId, title, markdown, verifiedClaims }, ctx) => {
        const c = ctx.store.getCourse(ctx.courseId);
        const topic = c.research?.topics.find((x) => x.id === topicId || x.title.toLowerCase() === topicId.toLowerCase());
        const body = verifiedClaims?.length ? `${markdown}\n\n## Cross-checked facts\n${verifiedClaims.map((v) => `- ${v}`).join("\n")}` : markdown;
        const r = ingestResource(ctx.store, ctx.courseId, {
          title: `Lecture notes: ${title}`,
          kind: "notes",
          source: `alex:notes:${topic?.id ?? topicId}`,
          text: `# ${title}\n\n${body}`,
          summary: `AI-written lecture notes${topic ? ` for "${topic.title}"` : ""}, pitched at ${c.research?.profile?.level ?? "the student's level"}${verifiedClaims?.length ? `; ${verifiedClaims.length} key facts cross-checked` : ""}.`,
          addedBy: "librarian",
          topicId: topic?.id,
        });
        if (topic)
          ctx.store.update(ctx.courseId, (course) => {
            const tt = course.research!.topics.find((x) => x.id === topic.id)!;
            tt.notesId = r.id;
            tt.status = "noted";
          });
        ctx.emit({ type: "ui", role: "librarian", name: "bag_updated", payload: { resource: r.title } });
        return `Lecture notes "${title}" saved (${r.chunkCount} passages)${topic ? ` for topic ${topic.id}` : ""}.`;
      },
    ),
  ];
}
