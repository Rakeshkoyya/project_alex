/**
 * End-to-end student journey in demo mode: the real Pi agent loop, real tools
 * and real store, with the scripted demo brain standing in for the LLM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ALEX_PROVIDER;
process.env.ALEX_DEMO_TPS = "1000000";

const { app, init } = await import("../src/app.js");
const { Store } = await import("../src/store/store.js");
const { Vault } = await import("../src/library/vault.js");
const P = await import("../src/workflow/pipeline.js");

const root = mkdtempSync(join(tmpdir(), "alex-"));
cpSync(join(import.meta.dirname, "../../data/vault"), join(root, "vault"), { recursive: true });
init(new Store(root), new Vault(join(root, "vault")));

const events: any[] = [];
const emit = (e: any) => events.push(e);

test("student journey: goal → bag → diagnostic → ZPD roadmap → tutoring → quiz", async () => {
  const store = app.store!;
  const c = store.createCourse({ studentId: "me", title: "Photosynthesis", goal: "Understand photosynthesis for grade 9 biology", currentLevel: "weak on chemistry", hoursPerWeek: 4 });

  // 1–3. Librarian, Advisor (concept map), Editorial (diagnostic)
  await P.prepareCourse(c.id, emit);
  let s = store.getCourse(c.id);
  assert.equal(s.stage, "assessment");
  assert.ok(s.bag.resources.some((r) => r.chunkCount > 0), "bag has ingested material");
  assert.ok(s.bag.keyPoints.length > 0 && s.bag.flashcards.length > 0, "points to remember + flashcards");
  assert.ok(s.concepts.some((k) => k.depth > 0) && s.concepts.some((k) => k.depth === 0), "map has targets and foundations");
  // Research dossier: profile, plan, sources per topic, lecture notes, curriculum discussion.
  assert.ok(s.research?.profile, "Advisor profiled the learner");
  assert.ok(s.research!.topics.length >= 2, "Advisor planned research topics");
  assert.ok(s.research!.topics.every((t) => t.status !== "planned"), "every topic was researched");
  assert.ok(s.bag.resources.some((r) => r.kind === "notes"), "Librarian wrote lecture notes from its own knowledge");
  assert.ok(s.research!.topics.filter((t) => t.notesId).length >= 1);
  assert.ok(events.some((e) => e.type === "tool_start" && e.name === "coverage_report"), "Advisor checked coverage of the concept map");
  assert.ok(s.activity.some((a) => a.role === "advisor" && a.text.startsWith("set_research_plan")), "faculty tool calls are logged to the course activity");
  const diag = s.assessments.find((a) => a.kind === "diagnostic")!;
  assert.ok(diag.questions.length >= s.concepts.length);

  // The student is weak on the chemistry foundations.
  const weak = s.concepts.filter((k) => /energy|matter/i.test(k.title)).map((k) => k.id);
  const responses = Object.fromEntries(
    diag.questions.map((q) => [q.id, weak.includes(q.conceptId) ? "no idea" : q.type === "short" ? "plants use light energy to make glucose from carbon dioxide and water releasing oxygen" : q.answer]),
  );
  await P.submitAssessment(c.id, diag.id, responses, emit);
  s = store.getCourse(c.id);
  assert.equal(s.stage, "active");
  assert.ok(s.roadmap && s.roadmap.modules.length > 0);
  assert.equal(s.roadmap!.modules[0].title, "Foundations refresh", "weakest foundations come first");
  for (const id of weak) assert.ok(s.concepts.find((k) => k.id === id)!.pKnown < 0.6);

  // System files are written for the course.
  const roadmapMd = readFileSync(join(store.courseDir(c.id), "roadmap.md"), "utf8");
  assert.match(roadmapMd, /Concept map \(ZPD state\)/);

  // 4. Tutor session: plan, teach, practice with scaffolding
  const sess = await P.startSession(c.id, emit);
  s = store.getCourse(c.id);
  const live = s.sessions.find((x) => x.id === sess.id)!;
  assert.ok(live.plan.length >= 2, "today's plan was set");
  assert.ok(live.focusConceptId, "tutor focused a concept");

  await P.tutorTurn(c.id, sess.id, "I think it has to do with energy?", emit); // activation → explain + question
  await P.tutorTurn(c.id, sess.id, "banana", emit); // wrong → more support
  const before = store.getCourse(c.id).concepts.find((k) => k.id === live.focusConceptId)!;
  assert.equal(before.attempts, 1);
  assert.ok(events.some((e) => e.type === "ui" && e.name === "mastery" && e.payload.action === "increase-support"));

  // 5. Close with a quiz written by Editorial; grade it
  await P.tutorTurn(c.id, sess.id, "let's wrap up", emit);
  s = store.getCourse(c.id);
  const quizId = s.sessions.find((x) => x.id === sess.id)!.quizId!;
  assert.ok(quizId, "quiz created by Editorial via delegation");
  const quiz = s.assessments.find((a) => a.id === quizId)!;
  const graded = await P.submitAssessment(c.id, quizId, Object.fromEntries(quiz.questions.map((q) => [q.id, q.answer])), emit);
  assert.equal(graded.status, "graded");
  assert.ok(graded.score! >= 75);
  const chat = await P.sessionChat(c.id, store.getCourse(c.id).sessions.find((x) => x.id === sess.id)!);
  assert.ok(chat.length >= 4, "tutor conversation is read back from the durable Pi session");

  // Every faculty thread is a Pi JSONL session stored with the course.
  const threads = Object.keys(store.getCourse(c.id).threads);
  for (const t of ["librarian", "advisor", `tutor:${sess.id}`]) assert.ok(threads.includes(t), `thread ${t}`);
  assert.ok(threads.some((t) => t.startsWith("editorial:diagnostic:")), "diagnostic written on its own editorial thread");
  assert.ok(threads.some((t) => t.startsWith("editorial:grade:") || t.startsWith("editorial:")), "editorial uses fresh threads");
  await app.faculty!.close();
});
