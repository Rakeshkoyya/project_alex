import { useEffect, useState } from "react";
import { api, type Course } from "./api";
import { Intake } from "./pages/Intake";
import { CourseView } from "./pages/CourseView";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export const go = (path: string) => (location.hash = path);

const STAGE_LABEL: Record<string, string> = {
  intake: "New",
  gathering: "Gathering material",
  assessment: "Diagnostic waiting",
  planning: "Planning",
  active: "Studying",
  completed: "Completed 🎓",
};

export function App() {
  const hash = useHash();
  const [status, setStatus] = useState<{ demo: boolean; model: string }>();
  useEffect(() => void api.status().then(setStatus).catch(() => {}), []);
  const m = hash.match(/^#\/course\/([^/]+)(?:\/(\w+))?/);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="crest">A</span>
          <span>
            <b>Alex</b>
            <small>personal university</small>
          </span>
        </a>
        <nav>
          <a href="#/">My courses</a>
        </nav>
        {status && (
          <span className={`mode ${status.demo ? "demo" : "live"}`} title={status.demo ? "Set ANTHROPIC_API_KEY on the server to run the real faculty" : ""}>
            {status.demo ? "Demo mode · scripted faculty" : `Live · ${status.model}`}
          </span>
        )}
      </header>
      <main>{m ? <CourseView key={m[1]} id={m[1]} tab={m[2]} /> : <Home />}</main>
    </div>
  );
}

function Home() {
  const [courses, setCourses] = useState<Course[]>([]);
  useEffect(() => void api.courses().then(setCourses), []);
  return (
    <div className="home">
      <Intake />
      {courses.length > 0 && (
        <section className="courses">
          <h2>Your courses</h2>
          <div className="grid">
            {courses.map((c) => {
              const mastered = c.concepts.filter((k) => k.status === "mastered").length;
              return (
                <a key={c.id} className="card course-card" href={`#/course/${c.id}`}>
                  <span className="stage-pill" data-stage={c.stage}>{STAGE_LABEL[c.stage]}</span>
                  <h3>{c.title}</h3>
                  <p className="muted">{c.goal}</p>
                  {c.concepts.length > 0 && (
                    <div className="progress">
                      <div style={{ width: `${(mastered / c.concepts.length) * 100}%` }} />
                    </div>
                  )}
                  <small className="muted">
                    {c.concepts.length ? `${mastered}/${c.concepts.length} concepts mastered` : "Not started"}
                    {c.deadline && ` · due ${c.deadline}`}
                  </small>
                </a>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
