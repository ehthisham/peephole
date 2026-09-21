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
    // A configured name is still resolved inside the repo and never above it: a config file is
    // committed content, and a ledger branch anyone can push to should not be able to name
    // /etc/passwd.
    const abs = path.resolve(repoRoot, name);
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) continue;
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) found.push({ name, bytes: stat.size });
    } catch {
      /* not in this repo */
    }
  }
  return found;
}

/** One document's text. `name` must be one the discovery step already reported, so this cannot be
 *  turned into a read-any-file endpoint. */
export async function readStandard(repoRoot, name, configured) {
  const found = await findStandards(repoRoot, configured);
  const pick = found.find((f) => f.name === name) || found[0] || null;
  if (!pick) return { files: found, file: null, content: null };
  const abs = path.resolve(repoRoot, pick.name);
  const content = await fs.readFile(abs, "utf8").catch(() => null);
  return {
    files: found,
    file: pick.name,
    truncated: content != null && content.length > MAX_BYTES,
    content: content == null ? null : content.slice(0, MAX_BYTES),
  };
}

export const STANDARD_CANDIDATES = CANDIDATES;
