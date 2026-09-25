import { Type } from "@earendil-works/pi-ai";
import { json } from "@alex/harness";
import { t, type AlexCtx } from "../context.js";
import { newId, now } from "../store/store.js";
import { SCAFFOLD_LADDER, findConcept, frontier, recordAttempt, refreshStatuses } from "../learning/zpd.js";
import { newConcept } from "../learning/grading.js";
import { isDue } from "../learning/fsrs.js";
import { conceptId } from "./advisorTools.js";
import { ARTIFACT_KINDS, parkedGenerations } from "@alex/harness";
import type { PlanItem, StudySession } from "../store/types.js";

const ACTIVITIES = ["review", "learn", "practice", "challenge", "remediate", "quiz"] as const;

function session(ctx: AlexCtx): StudySession {
  const s = ctx.store.getCourse(ctx.courseId).sessions.find((x) => x.id === ctx.sessionId);
  if (!s) throw new Error("No active study session");
  return s;
}

export function learnerState(ctx: AlexCtx) {
  const c = ctx.store.getCourse(ctx.courseId);
  const s = c.sessions.find((x) => x.id === ctx.sessionId);
  const module = c.roadmap?.modules.find((m) => m.status === "in-progress");
  const lastQuiz = c.assessments.filter((a) => a.status === "graded").at(-1);
  return {
    goal: c.goal,
    deadline: c.deadline ?? "none",
    currentModule: module ? { id: module.id, title: module.title, objectives: module.objectives, exercises: module.exercises, memoryTechniques: module.memoryTechniques } : "roadmap complete or missing",
    zpdFrontier: frontier(c).slice(0, 5).map((k) => ({ id: k.id, title: k.title, depth: k.depth, pKnown: round(k.pKnown), lastHintLevel: k.lastHintLevel })),
    concepts: c.concepts.map((k) => ({ id: k.id, title: k.title, depth: k.depth, prerequisites: k.prerequisites, pKnown: round(k.pKnown), zone: k.zone, status: k.status })),
    flashcardsDue: c.bag.flashcards.filter((f) => isDue(f)).map((f) => ({ front: f.front, conceptId: f.conceptId })),
    todaysPlan: s?.plan ?? [],
    focusConceptId: s?.focusConceptId,
    recentDiary: c.diary.slice(-5).map((d) => `${d.createdAt.slice(0, 10)} ${d.author}: ${d.text}`),
    lastAssessment: lastQuiz ? { title: lastQuiz.title, score: lastQuiz.score, perConcept: lastQuiz.conceptScores, report: lastQuiz.summary } : "none",
    scaffoldLadder: SCAFFOLD_LADDER.map((l) => `${l.level}. ${l.name}: ${l.tutorMove}`),
  };
}

export function tutorTools() {
  return [
    t("get_learner_state", "Read learner state", "The student's current mastery per concept, ZPD frontier, today's plan, due flashcards, recent diary and last assessment.", Type.Object({}), (_p, ctx) => json(learnerState(ctx))),
    t(
      "set_today_plan",
      "Set today's plan",
      "Set today's study plan (15–60 min total). Typical shape: short spaced review → one new concept from the ZPD frontier → practice → challenge → quiz.",
      Type.Object({
        items: Type.Array(
          Type.Object({
            activity: Type.Union(ACTIVITIES.map((a) => Type.Literal(a))),
            title: Type.String(),
            conceptId: Type.Optional(Type.String()),
            minutes: Type.Number({ minimum: 1, maximum: 60 }),
          }),
          { minItems: 1, maxItems: 8 },
        ),
      }),
      ({ items }, ctx) => {
        const plan: PlanItem[] = items.map((i) => ({ ...i, id: newId("plan"), done: false }));
        ctx.store.update(ctx.courseId, () => {
          session(ctx).plan = plan;
        });
        ctx.emit({ type: "ui", role: "tutor", name: "plan_updated", payload: { plan } });
        return `Plan set: ${plan.map((p) => `${p.id} ${p.activity} "${p.title}"`).join("; ")}`;
      },
    ),
    t("complete_plan_item", "Tick plan item", "Mark an item of today's plan as done.", Type.Object({ planItemId: Type.String() }), ({ planItemId }, ctx) => {
      ctx.store.update(ctx.courseId, () => {
        const item = session(ctx).plan.find((p) => p.id === planItemId);
        if (!item) throw new Error(`No plan item ${planItemId}`);
        item.done = true;
      });
      ctx.emit({ type: "ui", role: "tutor", name: "plan_updated", payload: {} });
      return "Done.";
    }),
    t("set_focus", "Focus concept", "Tell the UI which concept is being taught right now.", Type.Object({ conceptId: Type.String() }), ({ conceptId }, ctx) => {
      const c = ctx.store.update(ctx.courseId, (course) => {
        const k = findConcept(course, conceptId);
        session(ctx).focusConceptId = k.id;
        if (k.status === "ready") k.status = "learning";
        return k;
      });
      ctx.emit({ type: "ui", role: "tutor", name: "focus", payload: { conceptId: c.id, title: c.title } });
      return `Focus: ${c.title} (P(known)=${round(c.pKnown)}, zone=${c.zone})`;
    }),
    t(
      "record_attempt",
      "Record attempt (ZPD)",
      "Call after EVERY student answer to a practice question. Pass the scaffold level that was active when they answered (0 = no help ... 4 = after a worked example). Returns the contingent next move from the ZPD engine — follow it.",
      Type.Object({
        conceptId: Type.String(),
        correct: Type.Boolean(),
        hintLevel: Type.Number({ minimum: 0, maximum: 4 }),
        observation: Type.Optional(Type.String({ description: "What the answer revealed (misconception, partial understanding...)" })),
      }),
      ({ conceptId, correct, hintLevel, observation }, ctx) => {
        const rec = ctx.store.update(ctx.courseId, (c) => {
          const r = recordAttempt(c, conceptId, correct, Math.round(hintLevel));
          if (observation) c.diary.push({ id: newId("d"), sessionId: ctx.sessionId, author: "tutor", text: `[${findConcept(c, conceptId).title}] ${observation}`, createdAt: now() });
          return r;
        });
        ctx.emit({ type: "ui", role: "tutor", name: "mastery", payload: rec });
        return json(rec);
      },
    ),
    t(
      "add_prerequisite",
      "Add foundation concept",
      "Register a missing foundation discovered while teaching (e.g. the student lacks a grade-5 basic needed for this grade-9 concept). It becomes a prerequisite and goes to the front of the ZPD frontier.",
      Type.Object({ forConceptId: Type.String(), title: Type.String(), description: Type.String() }),
      ({ forConceptId, title, description }, ctx) => {
        const k = ctx.store.update(ctx.courseId, (c) => {
          const parent = findConcept(c, forConceptId);
          const id = conceptId(title);
          let k = c.concepts.find((x) => x.id === id);
          if (!k) {
            k = newConcept({ id, title, description, depth: parent.depth + 1, targetBloom: "understand", addedBy: "tutor", pKnown: 0.2 });
            c.concepts.push(k);
          }
          if (!parent.prerequisites.includes(id)) parent.prerequisites.push(id);
          refreshStatuses(c);
          return k;
        });
        ctx.emit({ type: "ui", role: "tutor", name: "concepts_updated", payload: {} });
        return `Foundation "${k.title}" (${k.id}) added under ${forConceptId}. Teach it first, then return.`;
      },
    ),
    t("write_diary", "Write student diary", "Append an entry to the student's diary: observations, breakthroughs, struggles, how they like to learn.", Type.Object({ text: Type.String() }), ({ text }, ctx) => {
      ctx.store.update(ctx.courseId, (c) => c.diary.push({ id: newId("d"), sessionId: ctx.sessionId, author: "tutor", text, createdAt: now() }));
      return "Diary updated.";
    }),
    t(
      "show_artifact",
      "Show learning artifact",
      "Ask the Generations engine for a visual/learning artifact (concept page, image, animation, diagram, mind map, memory palace, slide deck). NOTE: the engine is currently parked — the UI shows a placeholder card, so ALSO describe the visual in words (or an ASCII/markdown diagram) in your reply.",
      Type.Object({ conceptId: Type.Optional(Type.String()), kind: Type.Union(ARTIFACT_KINDS.map((k) => Type.Literal(k))), brief: Type.String() }),
      async ({ conceptId, kind, brief }, ctx) => {
        const art = await parkedGenerations.request({ courseId: ctx.courseId, conceptId, kind, brief });
        ctx.emit({ type: "ui", role: "generations", name: "artifact", payload: art });
        return `Artifact ${art.id} is ${art.status} (Generations engine not yet enabled). Describe it in words instead.`;
      },
    ),
    t(
      "start_session_quiz",
      "Close with quiz",
      "End today's teaching with a short quiz to lock in the knowledge. The independent Editorial examiner writes it; the student takes it in the UI.",
      Type.Object({ conceptIds: Type.Array(Type.String(), { minItems: 1 }), questionCount: Type.Optional(Type.Number({ minimum: 2, maximum: 10 })) }),
      async ({ conceptIds, questionCount }, ctx) => {
        const n = questionCount ?? 4;
        await ctx.delegate(
          "editorial",
          `Write an end-of-session quiz ("kind": "quiz") with ${n} questions on concept ids: ${conceptIds.join(", ")}. Mix retrieval (remember/understand) with at least one apply-level question. Use create_assessment.`,
        );
        const quiz = ctx.store.getCourse(ctx.courseId).assessments.filter((a) => a.kind === "quiz").at(-1);
        if (!quiz) throw new Error("Editorial did not produce a quiz");
        ctx.store.update(ctx.courseId, () => {
          session(ctx).quizId = quiz.id;
        });
        return `Quiz ${quiz.id} is ready in the student's screen (${quiz.questions.length} questions). Tell the student to take it; you'll see the result next session.`;
      },
    ),
  ];
}

const round = (x: number) => Math.round(x * 100) / 100;
