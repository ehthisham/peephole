import fs from "node:fs/promises";

// Bump when the wording these functions generate changes materially. The number is written into
// the start marker, so an already-scaffolded repo can be told its section is out of date — a
// presence check never could, which is why repos kept serving agents the first version of the
// instructions forever.
export const NOTE_VERSION = 2;

const START_RE = /<!--\s*peephole:start(?:\s+v=(\d+))?\s*-->/;
const START = `<!-- peephole:start v=${NOTE_VERSION} -->`;
const END = "<!-- peephole:end -->";

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Inserts or replaces a marker-delimited block in a doc file, leaving everything else untouched. */
export async function upsertMarkedSection(filePath, sectionBody, fallbackHeader) {
  const block = `${START}\n${sectionBody.trim()}\n${END}\n`;
  let existing = "";
  if (await fileExists(filePath)) existing = await fs.readFile(filePath, "utf8");

  const startMatch = existing.match(START_RE);
  const startIdx = startMatch ? startMatch.index : -1;
  const endIdx = existing.indexOf(END);
  let next;
  if (startIdx !== -1 && endIdx !== -1) {
    next = existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length).replace(/^\n+/, "\n");
  } else if (existing.trim()) {
    next = existing.trimEnd() + "\n\n" + block;
  } else {
    next = `${fallbackHeader}\n\n${block}`;
  }
  await fs.writeFile(filePath, next, "utf8");
}

export function hasMarkedSection(text) {
  return Boolean(text && START_RE.test(text));
}

/** The version of the section in `text`: a number, 1 for an unversioned (pre-versioning) block, or
 *  null when there is no section at all. */
export function markedSectionVersion(text) {
  const m = text && text.match(START_RE);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 1;
}

export function agentNoteBody({ binPath, repoRoot, port }) {
  const cli = `node ${binPath}`;
  return `## Working with Peephole (task tracking)

This repo tracks AI-executed work in \`.peephole/\`. The dashboard must be running for the
commands below to work — start it once in the background if it isn't already:
\`${cli} serve --repo ${repoRoot} --port ${port}\`

Before starting non-trivial work:

1. Check \`.peephole/tickets/*.md\` for a ticket matching the task. If none exists, create one —
   **before** starting the work, not after — don't hand-write the YAML, use the CLI so the schema
   is always valid:
   \`\`\`
   ${cli} ticket new --project "<this project>" --intent "<one sentence, the why>" --transcript <your transcript_path> --port ${port}
   \`\`\`
   Add \`--risk irreversible\` if the change is hard to undo. This prints the ticket id it chose.
2. Claim it before you start work — sets state to in-progress and records you as owner:
   \`\`\`
   ${cli} ticket claim <id> --owner <your session id> --transcript <your transcript_path> --port ${port}
   \`\`\`
   A ticket can be reserved for one person (\`assignee\` in its frontmatter, set from the board or
   with \`${cli} ticket assign <id> --to "<person>"\`). If it is, this claim is REFUSED for anyone
   else — the CLI sends your machine's git identity automatically and the server matches it
   against the assignee. Don't work a ticket whose claim was refused; pick another.

   Always pass \`--transcript\` (your own \`transcript_path\`, visible in your session context/hook
   payloads) on both of the above and on \`ticket advance\`. It's the only thing that links a ticket
   back to the actual chat that did the work — token usage is computed from it automatically and
   stored on the ticket (\`ticket.sessions[]\`). Skip it and the ticket is provenance-free: a record
   that work happened, with no way to trace which conversation produced it or what it cost.
3. Before continuing work on a claimed ticket, check whether you've been told to stop:
   \`\`\`
   ${cli} control check <id> --port ${port}
   \`\`\`
   Exit code 0 means proceed; nonzero means \`pause\`/\`skip\`/\`restart\` — stop and say why rather
   than pushing through. (If \`.claude/settings.local.json\` has Peephole's hooks wired in, this is
   already checked automatically before every tool call — the manual command is the fallback for
   when it isn't.)
4. As the work actually progresses, advance \`state\` — never hand-edit it, use the CLI:
   \`\`\`
   ${cli} ticket advance <id> --state <in-progress|built|verified|shipped|closed> --transcript <your transcript_path> --port ${port}
   \`\`\`
   Only ever move forward (proposed → in-progress → built → verified → shipped) or to \`closed\` —
   never backward, never delete a ticket file. Do this at real milestones (code merged → \`built\`;
   tests/verification done → \`verified\`; live → \`shipped\`), not speculatively.
5. If a ticket must be hand-edited directly, keep every frontmatter field the CLI would have set
   (id, project, intent, acceptance, state, risk, blockedOn, control, owner, branch, pr, estimate,
   createdAt, updatedAt, history) — a missing field or an invalid state/risk/control value makes
   the dashboard reject the file.
6. Write the ticket body as **What it does** + **Acceptance criteria** — two clear sections, plain
   readable prose, nothing else. For a shipped feature, "what it does" is the mechanism (a real code
   snippet or a permalink to the file, not just a citation in prose) and "acceptance criteria" is
   what proves it works (tests, verified behavior). Never narrate the edit itself — no "Enriched
   on...", "Corrected 2026-...", "Found by the audit", "this ticket now...". If something changed,
   say what's true now; the *that it changed* belongs in \`history\`, not the body.

View the live board: \`${cli} serve --repo ${repoRoot} --port ${port}\``;
}

export function readmeNoteBody(peepholeCmd) {
  return `## Task board (Peephole)

This repo's AI-executed work is tracked live in \`.peephole/\`. To see current status — what's
in progress, blocked, shipped — run:

\`\`\`
${peepholeCmd}
\`\`\`

then open the printed \`http://localhost:<port>\` link.

### The two \`.peephole\` directories

Both are the same tracked path, seen from two checkouts of this repo:

- \`.peephole/\` — this branch's copy of the ticket files, committed like any other source. The
  board never reads it, so it is normally behind: it is whatever reached this branch the last time
  the ticket files were merged in.
- \`.peephole-worktree/\` — a git worktree (a second checkout sharing this repo's one \`.git\`
  object store) parked on the branch \`peephole/<stateBranch>\`. Every ticket write happens there,
  which is why your own branch and uncommitted changes are never touched. Its \`.peephole/\` is the
  live one the board reads.

This branch catches up only after the board's **Push to remote** and a pull.

Keep \`.peephole-worktree/\` in \`.gitignore\` — git does not ignore a nested worktree on its own,
so it shows as untracked and one \`git add -A\` would commit the whole duplicate tree.

### Removing Peephole from this repo

Stop the board first (the worktree is in use while it runs), then:

\`\`\`
git worktree remove --force .peephole-worktree     # the checkout AND its registration
git branch -D peephole/<stateBranch>               # the local state branch
\`\`\`

Deleting the folder by hand is not enough — the registration lives in \`.git/worktrees/\`, and git
keeps reporting a broken worktree until \`git worktree remove\` (or \`git worktree prune\`) clears it.

The ticket data is ordinary tracked content; to drop that too:

\`\`\`
git rm -r .peephole && git commit -m "Remove Peephole ticket data"
git push origin <stateBranch>                      # if the branch was already shared
git push origin --delete peephole/<stateBranch>    # only if that branch was ever pushed
\`\`\`

Then unwire the per-machine bits, which are not in git history: the \`peephole/hooks/\` entries in
\`.claude/settings.local.json\`, and the \`peephole:start\`/\`peephole:end\` sections in this file
and in CLAUDE.md.`;
}
