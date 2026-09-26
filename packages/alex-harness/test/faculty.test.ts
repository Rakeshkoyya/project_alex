/**
 * @alex/harness on the vendored Pi AgentHarness: roles, threads that persist
 * across restarts, live briefings via transform_context, delegation, events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ALEX_PROVIDER;
process.env.ALEX_DEMO_TPS = "1000000";
const { Faculty, tool } = await import("../src/index.ts");
import type { DemoBrain, FacultyContext, FacultyEvent, JsonlSessionMetadata } from "../src/index.ts";

interface Ctx extends FacultyContext {
  notes: string[];
}

const root = mkdtempSync(join(tmpdir(), "alex-harness-"));
const threads = new Map<string, JsonlSessionMetadata>();
const index = {
  get: (c: string, t: string) => threads.get(`${c}/${t}`),
  set: (c: string, t: string, m: JsonlSessionMetadata) => void threads.set(`${c}/${t}`, m),
  sessionsDir: (c: string) => join(root, c),
};

// A tiny scripted brain: the tutor calls `note` once, then replies with what it saw.
const seenPrompts: string[] = [];
const brain: DemoBrain = ({ role, messages }) => {
  const last = messages.at(-1)!;
  if (role === "editorial") return fauxAssistantMessage([fauxText("quiz written")]);
  if (last.role === "user") return fauxAssistantMessage([fauxToolCall("note", { text: "hello" })], { stopReason: "toolUse" });
  return fauxAssistantMessage([fauxText(`reply after ${messages.length} messages`)]);
};

const notes: string[] = [];
const noteParams = () => Type.Object({ text: Type.String() });
function makeFaculty() {
  const f = new Faculty<Ctx>({ index, demoBrain: brain, makeContext: (base) => ({ ...base, notes }) });
  f.register({
    role: "tutor",
    systemPrompt: () => "You are a tutor.",
    briefing: (ctx) => {
      seenPrompts.push(`briefing:${ctx.courseId}`);
      return `Notes so far: ${ctx.notes.length}`;
    },
    tools: [
      tool<Ctx, ReturnType<typeof noteParams>>("note", "Take note", "Record a note", noteParams(), async ({ text }, ctx) => {
        ctx.notes.push(text);
        ctx.emit({ type: "ui", role: "tutor", name: "noted", payload: { text } });
        await ctx.delegate("editorial", "write a quiz");
        return "noted";
      }),
    ],
  });
  f.register({ role: "editorial", systemPrompt: () => "You are an examiner.", tools: [] });
  return f;
}

test("a role runs on the Pi harness: tools get live context, events stream, delegation works", async () => {
  const f = makeFaculty();
  const events: FacultyEvent[] = [];
  const text = await f.run("tutor", "course1", "hi", (e) => events.push(e), { thread: "tutor:s1" });
  assert.match(text, /reply after/);
  assert.deepEqual(notes, ["hello"]);
  const kinds = events.map((e) => `${e.role}:${e.type}`);
  for (const k of ["tutor:agent_start", "tutor:tool_start", "tutor:ui", "editorial:agent_start", "editorial:agent_end", "tutor:tool_end", "tutor:text", "tutor:agent_end"]) {
    assert.ok(kinds.includes(k), `missing ${k} in ${kinds.join(",")}`);
  }
  assert.ok(seenPrompts.length >= 2, "briefing recomputed before every model request");
  await f.close();
});

test("threads are durable Pi JSONL sessions that survive a restart", async () => {
  const before = makeFaculty();
  await before.run("tutor", "course1", "again", () => {}, { thread: "tutor:s1" });
  await before.close();
  // "Restart": a brand-new faculty reads the same session files.
  const after = makeFaculty();
  const msgs = await after.messages("tutor", "course1", "tutor:s1");
  const users = msgs.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((b) => b.text ?? "").join("")));
  assert.deepEqual(users.slice(0, 2), ["hi", "again"]);
  const text = await after.run("tutor", "course1", "third", () => {}, { thread: "tutor:s1" });
  assert.match(text, /reply after \d+ messages/);
  assert.ok(Number(text.match(/(\d+) messages/)![1]) > 6, "the model sees the full persisted history");
  assert.ok(readdirSync(join(root, "course1"), { recursive: true }).some((f) => String(f).endsWith(".jsonl")));
  await after.close();
});
