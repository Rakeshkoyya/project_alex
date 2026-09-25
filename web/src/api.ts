import type { Assessment, CourseState, Flashcard, StudySession } from "../../server/src/store/types";

export type { Assessment, CourseState, Flashcard, StudySession };
export type RoleName = "advisor" | "librarian" | "tutor" | "editorial" | "generations";

export type Course = Omit<CourseState, "sessions"> & { sessions: Omit<StudySession, "transcript">[]; dueFlashcards: number };

export type HarnessEvent =
  | { type: "agent_start"; role: RoleName }
  | { type: "text"; role: RoleName; delta: string }
  | { type: "tool_start"; role: RoleName; id: string; name: string; label: string; args: unknown }
  | { type: "tool_end"; role: RoleName; id: string; name: string; isError: boolean; summary: string }
  | { type: "ui"; role: RoleName; name: string; payload: any }
  | { type: "agent_end"; role: RoleName; text: string }
  | { type: "error"; role: RoleName; message: string }
  | { type: "done" };

/** Called when the server says the session expired, so the app can show the sign-in screen. */
export let onUnauthorized = () => {};
export const setOnUnauthorized = (fn: () => void) => (onUnauthorized = fn);

async function json<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({ error: r.statusText }));
  if (r.status === 401 && !r.url.includes("/api/auth/")) onUnauthorized();
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body;
}

export interface Status {
  demo: boolean;
  provider: string;
  model: string;
  signupOpen: boolean;
}
export interface Me {
  id: string;
  username: string;
}
const post = (url: string, body?: object) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const api = {
  status: () => fetch("/api/status").then((r) => json<Status>(r)),
  me: () => fetch("/api/auth/me").then((r) => (r.ok ? (r.json() as Promise<Me>) : undefined)),
  login: (username: string, password: string) => post("/api/auth/login", { username, password }).then((r) => json<Me>(r)),
  signup: (username: string, password: string) => post("/api/auth/signup", { username, password }).then((r) => json<Me>(r)),
  logout: () => post("/api/auth/logout").then((r) => json<{ ok: true }>(r)),
  deleteCourse: (id: string) => fetch(`/api/courses/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r)),
  courses: () => fetch("/api/courses").then((r) => json<Course[]>(r)),
  course: (id: string) => fetch(`/api/courses/${id}`).then((r) => json<Course>(r)),
  create: (form: FormData) => fetch("/api/courses", { method: "POST", body: form }).then((r) => json<Course>(r)),
  chat: (id: string, sid: string) => fetch(`/api/courses/${id}/sessions/${sid}/chat`).then((r) => json<{ role: "student" | "tutor"; text: string }[]>(r)),
  dueCards: (id: string) => fetch(`/api/courses/${id}/flashcards/due`).then((r) => json<Flashcard[]>(r)),
  reviewCard: (id: string, cardId: string, rating: number) =>
    fetch(`/api/courses/${id}/flashcards/${cardId}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating }) }).then((r) => json<Flashcard>(r)),
  file: (id: string, name: string) => fetch(`/api/courses/${id}/files/${name}`).then((r) => r.text()),
};

/** POST and consume the server's SSE stream of faculty events. */
export async function streamPost(url: string, body: FormData | object | undefined, onEvent: (e: HarnessEvent) => void) {
  const init: RequestInit = { method: "POST" };
  if (body instanceof FormData) init.body = body;
  else if (body) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(url, init);
  if (res.status === 401) onUnauthorized();
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => undefined);
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

export const ROLE_META: Record<RoleName, { name: string; icon: string; color: string; blurb: string }> = {
  librarian: { name: "Librarian", icon: "📚", color: "var(--librarian)", blurb: "Finds and ingests material into your bag" },
  advisor: { name: "Advisor", icon: "🧭", color: "var(--advisor)", blurb: "Designs your ZPD roadmap" },
  editorial: { name: "Editorial", icon: "⚖️", color: "var(--editorial)", blurb: "Independent examiner" },
  tutor: { name: "Tutor", icon: "🎓", color: "var(--tutor)", blurb: "Teaches you live" },
  generations: { name: "Generations", icon: "🎬", color: "var(--generations)", blurb: "Visual assets (parked)" },
};
