# Architecture

```
┌──────────────────────── web/ (React + Vite) ────────────────────────┐
│ Intake · Faculty feed · Student bag · Diagnostic · Roadmap ·        │
│ Study room (plan / tutor chat / ZPD panel / artifacts / quiz) ·     │
│ Record                                                              │
└───────────────▲──────────────── SSE stream of HarnessEvents ────────┘
                │ REST + Server-Sent Events
┌───────────────┴──────── server/ (Node + Express) ───────────────────┐
│ workflow/pipeline.ts   the student journey (one lock per course)    │
│                                                                     │
│ harness/runner.ts      ALEX HARNESS on top of the Pi agent          │
│   RoleSpec = system prompt + toolset → new Pi Agent per run          │
│   streams events · logs tools · roles delegate to each other        │
│ harness/model.ts       Claude per role, or the demo brain (no key)  │
│                                                                     │
│ agents/roles.ts        Librarian · Advisor · Tutor · Editorial      │
│ agents/generations.ts  Generations engine interface (PARKED)        │
│ tools/*                the faculty's tools (typed with TypeBox)     │
│                                                                     │
│ learning/zpd.ts        ZPD engine: scaffolding ladder, step-down    │
│ learning/bkt.ts        Bayesian Knowledge Tracing                   │
│ learning/fsrs.ts       spaced repetition                            │
│ learning/grading.ts    objective auto-grading, mastery updates      │
│ library/*              ingest (PDF/HTML/text), BM25, web, vault      │
│ store/*                file-backed course state + system .md files  │
└─────────────────────────────────────────────────────────────────────┘
```

## The Pi agent as our harness

We use the open-source **Pi agent** (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`) as the agent runtime. It handles the tool-calling loop, event streaming, provider abstraction and transcript state. Our layer, `harness/runner.ts`, adds:

* **Roles.** `registerRole({ role, systemPrompt(ctx), tools(ctx) })`. Each role's tools are bound to one course and session, so an agent can only touch its own student's data.
* **One event channel.** Pi events (`message_update`, `tool_execution_*`) are mapped to `HarnessEvent`s and streamed to the browser as SSE. Tools can also emit `ui` events, such as `plan_updated`, `mastery`, `artifact`, `assessment_ready` or `stage`, that drive the interface directly.
* **Delegation.** `ctx.delegate(role, prompt)` runs another role in the same channel. For example, the Tutor's `start_session_quiz` asks Editorial to write the quiz, which keeps the examiner independent.
* **Persistence.** Tutor transcripts (Pi `AgentMessage[]`) are stored on the session, so a conversation continues across turns and server restarts.
* **Demo mode.** Without `ANTHROPIC_API_KEY`, `harness/demoBrain.ts` plugs into Pi's faux provider. It is a scripted stand-in model that makes real tool calls, built mechanically from the student's bag, so the whole system can be tried and tested offline.

The Generations engine will need deeper changes to Pi (asset planners, renderers, a job queue). Its interface is fixed in `agents/generations.ts` and the Tutor already calls it through `show_artifact`, so enabling it later won't require changes elsewhere.

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

* `course.json` holds the full `CourseState` (bag, concepts, roadmap, assessments, sessions and transcripts, diary, activity).
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
