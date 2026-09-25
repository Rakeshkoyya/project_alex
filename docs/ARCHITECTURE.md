# Architecture

```
┌──────────────────────── web/ (React + Vite) ────────────────────────┐
│ Intake · Faculty feed · Student bag · Diagnostic · Roadmap ·        │
│ Study room (plan / tutor chat / ZPD panel / artifacts / quiz) ·     │
│ Record                                                              │
└───────────────▲──────────────── SSE stream of FacultyEvents ────────┘
                │ REST + Server-Sent Events
┌───────────────┴──────── server/ (Node + Express) ───────────────────┐
│ workflow/pipeline.ts   the student journey (one lock per course)    │
│ agents/roles.ts        Librarian · Advisor · Tutor · Editorial specs │
│ tools/*                the faculty's tools (TypeBox schemas)        │
│ learning/*             ZPD engine · BKT · FSRS · grading            │
│ library/*              ingest (PDF/HTML/text) · BM25 · web · vault  │
│ store/*                course state + system .md files              │
│ demo/demoBrain.ts      scripted model for demo mode                 │
└───────────────┬─────────────────────────────────────────────────────┘
                │ faculty.run(role, course, prompt, emit, { thread })
┌───────────────┴──── packages/alex-harness (@alex/harness) ──────────┐
│ Faculty      roles → one Pi AgentHarness per (course, thread)       │
│              live briefing via transform_context hook               │
│              Pi events → FacultyEvents · role delegation            │
│ models.ts    Claude via Pi's Anthropic provider, or demo (faux)     │
│ generations  Generations engine interface (PARKED)                  │
└───────────────┬─────────────────────────────────────────────────────┘
                │
┌───────────────┴──── vendor/pi-mono (Pi agent, v0.87.1) ─────────────┐
│ pi-agent-core  AgentHarness: durable JSONL sessions, lanes, hooks,  │
│                compaction, retries, crash recovery                  │
│ pi-ai          providers (Anthropic, …), model catalogue, faux      │
└─────────────────────────────────────────────────────────────────────┘
```

## Pi as the harness

Pi's source is vendored at `vendor/pi-mono` (see `UPSTREAM.md` for the pinned commit and patches). Its packages are npm workspaces built from source on install. Alex runs on Pi's **`AgentHarness`**, its durable runtime. Each conversation is a JSONL session file (an entry tree plus operation state) that survives crashes and restarts, with lanes, hooks, automatic compaction and retries.

`@alex/harness` (`packages/alex-harness`) is our layer on top. It is kept separate from the vendored code so upstream updates stay a clean re-copy.

* **Roles.** A `RoleSpec` (system prompt, tools, optional briefing) configures one Pi `AgentHarness`. Tools are Pi `AgentHarnessTool`s, and their tool context is the live run context (course, store, event channel, delegation).
* **Threads.** Each `(course, thread)` pair is one persistent Pi session, stored in `pi-sessions/` in the course folder and indexed in `course.json` → `threads`:
  * `librarian` and `advisor`: one running thread per course, so the Advisor's map reasoning carries into the roadmap.
  * `editorial:<purpose>`: a **fresh** thread for every exam, so the examiner carries no memory of the student and stays unbiased.
  * `tutor:<sessionId>`: one thread per study session. It resumes with full history after a restart, and Pi compacts it when it grows long.
* **Live briefing.** A Pi `transform_context` hook appends a freshly computed block to the system prompt before every model request. The Tutor uses it to always see the learner's current ZPD state: focus concept, P(known), scaffold level, frontier, due reviews, plan progress.
* **One event channel.** Pi harness events (`message_update`, `tool_start`, `tool_end`, `compaction_end`) become `FacultyEvent`s streamed to the browser as SSE. Tools can also emit `ui` events, such as `plan_updated`, `mastery`, `artifact`, `assessment_ready` or `stage`.
* **Delegation.** `ctx.delegate(role, prompt)` runs another role in the same channel. The Tutor's `start_session_quiz` asks Editorial to write the quiz.
* **Demo mode.** Without `ANTHROPIC_API_KEY`, the app's demo brain is plugged into Pi's faux provider. It makes real tool calls through the real harness, and the course id reaches it through the harness's `streamOptions.metadata`.

The Generations engine will need changes inside Pi itself (asset planners, renderers, a job queue). Its interface is fixed in `packages/alex-harness/src/generations.ts`, and the Tutor already calls it through `show_artifact`. When it's built, any edits to the vendored Pi source go in `UPSTREAM.md`'s patch list.

## The student journey

| Stage | Who | What happens |
|---|---|---|
| `intake` | student | Types a goal and/or uploads PDFs or notes. Optionally gives a deadline, current level and hours per week. Uploads are ingested right away (text extraction → section-aware chunks → BM25 index). |
| `gathering` | Librarian | Searches the curated vault, then the web (Tavily, Brave, or Wikipedia as fallback), ingests good sources, summarizes the student's uploads, and extracts points to remember with memory aids and flashcards. |
| | Advisor | `PHASE: map` builds the concept graph: target concepts plus the foundations beneath them. |
| | Editorial | Writes the diagnostic, covering every concept including the foundations. |
| `assessment` | student | Takes the diagnostic. |
| `planning` | Editorial → Advisor | Auto-grades objective items and has Editorial grade open ones. Mastery priors are set per concept. `PHASE: roadmap` then orders modules from the weakest foundation upward, fits them to the deadline and hours per week, and adds objectives, exercises, memory techniques and checkpoints. |
| `active` | Tutor | Each session: plan (due reviews → frontier concept → practice → challenge → quiz). Then teach, with `record_attempt` after every answer and the ZPD engine's move followed. Then diary entry and a lock-in quiz written by Editorial. Quiz results update mastery and advance modules. |
| `completed` | | Every module is mastered. |

## Data

Each course lives in `data/students/<student>/courses/<course>/`:

* `course.json` holds the full `CourseState` (bag, concepts, roadmap, assessments, sessions, diary, activity, and the index of Pi session threads).
* `pi-sessions/` holds the durable Pi JSONL sessions, one per faculty thread.
* `chunks.json` holds the ingested passages.
* `roadmap.md`, `notes.md` and `diary.md` are human-readable system files, regenerated on every change.

The resource vault is in `data/vault/`: `catalog.json` lists trusted open resources, and `primers/` holds full-text primers the tutor can teach from.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/status` | demo mode, model |
| GET/POST | `/api/courses` | list / enroll (multipart: goal, files[], currentLevel, deadline, hoursPerWeek) |
| GET | `/api/courses/:id` | course (answer keys and transcripts stripped) |
| POST | `/api/courses/:id/prepare` | **SSE**: Librarian → Advisor map → Editorial diagnostic |
| POST | `/api/courses/:id/resources` | **SSE**: add files, url or text, then the Librarian processes them |
| POST | `/api/courses/:id/assessments/:aid/submit` | **SSE**: grade (then roadmap, if it was the diagnostic) |
| POST | `/api/courses/:id/sessions` | **SSE**: start today's session |
| POST | `/api/courses/:id/sessions/:sid/messages` | **SSE**: talk to the tutor |
| GET | `/api/courses/:id/sessions/:sid/chat` | chat history |
| GET/POST | `/api/courses/:id/flashcards/due`, `…/:cid/review` | FSRS review (rating 1–4) |
| GET | `/api/courses/:id/files/(roadmap\|notes\|diary).md` | system files |
