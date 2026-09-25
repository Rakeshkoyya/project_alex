import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ActivityEvent, Chunk, CourseState, RoleName, Student } from "./types.js";
import { renderDiaryMd, renderNotesMd, renderRoadmapMd } from "./systemFiles.js";

/**
 * File-backed store. Layout:
 *
 *   data/students/<studentId>/student.json
 *   data/students/<studentId>/courses/<courseId>/course.json   ← CourseState
 *   data/students/<studentId>/courses/<courseId>/chunks.json   ← ingested text
 *   data/students/<studentId>/courses/<courseId>/roadmap.md    ← system files,
 *   data/students/<studentId>/courses/<courseId>/diary.md        regenerated on
 *   data/students/<studentId>/courses/<courseId>/notes.md        every save
 *
 * The server is a single process, so an in-memory cache is the source of truth
 * and every mutation writes through to disk.
 */

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
export const now = () => new Date().toISOString();

export class Store {
  private courses = new Map<string, CourseState>();
  private chunks = new Map<string, Chunk[]>();
  private courseDirs = new Map<string, string>();

  constructor(private root: string) {
    mkdirSync(join(root, "students"), { recursive: true });
    this.loadAll();
  }

  private loadAll() {
    const studentsDir = join(this.root, "students");
    for (const sid of readdirSync(studentsDir)) {
      const coursesDir = join(studentsDir, sid, "courses");
      if (!existsSync(coursesDir)) continue;
      for (const cid of readdirSync(coursesDir)) {
        const file = join(coursesDir, cid, "course.json");
        if (!existsSync(file)) continue;
        this.courses.set(cid, JSON.parse(readFileSync(file, "utf8")));
        this.courseDirs.set(cid, join(coursesDir, cid));
      }
    }
  }

  // ------------------------------------------------------------ students

  ensureStudent(id: string, name = "Student"): Student {
    const dir = join(this.root, "students", id);
    const file = join(dir, "student.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    mkdirSync(dir, { recursive: true });
    const student: Student = { id, name, createdAt: now() };
    writeFileSync(file, JSON.stringify(student, null, 2));
    return student;
  }

  // ------------------------------------------------------------ courses

  listCourses(studentId: string): CourseState[] {
    return [...this.courses.values()]
      .filter((c) => c.studentId === studentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createCourse(init: Pick<CourseState, "studentId" | "title" | "goal" | "currentLevel" | "deadline" | "hoursPerWeek">) {
    const course: CourseState = {
      ...init,
      id: newId("course"),
      stage: "intake",
      createdAt: now(),
      bag: { resources: [], notes: [], keyPoints: [], flashcards: [] },
      concepts: [],
      assessments: [],
      sessions: [],
      diary: [],
      activity: [],
    };
    const dir = join(this.root, "students", init.studentId, "courses", course.id);
    mkdirSync(dir, { recursive: true });
    this.courseDirs.set(course.id, dir);
    this.courses.set(course.id, course);
    this.chunks.set(course.id, []);
    this.save(course);
    return course;
  }

  getCourse(id: string): CourseState {
    const c = this.courses.get(id);
    if (!c) throw new Error(`Course ${id} not found`);
    return c;
  }

  /** Apply a mutation and persist. Returns the mutator's result. */
  update<T>(courseId: string, fn: (c: CourseState) => T): T {
    const course = this.getCourse(courseId);
    const result = fn(course);
    this.save(course);
    return result;
  }

  log(courseId: string, role: RoleName, kind: ActivityEvent["kind"], text: string) {
    this.update(courseId, (c) => {
      c.activity.push({ id: newId("evt"), role, kind, text, at: now() });
      if (c.activity.length > 300) c.activity.splice(0, c.activity.length - 300);
    });
  }

  private save(course: CourseState) {
    const dir = this.courseDirs.get(course.id)!;
    writeFileSync(join(dir, "course.json"), JSON.stringify(course, null, 2));
    writeFileSync(join(dir, "roadmap.md"), renderRoadmapMd(course));
    writeFileSync(join(dir, "diary.md"), renderDiaryMd(course));
    writeFileSync(join(dir, "notes.md"), renderNotesMd(course));
  }

  // ------------------------------------------------------------ chunks

  getChunks(courseId: string): Chunk[] {
    let list = this.chunks.get(courseId);
    if (!list) {
      const file = join(this.courseDirs.get(courseId)!, "chunks.json");
      list = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      this.chunks.set(courseId, list!);
    }
    return list!;
  }

  addChunks(courseId: string, chunks: Chunk[]) {
    const list = this.getChunks(courseId);
    list.push(...chunks);
    writeFileSync(join(this.courseDirs.get(courseId)!, "chunks.json"), JSON.stringify(list));
  }

  courseDir(courseId: string) {
    return this.courseDirs.get(courseId)!;
  }
}
