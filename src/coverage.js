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

/** First coverage source found, checked in this order. Returns null if neither exists —
 *  absence is normal (no test run yet, or a project this doesn't apply to), not an error. */
export async function detectCoverage(repoRoot) {
  return (await goCoverage(repoRoot)) || (await istanbulCoverage(repoRoot));
}
