// The per-developer opt-in signal: `git config --local peephole.enabled true`.
//
// A repo's git hooks and CI scripts can't tell whether the person committing actually uses Peephole
// — commits come from plain terminals too, and a project-level plugin entry turns the plugin on for
// everyone. Peephole leaves ONE stable, plugin-independent mark in the clone that anything can read:
//
//     git config --local --get peephole.enabled   ->  "true"
//
//   true  = this developer tracks their work on the Peephole board and accepts ticket-reference
//           checks (e.g. a commit-msg hook requiring a ticket id).
//   false = this developer has opted out; Peephole must never flip it back.
//   unset = undecided; Peephole sets it to true the first time it runs here.
//
// The mark is per-developer (`--local`, lives in `.git/config`, never committed), so it says nothing
// about teammates — exactly the point.

import path from "node:path";
import os from "node:os";
import * as git from "./git.js";

export const ENABLED_KEY = "peephole.enabled";

/** A board's own ledger checkout — the sparse clone under ~/.peephole/ledgers, or the in-repo
 *  `.peephole-worktree`. These are Peephole's plumbing, not a developer's working copy, so they must
 *  never carry the opt-in mark. */
export function isLedgerCheckout(dir) {
  const resolved = path.resolve(dir);
  const ledgerHome = path.resolve(process.env.PEEPHOLE_LEDGER_HOME || path.join(os.homedir(), ".peephole", "ledgers"));
  if (resolved === ledgerHome || resolved.startsWith(ledgerHome + path.sep)) return true;
  return path.basename(resolved) === ".peephole-worktree";
}

/** The current opt-in value in this checkout: "true", "false", or null when unset. */
export async function getEnabled(dir) {
  return git.localConfigGet(dir, ENABLED_KEY);
}

/** Sets the opt-in mark to true ONLY when it is currently unset, and only in a real developer
 *  checkout. Never overrides an explicit value (true or false), never writes into a ledger checkout
 *  or a non-git directory. Returns {marked, reason} so the caller can log what happened. Idempotent
 *  and safe to call on every serve / session start. */
export async function markEnabledIfUnset(dir) {
  if (!dir) return { marked: false, reason: "no directory" };
  if (isLedgerCheckout(dir)) return { marked: false, reason: "ledger checkout — never marked" };
  if (!(await git.isInsideWorkTree(dir))) return { marked: false, reason: "not a git checkout" };
  const current = await getEnabled(dir);
  if (current !== null) return { marked: false, reason: `already ${current}`, value: current };
  await git.localConfigSet(dir, ENABLED_KEY, "true");
  return { marked: true, reason: "set true (was unset)", value: "true" };
}

/** Explicit opt-in / opt-out: `peephole enable` / `peephole disable`. Unlike markEnabledIfUnset this
 *  DOES override — it is the developer deciding on purpose. Still refuses a non-git directory and a
 *  ledger checkout. Returns {ok, value, reason}. */
export async function setEnabled(dir, enabled) {
  if (isLedgerCheckout(dir)) return { ok: false, reason: "that is a Peephole ledger checkout, not a developer checkout" };
  if (!(await git.isInsideWorkTree(dir))) return { ok: false, reason: "not a git checkout" };
  const value = enabled ? "true" : "false";
  await git.localConfigSet(dir, ENABLED_KEY, value);
  return { ok: true, value };
}
