/**
 * ZPD engine — Vygotsky's Zone of Proximal Development made operational.
 *
 * The LLM tutor does the talking; this module does the bookkeeping that keeps
 * the talking inside the ZPD:
 *
 *  - a concept graph with prerequisites (what the student already knows is the
 *    anchor; new concepts are only "ready" when their prerequisites are solid),
 *  - a contingent scaffolding ladder (Wood, Bruner & Ross 1976; Wood & Middleton
 *    1975 "contingent shift": fail → one more level of help, succeed → one less),
 *  - zone classification per concept (can do alone / can do with help / can't
 *    yet even with help), and
 *  - the "step down" rule: when a student fails even with a worked example, the
 *    gap is below this concept, so we descend the prerequisite graph and teach
 *    the weakest foundation first (e.g. 9th-grade science → 5th-grade basics).
 */
import type { Concept, CourseState, ZpdZone } from "../store/types.js";
import { MASTERY_THRESHOLD, READY_THRESHOLD, bktUpdate } from "./bkt.js";

export interface ScaffoldLevel {
  level: number;
  name: string;
  tutorMove: string;
}

export const SCAFFOLD_LADDER: ScaffoldLevel[] = [
  { level: 0, name: "Independent attempt", tutorMove: "Ask an open question and wait. Do not help yet." },
  { level: 1, name: "Metacognitive prompt", tutorMove: "Nudge reflection: 'What do you already know that might help here?' / 'What is the question really asking?'" },
  { level: 2, name: "Conceptual hint", tutorMove: "Point to the relevant idea or principle without applying it for them." },
  { level: 3, name: "Specific hint", tutorMove: "Give the first step or narrow the choice; ask them to complete the rest." },
  { level: 4, name: "Worked example", tutorMove: "Demonstrate a fully worked, parallel example, then give a near-identical problem to try (faded example)." },
  { level: 5, name: "Step down", tutorMove: "The gap is in a prerequisite. Leave this concept and teach the weakest prerequisite first." },
];

export type NextAction = "advance" | "fade-support" | "retry-same-level" | "increase-support" | "step-down";

export interface ZpdRecommendation {
  conceptId: string;
  action: NextAction;
  nextHintLevel: number;
  zone: ZpdZone;
  pKnown: number;
  tutorMove: string;
  stepDownTo?: { id: string; title: string; pKnown: number }[];
  reason: string;
}

export function classifyZone(c: Pick<Concept, "pKnown" | "lastHintLevel" | "attempts">, lastCorrect?: boolean): ZpdZone {
  if (c.pKnown >= MASTERY_THRESHOLD && c.lastHintLevel <= 1) return "can-do-alone";
  if (lastCorrect === false && c.lastHintLevel >= 4) return "beyond";
  if (c.pKnown < 0.2 && c.attempts >= 3) return "beyond";
  return "zpd";
}

/** Record one attempt and return the contingent next move for the tutor. */
export function recordAttempt(course: CourseState, conceptId: string, correct: boolean, hintLevel: number): ZpdRecommendation {
  const c = findConcept(course, conceptId);
  c.attempts += 1;
  if (correct) c.correct += 1;
  c.pKnown = bktUpdate(c.pKnown, correct, hintLevel);
  c.lastHintLevel = hintLevel;
  c.zone = classifyZone(c, correct);
  c.status = c.pKnown >= MASTERY_THRESHOLD ? "mastered" : "learning";
  refreshStatuses(course);
  return recommend(course, c, correct, hintLevel);
}

function recommend(course: CourseState, c: Concept, correct: boolean, hintLevel: number): ZpdRecommendation {
  const base = { conceptId: c.id, zone: c.zone, pKnown: round(c.pKnown) };

  if (correct && c.pKnown >= MASTERY_THRESHOLD && hintLevel <= 1) {
    return { ...base, action: "advance", nextHintLevel: 0, tutorMove: "Celebrate briefly, then move to a harder variation or the next concept on the frontier.", reason: "Correct without meaningful help and mastery estimate is above threshold." };
  }
  if (correct) {
    const next = Math.max(0, hintLevel - 1);
    return { ...base, action: "fade-support", nextHintLevel: next, tutorMove: `Fade scaffolding: pose a similar problem and start at level ${next} (${SCAFFOLD_LADDER[next].name}).`, reason: "Correct, but with support — reduce help one level so responsibility shifts to the student." };
  }
  if (hintLevel >= 4) {
    const weak = weakestPrerequisites(course, c.id);
    if (weak.length) {
      return { ...base, action: "step-down", nextHintLevel: 0, stepDownTo: weak, tutorMove: `${SCAFFOLD_LADDER[5].tutorMove} Start with "${weak[0].title}".`, reason: "Failed even after a worked example; a prerequisite is weak." };
    }
    return { ...base, action: "step-down", nextHintLevel: 0, stepDownTo: [], tutorMove: "Failed after a worked example and no known prerequisite is weak: diagnose the missing foundation with 1–2 probing questions, then call add_prerequisite to register it and teach it first.", reason: "Gap is below this concept but not yet in the concept map." };
  }
  const next = Math.min(4, hintLevel + 1);
  return { ...base, action: "increase-support", nextHintLevel: next, tutorMove: `Contingent shift up: ${SCAFFOLD_LADDER[next].name} — ${SCAFFOLD_LADDER[next].tutorMove}`, reason: "Incorrect — give one more level of help, never more than needed." };
}

/** Prerequisites (recursively) below READY, weakest and most basic first. */
export function weakestPrerequisites(course: CourseState, conceptId: string, seen = new Set<string>()): { id: string; title: string; pKnown: number }[] {
  const c = findConcept(course, conceptId);
  const out: Concept[] = [];
  for (const pid of c.prerequisites) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = course.concepts.find((x) => x.id === pid);
    if (!p) continue;
    // Deeper weak foundations come first: fix the lowest brick before the wall.
    out.push(...weakestPrerequisites(course, pid, seen).map((w) => findConcept(course, w.id)));
    if (p.pKnown < READY_THRESHOLD) out.push(p);
  }
  return out.map((p) => ({ id: p.id, title: p.title, pKnown: round(p.pKnown) }));
}

/**
 * Concepts the student can learn next: not mastered, prerequisites solid.
 * Ordered by the roadmap (current module first), then most foundational, then
 * closest to mastery — the next step that is within reach.
 */
export function frontier(course: CourseState): Concept[] {
  const moduleRank = (id: string) => {
    const mods = course.roadmap?.modules ?? [];
    const i = mods.findIndex((m) => m.status !== "done" && m.conceptIds.includes(id));
    return i < 0 ? mods.length : i;
  };
  return course.concepts
    .filter((c) => c.pKnown < MASTERY_THRESHOLD)
    .filter((c) => c.prerequisites.every((pid) => (course.concepts.find((x) => x.id === pid)?.pKnown ?? 1) >= READY_THRESHOLD))
    .sort((a, b) => moduleRank(a.id) - moduleRank(b.id) || b.depth - a.depth || b.pKnown - a.pKnown);
}

export function refreshStatuses(course: CourseState) {
  const ready = new Set(frontier(course).map((c) => c.id));
  for (const c of course.concepts) {
    if (c.pKnown >= MASTERY_THRESHOLD) c.status = "mastered";
    else if (c.attempts > 0 && ready.has(c.id)) c.status = "learning";
    else if (ready.has(c.id)) c.status = "ready";
    else c.status = "locked";
  }
}

export function findConcept(course: CourseState, idOrTitle: string): Concept {
  const c =
    course.concepts.find((x) => x.id === idOrTitle) ??
    course.concepts.find((x) => x.title.toLowerCase() === idOrTitle.toLowerCase());
  if (!c) throw new Error(`Unknown concept "${idOrTitle}". Known: ${course.concepts.map((x) => `${x.id} (${x.title})`).join(", ")}`);
  return c;
}

const round = (x: number) => Math.round(x * 100) / 100;
