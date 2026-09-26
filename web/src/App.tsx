import { useEffect, useState } from "react";
import { api, setOnUnauthorized, type Course, type Me, type Status } from "./api";
import { Intake } from "./pages/Intake";
import { Login } from "./pages/Login";
import { CourseView } from "./pages/CourseView";
import { ThemeToggle } from "./components/ThemeToggle";

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
  const [status, setStatus] = useState<Status>();
  const [me, setMe] = useState<Me | null>(); // undefined = checking, null = signed out
  useEffect(() => {
    api.status().then(setStatus).catch(() => {});
    api.me().then((u) => setMe(u ?? null)).catch(() => setMe(null));
    setOnUnauthorized(() => setMe(null));
  }, []);
  const m = hash.match(/^#\/course\/([^/]+)(?:\/(\w+))?/);
  const route = m ? "course" : hash === "#/new" ? "new" : hash === "#/courses" ? "courses" : "home";

  const logout = async () => {
    await api.logout().catch(() => {});
    setMe(null);
    go("/");
  };

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
        {me && (
          <nav>
            <a href="#/courses" className={route === "courses" ? "on" : ""}>My courses</a>
            <a href="#/new" className={`new ${route === "new" ? "on" : ""}`}>+ New course</a>
          </nav>
        )}
        <div className="top-right">
          {status && (
            <span className={`mode ${status.demo ? "demo" : "live"}`} title={status.demo ? "Set OPENROUTER_API_KEY on the server to run the real faculty" : `${status.provider} · ${status.model}`}>
              {status.demo ? "Demo mode · scripted faculty" : `Live · ${status.model}`}
            </span>
          )}
          {me && !me.guest && (
            <span className="user">
              {me.username}
              <button className="link" onClick={logout}>Sign out</button>
            </span>
          )}
          <ThemeToggle />
        </div>
      </header>
      <main>
        {me === undefined ? <div className="loading">Loading…</div> : me === null ? <Login status={status} onDone={setMe} /> : m ? <CourseView key={m[1]} id={m[1]} tab={m[2]} /> : route === "new" ? <Intake /> : <Home key={hash} explicit={route === "courses"} />}
      </main>
    </div>
  );
}

/**
 * "My courses": the dashboard. It's also the landing page once the student has
 * a course; a first-time visitor (no courses) lands straight on the intake form.
 */
function Home({ explicit }: { explicit: boolean }) {
  const [courses, setCourses] = useState<Course[]>();
  useEffect(() => void api.courses().then(setCourses).catch(() => setCourses([])), []);
  if (!courses) return <div className="loading">Loading…</div>;
  if (!courses.length && !explicit) return <Intake />;
  return (
    <div className="home">
      <section className="courses">
        <div className="courses-head">
          <div>
            <h1>My courses</h1>
            <p className="muted">{courses.length ? "Pick up where you left off." : "You haven't started a course yet."}</p>
          </div>
          <a className="button primary" href="#/new">+ New course</a>
        </div>
        {courses.length === 0 ? (
          <a className="card empty-course" href="#/new">
            <b>Start your first course →</b>
            <span className="muted">Tell Alex what you want to learn, or drop in your book.</span>
          </a>
        ) : (
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
                    {c.concepts.length ? `${mastered}/${c.concepts.length} concepts mastered` : "Being prepared"}
                    {c.deadline && ` · due ${c.deadline}`}
                  </small>
                  <span className="continue">{NEXT_STEP[c.stage] ?? "Open"} →</span>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

const NEXT_STEP: Record<string, string> = {
  intake: "Continue setup",
  gathering: "See progress",
  assessment: "Take the diagnostic",
  planning: "See your roadmap",
  active: "Continue studying",
  completed: "Review",
};
