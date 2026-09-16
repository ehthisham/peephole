import fs from "node:fs/promises";
import path from "node:path";
import * as git from "./git.js";
import { parseConfig, parseTicket } from "./schema.js";
import { markedSectionVersion, NOTE_VERSION } from "./notes.js";

/** Hook wiring is per-machine config (.claude/settings.local.json), read from the REAL repo
 * root directly — never through the git ref abstraction the rest of this file uses, since it
 * must reflect what Claude Code sessions on this machine actually see, not what's committed. */
/** Reads a file from the developer's checkout — for the things that live on the code branch and on
 *  this machine, rather than in the ledger. */
async function readWorkingFile(repoRoot, name) {
  try {
    return await fs.readFile(path.join(repoRoot, name), "utf8");
  } catch {
    return null;
  }
}

async function hasHookSetup(repoRoot) {
  try {
    const raw = await fs.readFile(path.join(repoRoot, ".claude", "settings.local.json"), "utf8");
    return raw.includes("peephole/hooks/");
  } catch {
    return false;
  }
}

/**
 * Reads `.peephole/**` at `ref` (e.g. "origin/main") without ever checking
 * that ref out — so it never disturbs whatever the developer's own working
 * tree is doing.
 */
/**
 * `ledgerRoot` is where `.peephole/**` is read from at `ref` — the ledger clone, or the repo itself
 * in worktree mode. `repoRoot` is the developer's checkout, and the two are no longer the same
 * place: CLAUDE.md, README.md, .gitignore and the hook wiring all belong to the code branch and to
 * this machine. Passing one root for both reported those files permanently missing once the ledger
 * moved into its own clone, which contains none of them.
 */
export async function scan(ledgerRoot, ref, { repoRoot = ledgerRoot } = {}) {
  const issues = [];
  let config = null;

  const configText = await git.showFile(ledgerRoot, ref, ".peephole/config.yaml");
  if (configText === null) {
    issues.push({ kind: "missing-config", message: `No .peephole/config.yaml found on ${ref}` });
  } else {
    const parsed = parseConfig(configText);
    config = parsed.config;
    for (const e of parsed.errors) issues.push({ kind: "invalid-config", message: e });
  }

  const ticketFiles = await git.lsTreeFiles(ledgerRoot, ref, ".peephole/tickets");
  const ticketMdFiles = ticketFiles.filter((f) => f.endsWith(".md"));
  if (ticketFiles.length === 0) {
    issues.push({ kind: "missing-tickets-dir", message: ".peephole/tickets/ directory missing (or empty)" });
  }

  const tickets = [];
  for (const file of ticketMdFiles) {
    const id = file.split("/").pop().replace(/\.md$/, "");
    const text = await git.showFile(ledgerRoot, ref, file);
    const parsed = parseTicket(text, id);
    for (const e of parsed.errors) issues.push({ kind: "invalid-ticket", message: e, ticketId: id });
    if (parsed.ok) tickets.push(parsed.ticket);
  }

  const agentFiles = await git.lsTreeFiles(ledgerRoot, ref, ".peephole/agents");
  if (agentFiles.length === 0) {
    issues.push({ kind: "missing-agents-dir", message: ".peephole/agents/ directory missing (or empty)" });
  }
  const agents = [];
  for (const file of agentFiles.filter((f) => f.endsWith(".json"))) {
    const text = await git.showFile(ledgerRoot, ref, file);
    try {
      const agent = JSON.parse(text);
      agents.push(agent);
    } catch (e) {
      issues.push({ kind: "invalid-agent", message: `${file} does not parse as JSON: ${e.message}` });
    }
  }

  // CLAUDE.md and README.md are read from the WORKING TREE, not the ledger ref. They belong to the
  // code branch and the scaffold writes them there; reading them at the ledger ref reported them
  // permanently missing once the ledger moved to its own branch (a sparse ledger clone contains
  // neither file), an issue no amount of clicking Fix it could clear.
  for (const [file, kind, missing, stale] of [
    ["CLAUDE.md", "agent-note",
      "CLAUDE.md has no Peephole section — agents won't know to create/update tickets",
      "CLAUDE.md's Peephole section is out of date — agents are reading older instructions"],
    ["README.md", "readme-note",
      "README.md has no Peephole section — nobody browsing the repo can find the live board",
      "README.md's Peephole section is out of date"],
  ]) {
    const text = await readWorkingFile(repoRoot, file);
    const version = markedSectionVersion(text);
    if (version === null) issues.push({ kind: `missing-${kind}`, message: missing });
    else if (version < NOTE_VERSION) issues.push({ kind: `stale-${kind}`, message: stale });
  }

  // The worktree fallback puts a full checkout inside the repo. Git does not ignore a nested
  // worktree on its own, so without this entry it shows up as untracked and one `git add -A`
  // commits the whole duplicate tree into the repo it was copied from.
  const gitignore = (await readWorkingFile(repoRoot, ".gitignore")) || "";
  // Accepts the anchored form too (`/.peephole-worktree/`), which is what a repo that already
  // ignores it usually has — matching only the bare spelling appended a duplicate line.
  if (!/^\s*\/?\.peephole-worktree\/?\s*$/m.test(gitignore)) {
    issues.push({
      kind: "missing-gitignore",
      message: ".peephole-worktree/ is not in .gitignore — a stray `git add -A` would commit a copy of the repo",
    });
  }

  // Reported as a value, not only as an issue: "are the hooks installed" and "has a session checked
  // in recently" are different questions, and the board was answering the first with the second.
  const hooksInstalled = await hasHookSetup(repoRoot);
  if (!hooksInstalled) {
    issues.push({ kind: "missing-hook-setup", message: "No Peephole hook wired into .claude/settings.local.json — pause/skip won't be enforced on agent sessions" });
  }

  const STALE_MS = 5 * 60 * 1000;
  const now = Date.now();
  for (const a of agents) {
    const last = a.lastSeenAt ? Date.parse(a.lastSeenAt) : NaN;
    a.stale = !Number.isFinite(last) || now - last > STALE_MS;
  }

  return { config, tickets, agents, issues, hooksInstalled };
}
