import { Type } from "@earendil-works/pi-ai";
import { json } from "@alex/harness";
import { t, type AlexCtx } from "../context.js";
import { newConcept } from "../learning/grading.js";
import { refreshStatuses } from "../learning/zpd.js";
import { now } from "../store/store.js";
import type { BloomLevel, CourseState } from "../store/types.js";

const BLOOM = ["remember", "understand", "apply", "analyze", "evaluate", "create"] as const;
const Bloom = Type.Union(BLOOM.map((b) => Type.Literal(b)));

export const conceptId = (key: string) =>
  "c_" + key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export function courseBrief(c: CourseState) {
  const diag = c.assessments.filter((a) => a.kind === "diagnostic" && a.status === "graded").at(-1);
  return {
    title: c.title,
    goal: c.goal,
    studentSaysTheirLevelIs: c.currentLevel ?? "not stated",
    deadline: c.deadline ?? "none (self-paced)",
    hoursPerWeek: c.hoursPerWeek,
    today: now().slice(0, 10),
    bag: c.bag.resources.map((r) => ({ id: r.id, title: r.title, kind: r.kind, summary: r.summary })),
    concepts: c.concepts.map((k) => ({ id: k.id, title: k.title, depth: k.depth, prerequisites: k.prerequisites, pKnown: Math.round(k.pKnown * 100) / 100, zone: k.zone, status: k.status })),
    diagnostic: diag ? { score: diag.score, perConcept: diag.conceptScores, editorialSummary: diag.summary } : "not taken yet",
    roadmap: c.roadmap ? { modules: c.roadmap.modules.map((m) => ({ id: m.id, title: m.title, status: m.status })) } : "none yet",
  };
}

export function advisorTools() {
  return [
    t("get_course_brief", "Read course brief", "Goal, deadline, student's self-described level, bag contents, concept map and diagnostic results.", Type.Object({}), (_p, ctx) =>
      json(courseBrief(ctx.store.getCourse(ctx.courseId))),
    ),
    t(
      "set_concept_map",
      "Draft concept map",
      "Define the course's knowledge graph. Include the target concepts (depth 0) AND the foundations they rest on (depth 1 = one level more basic, depth 2 = even more basic...). Prerequisites reference other concept keys. Keep existing mastery for concepts that already exist.",
      Type.Object({
        concepts: Type.Array(
          Type.Object({
            key: Type.String({ description: "Short stable key, e.g. 'balanced-equations'" }),
            title: Type.String(),
            description: Type.String(),
            prerequisites: Type.Array(Type.String(), { description: "keys of prerequisite concepts" }),
            depth: Type.Number({ minimum: 0, maximum: 5 }),
            targetBloom: Bloom,
          }),
          { minItems: 2 },
        ),
      }),
      ({ concepts }, ctx) => {
        ctx.store.update(ctx.courseId, (c) => {
          const keep = new Map(c.concepts.map((k) => [k.id, k]));
          c.concepts = concepts.map((k) => {
            const id = conceptId(k.key);
            const prereq = k.prerequisites.map(conceptId).filter((p) => p !== id);
            const old = keep.get(id);
            return old
              ? { ...old, title: k.title, description: k.description, prerequisites: prereq, depth: k.depth, targetBloom: k.targetBloom as BloomLevel }
              : newConcept({ id, title: k.title, description: k.description, prerequisites: prereq, depth: k.depth, targetBloom: k.targetBloom as BloomLevel });
          });
          const ids = new Set(c.concepts.map((k) => k.id));
          for (const k of c.concepts) k.prerequisites = k.prerequisites.filter((p) => ids.has(p));
          refreshStatuses(c);
        });
        ctx.emit({ type: "ui", role: "advisor", name: "concepts_updated", payload: {} });
        return `Concept map saved with ${concepts.length} concepts: ${concepts.map((k) => conceptId(k.key)).join(", ")}`;
      },
    ),
    t(
      "set_roadmap",
      "Publish roadmap",
      "Publish the personalized roadmap (syllabus + timeline). Modules must be ordered so every module only needs concepts from earlier modules or ones the student already knows. Start with the weakest foundations the diagnostic revealed.",
      Type.Object({
        title: Type.String(),
        rationale: Type.String({ description: "2–4 sentences: what the student already knows, the gaps, and how this path joins the dots." }),
        totalDays: Type.Number({ minimum: 1 }),
        modules: Type.Array(
          Type.Object({
            title: Type.String(),
            summary: Type.String(),
            conceptIds: Type.Array(Type.String()),
            objectives: Type.Array(Type.String(), { description: "Measurable learning objectives ('Student can ...')" }),
            exercises: Type.Array(Type.String()),
            assessment: Type.String({ description: "What the checkpoint assessment covers" }),
            startDay: Type.Number({ minimum: 0 }),
            durationDays: Type.Number({ minimum: 1 }),
            memoryTechniques: Type.Array(Type.String()),
          }),
          { minItems: 1 },
        ),
        milestones: Type.Array(Type.Object({ day: Type.Number(), title: Type.String() })),
      }),
      (r, ctx) => {
        const c = ctx.store.getCourse(ctx.courseId);
        const known = new Set(c.concepts.map((k) => k.id));
        const bad = r.modules.flatMap((m) => m.conceptIds).filter((id) => !known.has(id));
        if (bad.length) throw new Error(`Unknown concept ids: ${bad.join(", ")}. Use ids returned by set_concept_map.`);
        ctx.store.update(ctx.courseId, (c) => {
          c.roadmap = {
            title: r.title,
            rationale: r.rationale,
            totalDays: r.totalDays,
            hoursPerWeek: c.hoursPerWeek,
            milestones: r.milestones,
            createdAt: now(),
            modules: r.modules.map((m, i) => ({ ...m, id: `m${i + 1}`, status: i === 0 ? "in-progress" : "upcoming" })),
          };
        });
        ctx.emit({ type: "ui", role: "advisor", name: "roadmap_updated", payload: {} });
        return `Roadmap "${r.title}" published with ${r.modules.length} modules over ${r.totalDays} days.`;
      },
    ),
  ];
}
