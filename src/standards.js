import fs from "node:fs/promises";
import path from "node:path";

/**
 * The documents that tell people — and agents — how to write code in this repo.
 *
 * Read from the developer's CHECKOUT, not from the ledger branch. The old endpoint asked git for
 * `ENGINEERING-STANDARDS-GO.md` at the ledger ref: one repo's filename, on a branch that holds
 * nothing but `.peephole/**`, so the tab was empty for every project including the one the
 * filename was written for.
 *
 * Discovered rather than configured, because these files already have conventional names, and the
 * list deliberately includes the agent-rules files (`.ai-rules.md`, `.cursorrules`,
 * `copilot-instructions.md`): they are load-bearing configuration that steers every generation,
 * and a board that shows the human standards while ignoring the machine ones is showing half the
 * policy. `standardsFiles` in `.peephole/config.yaml` overrides the list.
 */
const CANDIDATES = [
  "ENGINEERING-STANDARDS.md",
  "ENGINEERING-STANDARDS-GO.md",
  "CODING-STANDARDS.md",
  "STANDARDS.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  ".ai-rules.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  "docs/engineering-standards.md",
  "docs/coding-standards.md",
  "docs/architecture.md",
];

const MAX_BYTES = 1024 * 1024;

/** Every standards document present in this checkout, with its size. Paths are relative and come
 *  only from the candidate list, so nothing outside the repo can be named. */
export async function findStandards(repoRoot, configured) {
  const names = Array.isArray(configured) && configured.length ? configured : CANDIDATES;
  const found = [];
  for (const name of names) {
    const real = await insideRepo(repoRoot, name);
    if (!real) continue;
    try {
      const stat = await fs.stat(real);
      if (stat.isFile()) found.push({ name, bytes: stat.size });
    } catch {
      /* not in this repo */
    }
  }
  return found;
}

/**
 * The real path of `name` inside `repoRoot`, or null.
 *
 * Comparing the RESOLVED string was not enough. `path.resolve` collapses `../`, so a configured
 * name cannot climb out — but a symlink can: `.ai-rules.md -> /home/you/.ssh/id_rsa` passes any
 * string check and then gets read and rendered to whoever opens the tab. Both inputs are
 * attacker-reachable in the way that matters here — `standardsFiles` lives in a config committed
 * to a branch anyone with push access can write, and a symlink is just a file in the repo.
 *
 * So: follow the links first (`realpath`), then require the result to be under the repo, and
 * refuse a symlink outright. A standards document has no reason to be one.
 */
async function insideRepo(repoRoot, name) {
  const root = path.resolve(repoRoot);
  const abs = path.resolve(root, name);
  if (!abs.startsWith(root + path.sep)) return null;
  try {
    const link = await fs.lstat(abs);
    if (link.isSymbolicLink()) return null;
    const real = await fs.realpath(abs);
    return real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null;
  }
}

/** One document's text. `name` must be one the discovery step already reported, so this cannot be
 *  turned into a read-any-file endpoint. */
export async function readStandard(repoRoot, name, configured) {
  const found = await findStandards(repoRoot, configured);
  const pick = found.find((f) => f.name === name) || found[0] || null;
  if (!pick) return { files: found, file: null, content: null };
  // Re-resolved rather than trusting the discovery step's path: the file could have been replaced
  // by a link between the two calls, and this is the read that leaves the machine.
  const real = await insideRepo(repoRoot, pick.name);
  if (!real) return { files: found, file: null, content: null };
  const content = await fs.readFile(real, "utf8").catch(() => null);
  return {
    files: found,
    file: pick.name,
    truncated: content != null && content.length > MAX_BYTES,
    content: content == null ? null : content.slice(0, MAX_BYTES),
  };
}

export const STANDARD_CANDIDATES = CANDIDATES;
