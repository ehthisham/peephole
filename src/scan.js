import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "./git.js";
import { parseConfig, parseTicket } from "./schema.js";
import { markedSectionVersion, NOTE_VERSION } from "./notes.js";

// True when this code runs from an installed Claude Code plugin (cache/synced/marketplaces), where
// the shipped hooks/hooks.json already registers peephole's SessionStart/PreToolUse/SessionEnd hooks
// via ${CLAUDE_PLUGIN_ROOT}. In that mode the per-repo settings.local.json wiring is redundant and,
// if also written, double-fires every hook — so plugin mode counts as "hooks wired".
const RUNNING_AS_PLUGIN = /[/\\]plugins[/\\](cache|synced|marketplaces)[/\\]/.test(fileURLToPath(import.meta.url));

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
/** Reads a ledger file from the checkout when one is present, falling back to `git show` at the
 *  ref. The ledger checkout — clone or worktree — always holds exactly what was last committed,
 *  because every writer commits before returning. Going through git meant one process per ticket:
 *  110 spawns, 822ms, to read files already on disk. */
async function readLedgerFile(ledgerRoot, ref, file) {
  try {
    return await fs.readFile(path.join(ledgerRoot, file), "utf8");
  } catch {
    return git.showFile(ledgerRoot, ref, file);
  }
}

async function listLedgerFiles(ledgerRoot, ref, subpath) {
  try {
    const names = await fs.readdir(path.join(ledgerRoot, subpath));
    return names.map((n) => `${subpath}/${n}`);
  } catch {
    return git.lsTreeFiles(ledgerRoot, ref, subpath);
  }
}

export async function scan(ledgerRoot, ref, { repoRoot = ledgerRoot } = {}) {
  const issues = [];
  let config = null;

  const configText = await readLedgerFile(ledgerRoot, ref, ".peephole/config.yaml");
  if (configText === null) {
    issues.push({ kind: "missing-config", message: `No .peephole/config.yaml found on ${ref}` });
  } else {
    const parsed = parseConfig(configText);
    config = parsed.config;
    for (const e of parsed.errors) issues.push({ kind: "invalid-config", message: e });
  }

  const ticketFiles = await listLedgerFiles(ledgerRoot, ref, ".peephole/tickets");
  const ticketMdFiles = ticketFiles.filter((f) => f.endsWith(".md"));
  if (ticketFiles.length === 0) {
    issues.push({ kind: "missing-tickets-dir", message: ".peephole/tickets/ directory missing (or empty)" });
  }

  const tickets = [];
  for (const file of ticketMdFiles) {
    const id = file.split("/").pop().replace(/\.md$/, "");
    const text = await readLedgerFile(ledgerRoot, ref, file);
    const parsed = parseTicket(text, id);
    for (const e of parsed.errors) issues.push({ kind: "invalid-ticket", message: e, ticketId: id });
    if (parsed.ok) tickets.push(parsed.ticket);
  }

  const agentFiles = await listLedgerFiles(ledgerRoot, ref, ".peephole/agents");
  if (agentFiles.length === 0) {
    issues.push({ kind: "missing-agents-dir", message: ".peephole/agents/ directory missing (or empty)" });
  }
  const agents = [];
  for (const file of agentFiles.filter((f) => f.endsWith(".json"))) {
    const text = await readLedgerFile(ledgerRoot, ref, file);
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
  // CLAUDE.md is NOT required. The plugin ships a Peephole skill (skills/peephole/SKILL.md) that
  // travels with every install and already tells agents to create/claim a ticket before coding, so a
  // per-repo CLAUDE.md section only duplicates it (flagMissing: false). We still flag a CLAUDE.md
  // section that EXISTS but is out of date, so stale/contradictory instructions get refreshed. README
  // stays required: it is for humans browsing the repo to find the live board, which the skill does
  // not cover (flagMissing: true).
  for (const [file, kind, missing, stale, flagMissing] of [
    ["CLAUDE.md", "agent-note",
      "CLAUDE.md has no Peephole section — agents won't know to create/update tickets",
      "CLAUDE.md's Peephole section is out of date — agents are reading older instructions",
      false],
    ["README.md", "readme-note",
      "README.md has no Peephole section — nobody browsing the repo can find the live board",
      "README.md's Peephole section is out of date",
      true],
  ]) {
    const text = await readWorkingFile(repoRoot, file);
    const version = markedSectionVersion(text);
    if (version === null) { if (flagMissing) issues.push({ kind: `missing-${kind}`, message: missing }); }
    else if (version < NOTE_VERSION) issues.push({ kind: `stale-${kind}`, message: stale });
  }

  // A repo whose ledger lives on another branch needs one file on the CODE branch saying so.
  // Without it, resolution works only by guessing at a branch name.
  const pointer = await readWorkingFile(repoRoot, path.join(".peephole", "config.yaml"));
  if (!pointer) {
    issues.push({
      kind: "missing-pointer",
      message: ".peephole/config.yaml is missing from this checkout — nothing on the code branch says where the ledger lives",
    });
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
  // Plugin installs get their hooks from the plugin manifest (hooks/hooks.json), so they are already
  // enforced regardless of settings.local.json; only the non-plugin install needs the local wiring.
  const hooksInstalled = RUNNING_AS_PLUGIN || await hasHookSetup(repoRoot);
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
