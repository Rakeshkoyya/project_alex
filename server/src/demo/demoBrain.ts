import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { DemoBrain } from "@alex/harness";
import { app } from "../app.js";
import type { Concept, CourseState, StudySession } from "../store/types.js";
import { searchBag } from "../library/service.js";
import { acronym, distractors, hash, keyTerm, makeCloze, placeAnswer, sentences, type Cloze } from "./demoText.js";
import { frontier } from "../learning/zpd.js";
import { isDue } from "../learning/fsrs.js";

/**
 * DEMO BRAIN — a scripted stand-in for the LLM, used when no API key is set.
 *
 * @alex/harness plugs it into Pi's faux provider, so it drives the *real*
 * harness (durable sessions, tool execution, hooks, events): it emits
 * genuine tool calls that the real tools execute against the real store. The
 * content is built mechanically from the student's bag (cloze questions,
 * extracted definitions), so it's coherent but obviously not a real tutor.
 * Set ANTHROPIC_API_KEY for the real faculty.
 */

type Msg = Message;
const call = (name: string, args: Record<string, unknown>) => fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]);
const tools = (...calls: ReturnType<typeof call>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage([fauxText(text)]);

export const demoBrain: DemoBrain = async ({ role, courseId, messages }): Promise<AssistantMessage> => {
  const course = courseId ? app.store!.getCourse(courseId) : undefined;
  if (!course) return say("(demo) I have no course context.");
  const run = currentRun(messages);
  switch (role) {
    case "librarian":
      return librarian(course, run);
    case "advisor":
      return advisor(course, run);
    case "editorial":
      return editorial(course, run);
    case "tutor":
      return tutor(course, run);
    default:
      return say("The Generations engine is parked.");
  }
};

interface Run {
  prompt: string;
  called: Map<string, string[]>; // tool name → result texts (this run only)
}

function currentRun(messages: Msg[]): Run {
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== "user") start--;
  const u = messages[start];
  const prompt = u && u.role === "user" ? (typeof u.content === "string" ? u.content : u.content.map((c: any) => c.text ?? "").join("")) : "";
  const called = new Map<string, string[]>();
  for (const m of messages.slice(start + 1)) {
    if (m.role !== "toolResult") continue;
    const text = m.content.map((c: any) => c.text ?? "").join("");
    called.set(m.toolName, [...(called.get(m.toolName) ?? []), text]);
  }
  return { prompt, called };
}

// ============================================================== librarian

function librarian(c: CourseState, run: Run): AssistantMessage {
  const has = (t: string) => run.called.has(t);
  if (/PHASE: (synthesize|fill-gap)/.test(run.prompt)) return librarianSynthesize(c, run);
  if (/uploaded|summari[sz]e/i.test(run.prompt) && !has("summarize_resource")) {
    const mine = c.bag.resources.filter((r) => r.addedBy === "student" && r.chunkCount > 0);
    if (mine.length) {
      return tools(
        ...mine.map((r) => {
          const first = app.store!.getChunks(c.id).find((k) => k.resourceId === r.id);
          const s = sentences(first?.text ?? "")[0] ?? r.summary ?? r.title;
          return call("summarize_resource", { resourceId: r.id, summary: `Student-provided material (${r.chunkCount} passages). Opens with: "${s.slice(0, 160)}"` });
        }),
      );
    }
  }
  if (!has("vault_search") && !/uploaded/i.test(run.prompt)) return tools(call("vault_search", { query: `${c.title} ${c.goal}` }));
  if (has("vault_search") && !has("add_vault_resource")) {
    let hits: { id: string; fullText: boolean }[] = [];
    try {
      hits = JSON.parse(run.called.get("vault_search")![0]);
    } catch {}
    const picks = hits.slice(0, 3);
    return tools(
      ...picks.map((h) => call("add_vault_resource", { id: h.id, whyUseful: h.fullText ? "full text indexed for the tutor" : "recommended reference" })),
      call("web_search", { query: c.title }),
    );
  }
  if (has("web_search") && !has("fetch_and_ingest") && !has("add_key_point")) {
    const res = run.called.get("web_search")![0];
    const url = res.match(/^Link: (\S+)/m)?.[1];
    const title = res.match(/^Title: (.+)$/m)?.[1];
    if (url && title) return tools(call("fetch_and_ingest", { url, title, summary: "Encyclopedic overview found by web search." }));
  }
  if (!has("add_key_point")) {
    const hits = searchBag(app.store!, c.id, `${c.title} ${c.goal}`, 6);
    const facts = hits.flatMap((h) => sentences(h.text).filter((s) => / (is|are|means|contains?) /.test(s)).slice(0, 1)).slice(0, 4);
    if (facts.length) {
      return tools(
        ...facts.map((s) => {
          const cl = makeCloze(s);
          const ac = acronym(s);
          return call("add_key_point", {
            text: s,
            technique: ac ? "mnemonic" : "visual-association",
            aid: ac ?? `Picture the idea as a vivid, exaggerated scene: ${s.slice(0, 80)}…`,
            front: cl ? cl.prompt : `Explain: ${s.slice(0, 60)}…`,
            back: cl ? cl.term : s,
          });
        }),
      );
    }
  }
  const bag = c.bag.resources.map((r) => `- **${r.title}** — ${r.summary}`).join("\n");
  return say(`📚 Your bag is ready for **${c.title}**:\n\n${bag || "_(nothing found yet — upload a PDF or notes to add material)_"}\n\nI also saved ${c.bag.keyPoints.length} points to remember, each with a memory aid and a flashcard.`);
}

/** Demo synthesis: lecture notes per topic from the gathered passages, then verified points to remember. */
function librarianSynthesize(c: CourseState, run: Run): AssistantMessage {
  const has = (t: string) => run.called.has(t);
  if (!has("get_research_report")) return tools(call("get_research_report", {}));
  if (/PHASE: fill-gap/.test(run.prompt)) {
    const concept = run.prompt.match(/concept "([^"]+)"/)?.[1] ?? c.title;
    if (!has("write_lecture_notes")) return tools(call("write_lecture_notes", { topicId: concept, title: concept, markdown: demoNotes(c, concept) }));
    return say(`Added lecture notes for **${concept}** built from the bag's sources.`);
  }
  const topics = (c.research?.topics ?? []).filter((t) => !t.notesId);
  if (!has("write_lecture_notes") && topics.length) {
    return tools(...topics.map((t) => call("write_lecture_notes", { topicId: t.id, title: t.title, markdown: demoNotes(c, t.title) })));
  }
  if (!has("verify_fact") && !has("add_key_point")) {
    const facts = keyFacts(c);
    if (facts.length) return tools(...facts.slice(0, 2).map((f) => call("verify_fact", { claim: f })));
  }
  if (!has("add_key_point")) {
    const facts = keyFacts(c);
    if (facts.length) {
      return tools(
        ...facts.map((s) => {
          const cl = makeCloze(s);
          const ac = acronym(s);
          return call("add_key_point", { text: s, technique: ac ? "mnemonic" : "visual-association", aid: ac ?? `Picture the idea as a vivid, exaggerated scene: ${s.slice(0, 80)}…`, front: cl ? cl.prompt : `Explain: ${s.slice(0, 60)}…`, back: cl ? cl.term : s });
        }),
      );
    }
  }
  const counts = { web: c.bag.resources.filter((r) => r.kind === "web").length, vault: c.bag.resources.filter((r) => r.kind === "vault").length, notes: c.bag.resources.filter((r) => r.kind === "notes").length };
  return say(`📚 Your bag is ready for **${c.title}**: ${counts.vault} trusted primer(s), ${counts.web} web source(s) and ${counts.notes} set(s) of lecture notes, plus ${c.bag.keyPoints.length} cross-checked points to remember.`);
}

/** Bag search over gathered SOURCES only (the demo's own notes are too generic to quiz from). */
function searchSources(c: CourseState, q: string, k: number) {
  return searchBag(app.store!, c.id, q, k * 4 + 10).filter((h) => !h.resource.startsWith("Lecture notes")).slice(0, k);
}

function keyFacts(c: CourseState) {
  const hits = searchSources(c, `${c.title} ${c.goal}`, 8);
  return hits.flatMap((h) => sentences(h.text).filter((s) => / (is|are|means|contains?) /.test(s)).slice(0, 1)).slice(0, 4);
}

function demoNotes(c: CourseState, topic: string) {
  const hits = searchSources(c, topic, 3);
  const lines = hits.flatMap((h) => sentences(h.text)).slice(0, 5);
  const level = c.research?.profile?.level ?? "your level";
  return [
    `## ${topic}, explained for ${level}`,
    lines.length ? lines.join(" ") : `${topic} is part of ${c.title}. (Demo mode writes notes from the gathered sources; with a real model these are full lecture notes.)`,
    `## Key idea`,
    lines[0] ?? `The central idea of ${topic}.`,
    `## Common misconception`,
    `Students often memorise the words of ${topic} without being able to explain why it works: explain it back in your own words.`,
  ].join("\n\n");
}

// ============================================================== advisor

function advisor(c: CourseState, run: Run): AssistantMessage {
  if (!run.called.has("get_course_brief")) return tools(call("get_course_brief", {}));
  if (/PHASE: scope/.test(run.prompt)) {
    if (!run.called.has("set_learner_profile")) {
      const lvl = c.currentLevel ?? c.goal.match(/grade \d+|beginner|university|college|high school/i)?.[0] ?? "beginner";
      return tools(
        call("set_learner_profile", { level: lvl, audience: /grade|school/i.test(lvl) ? "for high school students" : "for beginners", depth: "standard", assumedKnowledge: [], suspectedGaps: ["core vocabulary"], notes: "Start concrete, check understanding often." }),
        call("set_research_plan", { topics: demoTopics(c) }),
      );
    }
    return say(`I've profiled you and planned research on **${c.research?.topics.length ?? 0} topics**, foundations first. The Librarian is gathering material now.`);
  }
  if (/PHASE: map/.test(run.prompt)) {
    if (!run.called.has("set_concept_map")) return tools(call("set_concept_map", { concepts: deriveConcepts(c) }));
    if (!run.called.has("coverage_report")) return tools(call("coverage_report", {}));
    if (!run.called.has("request_material")) {
      let gaps: { title: string; status: string }[] = [];
      try {
        gaps = JSON.parse(run.called.get("coverage_report")!.at(-1)!).filter((x: any) => x.status === "GAP");
      } catch {}
      if (gaps.length) return tools(call("request_material", { concept: gaps[0].title, need: "An explanation at the student's level" }));
    }
    return say(`I've mapped **${c.concepts.length} concepts** for ${c.title}, including the foundations underneath them. Next, a short diagnostic so we know where your solid ground is.`);
  }
  if (!run.called.has("set_roadmap")) return tools(call("set_roadmap", deriveRoadmap(c)));
  const r = c.roadmap!;
  return say(`🗺️ Your roadmap is ready: **${r.title}** — ${r.modules.length} modules over ${r.totalDays} days.\n\n${r.rationale}\n\nHead to **Study** whenever you're ready; your tutor will propose today's plan.`);
}

function demoTopics(c: CourseState) {
  // Use a matching vault primer's outline when there is one, else a generic outline.
  const primer = app.vault!.search(`${c.title} ${c.goal}`, 3).find((e) => e.primer);
  const heads = primer ? [...(app.vault!.primerText(primer) ?? "").matchAll(/^## (.+)$/gm)].map((m) => m[1]) : [];
  const list = heads.length
    ? heads.slice(0, 8).map((h) => ({ title: h.replace(/^foundations?:\s*/i, ""), kind: /^foundations?:/i.test(h) ? "foundation" : "core" }))
    : [
        { title: `Core vocabulary of ${c.title}`, kind: "foundation" },
        { title: `Key principles of ${c.title}`, kind: "core" },
        { title: `Applying ${c.title}`, kind: "core" },
      ];
  return list.map((t) => ({ ...t, queries: [`${t.title} explained`, `${t.title} ${c.title}`] }));
}

function deriveConcepts(c: CourseState) {
  // Concepts come from the gathered sources' structure (not from AI-written notes).
  const sourceIds = new Set(c.bag.resources.filter((r) => r.kind !== "notes").map((r) => r.id));
  const chunks = app.store!.getChunks(c.id).filter((k) => sourceIds.has(k.resourceId));
  const headings: { title: string; foundation: boolean }[] = [];
  const seen = new Set<string>();
  for (const k of chunks) {
    const h = k.text.split("\n")[0].replace(/^#+\s*/, "").trim();
    if (h.length > 70 || h.length < 3 || /[.?!]$/.test(h) || seen.has(h.toLowerCase())) continue;
    if (h.toLowerCase() === c.title.toLowerCase()) continue;
    seen.add(h.toLowerCase());
    headings.push({ title: cap(h.replace(/^foundations?:\s*/i, "")), foundation: /^foundations?:/i.test(h) });
  }
  let list = headings.slice(0, 12);
  if (list.length < 3) {
    list = [
      { title: `Core vocabulary of ${c.title}`, foundation: true },
      { title: `Basic building blocks of ${c.title}`, foundation: true },
      { title: `Key principles of ${c.title}`, foundation: false },
      { title: `Applying ${c.title}`, foundation: false },
      { title: `Analyzing problems in ${c.title}`, foundation: false },
    ];
  }
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const foundations = list.filter((x) => x.foundation);
  const core = list.filter((x) => !x.foundation);
  return [
    ...foundations.map((f, i) => ({ key: key(f.title), title: f.title, description: `Foundation for ${c.title}.`, prerequisites: i > 0 ? [key(foundations[i - 1].title)] : [], depth: 1, targetBloom: "understand" })),
    ...core.map((k, i) => ({
      key: key(k.title),
      title: k.title,
      description: `Part of ${c.title}.`,
      prerequisites: i === 0 ? foundations.map((f) => key(f.title)) : [key(core[i - 1].title)],
      depth: 0,
      targetBloom: i < 2 ? "understand" : "apply",
    })),
  ];
}

function deriveRoadmap(c: CourseState) {
  const weak = c.concepts.filter((k) => k.depth > 0 && k.pKnown < 0.6);
  const strong = c.concepts.filter((k) => k.pKnown >= 0.6);
  const core = c.concepts.filter((k) => k.depth === 0 && k.pKnown < 0.85).sort((a, b) => order(c, a) - order(c, b));
  const groups: { title: string; ids: Concept[] }[] = [];
  if (weak.length) groups.push({ title: "Foundations refresh", ids: weak });
  for (let i = 0; i < core.length; i += 2) groups.push({ title: core.slice(i, i + 2).map((k) => k.title).join(" & "), ids: core.slice(i, i + 2) });
  if (!groups.length) groups.push({ title: "Deepen and extend", ids: c.concepts.slice(0, 3) });
  const daysPerConcept = Math.max(1, Math.round(6 / Math.max(1, c.hoursPerWeek / 2)));
  let day = 0;
  const modules = groups.map((g) => {
    const m = {
      title: g.title,
      summary: `Covers ${g.ids.map((k) => k.title).join(", ")}.`,
      conceptIds: g.ids.map((k) => k.id),
      objectives: g.ids.map((k) => `Student can explain and use: ${k.title}`),
      exercises: ["Worked example walkthrough", "Faded practice (you finish the steps)", "Interleaved challenge mixing earlier modules"],
      assessment: `Checkpoint quiz on ${g.ids.map((k) => k.title).join(", ")}`,
      startDay: day,
      durationDays: daysPerConcept * g.ids.length,
      memoryTechniques: ["Spaced flashcards", "Mnemonic for key terms", "Explain-it-back (Feynman)"],
    };
    day += m.durationDays;
    return m;
  });
  return {
    title: `${c.title}: personal pathway`,
    rationale: `${strong.length ? `You already have solid ground in ${strong.map((k) => k.title).slice(0, 3).join(", ")}, so we build from there. ` : "We start from the ground up. "}${weak.length ? `The diagnostic showed gaps in ${weak.map((k) => k.title).join(", ")}, so we fix those foundations first. ` : ""}Each module sits just beyond what you can already do on your own.`,
    totalDays: day,
    modules,
    milestones: modules.map((m) => ({ day: m.startDay + m.durationDays, title: `Finish: ${m.title}` })),
  };
}

const order = (c: CourseState, k: Concept) => c.concepts.indexOf(k);

// ============================================================== editorial

function editorial(c: CourseState, run: Run): AssistantMessage {
  if (/Grade the submission/i.test(run.prompt)) {
    const id = run.prompt.match(/asm_\w+/)?.[0] ?? "";
    const a = c.assessments.find((x) => x.id === id);
    if (!a) return say("No such assessment.");
    if (!run.called.has("get_submission")) return tools(call("get_submission", { assessmentId: id }));
    if (!run.called.has("record_grades")) {
      const grades = a.questions
        .filter((q) => q.type === "short")
        .map((q) => {
          const r = a.results.find((x) => x.questionId === q.id)?.response ?? "";
          const want = new Set((q.rubric ?? q.answer).toLowerCase().match(/[a-z]{5,}/g) ?? []);
          const got = new Set(r.toLowerCase().match(/[a-z]{5,}/g) ?? []);
          const overlap = [...want].filter((w) => got.has(w)).length;
          const score = want.size ? Math.min(1, Math.round((overlap / Math.min(4, want.size)) * 4) / 4) : 0;
          return { questionId: q.id, score, feedback: score >= 0.75 ? "Covers the key ideas." : score > 0 ? `Partially correct. A full answer mentions: ${q.rubric}` : `Missing the key idea: ${q.rubric}` };
        });
      return tools(call("record_grades", { assessmentId: id, grades }));
    }
    if (!run.called.has("write_exam_report")) {
      const per = a.questions.map((q) => ({ q, s: a.results.find((r) => r.questionId === q.id)?.score ?? 0 }));
      const title = (cid: string) => c.concepts.find((k) => k.id === cid)?.title ?? cid;
      const strong = [...new Set(per.filter((p) => p.s >= 0.75).map((p) => title(p.q.conceptId)))];
      const weak = [...new Set(per.filter((p) => p.s < 0.5).map((p) => title(p.q.conceptId)))];
      return tools(call("write_exam_report", { assessmentId: id, summary: `Strengths: ${strong.join(", ") || "none yet"}. Gaps: ${weak.join(", ") || "none"}.` }));
    }
    return say("Grading complete.");
  }
  if (!run.called.has("get_concepts")) return tools(call("get_concepts", {}));
  if (!run.called.has("create_assessment")) {
    const quiz = /"kind": "quiz"|quiz/i.test(run.prompt) && !/diagnostic/i.test(run.prompt);
    const ids = quiz ? (run.prompt.match(/c_[a-z0-9-]+/g) ?? []) : c.concepts.map((k) => k.id);
    const concepts = c.concepts.filter((k) => ids.includes(k.id));
    const questions = buildQuestions(c, concepts, quiz ? 4 : Math.min(12, concepts.length * 2));
    return tools(call("create_assessment", { kind: quiz ? "quiz" : "diagnostic", title: quiz ? "End-of-session quiz" : `Diagnostic: ${c.title}`, questions }));
  }
  return say("Assessment ready.");
}

function buildQuestions(c: CourseState, concepts: Concept[], max: number) {
  // Distractors are other key terms from the same material: plausible, not random.
  const notesIds = new Set(c.bag.resources.filter((r) => r.kind === "notes").map((r) => r.id));
  const pool = [...new Set(app.store!.getChunks(c.id).filter((k) => !notesIds.has(k.resourceId)).flatMap((k) => sentences(k.text).map((s) => keyTerm(s)).filter((t): t is string => !!t)))];
  const out: any[] = [];
  const used = new Set<string>();
  for (let round = 0; round < 2 && out.length < max; round++) {
    for (const k of concepts) {
      if (out.length >= max) break;
      const cl = clozeFor(c, k, used, round);
      if (cl) {
        used.add(cl.sentence);
        const seed = hash(cl.sentence);
        out.push({
          conceptId: k.id,
          type: "mcq",
          prompt: `Fill the blank: ${cl.prompt}`,
          options: placeAnswer(cl.term, distractors(cl.term, pool.slice(seed % Math.max(1, pool.length - 10))), seed),
          answer: cl.term,
          difficulty: k.depth > 0 ? 1 : 2 + round,
          bloom: "remember",
        });
      } else if (round === 0) {
        out.push({ conceptId: k.id, type: "short", prompt: `In your own words, what is "${k.title}"?`, answer: k.description, rubric: `${k.title} ${k.description}`, difficulty: 2, bloom: "understand" });
      }
    }
  }
  const main = concepts.find((k) => k.depth === 0) ?? concepts[0];
  const s = sentences(searchSources(c, main.title, 1)[0]?.text ?? "")[0];
  if (s && out.length < max + 1) out.push({ conceptId: main.id, type: "short", prompt: `Explain why this is true, in your own words: "${s}"`, answer: s, rubric: s, difficulty: 3, bloom: "understand" });
  return out;
}

function clozeFor(c: CourseState, k: Concept, used: Set<string>, nth = 0): Cloze | undefined {
  const hits = searchSources(c, `${k.title} ${k.description}`, 3);
  const cands = hits.flatMap((h) => sentences(h.text)).filter((s) => !used.has(s));
  for (const s of cands.slice(nth)) {
    const cl = makeCloze(s);
    if (cl) return cl;
  }
  return undefined;
}

// ============================================================== tutor

interface TutorMemo {
  phase: "activate" | "question" | "closed";
  conceptId?: string;
  cloze?: Cloze;
  hintLevel: number;
  used: Set<string>;
  practiced: string[];
}
const memos = new Map<string, TutorMemo>();

function tutor(c: CourseState, run: Run): AssistantMessage {
  const s = c.sessions.at(-1)!;
  let memo = memos.get(s.id);
  if (!memo) memos.set(s.id, (memo = { phase: "activate", hintLevel: 0, used: new Set(), practiced: [] }));
  const has = (t: string) => run.called.has(t);
  const title = (id?: string) => c.concepts.find((k) => k.id === id)?.title ?? id ?? "";

  // ---- session opening
  if (/\[session start\]/.test(run.prompt)) {
    if (!has("get_learner_state")) return tools(call("get_learner_state", {}));
    const f = frontier(c);
    if (!has("set_today_plan")) {
      const due = c.bag.flashcards.filter((x) => isDue(x)).length;
      const items = [
        ...(due ? [{ activity: "review", title: `Spaced review: ${due} flashcards`, minutes: 5 }] : []),
        ...f.slice(0, 2).map((k, i) => ({ activity: k.depth > 0 ? "remediate" : "learn", title: `${i ? "Then" : "Learn"}: ${k.title}`, conceptId: k.id, minutes: 12 })),
        { activity: "challenge", title: "Mixed challenge", minutes: 6 },
        { activity: "quiz", title: "Lock-in quiz", minutes: 5 },
      ];
      return tools(call("set_today_plan", { items }));
    }
    if (!has("set_focus") && f[0]) return tools(call("set_focus", { conceptId: f[0].id }));
    memo.conceptId = f[0]?.id;
    memo.phase = "activate";
    const plan = s.plan.map((p) => `- ${p.title} (${p.minutes} min)`).join("\n");
    const last = c.diary.filter((d) => d.author === "tutor").at(-1);
    return say(
      `${c.sessions.length > 1 ? "Welcome back!" : "Welcome to your first session! 👋"} ${last ? `Last time I noted: _${last.text.slice(0, 120)}_\n\n` : ""}Here's today's plan:\n\n${plan}\n\nLet's start with **${title(memo.conceptId)}**. Before I explain anything — what do you already know or guess about it? Even a rough idea helps me pitch this at the right level.`,
    );
  }

  // ---- closing
  if (memo.phase === "closed" || /wrap up|end (the )?session|quiz me|finish/i.test(run.prompt)) {
    if (!has("write_diary")) {
      return tools(call("write_diary", { text: `Session ${s.id}: practiced ${memo.practiced.map(title).join(", ") || "warm-up only"}. Highest scaffold needed: level ${memo.hintLevel}.` }));
    }
    if (!has("start_session_quiz") && !s.quizId) {
      const ids = memo.practiced.length ? [...new Set(memo.practiced)] : [memo.conceptId ?? c.concepts[0].id];
      return tools(call("start_session_quiz", { conceptIds: ids, questionCount: 4 }));
    }
    memo.phase = "closed";
    return say("Great work today. 🎯 Your **lock-in quiz** is ready on the right — take it now while it's fresh. The examiner grades it independently and I'll adapt tomorrow's plan to the result.");
  }

  // ---- handle ZPD engine verdict after record_attempt
  if (has("record_attempt")) {
    const rec = JSON.parse(run.called.get("record_attempt")!.at(-1)!);
    return tutorAfterAttempt(c, s, memo, rec, run);
  }

  const k = c.concepts.find((x) => x.id === memo!.conceptId) ?? frontier(c)[0];
  if (!k) return say("You've mastered everything on the map! 🎓 Let's do a final review quiz — type **quiz me**.");
  memo.conceptId = k.id;

  // ---- activation answered → explain + first question
  if (memo.phase === "activate") {
    if (!has("show_artifact")) return tools(call("show_artifact", { conceptId: k.id, kind: "concept-page", brief: `One-page visual primer on ${k.title}` }));
    return explainAndAsk(c, memo, k, "Thanks — that tells me where to start.");
  }

  // ---- answer to a practice question
  if (memo.phase === "question" && memo.cloze) {
    const correct = new RegExp(`\\b${memo.cloze.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(run.prompt);
    return tools(call("record_attempt", { conceptId: k.id, correct, hintLevel: memo.hintLevel, observation: correct ? undefined : `Answered "${run.prompt.slice(0, 60)}" for a question whose answer was "${memo.cloze.term}".` }));
  }
  return explainAndAsk(c, memo, k, "");
}

function explainAndAsk(c: CourseState, memo: TutorMemo, k: Concept, lead: string, hintLevel = 0): AssistantMessage {
  const hits = searchSources(c, `${k.title} ${k.description}`, 2);
  const sents = hits.flatMap((h) => sentences(h.text));
  const explain = sents.slice(0, 2).join(" ");
  const cloze = sents.map((x) => (memo.used.has(x) ? undefined : makeCloze(x))).find(Boolean);
  memo.phase = "question";
  memo.hintLevel = hintLevel;
  memo.cloze = cloze;
  if (cloze) memo.used.add(cloze.sentence);
  const q = cloze ? `**Your turn:** fill the blank —\n\n> ${cloze.prompt}` : `**Your turn:** explain ${k.title} back to me in one or two sentences.`;
  return say(`${lead}\n\n**${k.title}** in small steps:\n\n${explain || k.description}\n\n_(A concept page would appear here — the Generations engine is parked for now.)_\n\n${q}`);
}

function tutorAfterAttempt(c: CourseState, s: StudySession, memo: TutorMemo, rec: any, run: Run): AssistantMessage {
  const k = c.concepts.find((x) => x.id === rec.conceptId)!;
  const cl = memo.cloze!;
  if (!memo.practiced.includes(k.id)) memo.practiced.push(k.id);
  switch (rec.action) {
    case "advance": {
      if (!run.called.has("add_key_point")) {
        const ac = acronym(cl.sentence);
        return tools(call("add_key_point", { conceptId: k.id, text: cl.sentence, technique: ac ? "mnemonic" : "visual-association", aid: ac ?? `Picture "${cl.term}" in giant glowing letters at your front door.`, front: cl.prompt, back: cl.term }));
      }
      const item = s.plan.find((p) => p.conceptId === k.id && !p.done);
      if (item && !run.called.has("complete_plan_item")) return tools(call("complete_plan_item", { planItemId: item.id }));
      const next = frontier(c).find((x) => x.id !== k.id);
      const planLeft = s.plan.filter((p) => !p.done && p.conceptId && p.conceptId !== k.id);
      if (!next || !planLeft.length) {
        memo.phase = "closed";
        return say(`✅ **${cl.term}** — exactly right, and without help. Mastery of ${k.title}: ${Math.round(rec.pKnown * 100)}%. I saved it to your points to remember with a memory aid.\n\nThat's today's material covered. Type **wrap up** for the lock-in quiz, or keep chatting to practice more.`);
      }
      if (!run.called.has("set_focus")) return tools(call("set_focus", { conceptId: next.id }));
      memo.conceptId = next.id;
      memo.phase = "activate";
      return say(`✅ **${cl.term}** — correct, no help needed! Mastery of ${k.title}: ${Math.round(rec.pKnown * 100)}%.\n\nNext up: **${next.title}**. What do you already know about it?`);
    }
    case "fade-support": {
      return explainAndAsk(c, memo, k, `✅ Yes — **${cl.term}**. You needed some help, so here's a similar one with less support (mastery ${Math.round(rec.pKnown * 100)}%).`, rec.nextHintLevel);
    }
    case "increase-support": {
      memo.hintLevel = rec.nextHintLevel;
      const hints: Record<number, string> = {
        1: `Not quite. 🤔 Take a breath — what is this sentence *about*? Which word would complete that idea?\n\n> ${cl.prompt}`,
        2: `Here's a hint: think about **${k.title}** — the missing word is a key term from it. Re-read:\n\n> ${cl.prompt}`,
        3: `Closer look: the word starts with **"${cl.term.slice(0, 2)}"** and has ${cl.term.length} letters.\n\n> ${cl.prompt}`,
        4: `Let me show you a worked example. The full sentence is:\n\n> ${cl.sentence}\n\nThe key word is **${cl.term}** because that's the term the idea hinges on. Now, in your own words — or just type the word — what completes it?`,
      };
      return say(hints[rec.nextHintLevel] ?? hints[4]);
    }
    case "step-down": {
      const target = rec.stepDownTo?.[0];
      if (target) {
        if (!run.called.has("set_focus")) return tools(call("set_focus", { conceptId: target.id }));
        memo.conceptId = target.id;
        memo.phase = "activate";
        return say(`Let's pause **${k.title}** — that's okay, it just means a foundation underneath needs attention first. 🧱 We'll step down to **${target.title}** and then climb back up.\n\nWhat do you remember about ${target.title}?`);
      }
      if (!run.called.has("add_prerequisite")) return tools(call("add_prerequisite", { forConceptId: k.id, title: `Basics behind ${k.title}`, description: `Vocabulary and ideas assumed by ${k.title}` }));
      memo.phase = "activate";
      memo.conceptId = c.concepts.at(-1)!.id;
      return say(`I think we're missing a building block. I've added **Basics behind ${k.title}** to your map — let's start there. What words in that sentence were unfamiliar?`);
    }
  }
  return say("Let's keep going.");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
