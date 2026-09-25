import {
  type AgentHarness,
  AgentHarness as Harness,
  type AgentLane,
  type AgentMessage,
  BACKGROUND_CONTEXT,
  type Entry,
  JsonlSessionRepo,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Emit, RoleName } from "./events.ts";
import { createFacultyModels, type DemoBrain, type FacultyModels } from "./models.ts";
import type { FacultyTool } from "./tool.ts";

/**
 * THE ALEX FACULTY — Project Alex's layer on top of Pi's durable AgentHarness.
 *
 * Pi gives us a crash-safe agent runtime: every conversation is a JSONL
 * session (an entry tree + operation state) that survives restarts, with
 * lanes, hooks, compaction and retries. Alex adds a *faculty* on top:
 *
 *  - Roles. A RoleSpec (system prompt + tools + optional live briefing) turns
 *    one Pi AgentHarness into a Librarian, Advisor, Tutor or Editorial.
 *  - Threads. Each (course, thread) pair is one persistent Pi session, e.g.
 *    the Librarian's running thread for a course, or one Tutor study session.
 *    Session metadata is kept in the application's course record, so a thread
 *    reopens with its full history after a restart.
 *  - Live briefing. Through Pi's `transform_context` hook, a role can inject a
 *    freshly computed block into the system prompt before *every* model
 *    request — the Tutor gets the learner's current ZPD state that way.
 *  - One event channel. Pi harness events become FacultyEvents on the caller's
 *    channel (SSE to the browser); tools can emit `ui` events too.
 *  - Delegation. `ctx.delegate(role, prompt)` lets one role hand a job to
 *    another inside the same channel (the Tutor asks Editorial for a quiz,
 *    which keeps the examiner independent).
 */

export interface FacultyContext {
  courseId: string;
  emit: Emit;
  delegate: (role: RoleName, prompt: string, opts?: { thread?: string }) => Promise<string>;
}

export interface RoleSpec<C extends FacultyContext> {
  role: RoleName;
  systemPrompt: (ctx: C) => string;
  /** Tools receive the live run context as their Pi tool context. */
  tools: FacultyTool<C>[];
  /** Recomputed before every model request and appended to the system prompt. */
  briefing?: (ctx: C) => string | undefined;
}

/** Where the application keeps Pi session metadata for each course thread. */
export interface ThreadIndex {
  get(courseId: string, thread: string): JsonlSessionMetadata | undefined;
  set(courseId: string, thread: string, meta: JsonlSessionMetadata): void;
  /** Directory that holds this course's Pi session files. */
  sessionsDir(courseId: string): string;
}

export interface FacultyOptions<C extends FacultyContext> {
  index: ThreadIndex;
  /** Build the application context for a run (store handles, session ids...). */
  makeContext: (base: FacultyContext, extra: Record<string, unknown>) => C;
  demoBrain?: DemoBrain;
  /** Max open Pi sessions kept in memory. */
  cacheSize?: number;
}

interface OpenThread<C extends object> {
  key: string;
  role: RoleName;
  session: Session<JsonlSessionMetadata>;
  harness: AgentHarness<C>;
  lane: AgentLane;
  /** The context of the run currently driving this thread (tools and events read it). */
  current?: { ctx: C; text: string };
  labels: Map<string, string>;
}

export interface RunOptions {
  /** Conversation to continue. Defaults to a fresh one-off thread. */
  thread?: string;
  /** Extra fields passed to makeContext (e.g. the study session id). */
  extra?: Record<string, unknown>;
}

const ctx0 = BACKGROUND_CONTEXT;

export class Faculty<C extends FacultyContext> {
  readonly models: FacultyModels;
  private roles = new Map<RoleName, RoleSpec<C>>();
  private open = new Map<string, OpenThread<C>>();
  private repos = new Map<string, JsonlSessionRepo>();
  private opening = new Map<string, Promise<OpenThread<C>>>();

  constructor(private options: FacultyOptions<C>) {
    this.models = createFacultyModels(options.demoBrain);
  }

  get demo() {
    return this.models.demo;
  }

  register(spec: RoleSpec<C>) {
    this.roles.set(spec.role, spec);
    return this;
  }

  private spec(role: RoleName) {
    const s = this.roles.get(role);
    if (!s) throw new Error(`Role ${role} is not registered`);
    return s;
  }

  /** Run one prompt through a role and stream it to `emit`. Returns the role's reply text. */
  async run(role: RoleName, courseId: string, prompt: string, emit: Emit, opts: RunOptions = {}): Promise<string> {
    const thread = opts.thread ?? `${role}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const base: FacultyContext = {
      courseId,
      emit,
      delegate: (other, p, o) => this.run(other, courseId, p, emit, { ...o, extra: opts.extra }),
    };
    const ctx = this.options.makeContext(base, opts.extra ?? {});
    const t = await this.thread(role, courseId, thread);
    if (t.current) throw new Error(`Thread ${thread} is busy`);
    t.current = { ctx, text: "" };
    emit({ type: "agent_start", role });
    try {
      const result = await t.lane.prompt(prompt, undefined, ctx0);
      if (!result.ok) throw new Error(`${role}: ${describe(result.error)}`);
      const v = result.value;
      if (v.status === "suspended") throw new Error(`${role}: run suspended waiting on a deferred response`);
      if (v.status === "failed") throw new Error(`${role}: ${describe(v.error)}`);
      const text = t.current.text;
      emit({ type: "agent_end", role, text });
      return text;
    } catch (e) {
      emit({ type: "error", role, message: (e as Error).message });
      throw e;
    } finally {
      t.current = undefined;
    }
  }

  /** The persisted conversation of a thread, oldest first (for chat history). */
  async messages(role: RoleName, courseId: string, thread: string): Promise<AgentMessage[]> {
    if (!this.options.index.get(courseId, thread)) return [];
    const t = await this.thread(role, courseId, thread);
    const entries: Entry[] = await t.lane.findEntries(undefined, ctx0);
    return entries
      .filter((e): e is Extract<Entry, { type: "message" }> => e.type === "message")
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.message);
  }

  async close() {
    for (const t of this.open.values()) await this.closeThread(t);
    for (const r of this.repos.values()) await r.close?.(ctx0);
  }

  // ------------------------------------------------------------------ internals

  private repo(courseId: string) {
    let r = this.repos.get(courseId);
    if (!r) {
      const dir = this.options.index.sessionsDir(courseId);
      r = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: dir }), sessionsRoot: dir });
      this.repos.set(courseId, r);
    }
    return r;
  }

  private async thread(role: RoleName, courseId: string, thread: string): Promise<OpenThread<C>> {
    const key = `${courseId}/${thread}`;
    const existing = this.open.get(key);
    if (existing) return existing;
    let p = this.opening.get(key);
    if (!p) {
      p = this.openThread(role, courseId, thread, key).finally(() => this.opening.delete(key));
      this.opening.set(key, p);
    }
    return p;
  }

  private async openThread(role: RoleName, courseId: string, thread: string, key: string): Promise<OpenThread<C>> {
    const spec = this.spec(role);
    const repo = this.repo(courseId);
    const meta = this.options.index.get(courseId, thread);
    const session = meta ? await repo.open(meta, ctx0) : await repo.create({ cwd: this.options.index.sessionsDir(courseId) }, ctx0);
    if (!meta) this.options.index.set(courseId, thread, session.metadata);

    let t!: OpenThread<C>;
    const live = () => {
      if (!t.current) throw new Error(`Thread ${thread} has no active run`);
      return t.current.ctx;
    };
    const tools = spec.tools;
    const { harness } = await Harness.create<C>(
      {
        session,
        models: this.models.models,
        model: this.models.modelFor(role),
        systemPrompt: () => spec.systemPrompt(live()),
        tools,
        toolContext: () => live(),
        toolExecution: "sequential",
        streamOptions: { metadata: { courseId, role, thread } },
      },
      ctx0,
    );
    const lane = await harness.lane(role, ctx0);
    t = { key, role, session, harness, lane, labels: new Map(tools.map((x) => [x.name, x.label])) };

    // ---- our modifications, expressed as Pi hooks and event listeners
    if (spec.briefing) {
      harness.hooks.on("transform_context", ({ systemPrompt }) => {
        const brief = t.current ? spec.briefing!(t.current.ctx) : undefined;
        return brief ? { systemPrompt: `${systemPrompt}\n\n## Live briefing (refreshed every turn)\n${brief}` } : undefined;
      });
    }
    harness.events.on("message_update", (e) => {
      if (e.event.type !== "text_delta" || !t.current) return;
      t.current.text += e.event.delta;
      t.current.ctx.emit({ type: "text", role, delta: e.event.delta });
    });
    harness.events.on("message_start", (e) => {
      if (e.message.role === "assistant" && t.current?.text) {
        t.current.text += "\n\n";
        t.current.ctx.emit({ type: "text", role, delta: "\n\n" });
      }
    });
    harness.events.on("tool_start", (e) => {
      t.current?.ctx.emit({ type: "tool_start", role, id: e.toolCallId, name: e.toolName, label: t.labels.get(e.toolName) ?? e.toolName, args: e.args });
    });
    harness.events.on("tool_end", (e) => {
      const first = e.result?.content?.find((c) => c.type === "text") as { text: string } | undefined;
      t.current?.ctx.emit({ type: "tool_end", role, id: e.toolCallId, name: e.toolName, isError: e.isError, summary: (first?.text ?? "").slice(0, 240) });
    });
    harness.events.on("compaction_end", (e) => {
      t.current?.ctx.emit({ type: "compaction", role, status: e.status });
    });

    this.open.set(key, t);
    await this.evict();
    return t;
  }

  private async evict() {
    const max = this.options.cacheSize ?? 40;
    for (const t of this.open.values()) {
      if (this.open.size <= max) break;
      if (!t.current) await this.closeThread(t);
    }
  }

  private async closeThread(t: OpenThread<C>) {
    this.open.delete(t.key);
    await t.harness.close(ctx0).catch(() => {});
    await t.session.close(ctx0).catch(() => {});
  }
}

function describe(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { message?: string; code?: string; _tag?: string };
  return e.message ?? e.code ?? e._tag ?? JSON.stringify(err);
}
