import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as git from "./git.js";

/**
 * The list of repos this Peephole install watches, stored outside any of them
 * (`~/.peephole/projects.json`). It is a convenience index, never a source of truth: a project's
 * real state lives in its repo's ledger branch, so losing this file costs nothing but the menu.
 *
 * Deliberately not stored inside the peephole checkout — that is a git repo somebody may pull,
 * and one developer's local paths have no business travelling to another's machine.
 */
const HOME = process.env.PEEPHOLE_HOME || path.join(os.homedir(), ".peephole");
const FILE = path.join(HOME, "projects.json");

async function readRaw() {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRaw(list) {
  await fs.mkdir(HOME, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(list, null, 2) + "\n", "utf8");
}

function idFor(repoRoot) {
  return path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
}

/** Every known project, each annotated with whether its checkout is still there — a path can be
 *  moved or deleted between runs, and a menu entry that silently fails to open is worse than one
 *  that says the directory is gone. */
export async function listProjects() {
  const list = await readRaw();
  return Promise.all(
    list.map(async (p) => ({
      ...p,
      missing: !(await fs
        .access(path.join(p.repoRoot, ".git"))
        .then(() => true)
        .catch(() => false)),
    })),
  );
}

/** Records a project (or refreshes what is known about it) and returns the full list. Called every
 *  time a board starts, so simply running `serve --repo X` is enough to make X switchable later —
 *  there is no separate "add project" step to forget. */
export async function rememberProject(repoRoot, { name, remoteUrl, stateBranch } = {}) {
  const list = await readRaw();
  const id = idFor(repoRoot);
  const entry = {
    id,
    name: name || path.basename(repoRoot),
    repoRoot,
    remoteUrl: remoteUrl ?? null,
    stateBranch: stateBranch ?? null,
    lastOpenedAt: new Date().toISOString(),
  };
  const idx = list.findIndex((p) => p.repoRoot === repoRoot || p.id === id);
  if (idx === -1) list.push(entry);
  else list[idx] = { ...list[idx], ...entry };
  await writeRaw(list);
  return list;
}

export async function forgetProject(repoRoot) {
  const list = await readRaw();
  await writeRaw(list.filter((p) => p.repoRoot !== repoRoot));
}

/** Validates a directory before the server tries to switch to it: a wrong path should come back as
 *  a sentence in the UI, not a stack trace that leaves the board pointing at nothing. */
export async function validateRepo(repoRoot) {
  const abs = path.resolve(repoRoot);
  const isGit = await fs
    .access(path.join(abs, ".git"))
    .then(() => true)
    .catch(() => false);
  if (!isGit) return { ok: false, error: `${abs} is not a git repository` };
  const branch = await git.currentBranch(abs).catch(() => null);
  if (!branch) return { ok: false, error: `${abs} has no checked-out branch` };
  return { ok: true, repoRoot: abs };
}
