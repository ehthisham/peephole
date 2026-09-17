import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import * as git from "./git.js";

/**
 * Where a repo's ticket ledger is checked out for Peephole to read and write.
 *
 * Two shapes, same contract — a directory containing `.peephole/**` on the ledger branch, plus the
 * branch name to commit and push:
 *
 * - **clone**: a sparse, blobless clone of the repo under `~/.peephole/ledgers/<slug>`, checked out
 *   to the ledger branch with `sparse-checkout set --no-cone .peephole`. It holds the ticket files
 *   and nothing else (measured on a real repo: 120 files, 512 KB, against 37 MB for a full
 *   worktree), lives outside the developer's repo entirely — no untracked tree to gitignore, no
 *   `git worktree remove` to undo — and is immune to whatever their checkout is doing.
 *
 * - **worktree**: the original `<repo>/.peephole-worktree`. Still required, and not a legacy path:
 *   a repo with no remote cannot be cloned from a URL, and a ledger branch that has never been
 *   pushed does not exist to clone. Both are ordinary situations — every repo starts that way.
 *
 * The choice is made per call and is not sticky: a repo that gains a remote, or a ledger branch
 * that gets pushed for the first time, moves to clone mode on the next resolve. The reverse never
 * silently happens with commits at stake, because a worktree holding unpushed ledger commits keeps
 * being used until those commits are pushed — switching to a clone would hide them.
 */
const LEDGER_HOME = process.env.PEEPHOLE_LEDGER_HOME || path.join(os.homedir(), ".peephole", "ledgers");

function slugFor(repoRoot, remoteUrl) {
  const base = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, "-");
  // Include a short digest of the remote (or the path) so two checkouts of different repos that
  // happen to share a directory name never share a ledger.
  const key = remoteUrl || repoRoot;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `${base}-${h.toString(16).padStart(8, "0")}`;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** A worktree that still holds commits nobody else has. Clone mode would read the remote and show
 *  a board missing exactly that work, so it stays in charge until the commits are pushed. */
async function worktreeHasUnpushed(repoRoot, branch) {
  const worktreePath = path.join(repoRoot, ".peephole-worktree");
  if (!(await exists(path.join(worktreePath, ".git")))) return false;
  const localBranch = `peephole/${branch}`;
  const count = await git.unpushedCount(worktreePath, localBranch, branch).catch(() => 0);
  return count > 0;
}

async function ensureClone(repoRoot, branch, remoteUrl, remote, { fetch = false } = {}) {
  const dir = path.join(LEDGER_HOME, slugFor(repoRoot, remoteUrl));
  if (await exists(path.join(dir, ".git"))) {
    // Fetching belongs to a refresh cycle, not to a write. It was running here on EVERY ledger
    // operation — every state move, control click, comment and selection toggle paid a network
    // round trip to the remote before it could touch a file, which is why moving a card took
    // seconds to show. Measured at 3.6s of a ~4.5s write.
    if (!fetch) return dir;
    await git.fetch(dir, remote).catch(() => {});
    // Fast-forward ONLY when nothing local is waiting. An unconditional reset is destructive here
    // in a way it never was for the worktree: the clone is the only copy of a ledger commit until
    // it is pushed, so resetting to the remote deletes work that exists nowhere else. (It did:
    // a ticket write committed in the clone vanished on the next resolve, and the push that
    // followed reported success having sent nothing.) Same rule as syncWorktreeIfClean.
    const pending = await git.unpushedCount(dir, branch, branch, remote).catch(() => 1);
    if (pending === 0) await git.hardResetTo(dir, `${remote}/${branch}`).catch(() => {});
    return dir;
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  // blob:none + sparse: history without file contents, and only `.peephole/` on disk. `--no-cone`
  // matters — cone mode also checks out every root-level file, which on a real repo was 139 files
  // instead of 120 and defeats the point.
  await git.cloneLedger(remoteUrl, dir, branch, remote);
  await git.sparseCheckoutLedger(dir);
  return dir;
}

/**
 * Resolves the ledger for `repoRoot` on `branch`, preferring a clone and falling back to the
 * in-repo worktree. `reason` explains the fallback, for the UI to show rather than leaving a user
 * wondering why a directory appeared inside their repo.
 */
/** Resolution involves several git calls and, when fetching, the network. Writes arrive in bursts —
 *  a dispatch claims, advances and comments within a second — so the answer is memoised briefly.
 *  A fetching resolve always recomputes and refreshes the entry. */
const cache = new Map();
const CACHE_MS = 10000;

export async function resolveLedger(repoRoot, branch, { remote = "origin", allowClone = true, fetch = false } = {}) {
  const key = `${repoRoot}\u0000${branch}\u0000${remote}\u0000${allowClone}`;
  if (!fetch) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  }
  const value = await resolveLedgerUncached(repoRoot, branch, { remote, allowClone, fetch });
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function resolveLedgerUncached(repoRoot, branch, { remote, allowClone, fetch }) {
  const remoteUrl = await git.remoteUrl(repoRoot, remote).catch(() => null);
  const reasons = [];
  if (!allowClone) reasons.push("clone mode disabled");
  if (allowClone && !remoteUrl) reasons.push("repo has no remote to clone from");
  if (allowClone && remoteUrl && !(await git.remoteBranchExists(repoRoot, branch, remote))) {
    reasons.push(`${remote}/${branch} does not exist yet — push it to move the ledger out of the repo`);
  }
  if (allowClone && remoteUrl && reasons.length === 0 && (await worktreeHasUnpushed(repoRoot, branch))) {
    reasons.push("the in-repo worktree still holds unpushed ledger commits");
  }

  if (reasons.length === 0) {
    try {
      const dir = await ensureClone(repoRoot, branch, remoteUrl, remote, { fetch });
      return { kind: "clone", path: dir, localBranch: branch, reason: null };
    } catch (e) {
      reasons.push(`clone failed: ${e.message}`);
    }
  }

  const { worktreePath, localBranch } = await git.ensureWorktree(repoRoot, branch, remote);
  await git.syncWorktreeIfClean(worktreePath, localBranch, branch, remote);
  return { kind: "worktree", path: worktreePath, localBranch, reason: reasons[0] || null };
}
