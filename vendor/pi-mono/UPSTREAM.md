# Vendored: Pi agent (pi-mono)

The agent harness under Project Alex is the open-source **Pi agent** by Mario Zechner, MIT licensed (see `LICENSE`).

- **Upstream:** https://github.com/badlogic/pi-mono
- **Tag:** `v0.87.1`
- **Commit:** `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`

## What's included

| Package | npm name | Role in Alex |
|---|---|---|
| `packages/agent` | `@earendil-works/pi-agent-core` | `AgentHarness`: durable JSONL sessions, lanes, hooks, compaction, retries, events. Alex's faculty runs on it. |
| `packages/ai` | `@earendil-works/pi-ai` | Provider abstraction (Anthropic and others), model catalogue, faux provider for demo mode. |
| `packages/chord` | `@earendil-works/chord` | Dependency of `agent`. |
| `packages/telemetry` | `@earendil-works/pi-telemetry` | Dependency of `ai` and `agent`. |

Upstream's tests, docs, benchmarks and the other packages (coding agent, TUI, server, …) are not vendored. `src/` is byte-for-byte upstream except for the patches below.

The packages are npm workspaces. `npm install` builds them to `dist/` via `scripts/build-pi.mjs`. Rebuild by hand with `npm run build:pi`.

## Patches applied on top of upstream

1. **Model catalogue data.** `packages/ai/src/providers/data/*.json` (including `.manifest.json`) is generated upstream from provider APIs and isn't committed to git. It is copied from the published `@earendil-works/pi-ai@0.87.1` npm tarball.
2. **No devDependencies.** Removed from the four `package.json` files. Tests aren't vendored, and vitest's peer tree plus the native `canvas` module break the workspace install.

Alex's own additions live **outside** this directory, in `packages/alex-harness` (`@alex/harness`), so upstream updates stay a clean re-copy. If Alex ever needs to change Pi itself (the planned Generations engine may), make the edit here and add it to this list, so `scripts/sync-pi.sh` users know to re-apply it.

## Updating

```bash
scripts/sync-pi.sh v0.88.0      # re-copies packages, re-applies patches 1–2, rebuilds
npm install && npm run typecheck && npm test
```
