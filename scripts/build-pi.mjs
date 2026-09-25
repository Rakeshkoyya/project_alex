#!/usr/bin/env node
/**
 * Build the vendored Pi packages (vendor/pi-mono) from source, in dependency order.
 * `--if-needed` skips packages whose dist/ is newer than their src/ (used by postinstall).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "vendor", "pi-mono", "packages");
const order = ["telemetry", "chord", "ai", "agent"];
const ifNeeded = process.argv.includes("--if-needed");
const tsc = join(import.meta.dirname, "..", "node_modules", "typescript", "bin", "tsc");

const newest = (dir) => {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
};

for (const pkg of order) {
  const dir = join(root, pkg);
  const dist = join(dir, "dist");
  if (ifNeeded && existsSync(dist) && newest(dist) >= newest(join(dir, "src"))) continue;
  process.stdout.write(`pi: building ${pkg}… `);
  rmSync(dist, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: dir, stdio: "inherit" });
  if (pkg === "ai") cpSync(join(dir, "src/providers/data"), join(dist, "providers/data"), { recursive: true });
  console.log("ok");
}
