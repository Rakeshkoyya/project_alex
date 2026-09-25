/**
 * GENERATIONS ENGINE — PARKED (placeholder only).
 *
 * The plan: before a course starts, pre-generate teaching assets per concept —
 * images, animations / motion graphics, visual explanations, a "course page"
 * the student reads before meeting the Tutor, plus advanced material such as
 * mind maps, memory palaces and slide decks — store them, and let the Tutor
 * surface them dynamically while teaching.
 *
 * That needs a dedicated generation pipeline built into our Pi harness fork
 * (asset planners, renderers, a job queue, storage). It is intentionally not
 * implemented yet. This module fixes the interface so the rest of the system
 * (Tutor tools, UI artifact panel) already speaks it.
 */

export const ARTIFACT_KINDS = ["concept-page", "image", "animation", "diagram", "mind-map", "memory-palace", "slide-deck"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactRequest {
  courseId: string;
  conceptId?: string;
  kind: ArtifactKind;
  brief: string;
}

export interface Artifact extends ArtifactRequest {
  id: string;
  status: "parked" | "queued" | "ready";
  /** URL of the rendered asset once the engine exists. */
  url?: string;
}

export interface GenerationsEngine {
  /** Pre-generate a course's asset library (run after the roadmap is final). */
  prepareCourse(courseId: string): Promise<Artifact[]>;
  /** Look up or generate one artifact on demand while teaching. */
  request(req: ArtifactRequest): Promise<Artifact>;
}

let seq = 0;
export const parkedGenerations: GenerationsEngine = {
  async prepareCourse() {
    return [];
  },
  async request(req) {
    return { ...req, id: `art_${++seq}`, status: "parked" };
  },
};
