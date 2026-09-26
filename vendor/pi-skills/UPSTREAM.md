# Reference copy: Pi skills — brave-search

This is how the Pi agent searches the internet. The Pi coding agent loads the `brave-search` skill and runs its scripts from a shell.

- **Upstream:** https://github.com/badlogic/pi-skills (MIT, © Mario Zechner, see `LICENSE`)
- **Commit:** `90bb51c` (2026-06-06)
- **Files:** `brave-search/SKILL.md`, `search.js`, `content.js`, `package.json`, unmodified

Alex's faculty agents have no shell access, by design, so they can't run these scripts. The same logic is ported to TypeScript as native agent tools in **`server/src/library/webSearch.ts`**:

| Skill | Alex |
|---|---|
| `search.js` (Brave Search API, `-n`, `--country`, `--freshness`, `--content`) | `webSearch()` → the `web_search` tool (`count`, `country`, `freshness`, `includeContent`), extended to query Brave **and** Tavily in parallel with merging, ranking and failover, plus `verify_fact` |
| `content.js` (fetch → Readability → Turndown markdown, main-content fallback) | `readPage()` → the `read_webpage` tool, and ingestion via `fetch_and_ingest` |

The port also adds PDF pages, Wikipedia's plain-text API, Tavily or Wikipedia when no Brave key is set, and a block on internal network addresses.

These files are kept for reference and attribution only. Nothing executes them.
