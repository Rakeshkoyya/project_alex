import type { CourseState } from "./types.js";

/** Human-readable system files kept next to each course's JSON state. */

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function renderRoadmapMd(c: CourseState): string {
  const lines = [`# ${c.title}`, "", `**Goal:** ${c.goal}`, ""];
  if (c.deadline) lines.push(`**Deadline:** ${c.deadline}`, "");
  lines.push(`**Stage:** ${c.stage} · **Hours/week:** ${c.hoursPerWeek}`, "");

  if (c.roadmap) {
    const r = c.roadmap;
    lines.push("## Why this path", "", r.rationale, "", "## Modules", "");
    for (const m of r.modules) {
      lines.push(`### ${m.title} — day ${m.startDay + 1}–${m.startDay + m.durationDays} (${m.status})`, "", m.summary, "");
      if (m.objectives.length) lines.push("**Objectives**", ...m.objectives.map((o) => `- ${o}`), "");
      const titles = m.conceptIds.map((id) => c.concepts.find((x) => x.id === id)?.title ?? id);
      if (titles.length) lines.push("**Concepts**", ...titles.map((t) => `- ${t}`), "");
      if (m.exercises.length) lines.push("**Exercises**", ...m.exercises.map((e) => `- ${e}`), "");
      if (m.memoryTechniques.length) lines.push("**Memory techniques**", ...m.memoryTechniques.map((e) => `- ${e}`), "");
      lines.push(`**Checkpoint:** ${m.assessment}`, "");
    }
    if (r.milestones.length) lines.push("## Milestones", "", ...r.milestones.map((m) => `- Day ${m.day}: ${m.title}`), "");
  }

  if (c.concepts.length) {
    lines.push("## Concept map (ZPD state)", "", "| Concept | Depth | Prerequisites | Mastery | Zone | Status |", "|---|---|---|---|---|---|");
    for (const k of c.concepts) {
      const pre = k.prerequisites.map((id) => c.concepts.find((x) => x.id === id)?.title ?? id).join(", ") || "—";
      lines.push(`| ${k.title} | ${k.depth} | ${pre} | ${pct(k.pKnown)} | ${k.zone} | ${k.status} |`);
    }
    lines.push("");
  }

  if (c.assessments.some((a) => a.status === "graded")) {
    lines.push("## Assessment record", "", "| Date | Assessment | Score |", "|---|---|---|");
    for (const a of c.assessments.filter((a) => a.status === "graded")) {
      lines.push(`| ${a.gradedAt?.slice(0, 10)} | ${a.title} | ${a.score}% |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderDiaryMd(c: CourseState): string {
  const lines = [`# Student diary — ${c.title}`, ""];
  for (const d of c.diary) lines.push(`## ${d.createdAt.slice(0, 16).replace("T", " ")} · ${d.author}`, "", d.text, "");
  return lines.join("\n");
}

export function renderNotesMd(c: CourseState): string {
  const lines = [`# Student bag — ${c.title}`, "", "## Resources", ""];
  for (const r of c.bag.resources) lines.push(`- **${r.title}** (${r.kind}${r.source ? `, ${r.source}` : ""}) — ${r.summary ?? ""}`);
  lines.push("", "## Points to remember", "");
  for (const k of c.bag.keyPoints) lines.push(`- ${k.text}${k.aid ? `  \n  _${k.technique}: ${k.aid}_` : ""}`);
  lines.push("", "## Notes", "");
  for (const n of c.bag.notes) lines.push(`### ${n.title}`, "", n.body, "");
  return lines.join("\n");
}
