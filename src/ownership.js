import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Who knows which parts of the codebase, measured as each author's share of the commits that
 * touched a directory inside a window.
 *
 * Commit share, not `git blame`. Blame is the intuitive measure and the wrong one here: it costs
 * minutes on a repo this size, it credits whoever last reformatted a file, and it says nothing
 * about who has read the code recently. Share-of-recent-commits is the standard proxy (it is what
 * the code-ownership literature uses), it comes from one `git log`, and it decays naturally —
 * somebody who owned a package two years ago and has not touched it since is no longer the person
 * you ask about it, which is exactly the claim this map needs to support.
 *
 * The window is the whole recency model. Rather than weighting every commit by age — which invents
 * a decay constant nobody can defend — anything older than the window simply does not count, and
 * the window is stated wherever the numbers are shown.
 */
const DEFAULT_WINDOW_MONTHS = 12;
const TIMEOUT_MS = 60000;

function sinceArg(months) {
  return `${months}.months.ago`;
}

/** The directory a file belongs to — the same key coverage reports use (`internal/store`), so the
 *  two can be joined without a mapping table. Files at the root collapse to ".". */
function packageOf(file) {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "." : file.slice(0, idx);
}

/**
 * Per-package authorship for `repoRoot` at `ref`, within the window.
 *
 * Returns packages keyed by directory, each with: total commits that touched it, a per-author
 * commit count, and when each author last touched it. `--use-mailmap` so the same human under two
 * addresses is one person, matching the Members panel.
 */
export async function ownershipMap(repoRoot, ref = "HEAD", { months = DEFAULT_WINDOW_MONTHS } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileP(
      "git",
      [
        "log", ref, "--use-mailmap", `--since=${sinceArg(months)}`, "--no-merges",
        // \x01 marks a commit header so the numstat block below it can be attributed without a
        // second pass; \x1f separates fields that may themselves contain spaces.
        "--pretty=format:\x01%H\x1f%aN\x1f%aI", "--numstat",
      ],
      { cwd: repoRoot, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return null;
  }

  const packages = new Map();
  let author = null;
  let at = null;
  let seenInCommit = null;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("\x01")) {
      const [, name, iso] = line.slice(1).split("\x1f");
      author = name;
      at = iso;
      // A commit touching six files in one package is one commit's worth of knowledge, not six.
      seenInCommit = new Set();
      continue;
    }
    if (!author || !line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const file = parts[2];
    // The ledger is Peephole's own bookkeeping, not this project's code.
    if (file.startsWith(".peephole/")) continue;

    const pkg = packageOf(file);
    if (seenInCommit.has(pkg)) continue;
    seenInCommit.add(pkg);

    let entry = packages.get(pkg);
    if (!entry) {
      entry = { pkg, commits: 0, authors: {}, lastBy: {} };
      packages.set(pkg, entry);
    }
    entry.commits += 1;
    entry.authors[author] = (entry.authors[author] || 0) + 1;
    if (!entry.lastBy[author] || entry.lastBy[author] < at) entry.lastBy[author] = at;
  }

  return {
    windowMonths: months,
    generatedAt: new Date().toISOString(),
    packages: [...packages.values()].sort((a, b) => b.commits - a.commits),
  };
}
