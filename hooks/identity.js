// Shared by session-start.js only (NOT pre-tool-use.js, which fires on every tool call and
// must stay cheap — see its own comment). Reads the machine's global git identity, the same
// one that ends up on this person's commits by default, so token usage naturally joins with
// the Members panel's (mailmap-resolved) commit counts server-side.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function gitIdentity() {
  try {
    const [{ stdout: name }, { stdout: email }] = await Promise.all([
      execFileP("git", ["config", "--global", "user.name"]),
      execFileP("git", ["config", "--global", "user.email"]),
    ]);
    const n = name.trim();
    const e = email.trim();
    return n && e ? { name: n, email: e } : null;
  } catch {
    return null; // no global identity set — author stays unattributed, never fatal to the hook
  }
}
