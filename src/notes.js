import fs from "node:fs/promises";

const START = "<!-- peephole:start -->";
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

  const startIdx = existing.indexOf(START);
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
  return Boolean(text && text.includes(START));
}

export function agentNoteBody({ binPath, repoRoot, port }) {
  const cli = `node ${binPath}`;
  return `## Working with Peephole (task tracking)

This repo tracks AI-executed work in \`.peephole/\`. The dashboard must be running for the
commands below to work — start it once in the background if it isn't already:
\`${cli} serve --repo ${repoRoot} --port ${port}\`

Before starting non-trivial work:

1. Check \`.peephole/tickets/*.md\` for a ticket matching the task. If none exists, create one —
   don't hand-write the YAML, use the CLI so the schema is always valid:
   \`\`\`
   ${cli} ticket new --project "<this project>" --intent "<one sentence, the why>" --port ${port}
   \`\`\`
   Add \`--risk irreversible\` if the change is hard to undo. This prints the ticket id it chose.
2. Claim it before you start work — sets state to in-progress and records you as owner:
   \`\`\`
   ${cli} ticket claim <id> --owner <your session id> --port ${port}
   \`\`\`
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
   ${cli} ticket advance <id> --state <in-progress|built|verified|shipped|closed> --port ${port}
   \`\`\`
   Only ever move forward (proposed → in-progress → built → verified → shipped) or to \`closed\` —
   never backward, never delete a ticket file. Do this at real milestones (code merged → \`built\`;
   tests/verification done → \`verified\`; live → \`shipped\`), not speculatively.
5. If a ticket must be hand-edited directly, keep every frontmatter field the CLI would have set
   (id, project, intent, acceptance, state, risk, blockedOn, control, owner, branch, pr, estimate,
   createdAt, updatedAt, history) — a missing field or an invalid state/risk/control value makes
   the dashboard reject the file.

View the live board: \`${cli} serve --repo ${repoRoot} --port ${port}\``;
}

export function readmeNoteBody(peepholeCmd) {
  return `## Task board (Peephole)

This repo's AI-executed work is tracked live in \`.peephole/\`. To see current status — what's
in progress, blocked, shipped — run:

\`\`\`
${peepholeCmd}
\`\`\`

then open the printed \`http://localhost:<port>\` link.`;
}
