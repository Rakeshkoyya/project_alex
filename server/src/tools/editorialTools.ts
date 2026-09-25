import { Type } from "@mariozechner/pi-ai";
import { json, tool, type RoleContext } from "../harness/runner.js";
import { newId, now } from "../store/store.js";
import type { Assessment, BloomLevel, Question, QuestionType } from "../store/types.js";

const QTYPE = ["mcq", "short", "numeric", "true-false"] as const;
const BLOOM = ["remember", "understand", "apply", "analyze", "evaluate", "create"] as const;

export function editorialTools(ctx: RoleContext) {
  return [
    tool("get_concepts", "Read concept map", "List the course concepts with ids, depth and current mastery estimate.", Type.Object({}), () => {
      const c = ctx.store.getCourse(ctx.courseId);
      return json(c.concepts.map((k) => ({ id: k.id, title: k.title, description: k.description, depth: k.depth, prerequisites: k.prerequisites, pKnown: Math.round(k.pKnown * 100) / 100, targetBloom: k.targetBloom })));
    }),
    tool(
      "create_assessment",
      "Write assessment",
      "Create an assessment for the student. Every question must target exactly one concept id. For mcq, `answer` must equal one of `options` exactly. For true-false, options are ['True','False'].",
      Type.Object({
        kind: Type.Union([Type.Literal("diagnostic"), Type.Literal("quiz"), Type.Literal("checkpoint"), Type.Literal("final")]),
        title: Type.String(),
        questions: Type.Array(
          Type.Object({
            conceptId: Type.String(),
            type: Type.Union(QTYPE.map((t) => Type.Literal(t))),
            prompt: Type.String(),
            options: Type.Optional(Type.Array(Type.String())),
            answer: Type.String(),
            rubric: Type.Optional(Type.String({ description: "For short answers: what a full-credit answer must contain." })),
            difficulty: Type.Number({ minimum: 1, maximum: 5 }),
            bloom: Type.Union(BLOOM.map((b) => Type.Literal(b))),
          }),
          { minItems: 1 },
        ),
      }),
      ({ kind, title, questions }) => {
        const c = ctx.store.getCourse(ctx.courseId);
        const ids = new Set(c.concepts.map((k) => k.id));
        for (const q of questions) {
          if (!ids.has(q.conceptId)) throw new Error(`Unknown conceptId ${q.conceptId}`);
          if (q.type === "mcq" && !(q.options ?? []).includes(q.answer)) throw new Error(`MCQ "${q.prompt.slice(0, 40)}": answer must be one of the options`);
        }
        const a: Assessment = {
          id: newId("asm"),
          kind,
          title,
          sessionId: ctx.sessionId,
          status: "open",
          results: [],
          createdAt: now(),
          questions: questions.map((q) => ({
            ...q,
            id: newId("q"),
            type: q.type as QuestionType,
            options: q.type === "true-false" ? ["True", "False"] : q.options,
            difficulty: Math.round(q.difficulty) as Question["difficulty"],
            bloom: q.bloom as BloomLevel,
          })),
        };
        ctx.store.update(ctx.courseId, (c) => c.assessments.push(a));
        ctx.emit({ type: "ui", role: "editorial", name: "assessment_ready", payload: { assessmentId: a.id, kind } });
        return { text: `Assessment ${a.id} created with ${a.questions.length} questions.`, details: { assessmentId: a.id } };
      },
    ),
    tool(
      "get_submission",
      "Read submission",
      "Read a submitted assessment: questions, rubrics, the student's responses and any auto-graded results.",
      Type.Object({ assessmentId: Type.String() }),
      ({ assessmentId }) => {
        const a = ctx.store.getCourse(ctx.courseId).assessments.find((x) => x.id === assessmentId);
        if (!a) throw new Error("Unknown assessment");
        return json(a.questions.map((q) => ({ questionId: q.id, type: q.type, prompt: q.prompt, answer: q.answer, rubric: q.rubric, result: a.results.find((r) => r.questionId === q.id) })));
      },
    ),
    tool(
      "record_grades",
      "Record grades",
      "Record grades for open-ended questions (score 0..1, partial credit allowed) with specific, neutral feedback. Grade only against the rubric.",
      Type.Object({
        assessmentId: Type.String(),
        grades: Type.Array(Type.Object({ questionId: Type.String(), score: Type.Number({ minimum: 0, maximum: 1 }), feedback: Type.String() })),
      }),
      ({ assessmentId, grades }) => {
        ctx.store.update(ctx.courseId, (c) => {
          const a = c.assessments.find((x) => x.id === assessmentId);
          if (!a) throw new Error("Unknown assessment");
          for (const g of grades) {
            const r = a.results.find((x) => x.questionId === g.questionId);
            if (!r) throw new Error(`No response for ${g.questionId}`);
            Object.assign(r, { score: g.score, feedback: g.feedback, gradedBy: "editorial" });
          }
        });
        return `Recorded ${grades.length} grades.`;
      },
    ),
    tool(
      "write_exam_report",
      "Write exam report",
      "Write the neutral examiner's report for the record: strengths, gaps (by concept), misconceptions observed.",
      Type.Object({ assessmentId: Type.String(), summary: Type.String() }),
      ({ assessmentId, summary }) => {
        ctx.store.update(ctx.courseId, (c) => {
          const a = c.assessments.find((x) => x.id === assessmentId);
          if (!a) throw new Error("Unknown assessment");
          a.summary = summary;
        });
        return "Report saved.";
      },
    ),
  ];
}
