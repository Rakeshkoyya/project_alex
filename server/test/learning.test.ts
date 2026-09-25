import { test } from "node:test";
import assert from "node:assert/strict";
import { bktUpdate } from "../src/learning/bkt.js";
import { review, intervalDays, newCardState } from "../src/learning/fsrs.js";
import { recordAttempt, frontier, weakestPrerequisites } from "../src/learning/zpd.js";
import { newConcept } from "../src/learning/grading.js";
import type { CourseState, Flashcard } from "../src/store/types.js";

const course = (): CourseState =>
  ({
    id: "c", studentId: "s", title: "t", goal: "g", hoursPerWeek: 3, stage: "active", createdAt: "",
    bag: { resources: [], notes: [], keyPoints: [], flashcards: [] }, assessments: [], sessions: [], diary: [], activity: [], threads: {},
    concepts: [
      newConcept({ id: "basics", title: "Grade 5 basics", depth: 2, pKnown: 0.3 }),
      newConcept({ id: "mid", title: "Grade 7 idea", depth: 1, prerequisites: ["basics"], pKnown: 0.7 }),
      newConcept({ id: "target", title: "Grade 9 topic", depth: 0, prerequisites: ["mid"], pKnown: 0.4 }),
    ],
  }) as CourseState;

test("BKT: correct answers raise P(known), hints weaken the evidence", () => {
  const unaided = bktUpdate(0.4, true, 0);
  const aided = bktUpdate(0.4, true, 4);
  assert.ok(unaided > 0.4 && aided > 0.4);
  assert.ok(unaided > aided, "a correct answer after a worked example is weaker evidence");
  assert.ok(bktUpdate(0.4, false, 0) < 0.4);
});

test("ZPD: contingent shift — fail → more support, success with help → fade", () => {
  const c = course();
  assert.equal(recordAttempt(c, "mid", false, 0).action, "increase-support");
  assert.equal(recordAttempt(c, "mid", false, 1).nextHintLevel, 2);
  const r = recordAttempt(c, "mid", true, 3);
  assert.equal(r.action, "fade-support");
  assert.equal(r.nextHintLevel, 2);
});

test("ZPD: failing after a worked example steps down to the weakest, most basic prerequisite", () => {
  const c = course();
  const r = recordAttempt(c, "target", false, 4);
  assert.equal(r.action, "step-down");
  assert.equal(r.stepDownTo?.[0].id, "basics", "fix the lowest brick first (grade 5 before grade 9)");
  assert.deepEqual(weakestPrerequisites(c, "target").map((x) => x.id), ["basics"]);
});

test("ZPD: frontier only contains concepts whose prerequisites are solid", () => {
  const c = course();
  // "mid" is blocked by weak basics; "target" is open because mid (0.7) is solid enough.
  assert.deepEqual(frontier(c).map((k) => k.id), ["basics", "target"]);
  c.concepts[0].pKnown = 0.9;
  c.concepts[1].pKnown = 0.3;
  assert.deepEqual(frontier(c).map((k) => k.id), ["mid"]);
});

test("ZPD: repeated unaided success reaches mastery and advances", () => {
  const c = course();
  let r;
  for (let i = 0; i < 4; i++) r = recordAttempt(c, "mid", true, 0);
  assert.equal(r!.action, "advance");
  assert.equal(c.concepts[1].status, "mastered");
});

test("FSRS: good reviews grow the interval, a lapse shrinks stability", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  let card: Flashcard = { id: "x", front: "f", back: "b", ...newCardState(t0) };
  card = review(card, 3, t0);
  const s1 = card.stability;
  const t1 = new Date(card.due);
  card = review(card, 3, t1);
  assert.ok(card.stability > s1, "stability grows after a successful spaced review");
  assert.ok(intervalDays(card.stability) > intervalDays(s1));
  const lapsed = review(card, 1, new Date(card.due));
  assert.ok(lapsed.stability < card.stability);
  assert.equal(lapsed.lapses, 1);
});
