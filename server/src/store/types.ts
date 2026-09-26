/**
 * Domain model for Project Alex.
 *
 * Everything a student owns for one course lives in a single CourseState
 * document plus a handful of human-readable markdown "system files"
 * (roadmap.md, diary.md, notes.md) so progress is documented, not hidden.
 */

export type CourseStage =
  | "intake" // goal captured, nothing gathered yet
  | "gathering" // Librarian is filling the student bag
  | "assessment" // diagnostic assessment is waiting for the student
  | "planning" // Advisor is building the roadmap
  | "active" // studying with the Tutor
  | "completed";

export type RoleName = "advisor" | "librarian" | "tutor" | "editorial" | "generations";

export interface Student {
  id: string;
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------- student bag

/** `notes` = lecture notes the Librarian wrote from the model's own knowledge (cross-checked against sources). */
export type ResourceKind = "pdf" | "text" | "web" | "vault" | "link" | "notes";

export interface Resource {
  id: string;
  title: string;
  kind: ResourceKind;
  source?: string; // url or file name
  summary?: string;
  addedBy: "student" | "librarian";
  /** Research topic this resource was gathered for. */
  topicId?: string;
  /** Web sources: which engines found it and its source-quality score. */
  foundBy?: string[];
  quality?: number;
  chunkCount: number;
  addedAt: string;
}

export interface Chunk {
  id: string;
  resourceId: string;
  index: number;
  text: string;
}

export interface Note {
  id: string;
  conceptId?: string;
  title: string;
  body: string;
  author: RoleName | "student";
  createdAt: string;
}

/** A "point to remember", optionally with a memorization technique attached. */
export interface KeyPoint {
  id: string;
  conceptId?: string;
  text: string;
  technique?: MemoryTechnique;
  aid?: string; // the mnemonic / palace locus / story
  createdAt: string;
}

export type MemoryTechnique =
  | "mnemonic"
  | "memory-palace"
  | "chunking"
  | "story"
  | "visual-association"
  | "elaboration"
  | "analogy";

/** Spaced-repetition card (FSRS-style memory state). */
export interface Flashcard {
  id: string;
  conceptId?: string;
  front: string;
  back: string;
  technique?: MemoryTechnique;
  aid?: string;
  stability: number; // days until retrievability drops to 90%
  difficulty: number; // 1..10
  reps: number;
  lapses: number;
  lastReview?: string;
  due: string;
}

export interface StudentBag {
  resources: Resource[];
  notes: Note[];
  keyPoints: KeyPoint[];
  flashcards: Flashcard[];
}

// ---------------------------------------------------------------- knowledge

export type ZpdZone = "unknown" | "can-do-alone" | "zpd" | "beyond";

export interface Concept {
  id: string;
  title: string;
  description: string;
  prerequisites: string[]; // concept ids
  /** Foundational depth: 0 = the course's own level, higher = more basic remediation. */
  depth: number;
  /** Bloom's level the course expects the student to reach. */
  targetBloom: BloomLevel;
  /** Bayesian Knowledge Tracing: P(student knows the concept). */
  pKnown: number;
  zone: ZpdZone;
  /** Highest scaffold level the student needed on their last attempts (0 = none). */
  lastHintLevel: number;
  attempts: number;
  correct: number;
  status: "locked" | "ready" | "learning" | "mastered";
  addedBy: "advisor" | "tutor";
}

export type BloomLevel = "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";

// ---------------------------------------------------------------- roadmap

export interface RoadmapModule {
  id: string;
  title: string;
  summary: string;
  conceptIds: string[];
  objectives: string[];
  exercises: string[];
  assessment: string; // what the checkpoint assessment covers
  startDay: number; // relative to course start
  durationDays: number;
  memoryTechniques: string[];
  status: "upcoming" | "in-progress" | "done";
}

export interface Roadmap {
  title: string;
  rationale: string; // how the plan joins what the student knows to the goal
  hoursPerWeek: number;
  totalDays: number;
  modules: RoadmapModule[];
  milestones: { day: number; title: string }[];
  createdAt: string;
}

// ---------------------------------------------------------------- assessments

export type QuestionType = "mcq" | "short" | "numeric" | "true-false";

export interface Question {
  id: string;
  conceptId: string;
  type: QuestionType;
  prompt: string;
  options?: string[];
  answer: string; // canonical answer (option text for MCQ)
  rubric?: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  bloom: BloomLevel;
}

export interface QuestionResult {
  questionId: string;
  response: string;
  score: number; // 0..1
  feedback: string;
  gradedBy: "auto" | "editorial";
}

export interface Assessment {
  id: string;
  kind: "diagnostic" | "quiz" | "checkpoint" | "final";
  title: string;
  sessionId?: string;
  questions: Question[];
  status: "open" | "grading" | "graded";
  results: QuestionResult[];
  score?: number; // 0..100
  conceptScores?: Record<string, number>;
  summary?: string;
  createdAt: string;
  gradedAt?: string;
}

// ---------------------------------------------------------------- sessions

export interface PlanItem {
  id: string;
  conceptId?: string;
  activity: "review" | "learn" | "practice" | "challenge" | "remediate" | "quiz";
  title: string;
  minutes: number;
  done: boolean;
}

export interface StudySession {
  id: string;
  startedAt: string;
  endedAt?: string;
  plan: PlanItem[];
  focusConceptId?: string;
  /** Faculty thread holding this session's Tutor conversation (a durable Pi session). */
  thread: string;
  quizId?: string;
  summary?: string;
}

export interface DiaryEntry {
  id: string;
  sessionId?: string;
  author: RoleName;
  text: string;
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  role: RoleName;
  kind: "tool" | "stage" | "info" | "error";
  text: string;
  at: string;
}

// ---------------------------------------------------------------- course

export interface CourseState {
  id: string;
  studentId: string;
  title: string;
  goal: string;
  currentLevel?: string; // student's own description
  deadline?: string;
  hoursPerWeek: number;
  stage: CourseStage;
  createdAt: string;
  bag: StudentBag;
  concepts: Concept[];
  roadmap?: Roadmap;
  assessments: Assessment[];
  sessions: StudySession[];
  diary: DiaryEntry[];
  activity: ActivityEvent[];
  /** The research dossier behind the curriculum (learner profile, research plan, what was found). */
  research?: Research;
  /** Pi session metadata for every faculty thread of this course (thread key → JSONL session). */
  threads: Record<string, PiSessionRef>;
}

/** Enough of Pi's JsonlSessionMetadata to reopen a durable session file. */
export interface PiSessionRef {
  id: string;
  createdAt: number;
  storageVersion: number;
  cwd: string;
  path: string;
  modifiedAt: number;
}

// ---------------------------------------------------------------- research

/** The Advisor's read of who this student is, used to pitch research and the curriculum. */
export interface LearnerProfile {
  level: string; // e.g. "grade 9", "first-year undergraduate", "complete beginner"
  audience: string; // phrase appended to searches, e.g. "for high school students"
  depth: "intro" | "standard" | "deep";
  assumedKnowledge: string[]; // what we expect they already know (the ZPD anchor)
  suspectedGaps: string[]; // foundations that may be missing
  notes: string;
}

export interface ResearchTopic {
  id: string;
  title: string;
  kind: "core" | "foundation";
  queries: string[]; // web queries (level-aware)
  status: "planned" | "researched" | "noted";
  resourceIds: string[]; // web/vault sources ingested for it
  notesId?: string; // Librarian's lecture notes for it
  searched?: { engines: string; candidates: number; ingested: number; errors: string[] };
}

export interface Research {
  profile?: LearnerProfile;
  topics: ResearchTopic[];
  /** Concepts the Advisor asked the Librarian to find more material for. */
  requests: { concept: string; need: string; at: string; result?: string }[];
  /** Requests made after this time count toward the current phase's limit. */
  windowStart?: string;
  startedAt: string;
  finishedAt?: string;
}
