import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Run a git command in `cwd`. Never touches a shell — args are passed as an array. */
async function run(cwd, args) {
  try {
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = (err.stderr || "").toString();
    const e = new Error(stderr.trim() || err.message);
    e.code = err.code;
    e.stderr = stderr;
    throw e;
  }
}

export async function fetch(repoRoot, remote = "origin") {
  await run(repoRoot, ["fetch", remote]);
}

export async function remoteUrl(repoRoot, remote = "origin") {
  try {
    return (await run(repoRoot, ["remote", "get-url", remote])).trim();
  } catch {
    return null;
  }
}

/** The git identity already configured for this repo — the same one every commit peephole
 * makes goes out under. Used as the default "created by" for a UI-created ticket; nothing new
 * to configure. */
export async function gitUser(repoRoot) {
  const get = async (key) => {
    try {
      return (await run(repoRoot, ["config", key])).trim() || null;
    } catch {
      return null;
    }
  };
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  return { name, email };
}

export async function currentBranch(repoRoot) {
  return (await run(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/** The remote's default branch (Bitbucket/GitHub/GitLab all expose this the same way), falling back to the current local branch when it can't be determined. */
export async function defaultRemoteBranch(repoRoot, remote = "origin") {
  try {
    const out = await run(repoRoot, ["remote", "show", remote]);
    const m = out.match(/HEAD branch:\s*(\S+)/);
    if (m && m[1] && m[1] !== "(unknown)") return m[1];
  } catch {
    /* fall through */
  }
  return currentBranch(repoRoot);
}

/** Reads `.peephole/config.yaml`'s `stateBranch` at `ref` without checking anything out. Used to
 *  bootstrap branch resolution: the config that names the branch is itself committed on a branch,
 *  so it is read from the remote's default ref first and only then followed. */
export async function declaredStateBranch(repoRoot, ref) {
  const text = await showFile(repoRoot, ref, ".peephole/config.yaml");
  if (!text) return null;
  const m = text.match(/^stateBranch:\s*(.+)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "") || null;
}

export async function headSha(repoRoot, ref = "HEAD") {
  try {
    return (await run(repoRoot, ["rev-parse", ref])).trim();
  } catch {
    return null;
  }
}

export async function refExists(repoRoot, ref) {
  try {
    await run(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Files under `subpath` at `ref`, or [] if the ref/path doesn't exist. */
export async function lsTreeFiles(repoRoot, ref, subpath) {
  try {
    const out = await run(repoRoot, ["ls-tree", "-r", "--name-only", ref, "--", subpath]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** File content at `ref:path`, or null if it doesn't exist there. */
export async function showFile(repoRoot, ref, path) {
  try {
    return await run(repoRoot, ["show", `${ref}:${path}`]);
  } catch (e) {
    if (/does not exist|Invalid object name|exists on disk, but not in/i.test(e.stderr || e.message)) {
      return null;
    }
    throw e;
  }
}

const worktreeDirName = ".peephole-worktree";

function localBranchName(remoteBranch) {
  return `peephole/${remoteBranch}`;
}

/**
 * Ensures a dedicated worktree exists, checked out to a peephole-owned local
 * branch tracking `origin/<remoteBranch>` — writes happen here so the
 * developer's own checkout (whatever branch/dirty state it's in) is never touched.
 */
export async function ensureWorktree(repoRoot, remoteBranch, remote = "origin") {
  const worktreePath = `${repoRoot}/${worktreeDirName}`;
  const localBranch = localBranchName(remoteBranch);
  const fs = await import("node:fs");
  if (fs.existsSync(`${worktreePath}/.git`)) {
    return { worktreePath, localBranch };
  }
  // A dedicated ledger branch usually does not exist yet on the first run. Branch it from the
  // remote's default rather than from HEAD: HEAD is whatever the developer happens to have checked
  // out, so the ledger would inherit an unrelated feature branch's contents on one machine and not
  // on another. Created here, shared on the first push.
  const candidates = [`${remote}/${remoteBranch}`];
  const fallback = await defaultRemoteBranch(repoRoot, remote).catch(() => null);
  if (fallback) candidates.push(`${remote}/${fallback}`, fallback);
  let base = "HEAD";
  for (const ref of candidates) {
    if (await refExists(repoRoot, ref)) { base = ref; break; }
  }
  await run(repoRoot, ["worktree", "add", "-B", localBranch, worktreePath, base]);
  return { worktreePath, localBranch };
}

/** A ledger clone: history without blobs, one branch, sparse working tree. Cheap enough to keep
 *  per project — it carries the ticket files and nothing else. */
export async function cloneLedger(remoteUrl, dir, branch, remote = "origin") {
  await run(process.cwd(), [
    "clone", "--quiet", "--filter=blob:none", "--sparse", "--single-branch",
    "--origin", remote, "--branch", branch, remoteUrl, dir,
  ]);
}

/** Only `.peephole/` on disk. `--no-cone` is required: cone mode also materialises every
 *  root-level file, which is most of what the clone was avoiding. */
export async function sparseCheckoutLedger(dir) {
  await run(dir, ["sparse-checkout", "set", "--no-cone", ".peephole"]);
}

export async function hardResetTo(dir, ref) {
  await run(dir, ["reset", "--hard", ref]);
}

/** Paths touched by the commits waiting to be pushed. Used to prove an auto-push would only ever
 *  publish ledger writes — anything else means something unexpected rode along on this branch. */
export async function pendingPaths(worktreePath, localBranch, remoteBranch, remote = "origin") {
  const { range } = await pendingRange(worktreePath, localBranch, remoteBranch, remote);
  const out = await run(worktreePath, ["diff", "--name-only", range]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Fast-forwards the worktree branch to match the remote — only when nothing local is waiting to be pushed, so an in-flight (unpushed) commit is never discarded. */
export async function syncWorktreeIfClean(worktreePath, localBranch, remoteBranch, remote = "origin") {
  const hasRemote = await refExists(worktreePath, `${remote}/${remoteBranch}`);
  if (!hasRemote) return;
  const pending = await unpushedCount(worktreePath, localBranch, remoteBranch, remote);
  if (pending === 0) {
    await run(worktreePath, ["reset", "--hard", `${remote}/${remoteBranch}`]);
  }
}

export async function stageAll(worktreePath, paths = [".peephole"]) {
  await run(worktreePath, ["add", "-A", "--", ...paths]);
}

export async function commitStaged(worktreePath, message) {
  try {
    await run(worktreePath, ["commit", "-m", message]);
  } catch (e) {
    if (/nothing to commit/i.test(e.message)) return null;
    throw e;
  }
  return (await run(worktreePath, ["rev-parse", "HEAD"])).trim();
}

export async function amendStaged(worktreePath, message) {
  await run(worktreePath, ["commit", "--amend", "-m", message]);
  return (await run(worktreePath, ["rev-parse", "HEAD"])).trim();
}

export async function lastCommitSubject(worktreePath) {
  try {
    return (await run(worktreePath, ["log", "-1", "--format=%s"])).trim();
  } catch {
    return null;
  }
}

export async function commitAll(worktreePath, message, paths = [".peephole"]) {
  await stageAll(worktreePath, paths);
  return commitStaged(worktreePath, message);
}

/** The range that would actually be published. When the target branch does not exist on the remote
 *  yet — a ledger branch on its first push — comparing against nothing counts the repo's entire
 *  history as "unpushed" (653 commits on a migration that added two). Measure from the remote's
 *  default branch instead: that is where the new branch was cut from, so the difference is the
 *  ledger work itself. */
async function pendingRange(worktreePath, localBranch, remoteBranch, remote) {
  if (await refExists(worktreePath, `${remote}/${remoteBranch}`)) {
    return { range: `${remote}/${remoteBranch}..${localBranch}`, newBranch: false };
  }
  const fallback = await defaultRemoteBranch(worktreePath, remote).catch(() => null);
  if (fallback && (await refExists(worktreePath, `${remote}/${fallback}`))) {
    return { range: `${remote}/${fallback}..${localBranch}`, newBranch: true };
  }
  return { range: localBranch, newBranch: true };
}

export async function unpushedCount(worktreePath, localBranch, remoteBranch, remote = "origin") {
  const { range } = await pendingRange(worktreePath, localBranch, remoteBranch, remote);
  const out = await run(worktreePath, ["rev-list", "--count", range]);
  return parseInt(out.trim(), 10) || 0;
}

/** Whether the ledger branch exists on the remote at all — the difference between "N commits
 *  waiting" and "this branch has never been shared". */
export async function remoteBranchExists(repoRoot, remoteBranch, remote = "origin") {
  return refExists(repoRoot, `${remote}/${remoteBranch}`);
}

/** True when `ref` already contains everything in `maybeAncestor` — used to tell "the target branch
 *  is this ledger, further along" from "the target branch is a different ledger". */
export async function isAncestor(repoRoot, maybeAncestor, ref) {
  try {
    await run(repoRoot, ["merge-base", "--is-ancestor", maybeAncestor, ref]);
    return true;
  } catch {
    return false;
  }
}

export async function createBranchAt(repoRoot, name, startPoint) {
  await run(repoRoot, ["branch", "-f", name, startPoint]);
}

export async function checkoutBranch(repoRoot, name) {
  await run(repoRoot, ["checkout", name]);
}

export async function pushWorktree(worktreePath, localBranch, remoteBranch, remote = "origin") {
  await run(worktreePath, ["push", remote, `${localBranch}:${remoteBranch}`]);
}

/** Every blob under `subpath` at `ref`, with its size — one git call, no per-file reads. */
export async function lsTreeLong(repoRoot, ref, subpath = ".") {
  const out = await run(repoRoot, ["ls-tree", "-r", "-l", ref, "--", subpath]);
  return out
    .split("\n")
    .map((line) => {
      const m = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\s+(\d+|-)\t(.+)$/);
      if (!m) return null;
      return { type: m[1], size: m[2] === "-" ? 0 : parseInt(m[2], 10), path: m[3] };
    })
    .filter(Boolean);
}

export async function commitCount(repoRoot, ref) {
  const out = await run(repoRoot, ["rev-list", "--count", ref]);
  return parseInt(out.trim(), 10) || 0;
}

export async function contributorCount(repoRoot, ref) {
  const out = await run(repoRoot, ["shortlog", "-sn", "--no-merges", ref]);
  return out.split("\n").filter((l) => l.trim()).length;
}

/** Per-author commit counts (the "contribution" the Members panel shows), sorted by
 * `git shortlog`'s own descending order. Same command as contributorCount — one source. */
export async function contributorStats(repoRoot, ref) {
  const out = await run(repoRoot, ["shortlog", "-sn", "--no-merges", ref]);
  return out
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*(\d+)\t(.+)$/);
      if (!m) return null;
      return { name: m[2].trim(), commits: parseInt(m[1], 10) };
    })
    .filter(Boolean);
}

/** Resolves a name/email pair through the repo's `.mailmap` (if any) to the same canonical
 *  identity `contributorStats`' `git shortlog` already displays — so a hook-reported author
 *  (the machine's raw global git identity) lines up with the Members panel's commit rows even
 *  when someone commits under two email addresses (see `.mailmap`). Falls back to the input
 *  unchanged if there's no mailmap entry, `git` errors, or a bad output shape. */
export async function checkMailmap(repoRoot, name, email) {
  try {
    const out = await run(repoRoot, ["check-mailmap", `${name} <${email}>`]);
    const m = out.trim().match(/^(.*?)\s*<([^>]*)>$/);
    return m ? { name: m[1], email: m[2] } : { name, email };
  } catch {
    return { name, email };
  }
}

export async function lastCommitInfo(repoRoot, ref) {
  const out = await run(repoRoot, ["log", "-1", "--format=%an%x09%aI%x09%s", ref]);
  const [author, date, subject] = out.trim().split("\t");
  return { author, date, subject };
}
