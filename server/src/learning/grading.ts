import type { Assessment, Concept, CourseState, Question, QuestionResult } from "../store/types.js";
import { bktUpdate, priorFromScore } from "./bkt.js";
import { classifyZone, refreshStatuses } from "./zpd.js";
import { now } from "../store/store.js";

/**
 * Objective grading happens in code (deterministic, unbiased); only
 * open-ended answers go to the Editorial agent with a rubric.
 */

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s.]+$/g, "").replace(/\s+/g, " ");

export function needsHumanlikeGrading(q: Question) {
  return q.type === "short";
}

export function autoGrade(q: Question, response: string): QuestionResult | undefined {
  const r = response ?? "";
  if (q.type === "mcq" || q.type === "true-false") {
    // Accept the option text or its letter (A, B, C...).
    const letter = /^[a-h]$/i.test(r.trim()) && q.options ? q.options[r.trim().toUpperCase().charCodeAt(0) - 65] : undefined;
    const ok = norm(letter ?? r) === norm(q.answer);
    return { questionId: q.id, response: r, score: ok ? 1 : 0, feedback: ok ? "Correct." : `The answer is: ${q.answer}`, gradedBy: "auto" };
  }
  if (q.type === "numeric") {
    const a = parseFloat(q.answer.replace(/[^\d.eE+-]/g, ""));
    const b = parseFloat(r.replace(/[^\d.eE+-]/g, ""));
    const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 0.01);
    return { questionId: q.id, response: r, score: ok ? 1 : 0, feedback: ok ? "Correct." : `Expected ${q.answer}.`, gradedBy: "auto" };
  }
  return undefined;
}

/** Compute scores and push the evidence into each concept's knowledge estimate. */
export function finalizeAssessment(course: CourseState, a: Assessment) {
  const byConcept = new Map<string, { got: number; total: number }>();
  for (const q of a.questions) {
    const res = a.results.find((r) => r.questionId === q.id);
    const s = byConcept.get(q.conceptId) ?? { got: 0, total: 0 };
    s.got += (res?.score ?? 0) * q.difficulty;
    s.total += q.difficulty;
    byConcept.set(q.conceptId, s);
  }
  const total = a.questions.reduce((s, q) => s + q.difficulty, 0) || 1;
  const got = a.questions.reduce((s, q) => s + (a.results.find((r) => r.questionId === q.id)?.score ?? 0) * q.difficulty, 0);
  a.score = Math.round((got / total) * 100);
  a.conceptScores = Object.fromEntries([...byConcept].map(([k, v]) => [k, Math.round((v.got / (v.total || 1)) * 100) / 100]));
  a.status = "graded";
  a.gradedAt = now();

  for (const [cid, score] of Object.entries(a.conceptScores)) {
    const c = course.concepts.find((x) => x.id === cid);
    if (!c) continue;
    if (a.kind === "diagnostic") {
      c.pKnown = priorFromScore(score);
    } else {
      for (const q of a.questions.filter((q) => q.conceptId === cid)) {
        const res = a.results.find((r) => r.questionId === q.id);
        c.pKnown = bktUpdate(c.pKnown, (res?.score ?? 0) >= 0.5, 0);
        c.attempts += 1;
        if ((res?.score ?? 0) >= 0.5) c.correct += 1;
      }
    }
    c.zone = classifyZone(c);
  }
  refreshStatuses(course);
}

export function newConcept(p: Partial<Concept> & Pick<Concept, "id" | "title">): Concept {
  return {
    description: "",
    prerequisites: [],
    depth: 0,
    targetBloom: "apply",
    pKnown: 0.1,
    zone: "unknown",
    lastHintLevel: 0,
    attempts: 0,
    correct: 0,
    status: "locked",
    addedBy: "advisor",
    ...p,
  };
}

/** Strip answers before sending an assessment to the student's browser. */
export function studentView(a: Assessment) {
  return {
    ...a,
    questions: a.questions.map(({ answer, rubric, ...q }) => (a.status === "graded" ? { ...q, answer } : q)),
  };
}
