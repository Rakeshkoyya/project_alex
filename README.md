# Project Alex: a personal university for self-learners

Alex is an AI learning system that teaches anything, the way a great one-to-one tutor would. It finds where your knowledge ends and teaches from that point, one step beyond what you can do alone: your **Zone of Proximal Development**. It uses well-supported learning techniques along the way: contingent scaffolding, retrieval practice, spaced repetition, mastery learning, and memorization aids such as memory palaces and mnemonics.

It is built on the open-source **[Pi agent](https://github.com/badlogic/pi-mono)**. Pi's source is vendored in this repo (`vendor/pi-mono`, pinned to v0.87.1), and Alex's multi-role learning harness (`packages/alex-harness`) is built on Pi's durable `AgentHarness`.

## Repository layout

```
vendor/pi-mono/          Pi agent source (ai, agent, chord, telemetry), pinned upstream release
vendor/pi-skills/        reference copy of Pi's brave-search skill (ported in server/src/library/webSearch.ts)
packages/alex-harness/   @alex/harness — the Alex faculty runtime on top of Pi's AgentHarness
server/                  the learning system: roles, tools, ZPD/BKT/FSRS engines, library, API
web/                     React UI
data/vault/              curated resource catalogue + full-text primers
```

## The faculty

| Role | Responsibility |
|---|---|
| 📚 **Librarian** | Collects material from the curated resource vault, the web, and whatever you upload. Ingests and indexes it into your **student bag**, and extracts points to remember with memory aids and flashcards. |
| 🧭 **Advisor** | Plays the syllabus committee. Maps the concepts, including the foundations underneath them, and after the diagnostic designs a personalized roadmap and timeline that fits your deadline and hours per week. |
| 🎓 **Tutor** | Teaches you live. Proposes today's plan, activates what you already know, teaches one concept at a time, and adjusts hints to how you're doing: nudge → hint → worked example → **step down** to missing basics. Keeps your diary and ends each session with a quiz. |
| ⚖️ **Editorial** | An independent examiner. Writes the diagnostics and quizzes and grades them without bias: objective items are graded in code, open answers against a rubric. Keeps your exam record. |
| 🎬 **Generations** | *Parked.* Will pre-generate images, animations, concept pages, mind maps, memory palaces and slide decks. The interface and UI slots are already in place. |

## The journey

1. **Goal**: type what you want to learn and/or drop in your PDFs and notes. A deadline is optional.
2. **Material**: the Librarian fills your bag, and the Advisor maps the concepts.
3. **Diagnostic**: Editorial tests the targets *and* their foundations.
4. **Roadmap**: the Advisor connects what you already know to the goal, and the weakest foundations come first.
5. **Daily sessions**: review what's due, then learn the next concept on your frontier, then practice with scaffolding, then take on a challenge.
6. **Lock in**: every session ends with a quiz, the results update your mastery, and modules advance until you finish the course.

## Screens

| | |
|---|---|
| ![Intake](docs/screenshots/01-home.png) | ![Study room](docs/screenshots/05-study.png) |
| **Intake**: goal, material, deadline | **Study room**: plan · tutor · ZPD scaffolding ladder |
| ![Roadmap](docs/screenshots/04-roadmap.png) | ![Quiz](docs/screenshots/06-quiz.png) |
| **Roadmap**: rationale, timeline, modules, concept map | **Lock-in quiz** from the Editorial examiner |

## Run it

```bash
npm install
npm run dev            # server on :8787 + web on :5173 → open http://localhost:5173
```

With no API key, Alex runs in **demo mode**. A scripted "demo brain" stands in for the language model, but the whole harness runs for real: agent loop, tool calls, ZPD engine, grading and storage. This lets you click through the complete journey offline. For the real faculty, the default is **DeepSeek V4 Flash via OpenRouter**:

```bash
cp .env.example .env                        # then fill in:
# OPENROUTER_API_KEY=sk-or-v1-...
# ALEX_MODEL=deepseek/deepseek-v4-flash     # default; per role: ALEX_MODEL_TUTOR, ALEX_MODEL_ADVISOR, ...
# BRAVE_API_KEY=...  TAVILY_API_KEY=tvly-...   # web search: both run in parallel, either one alone works
set -a; . ./.env; set +a; npm run dev
```

Anthropic also works (`ANTHROPIC_API_KEY`, `ALEX_PROVIDER=anthropic`).

**Web search** runs **Brave and Tavily in parallel**. Results are merged, de-duplicated and ranked by cross-engine agreement. If one engine fails, the other carries on, and Wikipedia is the last resort. Pages are read with a port of Pi's [`brave-search` skill](vendor/pi-skills/UPSTREAM.md): Mozilla Readability + Turndown turn each page into clean markdown. The Librarian cross-checks every fact it saves with `verify_fact` (independent sources, one per domain). The Tutor uses the same tools read-only. Set `BRAVE_API_KEY` and `TAVILY_API_KEY`.

**Access is open by default:** no login. Each browser gets its own private courses through an anonymous cookie. Set `ALEX_REQUIRE_LOGIN=true` for username/password accounts instead.

## Deploy

One Docker container serves the API and the UI on port 8787, with student data in the `/data` volume. See **[docs/DEPLOY.md](docs/DEPLOY.md)** for step-by-step Dokploy instructions. A `docker-compose.yml` is included too.

`npm install` also builds the vendored Pi packages from source. To update Pi, run `scripts/sync-pi.sh <tag>` (see `vendor/pi-mono/UPSTREAM.md`).

For production, run `npm run build && npm start`. The server then also serves the built UI on `:8787`.

Other scripts:

* `npm test` runs the harness tests (durability across restarts, live briefing, delegation), the learning-engine unit tests, and an end-to-end journey test (demo mode).
* `npm run typecheck` typechecks the server and the web app.

## Documentation

* [docs/DEPLOY.md](docs/DEPLOY.md): deploying on Dokploy (or any Docker host).
* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the harness, roles, workflow, data layout and API.
* [docs/PEDAGOGY.md](docs/PEDAGOGY.md): the teaching method, the research behind it, and where each piece lives in the code.
