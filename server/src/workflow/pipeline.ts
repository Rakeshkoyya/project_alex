import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { runRole, type HarnessEvent } from "../harness/runner.js";
import { app } from "../app.js";
import { newId, now } from "../store/store.js";
import type { CourseState, StudySession } from "../store/types.js";
import { fileToText } from "../library/ingest.js";
import { ingestResource } from "../library/service.js";
import { autoGrade, finalizeAssessment, needsHumanlikeGrading } from "../learning/grading.js";
import { MASTERY_THRESHOLD } from "../learning/bkt.js";

/**
 * The student journey, as an orchestrated sequence of faculty runs:
 *
 *   intake ─► Librarian fills the bag ─► Advisor maps concepts
 *          ─► Editorial writes the diagnostic ─► (student takes it)
 *          ─► Editorial grades ─► Advisor publishes the ZPD roadmap
 *          ─► daily Tutor sessions (plan → teach → practice → quiz) ─► …
 */

type Emit = (e: HarnessEvent) => void;

const locks = new Map<string, Promise<unknown>>();
/** One faculty operation per course at a time (they all mutate the same record). */
export async function withCourseLock<T>(courseId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(courseId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(courseId, next);
  try {
    return await next;
  } finally {
    if (locks.get(courseId) === next) locks.delete(courseId);
  }
}

const ctx = (courseId: string, emit: Emit, sessionId?: string) => ({ store: app.store!, vault: app.vault!, courseId, emit, sessionId });

const stage = (courseId: string, s: CourseState["stage"], emit: Emit) => {
  app.store!.update(courseId, (c) => (c.stage = s));
  app.store!.log(courseId, "advisor", "stage", `Stage → ${s}`);
  emit({ type: "ui", role: "advisor", name: "stage", payload: { stage: s } });
};

// ------------------------------------------------------------------ intake

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

export async function ingestUploads(courseId: string, files: UploadedFile[]) {
  const out = [];
  for (const f of files) {
    const text = await fileToText(f.buffer, f.originalname, f.mimetype);
    out.push(
      ingestResource(app.store!, courseId, {
        title: f.originalname.replace(/\.[^.]+$/, ""),
        kind: f.originalname.toLowerCase().endsWith(".pdf") ? "pdf" : "text",
        source: f.originalname,
        text,
        addedBy: "student",
      }),
    );
  }
  return out;
}

/** Steps 1–3: gather material, map concepts, write the diagnostic. */
export async function prepareCourse(courseId: string, emit: Emit) {
  const store = app.store!;
  const c = store.getCourse(courseId);
  const uploaded = c.bag.resources.filter((r) => r.addedBy === "student");

  stage(courseId, "gathering", emit);
  await runRole(
    "librarian",
    ctx(courseId, emit),
    uploaded.length
      ? `The student uploaded their own material: ${uploaded.map((r) => `"${r.title}" (${r.id})`).join(", ")}. Summarize each uploaded resource, then add complementary sources (especially foundations) from the vault/web, and extract points to remember.`
      : `The student described what they want to learn: "${c.goal}" (self-described level: ${c.currentLevel ?? "unknown"}). Find and ingest the best material, then extract points to remember.`,
  );

  await runRole("advisor", ctx(courseId, emit), "PHASE: map. Build the concept map for this course (targets + foundations) with set_concept_map. Do not publish a roadmap yet — the diagnostic comes first.");

  await runRole(
    "editorial",
    ctx(courseId, emit),
    "Write the DIAGNOSTIC assessment (kind: diagnostic) covering every concept in the map, including foundations, so we can locate the student's zone of proximal development.",
  );
  stage(courseId, "assessment", emit);
}

// ------------------------------------------------------------------ assessments

export async function submitAssessment(courseId: string, assessmentId: string, responses: Record<string, string>, emit: Emit) {
  const store = app.store!;
  const needsEditorial = store.update(courseId, (c) => {
    const a = c.assessments.find((x) => x.id === assessmentId);
    if (!a) throw new Error("Unknown assessment");
    if (a.status !== "open") throw new Error("Assessment already submitted");
    a.results = a.questions.map(
      (q) => autoGrade(q, responses[q.id] ?? "") ?? { questionId: q.id, response: responses[q.id] ?? "", score: 0, feedback: "Awaiting examiner", gradedBy: "editorial" as const },
    );
    a.status = "grading";
    return a.questions.some(needsHumanlikeGrading);
  });

  emit({ type: "ui", role: "editorial", name: "grading", payload: { assessmentId } });
  if (needsEditorial) {
    await runRole("editorial", ctx(courseId, emit), `Grade the submission for assessment ${assessmentId}: use get_submission, record_grades for every short-answer item, then write_exam_report.`);
  }
  const a = store.update(courseId, (c) => {
    const a = c.assessments.find((x) => x.id === assessmentId)!;
    finalizeAssessment(c, a);
    if (a.kind !== "diagnostic") advanceModules(c);
    return a;
  });
  emit({ type: "ui", role: "editorial", name: "graded", payload: { assessmentId, score: a.score } });

  if (a.kind === "diagnostic") {
    stage(courseId, "planning", emit);
    await runRole("advisor", ctx(courseId, emit), "PHASE: roadmap. The diagnostic is graded. Read the course brief and publish the personalized ZPD roadmap with set_roadmap.");
    stage(courseId, "active", emit);
  } else {
    store.update(courseId, (c) =>
      c.diary.push({ id: newId("d"), sessionId: a.sessionId, author: "editorial", text: `${a.title}: ${a.score}%. ${a.summary ?? ""}`.trim(), createdAt: now() }),
    );
  }
  return a;
}

/** Mark roadmap modules done when all their concepts are mastered. */
function advanceModules(c: CourseState) {
  if (!c.roadmap) return;
  for (const m of c.roadmap.modules) {
    const done = m.conceptIds.every((id) => (c.concepts.find((k) => k.id === id)?.pKnown ?? 0) >= MASTERY_THRESHOLD);
    if (done) m.status = "done";
  }
  const next = c.roadmap.modules.find((m) => m.status !== "done");
  if (next) next.status = "in-progress";
  else c.stage = "completed";
}

// ------------------------------------------------------------------ tutoring

export async function startSession(courseId: string, emit: Emit): Promise<StudySession> {
  const store = app.store!;
  const s: StudySession = { id: newId("sess"), startedAt: now(), plan: [], transcript: [] };
  store.update(courseId, (c) => {
    for (const old of c.sessions) old.endedAt ??= now();
    c.sessions.push(s);
  });
  emit({ type: "ui", role: "tutor", name: "session", payload: { sessionId: s.id } });
  await tutorTurn(courseId, s.id, "[session start] Open today's session: check my state, propose today's plan, and begin.", emit);
  return s;
}

export async function tutorTurn(courseId: string, sessionId: string, text: string, emit: Emit) {
  const store = app.store!;
  const s = store.getCourse(courseId).sessions.find((x) => x.id === sessionId);
  if (!s) throw new Error("Unknown session");
  const result = await runRole("tutor", ctx(courseId, emit, sessionId), text, { messages: s.transcript as AgentMessage[] });
  store.update(courseId, (c) => {
    const live = c.sessions.find((x) => x.id === sessionId)!;
    live.transcript = result.messages;
  });
  return result.text;
}

/** Chat history for the UI: user and assistant text only (tool traffic stays internal). */
export function sessionChat(s: StudySession) {
  const out: { role: "student" | "tutor"; text: string }[] = [];
  for (const m of s.transcript as any[]) {
    if (m.role === "user") {
      const t = typeof m.content === "string" ? m.content : m.content.map((x: any) => x.text ?? "").join("");
      if (!t.startsWith("[session start]")) out.push({ role: "student", text: t });
    } else if (m.role === "assistant") {
      const t = m.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
      if (t.trim()) out.push({ role: "tutor", text: t });
    }
  }
  return out;
}
