import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamPost, type Course, type HarnessEvent } from "../api";
import { go } from "../App";
import { FacultyFeed, reduceFeed, type FeedBlock } from "../components/FacultyFeed";
import { Bag } from "./Bag";
import { AssessmentView } from "./AssessmentView";
import { Roadmap } from "./Roadmap";
import { Study } from "./Study";
import { Record } from "./Record";

const TABS = [
  { id: "prepare", label: "Faculty", stage: ["intake", "gathering"] },
  { id: "bag", label: "Student bag" },
  { id: "diagnostic", label: "Diagnostic", stage: ["assessment"] },
  { id: "roadmap", label: "Roadmap", stage: ["planning"] },
  { id: "study", label: "Study", stage: ["active"] },
  { id: "record", label: "Record" },
];

const STEPS = [
  { stage: "gathering", label: "Material" },
  { stage: "assessment", label: "Diagnostic" },
  { stage: "planning", label: "Roadmap" },
  { stage: "active", label: "Studying" },
  { stage: "completed", label: "Graduated" },
];
const ORDER = ["intake", "gathering", "assessment", "planning", "active", "completed"];

export function CourseView({ id, tab }: { id: string; tab?: string }) {
  const [course, setCourse] = useState<Course>();
  const [feed, setFeed] = useState<FeedBlock[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const started = useRef(false);

  const refresh = useCallback(() => api.course(id).then(setCourse), [id]);
  useEffect(() => void refresh(), [refresh]);

  /** Run a faculty operation, stream it into the feed, refresh on UI events. */
  const run = useCallback(
    async (url: string, body?: FormData | object, onEvent?: (e: HarnessEvent) => void) => {
      setBusy(true);
      setError("");
      try {
        await streamPost(url, body, (e) => {
          setFeed((f) => reduceFeed(f, e));
          if (e.type === "ui" || e.type === "agent_end") refresh();
          if (e.type === "error") setError(e.message);
          onEvent?.(e);
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [refresh],
  );

  // Kick off preparation automatically for a freshly enrolled course.
  useEffect(() => {
    if (course?.stage === "intake" && !started.current) {
      started.current = true;
      if (tab !== "prepare") go(`/course/${id}/prepare`);
      run(`/api/courses/${id}/prepare`).then(() => go(`/course/${id}/diagnostic`));
    }
  }, [course?.stage]);

  if (!course) return <div className="loading">Loading…</div>;

  const active = tab ?? defaultTab(course.stage);
  const stageIdx = ORDER.indexOf(course.stage);

  return (
    <div className="course">
      <div className="course-head">
        <div>
          <h1>{course.title}</h1>
          <p className="muted">
            {course.goal}
            {course.deadline && <> · deadline <b>{course.deadline}</b></>} · {course.hoursPerWeek} h/week
          </p>
        </div>
        <ol className="stepper">
          {STEPS.map((s) => {
            const i = ORDER.indexOf(s.stage);
            return (
              <li key={s.stage} className={i < stageIdx ? "done" : i === stageIdx ? "now" : ""}>
                <span />
                {s.label}
              </li>
            );
          })}
        </ol>
      </div>
      <nav className="tabs">
        {TABS.map((t) => (
          <a key={t.id} href={`#/course/${id}/${t.id}`} className={`${active === t.id ? "on" : ""} ${t.stage?.includes(course.stage) ? "attn" : ""}`}>
            {t.label}
            {t.id === "bag" && course.dueFlashcards > 0 && <span className="badge">{course.dueFlashcards}</span>}
          </a>
        ))}
      </nav>
      {error && <p className="error banner">⚠️ {error}</p>}

      {active === "prepare" && (
        <section className="panel">
          <h2>Your faculty is preparing the course</h2>
          <p className="muted">The Librarian fills your bag, the Advisor maps the concepts (including the foundations underneath), and the Editorial board writes a diagnostic so we can find your Zone of Proximal Development.</p>
          {feed.length ? <FacultyFeed blocks={feed} /> : <p className="muted">{busy ? "Starting…" : course.stage === "intake" ? "Queued…" : "Preparation finished — see the Diagnostic tab."}</p>}
          {!busy && course.stage === "assessment" && <button className="primary" onClick={() => go(`/course/${id}/diagnostic`)}>Take the diagnostic →</button>}
        </section>
      )}
      {active === "bag" && <Bag course={course} run={run} busy={busy} feed={feed} refresh={refresh} />}
      {active === "diagnostic" && <DiagnosticTab course={course} run={run} busy={busy} feed={feed} />}
      {active === "roadmap" && <Roadmap course={course} />}
      {active === "study" && <Study course={course} run={run} busy={busy} refresh={refresh} />}
      {active === "record" && <Record course={course} />}
    </div>
  );
}

function defaultTab(stage: string) {
  return { intake: "prepare", gathering: "prepare", assessment: "diagnostic", planning: "roadmap", active: "study", completed: "record" }[stage] ?? "bag";
}

function DiagnosticTab({ course, run, busy, feed }: { course: Course; run: RunFn; busy: boolean; feed: FeedBlock[] }) {
  const diag = course.assessments.filter((a) => a.kind === "diagnostic").at(-1);
  if (!diag) return <section className="panel"><p className="muted">The diagnostic will appear once the faculty has prepared the course.</p></section>;
  return (
    <section className="panel">
      <h2>Diagnostic assessment</h2>
      <p className="muted">
        No pressure — this isn't graded for a mark. It locates where your solid ground ends so your roadmap starts exactly there. Questions cover the target topics <i>and</i> the foundations beneath them. Skip anything you don't know.
      </p>
      <AssessmentView
        assessment={diag}
        busy={busy}
        onSubmit={(responses) => run(`/api/courses/${course.id}/assessments/${diag.id}/submit`, { responses }).then(() => go(`/course/${course.id}/roadmap`))}
      />
      {busy && <FacultyFeed blocks={feed.slice(-3)} compact />}
    </section>
  );
}

export type RunFn = (url: string, body?: FormData | object, onEvent?: (e: HarnessEvent) => void) => Promise<void>;
