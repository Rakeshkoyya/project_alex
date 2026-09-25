import { useState } from "react";
import { api, ROLE_META, type Course } from "../api";
import { Markdown } from "../components/Markdown";

/** The student's academic record: exams (Editorial), diary, activity log and system files. */
export function Record({ course }: { course: Course }) {
  const [file, setFile] = useState<{ name: string; text: string }>();
  const graded = course.assessments.filter((a) => a.status === "graded");
  const open = (name: string) => api.file(course.id, name).then((text) => setFile({ name, text }));

  return (
    <div className="record">
      <section className="panel">
        <h2>Assessment record <small className="muted">graded independently by Editorial</small></h2>
        {graded.length === 0 ? (
          <p className="muted">No graded assessments yet.</p>
        ) : (
          <table>
            <thead><tr><th>Date</th><th>Assessment</th><th>Kind</th><th>Score</th><th>Examiner's report</th></tr></thead>
            <tbody>
              {graded.map((a) => (
                <tr key={a.id}>
                  <td>{a.gradedAt?.slice(0, 10)}</td>
                  <td>{a.title}</td>
                  <td><span className="tag">{a.kind}</span></td>
                  <td><b>{a.score}%</b></td>
                  <td className="muted">{a.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <div className="record-cols">
        <section className="panel">
          <h2>Student diary</h2>
          {course.diary.length === 0 && <p className="muted">Your tutor writes here after each session.</p>}
          <ul className="diary">
            {[...course.diary].reverse().map((d) => (
              <li key={d.id}>
                <small className="muted">{d.createdAt.slice(0, 16).replace("T", " ")} · {ROLE_META[d.author].icon} {ROLE_META[d.author].name}</small>
                <p>{d.text}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <h2>Faculty activity</h2>
          <ul className="activity">
            {[...course.activity].reverse().slice(0, 60).map((a) => (
              <li key={a.id} className={a.kind}>
                <span>{ROLE_META[a.role].icon}</span>
                <span className="muted">{a.at.slice(11, 16)}</span>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="panel">
        <h2>System files</h2>
        <p className="muted">Every course is documented as plain files next to its data, so your progress is portable.</p>
        <div className="row">
          {["roadmap.md", "notes.md", "diary.md"].map((n) => <button key={n} onClick={() => open(n)}>{n}</button>)}
        </div>
        {file && (
          <div className="file-view">
            <b>{file.name}</b>
            <Markdown text={file.text} />
          </div>
        )}
      </section>
    </div>
  );
}
