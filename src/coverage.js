import fs from "node:fs/promises";
import path from "node:path";

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// A go test -coverprofile line: <file>:<startLine>.<startCol>,<endLine>.<endCol> <numStmt> <count>
const PROFILE_LINE_RE = /^(\S+):\d+\.\d+,\d+\.\d+ (\d+) (\d+)$/;

/**
 * Reads `coverage.out` (a `go test -coverprofile` profile — Go's own, not something Peephole
 * generates) STRAIGHT FROM THE WORKING TREE, not through the git-ref abstraction the rest of
 * `scan.js`/`repoStats.js` use: coverage profiles are test-run artifacts, `.gitignore`d by
 * convention, so nothing would ever be found at a committed ref.
 *
 * Parses the raw profile directly rather than shelling out to `go tool cover -func` — a `-func`
 * summary gives one percentage PER FUNCTION, which can't be weighted back into an accurate
 * PER-PACKAGE percentage (functions have different statement counts). The raw profile's
 * `<numStmt> <count>` pairs can: sum statements per package, sum covered-statements (count>0) per
 * package, divide. No `go` binary needed at all as a result — pure text parsing.
 */
async function goCoverage(repoRoot) {
  const file = path.join(repoRoot, "coverage.out");
  if (!(await fileExists(file))) return null;
  try {
    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n");
    const byPkg = new Map(); // package path (e.g. "internal/generic") -> {covered, total}
    let overallCovered = 0;
    let overallTotal = 0;

    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].trim().match(PROFILE_LINE_RE);
      if (!m) continue;
      const [, filePath, numStmtStr, countStr] = m;
      const numStmt = parseInt(numStmtStr, 10);
      const covered = parseInt(countStr, 10) > 0 ? numStmt : 0;

      // Strip the module import path (host.tld/org/repo/...) so the package label is
      // repo-relative, e.g. "internal/generic" not the full import path.
      const relPath = filePath.replace(/^[a-z0-9.-]+\.[a-z]{2,}\/[^/]+\/[^/]+\//, "");
      const pkg = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : relPath;

      const entry = byPkg.get(pkg) || { covered: 0, total: 0 };
      entry.total += numStmt;
      entry.covered += covered;
      byPkg.set(pkg, entry);
      overallTotal += numStmt;
      overallCovered += covered;
    }

    if (overallTotal === 0) return null;
    const modules = Array.from(byPkg.entries())
      .map(([pkg, { covered, total }]) => ({ pkg, pct: (covered / total) * 100, covered, total }))
      .sort((a, b) => a.pct - b.pct); // worst-covered first — the actionable view

    return { tool: "go", pct: (overallCovered / overallTotal) * 100, file: "coverage.out", modules };
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
    const modules = Object.entries(data)
      .filter(([key]) => key !== "total")
      .map(([filePath, s]) => ({
        pkg: path.dirname(filePath),
        pct: s.lines?.pct ?? 0,
        covered: s.lines?.covered ?? 0,
        total: s.lines?.total ?? 0,
      }))
      .reduce((acc, row) => {
        const existing = acc.find((a) => a.pkg === row.pkg);
        if (existing) {
          existing.covered += row.covered;
          existing.total += row.total;
        } else {
          acc.push({ pkg: row.pkg, covered: row.covered, total: row.total });
        }
        return acc;
      }, [])
      .map((row) => ({ ...row, pct: row.total ? (row.covered / row.total) * 100 : 0 }))
      .sort((a, b) => a.pct - b.pct);
    return {
      tool: "istanbul",
      pct: total.lines?.pct ?? null,
      lines: total.lines?.pct ?? null,
      statements: total.statements?.pct ?? null,
      branches: total.branches?.pct ?? null,
      functions: total.functions?.pct ?? null,
      file: "coverage/coverage-summary.json",
      modules,
    };
  } catch {
    return null;
  }
}

// Standard places a coverage artifact lives, beyond the repo root: single-service subdirs, and one
// level under the usual monorepo containers. Non-existent candidates cost only a failed stat.
const COMMON_SUBDIRS = ["server", "client", "backend", "frontend", "api", "web", "app", "src", "lib", "test", "tests"];
const MONOREPO_CONTAINERS = ["packages", "apps", "services", "modules", "libs"];

async function childDirs(repoRoot, rel) {
  try {
    const ents = await fs.readdir(path.join(repoRoot, rel), { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => `${rel}/${e.name}`);
  } catch {
    return [];
  }
}

/** Repo-relative base directories a coverage artifact might sit in — the root, common service dirs,
 *  and the immediate children of monorepo containers (packages/*, apps/*, …). */
async function candidateBases(repoRoot) {
  const bases = ["."];
  for (const d of COMMON_SUBDIRS) bases.push(d);
  for (const c of MONOREPO_CONTAINERS) {
    for (const child of await childDirs(repoRoot, c)) bases.push(child);
  }
  return bases;
}

/** The two coverage files a base could hold, repo-relative, in detection order. */
function baseFiles(base) {
  const dir = base === "." ? "" : base + "/";
  return [`${dir}coverage.out`, `${dir}coverage/coverage-summary.json`];
}

function withPrefix(result, prefix) {
  if (!prefix) return result;
  return {
    ...result,
    file: prefix + result.file,
    modules: (result.modules || []).map((m) => ({ ...m, pkg: prefix + m.pkg })),
  };
}

/** Fold several coverage sources (e.g. server/ + client/ in a monorepo) into one figure: modules are
 *  unioned (already prefixed by their base), and the headline % is recomputed over all of them so it
 *  is a true weighted total rather than one source's number. */
function mergeSources(sources) {
  let covered = 0;
  let total = 0;
  const modules = [];
  const tools = new Set();
  for (const s of sources) {
    tools.add(s.tool);
    for (const m of s.modules || []) {
      modules.push(m);
      covered += m.covered;
      total += m.total;
    }
  }
  modules.sort((a, b) => a.pct - b.pct); // worst-covered first — the actionable view
  return {
    tool: tools.size === 1 ? [...tools][0] : "mixed",
    pct: total ? (covered / total) * 100 : null,
    file: sources.map((s) => s.file).join(", "),
    modules,
    sources: sources.map((s) => ({ tool: s.tool, file: s.file, pct: s.pct })),
  };
}

/**
 * Coverage for a repo, found wherever a test run normally drops it — the root for a single-package
 * project, or `server/`, `client/`, `packages/*` … for a monorepo — and merged across every source
 * found. Returns null when none exists (normal: no test run yet, or coverage not configured).
 */
export async function detectCoverage(repoRoot) {
  const bases = await candidateBases(repoRoot);
  const sources = [];
  for (const base of bases) {
    const dir = path.join(repoRoot, base);
    const prefix = base === "." ? "" : base + "/";
    const go = await goCoverage(dir);
    if (go && go.modules && go.modules.length) sources.push(withPrefix(go, prefix));
    const ist = await istanbulCoverage(dir);
    if (ist && ist.modules && ist.modules.length) sources.push(withPrefix(ist, prefix));
  }
  if (!sources.length) return null;
  return sources.length === 1 ? sources[0] : mergeSources(sources);
}

/** Cheap size+mtime stamp across every candidate coverage file, so the board re-parses only when one
 *  actually changed (a test run rewrites the profile without touching git). Null when none exist —
 *  itself a change worth noticing, since a deleted profile clears the figure. */
export async function coverageStamp(repoRoot) {
  const bases = await candidateBases(repoRoot);
  const parts = [];
  for (const base of bases) {
    for (const rel of baseFiles(base)) {
      try {
        const st = await fs.stat(path.join(repoRoot, rel));
        parts.push(`${rel}=${st.size}:${st.mtimeMs}`);
      } catch {
        /* not present */
      }
    }
  }
  return parts.length ? parts.join("|") : null;
}
