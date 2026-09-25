import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FacultyEvent } from "@alex/harness";
import { init } from "./app.js";
import { Auth, HttpError, type AuthedRequest } from "./auth.js";
import { Store } from "./store/store.js";
import { Vault } from "./library/vault.js";
import { ingestUploads, planRoadmap, prepareCourse, sessionChat, startSession, submitAssessment, tutorTurn, withCourseLock } from "./workflow/pipeline.js";
import { ingestResource } from "./library/service.js";
import { fetchPageText } from "./library/webSearch.js";
import { studentView } from "./learning/grading.js";
import { isDue, review, type Rating } from "./learning/fsrs.js";
import type { CourseState } from "./store/types.js";

// ALEX_DATA_DIR holds student data (mount a volume here). The vault ships with the app.
const REPO_DATA = join(import.meta.dirname, "../../data");
const ROOT = resolve(process.env.ALEX_DATA_DIR ?? REPO_DATA);
const VAULT = resolve(process.env.ALEX_VAULT_DIR ?? (existsSync(join(ROOT, "vault")) ? join(ROOT, "vault") : join(REPO_DATA, "vault")));
const app = init(new Store(ROOT), new Vault(VAULT));
const faculty = app.faculty!;
const store = app.store!;
const auth = new Auth(ROOT);
const modelId = () => faculty.models.modelFor("tutor").id;

const server = express();
server.set("trust proxy", true); // behind Dokploy/Traefik: honour X-Forwarded-Proto for secure cookies
server.disable("x-powered-by");
server.use(express.json({ limit: "2mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 10 } });

/** What the browser gets: no answer keys, no internal thread index. */
function publicCourse(c: CourseState) {
  return {
    ...c,
    assessments: c.assessments.map(studentView),
    threads: undefined,
    dueFlashcards: c.bag.flashcards.filter((f) => isDue(f)).length,
  };
}

/** Run a faculty operation and stream its events to the browser as SSE. */
async function stream(res: Response, courseId: string, fn: (emit: (e: FacultyEvent) => void) => Promise<unknown>) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  // Keep-alive comments so reverse proxies don't close the stream during long model calls.
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  try {
    await withCourseLock(courseId, () => fn(send));
    send({ type: "done" });
  } catch (err) {
    console.error(err);
    send({ type: "error", role: "advisor", message: (err as Error).message });
  } finally {
    clearInterval(ping);
    res.end();
  }
}

/** The course named in the URL, only if it belongs to the signed-in student. */
function course(req: Request): CourseState {
  const user = (req as AuthedRequest).user;
  let c: CourseState;
  try {
    c = store.getCourse(String(req.params.id));
  } catch {
    throw new HttpError(404, "Course not found");
  }
  if (c.studentId !== user.id) throw new HttpError(404, "Course not found");
  return c;
}

// ------------------------------------------------------------------ public

server.get("/api/health", (_req, res) => res.json({ ok: true }));

server.get("/api/status", (_req, res) => {
  res.json({
    demo: faculty.demo,
    provider: faculty.models.provider,
    model: modelId(),
    harness: "pi-agent-core (vendored) + @alex/harness",
    signupOpen: auth.signupOpen,
    roles: ["advisor", "librarian", "tutor", "editorial", "generations (parked)"],
  });
});

server.post("/api/auth/signup", (req, res) => {
  const user = auth.signup(String(req.body.username ?? ""), String(req.body.password ?? ""));
  store.ensureStudent(user.id, user.username);
  auth.setCookie(req, res, user);
  res.json({ id: user.id, username: user.username });
});

server.post("/api/auth/login", (req, res) => {
  const user = auth.login(String(req.body.username ?? ""), String(req.body.password ?? ""), req.ip ?? "");
  auth.setCookie(req, res, user);
  res.json({ id: user.id, username: user.username });
});

server.post("/api/auth/logout", (_req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

server.get("/api/auth/me", (req, res) => {
  const user = auth.userFrom(req);
  if (!user) return void res.status(401).json({ error: "Not signed in" });
  res.json({ id: user.id, username: user.username });
});

// ------------------------------------------------------------------ student routes

server.use("/api/courses", auth.require);

server.get("/api/courses", (req, res) => res.json(store.listCourses((req as AuthedRequest).user.id).map(publicCourse)));

server.post("/api/courses", upload.array("files", 10), async (req, res) => {
  const user = (req as AuthedRequest).user;
  const b = req.body as Record<string, string>;
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!b.goal?.trim() && !files.length) return void res.status(400).json({ error: "Describe what you want to learn or upload material." });
  store.ensureStudent(user.id, user.username);
  const c = store.createCourse({
    studentId: user.id,
    title: b.title?.trim() || (b.goal ?? files[0]?.originalname ?? "New course").split(/[.\n]/)[0].slice(0, 60),
    goal: (b.goal?.trim() || `Learn the material in ${files.map((f) => f.originalname).join(", ")}`).slice(0, 2000),
    currentLevel: b.currentLevel?.trim().slice(0, 500) || undefined,
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(b.deadline ?? "") ? b.deadline : undefined,
    hoursPerWeek: Math.min(60, Math.max(1, Number(b.hoursPerWeek) || 5)),
  });
  try {
    await ingestUploads(c.id, files);
  } catch (e) {
    return void res.status(400).json({ error: `Could not read upload: ${(e as Error).message}` });
  }
  res.json(publicCourse(store.getCourse(c.id)));
});

server.get("/api/courses/:id", (req, res) => res.json(publicCourse(course(req))));

server.delete("/api/courses/:id", async (req, res) => {
  const id = course(req).id;
  await withCourseLock(id, async () => {
    await faculty.forgetCourse(id);
    store.deleteCourse(id);
  });
  res.json({ ok: true });
});

server.get("/api/courses/:id/files/:name", (req, res) => {
  const name = String(req.params.name);
  if (!["roadmap.md", "diary.md", "notes.md"].includes(name)) return void res.status(404).end();
  const file = join(store.courseDir(course(req).id), name);
  res.type("text/markdown").send(existsSync(file) ? readFileSync(file, "utf8") : "");
});

server.post("/api/courses/:id/prepare", (req, res) => {
  const id = course(req).id;
  return stream(res, id, (emit) => prepareCourse(id, emit));
});

/** Continue a course whose last faculty step failed (e.g. a provider error). */
server.post("/api/courses/:id/resume", (req, res) => {
  const c = course(req);
  return stream(res, c.id, async (emit) => {
    if (c.stage === "intake" || c.stage === "gathering") return prepareCourse(c.id, emit);
    if (c.stage === "planning") return planRoadmap(c.id, emit);
    throw new Error(`Nothing to resume at stage "${c.stage}".`);
  });
});

server.post("/api/courses/:id/resources", upload.array("files", 10), (req, res) => {
  const id = course(req).id;
  const b = req.body as Record<string, string>;
  const files = (req.files as Express.Multer.File[]) ?? [];
  return stream(res, id, async (emit) => {
    const added = await ingestUploads(id, files);
    if (b.url) {
      if (!/^https?:\/\//i.test(b.url)) throw new Error("Links must start with http:// or https://");
      const text = await fetchPageText(b.url);
      added.push(ingestResource(store, id, { title: b.title || b.url, kind: "web", source: b.url, text, addedBy: "student" }));
    }
    if (b.text) added.push(ingestResource(store, id, { title: b.title || "My notes", kind: "text", text: b.text, addedBy: "student" }));
    if (!added.length) throw new Error("Nothing to add.");
    emit({ type: "ui", role: "librarian", name: "bag_updated", payload: {} });
    await faculty.run("librarian", id, `The student uploaded new material: ${added.map((r) => `"${r.title}" (${r.id})`).join(", ")}. Summarize it and extract points to remember. Do not search for other sources.`, emit, { thread: "librarian" });
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

server.get("/api/courses/:id/sessions/:sid/chat", async (req, res) => {
  const c = course(req);
  const s = c.sessions.find((x) => x.id === req.params.sid);
  if (!s) return void res.status(404).json({ error: "No such session" });
  res.json(await sessionChat(c.id, s));
});

server.post("/api/courses/:id/sessions/:sid/messages", (req, res) => {
  const id = course(req).id;
  const text = String(req.body.text ?? "").trim().slice(0, 4000);
  if (!text) return void res.status(400).json({ error: "Empty message" });
  return stream(res, id, (emit) => tutorTurn(id, String(req.params.sid), text, emit));
});

server.get("/api/courses/:id/flashcards/due", (req, res) => {
  res.json(course(req).bag.flashcards.filter((f) => isDue(f)));
});

server.post("/api/courses/:id/flashcards/:cid/review", (req, res) => {
  const rating = Number(req.body.rating) as Rating;
  if (![1, 2, 3, 4].includes(rating)) return void res.status(400).json({ error: "rating must be 1-4" });
  const card = store.update(course(req).id, (c) => {
    const i = c.bag.flashcards.findIndex((f) => f.id === req.params.cid);
    if (i < 0) throw new HttpError(404, "No such card");
    c.bag.flashcards[i] = review(c.bag.flashcards[i], rating);
    return c.bag.flashcards[i];
  });
  res.json(card);
});

server.use("/api", (_req, res) => void res.status(404).json({ error: "Not found" }));

// Built web UI (npm run build) is served from web/dist in production.
const dist = join(import.meta.dirname, "../../web/dist");
if (existsSync(dist)) {
  server.use(express.static(dist, { index: false, maxAge: "1h" }));
  server.get(/.*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

server.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : err.name === "MulterError" ? 413 : 400;
  if (!(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err.message });
});

const PORT = Number(process.env.PORT ?? 8787);
const listener = server.listen(PORT, () => {
  const mode = faculty.demo ? "DEMO mode (no OPENROUTER_API_KEY / ANTHROPIC_API_KEY)" : `${faculty.models.provider} · ${modelId()}`;
  console.log(`Project Alex on http://localhost:${PORT} — ${mode} · Pi AgentHarness · data ${ROOT}`);
});

// Graceful shutdown: close Pi sessions so JSONL files are flushed (Docker sends SIGTERM).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    console.log(`${sig} received, shutting down…`);
    listener.close();
    faculty.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
