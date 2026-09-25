import express, { type Request, type Response } from "express";
import multer from "multer";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "./app.js";
import { Store } from "./store/store.js";
import { Vault } from "./library/vault.js";
import "./agents/roles.js";
import type { HarnessEvent } from "./harness/runner.js";
import { isDemoMode, modelFor } from "./harness/model.js";
import { ingestUploads, prepareCourse, sessionChat, startSession, submitAssessment, tutorTurn, withCourseLock } from "./workflow/pipeline.js";
import { runRole } from "./harness/runner.js";
import { ingestResource } from "./library/service.js";
import { fetchPageText } from "./library/webSearch.js";
import { studentView } from "./learning/grading.js";
import { isDue, review, type Rating } from "./learning/fsrs.js";
import type { CourseState } from "./store/types.js";

const ROOT = resolve(process.env.ALEX_DATA_DIR ?? join(import.meta.dirname, "../../data"));
app.store = new Store(ROOT);
app.vault = new Vault(join(ROOT, "vault"));
const STUDENT = "me"; // single-user for now; auth would set this per request
app.store.ensureStudent(STUDENT, "Student");

const server = express();
server.use(express.json({ limit: "2mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

/** What the browser gets: no answer keys, no raw transcripts. */
function publicCourse(c: CourseState) {
  return {
    ...c,
    assessments: c.assessments.map(studentView),
    sessions: c.sessions.map(({ transcript, ...s }) => s),
    dueFlashcards: c.bag.flashcards.filter((f) => isDue(f)).length,
  };
}

/** Run a faculty operation and stream its events to the browser as SSE. */
async function stream(res: Response, courseId: string, fn: (emit: (e: HarnessEvent) => void) => Promise<unknown>) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  try {
    await withCourseLock(courseId, () => fn(send));
    send({ type: "done" });
  } catch (err) {
    console.error(err);
    send({ type: "error", role: "advisor", message: (err as Error).message });
  }
  res.end();
}

const course = (req: Request) => app.store!.getCourse(String(req.params.id));

server.get("/api/status", (_req, res) => {
  res.json({ demo: isDemoMode(), model: modelFor("tutor").id, roles: ["advisor", "librarian", "tutor", "editorial", "generations (parked)"] });
});

server.get("/api/courses", (_req, res) => res.json(app.store!.listCourses(STUDENT).map(publicCourse)));

server.post("/api/courses", upload.array("files", 10), async (req, res) => {
  const b = req.body as Record<string, string>;
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!b.goal?.trim() && !files.length) return void res.status(400).json({ error: "Describe what you want to learn or upload material." });
  const c = app.store!.createCourse({
    studentId: STUDENT,
    title: b.title?.trim() || (b.goal ?? files[0]?.originalname ?? "New course").split(/[.\n]/)[0].slice(0, 60),
    goal: b.goal?.trim() || `Learn the material in ${files.map((f) => f.originalname).join(", ")}`,
    currentLevel: b.currentLevel?.trim() || undefined,
    deadline: b.deadline || undefined,
    hoursPerWeek: Number(b.hoursPerWeek) || 5,
  });
  try {
    await ingestUploads(c.id, files);
  } catch (e) {
    return void res.status(400).json({ error: `Could not read upload: ${(e as Error).message}` });
  }
  res.json(publicCourse(app.store!.getCourse(c.id)));
});

server.get("/api/courses/:id", (req, res) => res.json(publicCourse(course(req))));

server.get("/api/courses/:id/files/:name", (req, res) => {
  const name = String(req.params.name);
  if (!["roadmap.md", "diary.md", "notes.md"].includes(name)) return void res.status(404).end();
  const file = join(app.store!.courseDir(course(req).id), name);
  res.type("text/markdown").send(existsSync(file) ? readFileSync(file, "utf8") : "");
});

server.post("/api/courses/:id/prepare", (req, res) => stream(res, course(req).id, (emit) => prepareCourse(course(req).id, emit)));

server.post("/api/courses/:id/resources", upload.array("files", 10), (req, res) => {
  const id = course(req).id;
  const b = req.body as Record<string, string>;
  const files = (req.files as Express.Multer.File[]) ?? [];
  return stream(res, id, async (emit) => {
    const added = await ingestUploads(id, files);
    if (b.url) {
      const text = await fetchPageText(b.url);
      added.push(ingestResource(app.store!, id, { title: b.title || b.url, kind: "web", source: b.url, text, addedBy: "student" }));
    }
    if (b.text) added.push(ingestResource(app.store!, id, { title: b.title || "My notes", kind: "text", text: b.text, addedBy: "student" }));
    emit({ type: "ui", role: "librarian", name: "bag_updated", payload: {} });
    await runRole("librarian", { store: app.store!, vault: app.vault!, courseId: id, emit }, `The student uploaded new material: ${added.map((r) => `"${r.title}" (${r.id})`).join(", ")}. Summarize it and extract points to remember. Do not search for other sources.`);
  });
});

server.post("/api/courses/:id/assessments/:aid/submit", (req, res) => {
  const id = course(req).id;
  return stream(res, id, (emit) => submitAssessment(id, String(req.params.aid), req.body.responses ?? {}, emit));
});

server.post("/api/courses/:id/sessions", (req, res) => {
  const id = course(req).id;
  return stream(res, id, (emit) => startSession(id, emit));
});

server.get("/api/courses/:id/sessions/:sid/chat", (req, res) => {
  const s = course(req).sessions.find((x) => x.id === req.params.sid);
  if (!s) return void res.status(404).json({ error: "No such session" });
  res.json(sessionChat(s));
});

server.post("/api/courses/:id/sessions/:sid/messages", (req, res) => {
  const id = course(req).id;
  const text = String(req.body.text ?? "").slice(0, 4000);
  return stream(res, id, (emit) => tutorTurn(id, String(req.params.sid), text, emit));
});

server.get("/api/courses/:id/flashcards/due", (req, res) => {
  res.json(course(req).bag.flashcards.filter((f) => isDue(f)));
});

server.post("/api/courses/:id/flashcards/:cid/review", (req, res) => {
  const rating = Number(req.body.rating) as Rating;
  if (![1, 2, 3, 4].includes(rating)) return void res.status(400).json({ error: "rating must be 1-4" });
  const card = app.store!.update(course(req).id, (c) => {
    const i = c.bag.flashcards.findIndex((f) => f.id === req.params.cid);
    if (i < 0) throw new Error("No such card");
    c.bag.flashcards[i] = review(c.bag.flashcards[i], rating);
    return c.bag.flashcards[i];
  });
  res.json(card);
});

// Built web UI (npm run build) is served from web/dist in production.
const dist = join(import.meta.dirname, "../../web/dist");
if (existsSync(dist)) {
  server.use(express.static(dist));
  server.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

server.use((err: Error, _req: Request, res: Response, _next: unknown) => {
  res.status(400).json({ error: err.message });
});

const PORT = Number(process.env.PORT ?? 8787);
server.listen(PORT, () => {
  console.log(`Project Alex server on http://localhost:${PORT} — ${isDemoMode() ? "DEMO mode (no ANTHROPIC_API_KEY)" : `model ${modelFor("tutor").id}`}`);
});
