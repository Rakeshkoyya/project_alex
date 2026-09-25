/** Faculty roles and the event stream Alex exposes to its UI. */

export type RoleName = "advisor" | "librarian" | "tutor" | "editorial" | "generations";

export type FacultyEvent =
  | { type: "agent_start"; role: RoleName }
  | { type: "text"; role: RoleName; delta: string }
  | { type: "tool_start"; role: RoleName; id: string; name: string; label: string; args: unknown }
  | { type: "tool_end"; role: RoleName; id: string; name: string; isError: boolean; summary: string }
  /** Structured UI instruction emitted by a tool, e.g. show an artifact, refresh the plan, open a quiz. */
  | { type: "ui"; role: RoleName; name: string; payload: unknown }
  | { type: "compaction"; role: RoleName; status: string }
  | { type: "agent_end"; role: RoleName; text: string }
  | { type: "error"; role: RoleName; message: string };

export type Emit = (e: FacultyEvent) => void;
