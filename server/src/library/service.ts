import type { Store } from "../store/store.js";
import { newId, now } from "../store/store.js";
import type { Resource, ResourceKind } from "../store/types.js";
import { chunkText } from "./ingest.js";
import { bm25Search } from "./bm25.js";

/** Ingest text into a course's student bag: chunk, index, register the resource. */
export function ingestResource(
  store: Store,
  courseId: string,
  r: { title: string; kind: ResourceKind; source?: string; text: string; summary?: string; addedBy: Resource["addedBy"] },
): Resource {
  const course = store.getCourse(courseId);
  const dup = course.bag.resources.find((x) => (r.source && x.source === r.source) || x.title === r.title);
  if (dup) return dup;
  const id = newId("res");
  const chunks = r.text.trim() ? chunkText(id, r.text) : [];
  store.addChunks(courseId, chunks);
  const resource: Resource = {
    id,
    title: r.title,
    kind: r.kind,
    source: r.source,
    summary: r.summary ?? r.text.slice(0, 220).replace(/\s+/g, " ") + (r.text.length > 220 ? "…" : ""),
    addedBy: r.addedBy,
    chunkCount: chunks.length,
    addedAt: now(),
  };
  store.update(courseId, (c) => c.bag.resources.push(resource));
  return resource;
}

export function searchBag(store: Store, courseId: string, query: string, k = 5) {
  const course = store.getCourse(courseId);
  const title = (rid: string) => course.bag.resources.find((r) => r.id === rid)?.title ?? rid;
  return bm25Search(store.getChunks(courseId), query, k).map(({ chunk, score }) => ({
    resource: title(chunk.resourceId),
    chunkId: chunk.id,
    score: Math.round(score * 100) / 100,
    text: chunk.text,
  }));
}
