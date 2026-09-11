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
  const hasRemote = await refExists(repoRoot, `${remote}/${remoteBranch}`);
  const base = hasRemote ? `${remote}/${remoteBranch}` : "HEAD";
  await run(repoRoot, ["worktree", "add", "-B", localBranch, worktreePath, base]);
  return { worktreePath, localBranch };
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

export async function unpushedCount(worktreePath, localBranch, remoteBranch, remote = "origin") {
  const hasRemote = await refExists(worktreePath, `${remote}/${remoteBranch}`);
  const range = hasRemote ? `${remote}/${remoteBranch}..${localBranch}` : localBranch;
  const out = await run(worktreePath, ["rev-list", "--count", range]);
  return parseInt(out.trim(), 10) || 0;
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
