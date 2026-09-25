import { Type } from "@earendil-works/pi-ai";
import { json } from "@alex/harness";
import { t, type AlexCtx } from "../context.js";
import { newId, now } from "../store/store.js";
import { searchBag } from "../library/service.js";
import { newCardState } from "../learning/fsrs.js";
import type { Flashcard, KeyPoint, MemoryTechnique } from "../store/types.js";

/** Student bag tools, shared by several roles. */

const TECHNIQUES = ["mnemonic", "memory-palace", "chunking", "story", "visual-association", "elaboration", "analogy"] as const;
const Technique = Type.Union(TECHNIQUES.map((t) => Type.Literal(t)));

export function searchBagTool() {
  return t(
    "search_bag",
    "Search student bag",
    "Full-text search over every resource in the student's bag. Use it to ground explanations and questions in the student's own material.",
    Type.Object({ query: Type.String(), k: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) }),
    ({ query, k }, ctx) => {
      const hits = searchBag(ctx.store, ctx.courseId, query, k ?? 4);
      if (!hits.length) return "No matching passages in the bag.";
      return hits.map((h) => `[${h.resource} · ${h.chunkId} · score ${h.score}]\n${h.text}`).join("\n\n---\n\n");
    },
  );
}

export function listBagTool() {
  return t("list_bag", "List student bag", "List the resources, notes and points to remember in the student's bag.", Type.Object({}), (_p, ctx) => {
    const { bag } = ctx.store.getCourse(ctx.courseId);
    return json({
      resources: bag.resources.map((r) => ({ id: r.id, title: r.title, kind: r.kind, chunks: r.chunkCount, summary: r.summary })),
      notes: bag.notes.map((n) => n.title),
      keyPoints: bag.keyPoints.map((k) => k.text),
      flashcards: bag.flashcards.length,
    });
  });
}

export function addNoteTool(author: "librarian" | "tutor" | "advisor") {
  return t(
    "add_note",
    "Write note to bag",
    "Save a study note into the student's bag (markdown). Notes are the student's long-term reference material.",
    Type.Object({ title: Type.String(), body: Type.String(), conceptId: Type.Optional(Type.String()) }),
    ({ title, body, conceptId }, ctx) => {
      ctx.store.update(ctx.courseId, (c) => c.bag.notes.push({ id: newId("note"), title, body, conceptId, author, createdAt: now() }));
      ctx.emit({ type: "ui", role: author, name: "bag_updated", payload: { note: title } });
      return `Saved note "${title}".`;
    },
  );
}

export function addKeyPointTool(role: "librarian" | "tutor") {
  return t(
    "add_key_point",
    "Add point to remember",
    "Save a 'point to remember'. For facts that must be memorized, attach a memorization aid (mnemonic, memory palace locus, story, chunking, vivid image). Also creates a spaced-repetition flashcard when front/back are given.",
    Type.Object({
      text: Type.String({ description: "The point itself, one sentence." }),
      conceptId: Type.Optional(Type.String()),
      technique: Type.Optional(Technique),
      aid: Type.Optional(Type.String({ description: "The mnemonic / palace image / story." })),
      front: Type.Optional(Type.String({ description: "Flashcard question (retrieval cue)." })),
      back: Type.Optional(Type.String({ description: "Flashcard answer." })),
    }),
    (p, ctx) => {
      ctx.store.update(ctx.courseId, (c) => {
        const kp: KeyPoint = { id: newId("kp"), text: p.text, conceptId: p.conceptId, technique: p.technique as MemoryTechnique | undefined, aid: p.aid, createdAt: now() };
        c.bag.keyPoints.push(kp);
        if (p.front && p.back) {
          const card: Flashcard = { id: newId("card"), conceptId: p.conceptId, front: p.front, back: p.back, technique: kp.technique, aid: p.aid, ...newCardState() };
          c.bag.flashcards.push(card);
        }
      });
      ctx.emit({ type: "ui", role, name: "bag_updated", payload: { keyPoint: p.text } });
      return `Saved point to remember${p.front ? " and scheduled a flashcard" : ""}.`;
    },
  );
}
