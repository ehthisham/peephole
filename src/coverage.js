import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Same PATH-then-known-install-path fallback the repo's own Makefile uses (`GO ?=
 *  $(shell command -v go 2>/dev/null || echo /usr/local/go/bin/go)`) — this box's `go`
 *  isn't always on a non-interactive PATH. */
async function resolveGo() {
  try {
    const { stdout } = await execFileP("which", ["go"]);
    if (stdout.trim()) return stdout.trim();
  } catch {
    // fall through to the known install location
  }
  return (await fileExists("/usr/local/go/bin/go")) ? "/usr/local/go/bin/go" : "go";
}

/**
 * Reads `coverage.out` (a `go test -coverprofile` profile — Go's own, not something Peephole
 * generates) STRAIGHT FROM THE WORKING TREE, not through the git-ref abstraction the rest of
 * `scan.js`/`repoStats.js` use: coverage profiles are test-run artifacts, `.gitignore`d by
 * convention (verified: this repo's own `.gitignore` excludes it), so nothing would ever be
 * found at a committed ref. Same exception `scan.js`'s `hasHookSetup` already makes for
 * `.claude/settings.local.json` — a few real-repo signals only exist on disk.
 */
async function goCoverage(repoRoot) {
  const file = path.join(repoRoot, "coverage.out");
  if (!(await fileExists(file))) return null;
  try {
    const go = await resolveGo();
    const { stdout } = await execFileP(go, ["tool", "cover", `-func=${file}`], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
    const lastLine = stdout.trim().split("\n").pop() || "";
    const m = lastLine.match(/([\d.]+)%\s*$/);
    if (!m) return null;
    return { tool: "go", pct: parseFloat(m[1]), file: "coverage.out" };
  } catch (e) {
    return { tool: "go", pct: null, file: "coverage.out", error: e.message };
  }
}

/** Istanbul/nyc/vitest `--reporter=json-summary` output — a plain JSON read, no exec needed. */
async function istanbulCoverage(repoRoot) {
  const file = path.join(repoRoot, "coverage", "coverage-summary.json");
  if (!(await fileExists(file))) return null;
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    const total = data.total;
    if (!total) return null;
    return {
      tool: "istanbul",
      pct: total.lines?.pct ?? null,
      lines: total.lines?.pct ?? null,
      statements: total.statements?.pct ?? null,
      branches: total.branches?.pct ?? null,
      functions: total.functions?.pct ?? null,
      file: "coverage/coverage-summary.json",
    };
  } catch {
    return null;
  }
}

/** First coverage source found, checked in this order. Returns null if neither exists —
 *  absence is normal (no test run yet, or a project this doesn't apply to), not an error. */
export async function detectCoverage(repoRoot) {
  return (await goCoverage(repoRoot)) || (await istanbulCoverage(repoRoot));
}
