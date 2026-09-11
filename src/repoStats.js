import * as git from "./git.js";

const LANG_BY_EXT = {
  go: "Go", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", py: "Python", java: "Java", rb: "Ruby", php: "PHP",
  html: "HTML", css: "CSS", scss: "SCSS", less: "LESS", md: "Markdown", mdx: "Markdown",
  yaml: "YAML", yml: "YAML", json: "JSON", sql: "SQL", sh: "Shell", bash: "Shell",
  proto: "Protobuf", vue: "Vue", c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++",
  rs: "Rust", kt: "Kotlin", swift: "Swift", graphql: "GraphQL", tf: "Terraform",
};

// A rough bytes-per-line heuristic so LOC can be approximated from a single `ls-tree -l` call
// instead of reading every file — labeled "approx." everywhere it's shown.
const AVG_BYTES_PER_LINE = 32;

export async function repoStats(repoRoot, ref) {
  const entries = await git.lsTreeLong(repoRoot, ref, ".");
  const blobs = entries.filter((e) => e.type === "blob" && !e.path.startsWith(".peephole/") && e.path !== ".peephole-worktree");

  let codeBytes = 0;
  const byLang = new Map();

  for (const b of blobs) {
    const ext = (b.path.split(".").pop() || "").toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;
    codeBytes += b.size;
    const cur = byLang.get(lang) || { files: 0, bytes: 0 };
    cur.files += 1;
    cur.bytes += b.size;
    byLang.set(lang, cur);
  }

  const topLanguages = Array.from(byLang.entries())
    .map(([lang, v]) => ({ lang, files: v.files, linesApprox: Math.round(v.bytes / AVG_BYTES_PER_LINE) }))
    .sort((a, b) => b.linesApprox - a.linesApprox)
    .slice(0, 6);

  const [commits, contributors, contributorList, lastCommit] = await Promise.all([
    git.commitCount(repoRoot, ref),
    git.contributorCount(repoRoot, ref),
    git.contributorStats(repoRoot, ref),
    git.lastCommitInfo(repoRoot, ref),
  ]);

  return {
    totalFiles: blobs.length,
    linesOfCodeApprox: Math.round(codeBytes / AVG_BYTES_PER_LINE),
    commits,
    contributors,
    contributorList,
    lastCommit,
    topLanguages,
  };
}
