import { ROLE_META, type HarnessEvent, type RoleName } from "../api";
import { Markdown } from "./Markdown";

/** Live view of the faculty at work: each agent run with its tool calls and message. */

export interface FeedBlock {
  role: RoleName;
  steps: { id: string; label: string; summary?: string; isError?: boolean; done: boolean }[];
  text: string;
  done: boolean;
}

export function reduceFeed(blocks: FeedBlock[], e: HarnessEvent): FeedBlock[] {
  const out = [...blocks];
  const cur = () => {
    const last = out[out.length - 1];
    if (last && "role" in e && last.role === e.role && !last.done) return last;
    const b: FeedBlock = { role: (e as any).role, steps: [], text: "", done: false };
    out.push(b);
    return b;
  };
  switch (e.type) {
    case "agent_start":
      out.push({ role: e.role, steps: [], text: "", done: false });
      break;
    case "text": {
      const b = cur();
      b.text += e.delta;
      break;
    }
    case "tool_start": {
      const b = cur();
      b.steps = [...b.steps, { id: e.id, label: e.label, done: false }];
      break;
    }
    case "tool_end": {
      const b = cur();
      b.steps = b.steps.map((s) => (s.id === e.id ? { ...s, done: true, summary: e.summary, isError: e.isError } : s));
      break;
    }
    case "agent_end": {
      // A delegated run (e.g. Editorial inside a Tutor turn) closes its own block only.
      for (let i = out.length - 1; i >= 0; i--) if (out[i].role === e.role && !out[i].done) { out[i] = { ...out[i], done: true }; break; }
      break;
    }
  }
  return out;
}

export function FacultyFeed({ blocks, compact }: { blocks: FeedBlock[]; compact?: boolean }) {
  return (
    <div className={`feed ${compact ? "compact" : ""}`}>
      {blocks.map((b, i) => {
        const meta = ROLE_META[b.role];
        return (
          <div key={i} className="feed-block" style={{ ["--role" as any]: meta.color }}>
            <div className="feed-head">
              <span className="avatar">{meta.icon}</span>
              <b>{meta.name}</b>
              <span className="muted">{meta.blurb}</span>
              {!b.done && <span className="spinner" />}
            </div>
            {b.steps.length > 0 && (
              <ul className="steps">
                {b.steps.map((s) => (
                  <li key={s.id} className={s.isError ? "err" : s.done ? "ok" : "run"}>
                    <span className="step-label">{s.label}</span>
                    {s.summary && !compact && <span className="muted step-sum">{s.summary.split("\n")[0].slice(0, 140)}</span>}
                  </li>
                ))}
              </ul>
            )}
            {b.text && <Markdown text={b.text} />}
          </div>
        );
      })}
    </div>
  );
}
