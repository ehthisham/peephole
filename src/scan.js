import fs from "node:fs/promises";
import path from "node:path";
import * as git from "./git.js";
import { parseConfig, parseTicket } from "./schema.js";
import { hasMarkedSection } from "./notes.js";

/** Hook wiring is per-machine config (.claude/settings.local.json), read from the REAL repo
 * root directly — never through the git ref abstraction the rest of this file uses, since it
 * must reflect what Claude Code sessions on this machine actually see, not what's committed. */
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
export async function scan(repoRoot, ref) {
  const issues = [];
  let config = null;

  const configText = await git.showFile(repoRoot, ref, ".peephole/config.yaml");
  if (configText === null) {
    issues.push({ kind: "missing-config", message: `No .peephole/config.yaml found on ${ref}` });
  } else {
    const parsed = parseConfig(configText);
    config = parsed.config;
    for (const e of parsed.errors) issues.push({ kind: "invalid-config", message: e });
  }

  const ticketFiles = await git.lsTreeFiles(repoRoot, ref, ".peephole/tickets");
  const ticketMdFiles = ticketFiles.filter((f) => f.endsWith(".md"));
  if (ticketFiles.length === 0) {
    issues.push({ kind: "missing-tickets-dir", message: ".peephole/tickets/ directory missing (or empty)" });
  }

  const tickets = [];
  for (const file of ticketMdFiles) {
    const id = file.split("/").pop().replace(/\.md$/, "");
    const text = await git.showFile(repoRoot, ref, file);
    const parsed = parseTicket(text, id);
    for (const e of parsed.errors) issues.push({ kind: "invalid-ticket", message: e, ticketId: id });
    if (parsed.ok) tickets.push(parsed.ticket);
  }

  const agentFiles = await git.lsTreeFiles(repoRoot, ref, ".peephole/agents");
  if (agentFiles.length === 0) {
    issues.push({ kind: "missing-agents-dir", message: ".peephole/agents/ directory missing (or empty)" });
  }
  const agents = [];
  for (const file of agentFiles.filter((f) => f.endsWith(".json"))) {
    const text = await git.showFile(repoRoot, ref, file);
    try {
      const agent = JSON.parse(text);
      agents.push(agent);
    } catch (e) {
      issues.push({ kind: "invalid-agent", message: `${file} does not parse as JSON: ${e.message}` });
    }
  }

  const claudeMd = await git.showFile(repoRoot, ref, "CLAUDE.md");
  if (!hasMarkedSection(claudeMd)) {
    issues.push({ kind: "missing-agent-note", message: "CLAUDE.md has no Peephole section — agents won't know to create/update tickets" });
  }
  const readmeMd = (await git.showFile(repoRoot, ref, "README.md")) ?? (await git.showFile(repoRoot, ref, "readme.md"));
  if (!hasMarkedSection(readmeMd)) {
    issues.push({ kind: "missing-readme-note", message: "README.md has no Peephole section — nobody browsing the repo can find the live board" });
  }

  if (!(await hasHookSetup(repoRoot))) {
    issues.push({ kind: "missing-hook-setup", message: "No Peephole hook wired into .claude/settings.local.json — pause/skip/restart won't be enforced on agent sessions" });
  }

  const STALE_MS = 5 * 60 * 1000;
  const now = Date.now();
  for (const a of agents) {
    const last = a.lastSeenAt ? Date.parse(a.lastSeenAt) : NaN;
    a.stale = !Number.isFinite(last) || now - last > STALE_MS;
  }

  return { config, tickets, agents, issues };
}
