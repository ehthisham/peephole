(function () {
  var STATES = [
    { key: "proposed", label: "Proposed" },
    { key: "in-progress", label: "In progress" },
    { key: "built", label: "Built" },
    { key: "verified", label: "Verified" },
    { key: "shipped", label: "Shipped" },
    { key: "closed", label: "Closed" },
  ];
  var STATE_COLOR = {
    "proposed": "var(--proposed)",
    "in-progress": "var(--progress)",
    "built": "var(--built)",
    "verified": "var(--verified)",
    "shipped": "var(--shipped)",
    "closed": "var(--closed)",
  };
  var STATE_BG = {
    "proposed": "var(--proposed-bg)",
    "in-progress": "var(--progress-bg)",
    "built": "var(--built-bg)",
    "verified": "var(--verified-bg)",
    "shipped": "var(--shipped-bg)",
    "closed": "var(--closed-bg)",
  };
  // The board shows three lanes, not six. `built`, `verified` and `closed` stay real states in the
  // schema (the CLI, writer.setState, history and the Insights breakdown all still use them) but
  // they are PHASES WITHIN a lane rather than lanes of their own: in practice ~85% of tickets go
  // proposed → shipped without ever stopping in built/verified, so as columns they were two
  // permanently-empty lanes squeezing the ones that carry the traffic. Each renders as a phase
  // badge on its card instead — same label, same palette entry, no column of its own.
  var LANES = [
    { key: "proposed", label: "Proposed", states: ["proposed"] },
    {
      key: "in-progress", label: "In progress", states: ["in-progress", "built", "verified"],
      // Verified work is done and waiting on somebody to say so; that is the move worth batching.
      bulk: { from: "verified", to: "shipped", label: "Ship" },
    },
    { key: "shipped", label: "Shipped", states: ["shipped", "closed"] },
  ];
  // The states that show as a badge because they are not their lane's headline state.
  var PHASE_STATES = new Set(["built", "verified", "closed"]);

  // No `restart`: it cleared `owner` in the same write that set the blocking value, so the deny
  // could never reach the session it was aimed at, and it left a stale control that denied the
  // NEXT claimer instead. Everything it could actually do is covered — pause stops, skip releases,
  // and the back button returns a ticket to proposed for a fresh attempt. `schema.CONTROLS` still
  // accepts "restart" so tickets already carrying it keep parsing.
  //
  // `run` is gone from the card too, and not because it did nothing: it set control back to the
  // default, which is what un-pausing means. Pause and skip are toggles now — pressing a lit one
  // clears it — so the row never needed a button whose icon promised to start something it had no
  // way of starting.
  var CONTROLS = ["pause", "skip"];
  var CONTROL_ICON = { pause: "⏸", skip: "⏭" };

  // Stroked SVGs for the two acts the old ▶ was conflating: marking a ticket for execution, and
  // actually dispatching one. A checkmark reads as "picked", never as "running".
  var SELECT_ICON =
    '<svg class="mv-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 8.6 6.3 12 13 4.6"/></svg>';
  // A terminal prompt: the card's way of saying "open the session working this".
  var ATTACH_ICON =
    '<svg class="mv-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4"/><path d="M4.6 6.2 6.9 8l-2.3 1.8M8.4 10.2h3"/></svg>';
  var CHAT_ICON =
    '<svg class="mv-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13.5 9.5a1.6 1.6 0 0 1-1.6 1.6H6.2L3.1 13.6V4.1A1.6 1.6 0 0 1 4.7 2.5h7.2a1.6 1.6 0 0 1 1.6 1.6z"/></svg>';
  var EXECUTE_ICON =
    '<svg class="mv-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="8" cy="8" r="6.1"/><path d="M6.6 5.5 10.6 8l-4 2.5z" fill="currentColor" stroke="none"/></svg>';
  // Stroked SVG rather than a text glyph: an arrow driven into a bar ("send to the next lane")
  // has no Unicode equivalent that renders the same across fonts, and `currentColor` lets one
  // markup string pick up whichever target-state tint the button carries.
  function moveIcon(dir) {
    var fwd = dir === "fwd";
    var shaft = fwd ? "M2.5 8H10" : "M13.5 8H6";
    var head = fwd ? "M7.2 4.8 10.4 8 7.2 11.2" : "M8.8 4.8 5.6 8 8.8 11.2";
    var bar = fwd ? "M13.2 3.4V12.6" : "M2.8 3.4V12.6";
    return (
      '<svg class="mv-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" ' +
      'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' + shaft + '"/><path d="' + head + '"/><path d="' + bar + '" stroke-width="2"/></svg>'
    );
  }
  var MOVE_ICON = { back: moveIcon("back"), fwd: moveIcon("fwd") };
  // What Fix it can actually repair. The stale-* and gitignore kinds are repairable too, so they
  // must be here or the button vanishes exactly when there is something to fix.
  var STRUCTURAL_ISSUES = new Set([
    "missing-config", "missing-tickets-dir", "missing-agents-dir",
    "missing-agent-note", "missing-readme-note", "missing-hook-setup",
    "stale-agent-note", "stale-readme-note", "missing-gitignore", "missing-pointer",
  ]);

  var board = document.getElementById("board");
  var agentList = document.getElementById("agentList");
  var issuesBanner = document.getElementById("issuesBanner");
  var issuesList = document.getElementById("issuesList");
  var fixBtn = document.getElementById("fixBtn");
  var pushBanner = document.getElementById("pushBanner");
  var pushText = document.getElementById("pushText");
  var pushBtn = document.getElementById("pushBtn");
  var pullBtn = document.getElementById("pullBtn");
  var autoFetchToggle = document.getElementById("autoFetchToggle");
  var intervalInput = document.getElementById("intervalInput");
  var hookState = document.getElementById("hookState");
  var lastUpdated = document.getElementById("lastUpdated");
  var projectName = document.getElementById("projectName");
  var projectBtn = document.getElementById("projectBtn");
  var projectMenu = document.getElementById("projectMenu");
  var addProjectBackdrop = document.getElementById("addProjectBackdrop");
  var addProjectPath = document.getElementById("addProjectPath");
  var addProjectError = document.getElementById("addProjectError");
  var addProjectGo = document.getElementById("addProjectGo");
  var addProjectCancel = document.getElementById("addProjectCancel");
  var addProjectClose = document.getElementById("addProjectClose");
  var checkoutBranchEl = document.getElementById("checkoutBranch");
  var statRow = document.getElementById("statRow");
  var completionEl = document.getElementById("completion");
  var langs = document.getElementById("langs");
  var tokenUsage = document.getElementById("tokenUsage");
  var coverageModulesEl = document.getElementById("coverageModules");
  var memberList = document.getElementById("memberList");
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var standardsContent = document.getElementById("standardsContent");
  var stateChartEl = document.getElementById("stateChart");
  var configContent = document.getElementById("configContent");
  var ticketModalBackdrop = document.getElementById("ticketModalBackdrop");
  var ticketModalTitle = document.getElementById("ticketModalTitle");
  var ticketModalClose = document.getElementById("ticketModalClose");
  var ticketModalBody = document.getElementById("ticketModalBody");
  var newTicketBtn = document.getElementById("newTicketBtn");
  var newTicketBackdrop = document.getElementById("newTicketBackdrop");
  var newTicketClose = document.getElementById("newTicketClose");
  var newTicketForm = document.getElementById("newTicketForm");
  var groupToggle = document.getElementById("groupToggle");
  var filterBtn = document.getElementById("filterBtn");
  var filterMenu = document.getElementById("filterMenu");
  var filterCount = document.getElementById("filterCount");
  var otherProjects = document.getElementById("otherProjects");
  var epicOptions = document.getElementById("epicOptions");
  var execSelectedBtn = document.getElementById("execSelectedBtn");
  var workerBtn = document.getElementById("workerBtn");
  var workerMenu = document.getElementById("workerMenu");
  var queueBar = document.getElementById("queueBar");
  var execBackdrop = document.getElementById("execBackdrop");
  var execTitle = document.getElementById("execTitle");
  var execModes = document.getElementById("execModes");
  var execGo = document.getElementById("execGo");
  var execCancel = document.getElementById("execCancel");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Inline markdown within one already-escaped line: **bold**, `code`, [text](url). Order matters —
  // code spans are pulled out first so bold/link markers inside them are never touched.
  function mdInline(escapedLine) {
    var codeSpans = [];
    // The placeholder is wrapped in U+0000, not spaces: a bare " 3 " also matches any ordinary
    // number in the prose, so a body reading "a 403 response" had its "403" swapped for
    // codeSpans[403] — i.e. the literal text "undefined". A NUL can never appear in a ticket
    // file's text, so the round-trip is now unambiguous.
    var withoutCode = escapedLine.replace(/`([^`]+)`/g, function (_, code) {
      codeSpans.push(code);
      return "\u0000" + (codeSpans.length - 1) + "\u0000";
    });
    var withLinks = withoutCode.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, text, url) {
      // Only allow schemes that can't execute script (a ticket body's URL isn't necessarily
      // ours — anything writing .peephole/tickets/*.md controls what lands here).
      var safe = /^(https?:\/\/|mailto:|\/|#)/i.test(url) ? url : "#";
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
    });
    var withBold = withLinks.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return withBold.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return "<code>" + codeSpans[Number(i)] + "</code>";
    });
  }

  // A small, deliberately non-general markdown renderer: handles exactly the subset Peephole's own
  // ticket bodies use (##/### headers, fenced ``` code blocks, **bold**, `code`, [links](url),
  // "- " bullet lists, "1. " numbered lists, "| a | b |" tables, blank-line-separated paragraphs).
  // Not a CommonMark implementation — just enough to make a ticket body readable instead of one
  // whitespace-collapsed blob.
  function renderMarkdown(md) {
    var lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    var html = [];
    var i = 0;
    var para = [];
    function flushPara() {
      if (para.length) {
        // Source lines are hard-wrapped for git-diff friendliness, not intentional line breaks —
        // join with a space (markdown's own soft-wrap rule), not <br>.
        html.push("<p>" + mdInline(esc(para.join(" "))) + "</p>");
        para = [];
      }
    }
    while (i < lines.length) {
      var line = lines[i];

      if (/^```/.test(line)) {
        flushPara();
        var lang = line.replace(/^```/, "").trim();
        var codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        html.push('<pre class="md-code"><code class="lang-' + esc(lang || "text") + '">' + esc(codeLines.join("\n")) + "</code></pre>");
        continue;
      }

      var h = line.match(/^(#{2,4})\s+(.*)$/);
      if (h) {
        flushPara();
        var level = Math.min(h[1].length + 2, 6); // ## -> h4, ### -> h5
        html.push("<h" + level + ' class="md-h">' + mdInline(esc(h[2])) + "</h" + level + ">");
        i++;
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        flushPara();
        var items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(mdInline(esc(lines[i].replace(/^\s*[-*]\s+/, ""))));
          i++;
        }
        html.push("<ul>" + items.map(function (it) { return "<li>" + it + "</li>"; }).join("") + "</ul>");
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        flushPara();
        var oitems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          oitems.push(mdInline(esc(lines[i].replace(/^\s*\d+\.\s+/, ""))));
          i++;
        }
        html.push("<ol>" + oitems.map(function (it) { return "<li>" + it + "</li>"; }).join("") + "</ol>");
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        flushPara();
        var headCells = line.split("|").slice(1, -1).map(function (c) { return mdInline(esc(c.trim())); });
        i += 2; // header + separator
        var bodyRows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          bodyRows.push(lines[i].split("|").slice(1, -1).map(function (c) { return mdInline(esc(c.trim())); }));
          i++;
        }
        html.push(
          "<table><thead><tr>" + headCells.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr></thead>" +
          "<tbody>" + bodyRows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>"
        );
        continue;
      }

      if (line.trim() === "") {
        flushPara();
        i++;
        continue;
      }

      para.push(line);
      i++;
    }
    flushPara();
    return html.join("\n");
  }

  function relTime(iso) {
    if (!iso) return "never";
    var diff = (Date.now() - Date.parse(iso)) / 1000;
    if (diff < 5) return "just now";
    if (diff < 60) return Math.floor(diff) + "s ago";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  function fmtNum(n) {
    return typeof n === "number" ? n.toLocaleString() : "—";
  }

  function fmtDuration(ms) {
    if (!(ms >= 0)) return "—";
    var m = ms / 60000;
    if (m < 60) return Math.max(1, Math.round(m)) + "m";
    var h = m / 60;
    if (h < 24) return Math.floor(h) + "h " + Math.round(m % 60) + "m";
    var d = h / 24;
    return Math.floor(d) + "d " + Math.round(h % 24) + "h";
  }

  /** Cost of one ticket, split into the two spans that mean different things:
   *
   *  - `waitMs`  — created until somebody claimed it (or until now, while nobody has). Backlog
   *    latency: nothing is being spent, the ticket is just sitting there.
   *  - `workMs`  — first claim until the ticket reached a terminal state (or until now, while
   *    still open). The only span in which effort was actually going into it.
   *
   *  They used to be one number measured from creation, which made a ticket filed 8 minutes ago
   *  and never touched report "8m in flight" as though someone were working it.
   *
   *  Tokens are likewise scoped to THIS ticket rather than the session's lifetime: a transcript
   *  has no per-ticket boundaries, so writer.js stores a {tokensAtStart, tokensAtLatest} pair per
   *  session touch and the marginal spend is the sum of the differences. Entries missing either
   *  bound (a session that never reported tokens) are skipped, not read as zero cost. */
  function ticketCost(t) {
    var history = Array.isArray(t.history) ? t.history : [];
    var createdAt = t.createdAt || (history.length ? history[0].at : null);
    var claimEntry = history.find(function (h) { return h.to === "in-progress"; });
    var claimedAt = claimEntry ? claimEntry.at : null;
    var isTerminal = TERMINAL_STATES.has(t.state);
    var endedAt = isTerminal && history.length ? history[history.length - 1].at : null;
    var now = Date.now();

    var waitMs = createdAt ? (claimedAt ? Date.parse(claimedAt) : now) - Date.parse(createdAt) : null;
    var workMs = claimedAt ? (endedAt ? Date.parse(endedAt) : now) - Date.parse(claimedAt) : null;

    var sessions = Array.isArray(t.sessions) ? t.sessions : [];
    var scoped = sessions.filter(function (s) { return s.tokensAtStart != null && s.tokensAtLatest != null; });
    var tokens = scoped.length
      ? scoped.reduce(function (sum, s) { return sum + Math.max(0, s.tokensAtLatest - s.tokensAtStart); }, 0)
      : null;
    return {
      createdAt: createdAt, waitMs: waitMs, workMs: workMs, tokens: tokens,
      waiting: !claimedAt, working: Boolean(claimedAt) && !isTerminal,
    };
  }

  /** How much of this project's work is finished, as a share of tickets that reached a terminal
   *  state. Deliberately NOT weighted by a per-state guess (built = 60% done and so on): those
   *  weights are invented, and a board that claims 71% because several tickets are "nearly built"
   *  is reporting an opinion as a measurement. Shipped or closed, or not done.
   *
   *  Scoped to the project the board is showing, so it matches the lanes rather than the file
   *  count. Null when there are no tickets at all — 0% of nothing is not progress. */
  function ticketProgress(tickets) {
    var mine = forThisProject(tickets || []);
    if (!mine.length) return null;
    var done = mine.filter(function (t) { return TERMINAL_STATES.has(t.state); }).length;
    return { done: done, total: mine.length, pct: (done / mine.length) * 100 };
  }

  /** Absolute local timestamp to the minute — a board is read against a calendar ("filed Monday
   *  afternoon"), which a relative age alone can't answer. */
  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  }

  /** Completion as a project reads it: one bar for the whole thing, then a line per epic. The
   *  Progress tile answers "how far along"; this answers "far along at WHAT", which is the question
   *  anyone planning the next week actually has. Unfiled work is shown last and named, because an
   *  epic list that quietly omits a third of the tickets is worse than no epic list. */
  function renderCompletion(tickets) {
    var mine = forThisProject(tickets || []);
    if (!mine.length) {
      completionEl.innerHTML = "";
      return;
    }
    function tally(list) {
      var done = list.filter(function (t) { return TERMINAL_STATES.has(t.state); }).length;
      var working = list.filter(function (t) { return !TERMINAL_STATES.has(t.state) && t.state !== "proposed"; }).length;
      return { done: done, working: working, total: list.length, pct: (done / list.length) * 100 };
    }
    var all = tally(mine);

    var byEpic = {};
    mine.forEach(function (t) {
      var key = t.epic || NO_EPIC;
      (byEpic[key] = byEpic[key] || []).push(t);
    });
    var keys = Object.keys(byEpic).sort().filter(function (k) { return k !== NO_EPIC; });
    if (byEpic[NO_EPIC]) keys.push(NO_EPIC);

    completionEl.innerHTML =
      "<h3>Completion</h3>" +
      '<div class="done-head"><span class="done-pct">' + all.pct.toFixed(0) + "%</span>" +
      '<span class="done-label">' + fmtNum(all.done) + " of " + fmtNum(all.total) + " shipped or closed" +
      (all.working ? '<small>' + fmtNum(all.working) + " in flight</small>" : "<small>nothing in flight</small>") +
      "</span></div>" +
      keys.map(function (key) {
        var t = tally(byEpic[key]);
        return (
          '<div class="done-row"><span class="name" title="' + esc(key === NO_EPIC ? "No epic" : key) + '">' +
          (key === NO_EPIC ? '<span class="dim">No epic</span>' : esc(key)) + "</span>" +
          '<span class="bar-track"><span class="bar-fill" style="width:' + t.pct.toFixed(1) +
          '%;background:' + (t.pct === 100 ? "var(--built)" : "var(--accent)") + '"></span></span>' +
          '<span class="amount mono">' + t.done + "/" + t.total + "</span></div>"
        );
      }).join("");
  }

  function renderInsights(stats, coverage, agents) {
    if (!stats) {
      statRow.innerHTML = '<p class="empty-note">Insights unavailable.</p>';
      langs.innerHTML = "";
      return;
    }
    var progress = ticketProgress(latestTickets);
    var tiles = [];
    if (progress) {
      tiles.push({
        value: progress.pct.toFixed(0) + "%",
        label: "Progress",
        sub: fmtNum(progress.done) + " of " + fmtNum(progress.total) + " shipped or closed",
      });
    }
    tiles = tiles.concat([
      { value: fmtNum(stats.linesOfCodeApprox), label: "Lines of code", sub: "approx." },
      { value: fmtNum(stats.totalFiles), label: "Tracked files" },
      { value: fmtNum(stats.commits), label: "Commits" },
      { value: fmtNum(stats.contributors), label: "Contributors" },
      {
        value: stats.lastCommit ? relTime(stats.lastCommit.date) : "—",
        label: "Last commit",
        sub: stats.lastCommit ? esc(stats.lastCommit.author) : "",
      },
    ]);
    // Grand total across every session, not just ones that matched a git-identity'd member —
    // the same source renderTokenUsage sums per-session, so the two numbers can never disagree.
    var totalTokens = (agents || []).reduce(function (sum, a) {
      return sum + ((a.tokens && a.tokens.totalTokens) || 0);
    }, 0);
    if (totalTokens > 0) {
      tiles.push({ value: fmtNum(totalTokens), label: "Total tokens", sub: "all sessions, excl. cached reads" });
    }
    // Only shown when a coverage artifact was actually found (coverage.out / coverage-summary.json)
    // — absent means no test run yet, not zero coverage, so the tile is omitted rather than
    // showing a misleading "0%".
    if (coverage && typeof coverage.pct === "number") {
      tiles.push({
        value: coverage.pct.toFixed(1) + "%",
        label: "Coverage",
        sub: coverage.tool === "go" ? "go test" : "istanbul",
      });
    }
    // Say which branch the code figures describe: they follow the reader's checkout, while the
    // Progress tile beside them counts tickets from the shared ledger. Same row, two sources.
    if (latestState && latestState.checkoutBranch) {
      tiles = tiles.map(function (t) {
        if (t.label === "Lines of code" || t.label === "Commits" || t.label === "Tracked files") {
          return { ...t, sub: (t.sub ? t.sub + " · " : "") + latestState.checkoutBranch };
        }
        return t;
      });
    }
    statRow.innerHTML = tiles.map(function (t) {
      return (
        '<div class="stat-tile"><div class="value mono">' + t.value + "</div>" +
        '<div class="label">' + esc(t.label) + "</div>" +
        (t.sub ? '<div class="sub">' + esc(t.sub) + "</div>" : "") +
        "</div>"
      );
    }).join("");

    renderCoverageModules(coverage);

    var topLangs = stats.topLanguages || [];
    if (topLangs.length === 0) {
      langs.innerHTML = "";
      return;
    }
    var max = Math.max.apply(null, topLangs.map(function (l) { return l.linesApprox; }));
    langs.innerHTML =
      "<h3>Top languages (approx. lines)</h3>" +
      topLangs.map(function (l) {
        var pct = max > 0 ? Math.round((l.linesApprox / max) * 100) : 0;
        return (
          '<div class="lang-row"><span class="name">' + esc(l.lang) + '</span>' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="amount mono">' + fmtNum(l.linesApprox) + " · " + l.files + " files</span></div>"
        );
      }).join("");
  }

  /** Global progress at a glance — a donut of every ticket's current state, pure CSS
   *  (conic-gradient), no chart library. The count in the middle is the total across every
   *  state, not just the ones with a nonzero slice. */
  function renderStateChart(tickets) {
    if (!tickets || tickets.length === 0) {
      stateChartEl.innerHTML = "";
      return;
    }
    var counts = STATES.map(function (s) {
      return { key: s.key, label: s.label, count: tickets.filter(function (t) { return t.state === s.key; }).length };
    });
    var total = tickets.length;
    var stops = [];
    var acc = 0;
    counts.forEach(function (c) {
      if (c.count === 0) return;
      var start = (acc / total) * 100;
      acc += c.count;
      var end = (acc / total) * 100;
      stops.push(STATE_COLOR[c.key] + " " + start.toFixed(2) + "% " + end.toFixed(2) + "%");
    });
    stateChartEl.innerHTML =
      "<h3>Ticket progress</h3>" +
      '<div class="state-chart-body">' +
      '<div class="donut" style="background:conic-gradient(' + stops.join(", ") + ')">' +
      '<div class="donut-hole"><span class="donut-total mono">' + fmtNum(total) + '</span><span class="donut-total-label">tickets</span></div>' +
      "</div>" +
      '<ul class="state-legend">' +
      counts.map(function (c) {
        var pct = total > 0 ? Math.round((c.count / total) * 100) : 0;
        return (
          "<li><span class=\"swatch\" style=\"background:" + STATE_COLOR[c.key] + '"></span>' +
          esc(c.label) + '<span class="count">' + fmtNum(c.count) + '</span><span class="pct">' + pct + "%</span></li>"
        );
      }).join("") +
      "</ul></div>";
  }

  function coverageColor(pct) {
    if (pct < 40) return "var(--accent)";
    if (pct < 70) return "var(--proposed)";
    return "var(--built)";
  }

  // Per-package breakdown ("how we developed tests" — module by module, worst-covered first),
  // not just one aggregate percentage. Absent entirely when no coverage.out/-summary.json was
  // found (no test run yet), same "omit, don't show a misleading 0%" rule as the tile above.
  /** How Peephole is set up for this repo — its own config.yaml plus the live runtime bits
   *  (hook wiring, auto-fetch, resolved git identity) that aren't in the file but matter just
   *  as much for understanding "is this actually tracking me." */
  function renderConfig(state) {
    var cfg = state.config || {};
    var gitUser = state.gitUser || {};
    var ledger = state.ledger || {};
    // The header carries only what changes as you work — the project and the branch you are on.
    // Everything else about how this project is wired lives here, where it can be read once
    // instead of sitting in the chrome of every screen.
    var rows = [
      ["Project", esc(cfg.project || state.project || "—")],
      ["Checkout", state.repoRoot ? '<span class="mono">' + esc(state.repoRoot) + "</span>" : "—"],
      ["Checked-out branch", state.checkoutBranch
        ? '<span class="mono">' + esc(state.checkoutBranch) + '</span> <span class="dim">— coverage and hook setup are read from it</span>'
        : "—"],
      ["Remote", state.remoteUrl ? '<span class="mono">' + esc(state.remoteUrl) + "</span>" : "—"],
      ["Ledger branch", esc(state.stateBranch || "—") +
        ' <span class="dim">(resolved from ' + esc(state.stateBranchSource || "?") + ")</span>" +
        (state.stateBranchOnRemote === false ? ' <span class="dim">— not pushed yet</span>' : "")],
      ["Ledger checkout", ledger.kind === "clone"
        ? 'sparse clone <span class="mono">' + esc(ledger.path || "") + "</span>"
        : 'in-repo worktree <span class="mono">' + esc(ledger.path || "") + "</span>" +
          (ledger.reason ? ' <span class="dim">— ' + esc(ledger.reason) + "</span>" : "")],
      ["Unpushed", state.unpushed ? esc(String(state.unpushed)) + " ledger commit" + (state.unpushed === 1 ? "" : "s") : "none"],
      ["Git identity", gitUser.name || gitUser.email ? esc(gitUser.name || "") + (gitUser.email ? " <" + esc(gitUser.email) + ">" : "") : "—"],
      ["Hooks", state.hookConfigured
        ? "live — a session is checking in"
        : (state.hooksInstalled ? "wired — no session running right now" : "not configured — run Fix it")],
      ["Autosync", state.autoFetch && state.autoFetch.enabled
        ? "every " + esc(state.autoFetch.intervalMinutes) + " min" + (state.autoFetch.push ? ", fetch + push" : ", fetch only")
        : "off"],
      ["States", Array.isArray(cfg.states) ? cfg.states.map(esc).join(" → ") : "—"],
      ["Control values", Array.isArray(cfg.control) ? cfg.control.map(esc).join(", ") : "—"],
      ["Risk values", Array.isArray(cfg.risk) ? cfg.risk.map(esc).join(", ") : "—"],
    ];
    configContent.innerHTML = rows.map(function (r) {
      return '<div class="modal-row"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + "</span></div>";
    }).join("");
  }

  function renderCoverageModules(coverage) {
    if (!coverage || !Array.isArray(coverage.modules) || coverage.modules.length === 0) {
      coverageModulesEl.innerHTML = '<p class="empty-note">No coverage run found yet.</p>';
      return;
    }
    // The per-package list never added up to anything a reader could quote: packages have wildly
    // different statement counts, so eyeballing 40 rows says nothing about the project. The
    // headline is the statement-weighted total — the same figure `go tool cover` reports.
    var head = typeof coverage.pct === "number"
      ? '<div class="cov-head"><span class="cov-pct">' + coverage.pct.toFixed(1) + "%</span>" +
        '<span class="cov-head-label">overall statement coverage<small>' +
        esc(coverage.tool === "go" ? "go test" : "istanbul") + " · " + esc(coverage.file || "") +
        (latestState && latestState.checkoutBranch ? " · " + esc(latestState.checkoutBranch) : "") +
        "</small></span>" +
        '<span class="cov-head-bar"><span style="width:' + Math.max(0, Math.min(100, coverage.pct)).toFixed(1) + '%"></span></span></div>'
      : "";
    coverageModulesEl.innerHTML =
      head +
      "<h3>Coverage by package (" + esc(coverage.tool === "go" ? "go test" : "istanbul") + ")</h3>" +
      '<div class="cov-list">' +
      coverage.modules.map(function (m) {
        var pct = Math.max(0, Math.min(100, m.pct));
        return (
          '<div class="cov-row"><span class="name" title="' + esc(m.pkg) + '">' + esc(m.pkg) + "</span>" +
          '<span class="bar-track"><span class="bar-fill" style="width:' + pct.toFixed(0) + "%;background:" + coverageColor(pct) + '"></span></span>' +
          '<span class="amount">' + pct.toFixed(1) + "% · " + fmtNum(m.covered) + "/" + fmtNum(m.total) + "</span></div>"
        );
      }).join("") +
      "</div>";
  }


  // The project this TAB is looking at, kept per tab. The server holds one context per project, so
  // two tabs can watch two repos at once; previously "switching" mutated a single server-side
  // active project and silently repointed every other tab.
  // sessionStorage, not localStorage: the selection is per TAB, and localStorage is shared across
  // every tab on the origin — two boards would have gone on overwriting each other's choice, which
  // is the very thing per-tab contexts exist to stop. localStorage keeps the last choice only as
  // the default for a NEW tab.
  var PROJECT_KEY = "peephole.project";
  var currentProject = null;
  try { currentProject = sessionStorage.getItem(PROJECT_KEY) || localStorage.getItem(PROJECT_KEY) || null; } catch (e) {}

  function rememberProjectChoice(root) {
    try {
      if (root) {
        sessionStorage.setItem(PROJECT_KEY, root);
        localStorage.setItem(PROJECT_KEY, root);
      } else {
        sessionStorage.removeItem(PROJECT_KEY);
        localStorage.removeItem(PROJECT_KEY);
      }
    } catch (e) {}
  }

  function withProject(path) {
    if (!currentProject) return path;
    return path + (path.indexOf("?") === -1 ? "?" : "&") + "project=" + encodeURIComponent(currentProject);
  }

  async function apiPost(path, body) {
    var res = await fetch(withProject(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  }

  // Once a ticket has shipped, Run/Pause/Skip/Restart no longer mean anything — the work is
  // done, there's nothing left to control. "closed" (shipped's own successor state) is the
  // same case.
  var TERMINAL_STATES = new Set(["shipped", "closed"]);

  // `writer.setState` (server-side) has always enforced forward-or-close-only; this is the
  // client-side mirror so the button never even offers an invalid move. `closed` has no
  // successor — nothing advances past it.
  function nextStateOf(state) {
    var idx = STATES.findIndex(function (s) { return s.key === state; });
    if (idx === -1 || idx === STATES.length - 1) return null;
    return STATES[idx + 1];
  }

  // The only legal backward move in the whole model: unclaiming an in-progress ticket hands it
  // back to `proposed` (writer.unclaimTicket). Everything past in-progress represents real work
  // that already happened, so there is deliberately no "prev" for it — the back button still
  // renders there, disabled, with the reason in its tooltip, rather than silently vanishing.
  function prevStateOf(state) {
    return state === "in-progress" ? STATES[0] : null;
  }

  // Owners come in two flavours: a human git name, or a raw agent session-id (UUID). Truncating
  // a UUID to "915b1f55…" made every card touched by one session look identical, so a session
  // owner instead gets a dot whose hue is derived from the id — two different sessions can never
  // read as the same agent — plus its first block. Full value stays in the tooltip either way.
  var SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;

  // sessionId -> git author name, harvested from the agents/*.json heartbeats (the SessionStart
  // hook posts the machine's global git identity). Lets a ticket whose `owner` predates
  // `ownerName` still show a human name, as long as that session is still in the heartbeat set.
  var authorBySession = {};

  /** The human behind a ticket: the name recorded on the ticket at claim time, else the live
   *  heartbeat's author, else null — in which case the caller falls back to the raw session id. */
  function ownerNameOf(t) {
    if (t.ownerName) return t.ownerName;
    if (!t.owner) return null;
    // An `owner` that isn't a session id IS a name — tickets claimed by a human (or by a CLI call
    // passing a person as --owner) carry one directly, and treating those as nameless made them
    // invisible to a member filter that was matching on names.
    if (!SESSION_ID_RE.test(t.owner)) return t.owner;
    return authorBySession[t.owner] || null;
  }

  function hueOf(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function ownerChip(t) {
    var owner = t.owner;
    var assignee = t.assignee;
    // Unclaimed but assigned: show who it is waiting for, so nobody else's session takes it.
    if (!owner) {
      return assignee
        ? '<span class="owner-chip assigned" title="assigned to ' + esc(assignee) + ' — only their session can claim it">' +
          '<span class="owner-dot assigned" aria-hidden="true"></span>' +
          '<span class="owner-name">' + esc(assignee) + "</span></span>"
        : "";
    }
    var name = ownerNameOf(t);
    // A person's name is what a board is read for; the session id is machine detail and lives in
    // the detail modal. The dot's hue is still derived from the session id, so two people (or two
    // sessions of one person) stay distinguishable at a glance even at chip size.
    var hue = SESSION_ID_RE.test(owner) ? hueOf(owner) : null;
    var label = name || (SESSION_ID_RE.test(owner) ? owner.slice(0, 6) : owner);
    var title = name ? name + " — session " + owner : "agent session " + owner;
    return '<span class="owner-chip' + (name ? "" : " agent") + '" title="' + esc(title) + '">' +
      '<span class="owner-dot' + (hue == null ? " human" : "") + '" aria-hidden="true"' +
      (hue == null ? "" : ' style="background:hsl(' + hue + ' 58% 45%)"') + "></span>" +
      '<span class="owner-name">' + esc(label) + "</span></span>";
  }

  function cardEl(t) {
    var card = document.createElement("article");
    card.className = "card";
    var risk = t.risk === "irreversible" ? '<span class="badge risk">⚠ irreversible</span>' : "";
    // blockedOn carries whole ticket ids, and often several comma-separated — rendered raw in a
    // nowrap badge that was wider than the card and spilled over its neighbour. Show what it is
    // blocked on, count the rest, and keep the full list in the tooltip.
    var blockedIds = (t.blockedOn || "").split(",").map(function (b) { return b.trim(); }).filter(Boolean);
    var blocked = blockedIds.length
      ? '<span class="badge blocked" title="' + esc("blocked on: " + blockedIds.join("\n")) + '">⛓ ' +
        esc(blockedIds[0]) + (blockedIds.length > 1 ? " +" + (blockedIds.length - 1) : "") + "</span>"
      : "";
    // The owner used to ride in `.card-top` alongside the project tag, the risk badge and every
    // ticket tag — four competing chips in one wrapping row. It now sits alone on the footer's
    // left, opposite the state-move buttons, so it can never crowd the tag row again.
    var owner = ownerChip(t);
    // A card sitting in a state that is not its lane's headline state says so on its own face —
    // "Built"/"Verified" inside the In progress lane, "Closed" inside Shipped — tinted with that
    // state's palette entry, so the lane stays coarse while the card stays exact.
    // The project name was the same on every card of a single-project board — pure noise. The
    // epic is what actually varies and what a reader groups by, so it takes that slot; a ticket
    // with no epic simply has one less chip.
    var epicTag = t.epic ? '<span class="epic-tag" title="epic: ' + esc(t.epic) + '">' + esc(t.epic) + "</span>" : "";
    // A control flag used to change nothing but a faint border tint on one 24px button, so setting
    // it looked like nothing happened. It now says so on the card's face, like every other state.
    var controlTag = t.control && t.control !== "run"
      ? '<span class="badge control-' + esc(t.control) + '">' + (t.control === "pause" ? "⏸ paused" : "⏭ skipped") + "</span>"
      : "";
    var queueTag = runningId === t.id
      ? '<span class="badge queued running">▶ running</span>'
      : (queuedIds.indexOf(t.id) !== -1 ? '<span class="badge queued">queued</span>' : "");
    var phaseState = PHASE_STATES.has(t.state) ? STATES.find(function (x) { return x.key === t.state; }) : null;
    var phase = phaseState
      ? '<span class="badge phase" style="color:' + STATE_COLOR[phaseState.key] + ";background:" + STATE_BG[phaseState.key] +
        '">' + esc(phaseState.label) + "</span>"
      : "";
    var tags = Array.isArray(t.tags) && t.tags.length
      ? t.tags.map(function (tg) { return '<span class="badge tag">' + esc(tg) + "</span>"; }).join("")
      : "";
    var isTerminal = TERMINAL_STATES.has(t.state);
    // Pause/skip toggle: clicking a lit one writes `run` back, which is what un-pausing is.
    var controls = isTerminal ? "" : CONTROLS.map(function (c) {
      var on = t.control === c;
      return (
        '<button class="ctl ' + c + '" data-ctl="' + (on ? "run" : c) + '" data-id="' + esc(t.id) + '" aria-pressed="' +
        on + '" title="' + (on ? "resume (clear " + c + ")" : c) + '" aria-label="' + (on ? "resume" : c) + '" type="button">' +
        CONTROL_ICON[c] + "</button>"
      );
    }).join("");
    // Selecting is queue-building; executing dispatches. Both only make sense before the work has
    // started, so neither appears once a ticket is past proposed.
    var selectable = t.state === "proposed";
    var queued = queuedIds.indexOf(t.id) !== -1;
    var isRunning = runningId === t.id;
    // A paused or skipped ticket is not a candidate for execution, so neither button is live on
    // one — offering them and then refusing the write would be the same contradiction one layer up.
    // The block itself is cleared with its own (lit) pause/skip button.
    // NOT named `blocked` — that is already the blockedOn badge's markup a few lines up, and
    // shadowing it rendered the literal string "true" on every skipped card.
    var ctlBlocked = t.control && t.control !== "run";
    var blockedWhy = ctlBlocked ? "This ticket is " + (t.control === "pause" ? "paused" : "skipped") + " — clear that first" : "";
    var selectBtn = selectable
      ? '<button class="ctl select" data-select="' + (t.selected ? "off" : "on") + '" data-id="' + esc(t.id) +
        '" aria-pressed="' + Boolean(t.selected) + '"' + (ctlBlocked ? " disabled" : "") +
        ' title="' + esc(ctlBlocked ? blockedWhy : (t.selected ? "Selected for execution — click to unselect" : "Select for execution")) +
        '" aria-label="Select for execution" type="button">' + SELECT_ICON + "</button>"
      : "";
    // Talking about a ticket is not a smaller version of doing it — it claims nothing, queues
    // nothing and is available whatever the ticket's state, because the ticket most worth
    // discussing is often one somebody already started.
    var chatting = (chatSessions[t.id] || null);
    // Only when there is a session to open: a ticket claimed under a person's own name has none.
    var sessionOwner = t.owner && SESSION_ID_RE.test(t.owner) ? t.owner : null;
    var attachBtn = sessionOwner
      ? '<button class="ctl attach" data-attach="' + esc(t.id) + '" data-session="' + esc(sessionOwner) +
        '" type="button" title="Hand this ticket to its session — ' + esc(sessionOwner.slice(0, 8)) +
        ' (opens a background session, or copies the prompt for an interactive one)" ' +
        'aria-label="Hand this ticket to its session">' + ATTACH_ICON + "</button>"
      : "";
    var chatBtn =
      '<button class="ctl chat" data-chat="' + esc(t.id) + '" type="button" title="' +
      esc(chatting ? "Being discussed — claude attach " + chatting.slice(0, 8) : "Talk about this ticket (no changes made)") +
      '" aria-label="Talk about this ticket"' + (chatting ? ' aria-pressed="true"' : "") + ">" + CHAT_ICON + "</button>";
    var executeBtn = selectable
      ? '<button class="ctl execute" data-execute="' + esc(t.id) + '" type="button"' +
        (queued || isRunning || ctlBlocked ? " disabled" : "") +
        ' title="' + esc(ctlBlocked ? blockedWhy : (isRunning ? "Running now" : queued ? "Queued for execution" : "Execute now — hand this ticket to a session")) +
        '" aria-label="Execute this ticket">' + EXECUTE_ICON + "</button>"
      : "";
    var next = nextStateOf(t.state);
    var prev = prevStateOf(t.state);
    // Icon-only, because a 200px lane has no room for two labelled buttons and the lane the card
    // lands in already says which state it reached. The glyph is an arrow driven INTO a bar —
    // "push this card to the next lane" — deliberately not the ▶ of the run control right below
    // it. Meaning that can't fit on the button lives in title/aria-label; the tint still comes
    // from the TARGET state's palette entry, so the color alone says where a click sends it.
    // --mv-fg/--mv-bg are custom properties (not the properties themselves) so the stylesheet's
    // :hover rule can invert them; setting background/color inline would out-specificity :hover.
    var advance = next
      ? '<button class="move-btn fwd" data-id="' + esc(t.id) + '" data-state="' + next.key +
        '" style="--mv-fg:' + STATE_COLOR[next.key] + ";--mv-bg:" + STATE_BG[next.key] +
        '" title="Move forward to ' + esc(next.label) + '" aria-label="Move forward to ' + esc(next.label) + '" type="button">' +
        MOVE_ICON.fwd + "</button>"
      : "";
    // Ownership is a coordination lock, not a hard one — an agent can hang, crash, or misjudge,
    // so a human always needs a way to hand a claimed ticket back. This is the one bounded
    // exception to forward-only state (writer.unclaimTicket): reachable only from in-progress,
    // never from built/verified/shipped, so it can undo a claim but never rewind real work.
    // On every other non-terminal state the button still renders, disabled, so the pair reads as
    // one back/forward control and the absence of a back move is explained instead of invisible.
    var unclaim = prev
      ? '<button class="move-btn back" data-id="' + esc(t.id) +
        '" style="--mv-fg:' + STATE_COLOR[prev.key] + ";--mv-bg:" + STATE_BG[prev.key] +
        '" title="Move back to ' + esc(prev.label) + ' (unclaim)" aria-label="Move back to ' + esc(prev.label) + ' (unclaim)" type="button">' +
        MOVE_ICON.back + "</button>"
      : (isTerminal ? "" :
        '<button class="move-btn back" disabled title="No way back from ' + esc(t.state) +
        ' — state only moves forward once work has been built" aria-label="No move back from ' + esc(t.state) + '" type="button">' +
        MOVE_ICON.back + "</button>");
    var moves = advance || unclaim ? '<div class="move-group">' + unclaim + advance + "</div>" : "";
    var ctlGroup = '<div class="controls">' + selectBtn + executeBtn + attachBtn + chatBtn + controls + "</div>";
    // One footer row, read left to right as "what the agent is doing" -> "who" -> "where it goes
    // next": run/pause/skip on the left, owner in the middle (the part that truncates when a lane
    // is narrow), the state moves on the right. They were two stacked rows, which cost every card
    // a line of height and split two control groups that are read together.
    var foot = ctlGroup || owner || moves
      ? '<div class="card-foot">' + ctlGroup + owner + moves + "</div>"
      : "";
    card.innerHTML =
      '<div class="card-top">' + epicTag + queueTag + controlTag + phase + tags + risk + "</div>" +
      '<p class="intent">' + esc(t.intent) + "</p>" +
      (blocked ? "<div>" + blocked + "</div>" : "") +
      foot;
    // Scoped to [data-ctl]: the select and execute buttons share the .ctl look but are not control
    // writes, and an unscoped selector posted `control: undefined` for them — which serialized a
    // ticket with no `control` field at all and made the file fail validation.
    Array.prototype.forEach.call(card.querySelectorAll(".ctl[data-ctl]"), function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.stopPropagation(); // a control click must not also open the detail modal
        var control = btn.dataset.ctl;
        var note = null;
        if (control !== "run") {
          // Pausing or skipping is a decision someone else has to understand later; clearing one
          // back to `run` needs no defence, so only the setting direction asks.
          note = window.prompt("Why " + control + " this ticket? (saved as a comment — optional)", "");
          if (note === null) return; // dismissed: do not write the control either
        }
        Array.prototype.forEach.call(card.querySelectorAll(".ctl[data-ctl]"), function (b) { b.disabled = true; });
        try {
          await apiPost("/api/tickets/" + encodeURIComponent(btn.dataset.id) + "/control", { control: control, note: note });
        } finally {
          Array.prototype.forEach.call(card.querySelectorAll(".ctl[data-ctl]"), function (b) { b.disabled = false; });
        }
      });
    });
    var selBtn = card.querySelector(".ctl.select:not([disabled])");
    if (selBtn) {
      selBtn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        selBtn.disabled = true;
        try {
          await apiPost("/api/tickets/" + encodeURIComponent(selBtn.dataset.id) + "/selected", {
            selected: selBtn.dataset.select === "on", actor: "peephole-ui",
          });
        } finally {
          selBtn.disabled = false;
        }
      });
    }
    var attachBtnEl = card.querySelector(".ctl.attach");
    if (attachBtnEl) {
      attachBtnEl.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        attachBtnEl.disabled = true;
        try {
          var res = await apiPost("/api/tickets/" + encodeURIComponent(attachBtnEl.dataset.attach) + "/handoff", {
            sessionId: attachBtnEl.dataset.session,
          });
          if (res && res.error) { window.alert(res.error); return; }
          if (res && res.mode === "attached" && res.opened) return;
          // Either an interactive session, which nothing can inject into, or no terminal here.
          // Both end the same way: put what that window needs on the clipboard.
          var text = (res && res.mode === "paste") ? res.prompt : (res && res.command) || "";
          var copied = false;
          if (text && navigator.clipboard) {
            try { await navigator.clipboard.writeText(text); copied = true; } catch (e) {}
          }
          window.alert(
            (res && res.reason ? res.reason : "Could not open a terminal here.") + "\n\n" +
            (copied ? "Copied to your clipboard." : text) +
            "\n\nThe ticket is claimed for that session either way.",
          );
        } finally {
          attachBtnEl.disabled = false;
        }
      });
    }
    var chatBtnEl = card.querySelector(".ctl.chat");
    if (chatBtnEl) {
      chatBtnEl.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        chatBtnEl.disabled = true;
        try {
          var res = await apiPost("/api/tickets/" + encodeURIComponent(chatBtnEl.dataset.chat) + "/chat", {});
          if (res && res.error) { window.alert(res.error); return; }
          if (res && !res.started) { window.alert("Could not start the conversation: " + (res.reason || "unknown")); return; }
          // A terminal opened — the conversation is on screen, so say nothing. Only the headless
          // fallback needs to hand over a command.
          if (res.launch === "background" && res.command) {
            if (navigator.clipboard) { try { await navigator.clipboard.writeText(res.command); } catch (e) {} }
            window.alert("No terminal could be opened here" + (res.reason ? " (" + res.reason + ")" : "") +
              ", so the discussion is running in the background.\n\nJoin it with (copied to your clipboard):\n\n  " +
              res.command);
          }
        } finally {
          chatBtnEl.disabled = false;
        }
      });
    }
    var execBtn = card.querySelector(".ctl.execute:not([disabled])");
    if (execBtn) {
      execBtn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        var choice = await askPermissionMode([execBtn.dataset.execute]);
        if (!choice) return;
        execBtn.disabled = true;
        try {
          await apiPost("/api/tickets/" + encodeURIComponent(execBtn.dataset.execute) + "/execute", choice);
        } finally {
          execBtn.disabled = false;
        }
      });
    }
    var advanceBtn = card.querySelector(".move-btn.fwd");
    if (advanceBtn) {
      advanceBtn.addEventListener("click", async function (ev) {
        ev.stopPropagation(); // never also open the detail modal
        advanceBtn.disabled = true;
        try {
          await apiPost("/api/tickets/" + encodeURIComponent(advanceBtn.dataset.id) + "/state", {
            state: advanceBtn.dataset.state, actor: "peephole-ui",
          });
        } finally {
          advanceBtn.disabled = false;
        }
      });
    }
    var unclaimBtn = card.querySelector(".move-btn.back:not([disabled])");
    if (unclaimBtn) {
      unclaimBtn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        unclaimBtn.disabled = true;
        try {
          await apiPost("/api/tickets/" + encodeURIComponent(unclaimBtn.dataset.id) + "/unclaim", { actor: "peephole-ui" });
        } finally {
          unclaimBtn.disabled = false;
        }
      });
    }
    card.addEventListener("click", function () { openTicketModal(t); });
    return card;
  }

  /** Everyone a ticket can be reserved for: the repo's commit authors (the Members panel's own
   *  mailmap-resolved list), plus whoever is already assigned or currently checked in — so a
   *  teammate who has a live session but no commits here yet is still assignable. */
  function knownPeople(t) {
    var names = ((latestState && latestState.stats && latestState.stats.contributorList) || [])
      .map(function (c) { return c.name; });
    Object.keys(authorBySession).forEach(function (sid) { names.push(authorBySession[sid]); });
    if (t && t.assignee) names.push(t.assignee);
    return names.filter(function (n, i) { return n && names.indexOf(n) === i; }).sort();
  }

  /** Every epic any ticket currently carries — the epic list is derived, never declared, so an
   *  epic exists exactly as long as something is filed under it. */
  function knownEpics() {
    var seen = (latestTickets || []).map(function (t) { return t.epic; }).filter(Boolean);
    return seen.filter(function (e, i) { return seen.indexOf(e) === i; }).sort();
  }

  /** Every tag any ticket currently carries — derived like the epic list, never declared, so a tag
   *  is a filter option exactly as long as something is filed under it. */
  function knownTags() {
    var seen = [];
    (latestTickets || []).forEach(function (t) {
      (Array.isArray(t.tags) ? t.tags : []).forEach(function (tg) { if (tg) seen.push(tg); });
    });
    return seen.filter(function (tg, i) { return seen.indexOf(tg) === i; }).sort();
  }

  /** Assignment is a claim-time gate, not a label (writer.claimTicket refuses a mismatched
   *  claimant), so it is edited here in the detail view rather than on the card — reserving work
   *  for a person is a deliberate act, unlike the one-click state moves. */
  function assignControl(t) {
    var people = knownPeople(t);
    return (
      '<select class="assign-select" data-id="' + esc(t.id) + '" aria-label="Assign this ticket">' +
      '<option value=""' + (t.assignee ? "" : " selected") + ">Unassigned</option>" +
      people.map(function (n) {
        return '<option value="' + esc(n) + '"' + (t.assignee === n ? " selected" : "") + ">" + esc(n) + "</option>";
      }).join("") +
      "</select>"
    );
  }

  /** Risk is editable here because it is usually learned after the ticket is written — you find out
   *  the migration is one-way while planning it. Every change is recorded in history. */
  function riskControl(t) {
    return (
      '<select class="risk-select" data-id="' + esc(t.id) + '" aria-label="Risk for this ticket">' +
      ["reversible", "irreversible"].map(function (r) {
        return '<option value="' + r + '"' + (t.risk === r ? " selected" : "") + ">" +
          (r === "irreversible" ? "⚠ irreversible" : "reversible") + "</option>";
      }).join("") +
      "</select>"
    );
  }

  /** Free text with the existing epics offered as suggestions: a new epic is created by typing
   *  one, which is the whole ceremony — see writer.setEpic on why epics aren't records. */
  function epicControl(t) {
    return (
      '<input class="epic-input" list="epicOptions" data-id="' + esc(t.id) + '" value="' + esc(t.epic || "") +
      '" placeholder="none" aria-label="Epic for this ticket">'
    );
  }

  /** The transcript, rendered as what happened rather than as a chat: a line per turn, with the
   *  tools each turn used. Sidechain turns (subagents) are marked, because "why did it read forty
   *  files" is usually answered by "a subagent did". */
  function renderTicketLog(data) {
    var sessions = (data && data.sessions) || [];
    if (!sessions.length) return '<p class="empty-note">No session was ever recorded on this ticket.</p>';
    return sessions.map(function (s) {
      var head = '<div class="log-head"><span class="mono">' + esc(s.sessionId.slice(0, 8)) + "</span>" +
        (s.alsoRecordedAs ? ' <span class="dim">also recorded as ' + s.alsoRecordedAs.map(esc).join(", ") + "</span>" : "") +
        (s.events && s.events.length ? ' <span class="dim">' + s.events.length + " turns</span>" : "") +
        "</div>";
      if (!s.found) return head + '<p class="empty-note">' + esc(s.reason || "no transcript") + "</p>";
      if (!s.events.length) {
        return head + '<p class="empty-note">' +
          esc(s.reason || "nothing in the transcript for the window this ticket was claimed") + "</p>";
      }
      return head + '<ul class="log-list">' + s.events.map(function (e) {
        var tools = (e.tools || []).map(function (t) {
          return '<span class="log-tool">' + esc(t.name) + (t.detail ? ' <span class="dim">' + esc(t.detail) + "</span>" : "") + "</span>";
        }).join("");
        return '<li class="log-' + esc(e.kind) + '">' +
          '<span class="log-when mono">' + esc((e.at || "").slice(11, 16)) + "</span>" +
          '<span class="log-body">' + (e.sidechain ? '<span class="log-side">subagent</span> ' : "") +
          (e.text ? esc(e.text) : "") + (tools ? '<span class="log-tools">' + tools + "</span>" : "") +
          "</span></li>";
      }).join("") + "</ul>";
    }).join("");
  }

  /** Detail popup for one ticket — everything the compact card leaves out, including the
   *  branch it was (or is being) built on, if the ticket ever recorded one. */
  function openTicketModal(t) {
    ticketModalTitle.textContent = "#" + t.id;
    var cost = ticketCost(t);
    var rows = [
      ["State", esc(t.state || "—")],
      ["Risk", riskControl(t)],
      ["Tags", Array.isArray(t.tags) && t.tags.length ? t.tags.map(esc).join(", ") : "—"],
      // Owner is the human; the session id that did the work is machine detail — useful for
      // matching against the Agents tab and the transcript, so it keeps a row of its own here
      // instead of taking the card's only chip.
      ["Owner", t.owner ? esc(ownerNameOf(t) || "unknown") : "—"],
      ["Assignee", assignControl(t)],
      ["Epic", epicControl(t)],
      ["Session", t.owner ? '<span class="mono">' + esc(t.owner) + "</span>" : "—"],
      ["Created by", t.createdBy ? esc(t.createdBy) : "—"],
      ["Branch", t.branch ? '<span class="mono">' + esc(t.branch) + "</span>" : "—"],
      ["PR", t.pr ? esc(t.pr) : "—"],
      ["Estimate", t.estimate ? esc(t.estimate) : "—"],
      ["Blocked on", t.blockedOn ? esc(t.blockedOn) : "—"],
      ["Created", cost.createdAt ? esc(fmtDateTime(cost.createdAt)) + ' <span class="dim">(' + relTime(cost.createdAt) + ")</span>" : "—"],
      ["Waiting", cost.waitMs != null ? fmtDuration(cost.waitMs) + (cost.waiting ? " (unclaimed)" : " before claim") : "—"],
      ["Work duration", cost.workMs != null ? fmtDuration(cost.workMs) + (cost.working ? " (open)" : "") : "—"],
      ["Tokens spent", cost.tokens != null ? fmtNum(cost.tokens) : "—"],
    ];
    var rowsHtml = rows.map(function (r) {
      return '<div class="modal-row"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + "</span></div>";
    }).join("");
    // History and comments are one story told in two arrays — a state change and the sentence
    // explaining it are minutes apart and belong on the same timeline, newest first.
    var events = [];
    (Array.isArray(t.history) ? t.history : []).forEach(function (h) {
      events.push({ at: h.at, kind: "event", by: h.by, from: h.from, to: h.to });
    });
    (Array.isArray(t.comments) ? t.comments : []).forEach(function (c) {
      events.push({ at: c.at, kind: "comment", by: c.by, text: c.text, control: c.control });
    });
    events.sort(function (a, b) { return Date.parse(b.at || 0) - Date.parse(a.at || 0); });
    var historyHtml = events.length
      ? '<ul class="modal-history">' + events.map(function (e) {
          if (e.kind === "comment") {
            return (
              '<li class="ev-comment"><span class="ev-when">' + relTime(e.at) + "</span>" +
              '<span class="ev-body">' + (e.control ? '<b>' + esc(e.control) + "</b> — " : "") +
              esc(e.text) + '</span><span class="by">' + esc(e.by || "") + "</span></li>"
            );
          }
          return (
            '<li><span class="ev-when">' + relTime(e.at) + '</span><span class="ev-body">' +
            esc(e.from || "—") + " → " + esc(e.to || "—") +
            '</span><span class="by">' + esc(e.by || "") + "</span></li>"
          );
        }).join("") + "</ul>"
      : '<p class="empty-note">Nothing logged yet.</p>';
    ticketModalBody.innerHTML =
      rowsHtml +
      "<h3>Intent</h3><p>" + esc(t.intent || "—") + "</p>" +
      (t.acceptance ? "<h3>Acceptance</h3>" + renderMarkdown(t.acceptance) : "") +
      (t.body ? "<h3>Notes</h3>" + renderMarkdown(t.body) : "") +
      '<h3>Comments</h3>' +
      '<div class="comment-add"><textarea id="commentText" rows="2" placeholder="Add a comment — why this is blocked, skipped, or what you decided"></textarea>' +
      '<button class="ghost" id="commentAdd" type="button" data-id="' + esc(t.id) + '">Comment</button></div>' +
      "<h3>Activity</h3>" + historyHtml +
      '<h3>Claude log</h3>' +
      '<div id="ticketLog"><button class="ghost" id="loadLog" type="button" data-id="' + esc(t.id) +
      '">Load what Claude did</button>' +
      '<p class="empty-note">Read from the session transcripts, for the window this ticket was claimed.</p></div>';
    var riskSelect = ticketModalBody.querySelector(".risk-select");
    if (riskSelect) {
      riskSelect.addEventListener("change", async function () {
        riskSelect.disabled = true;
        try {
          var res = await apiPost("/api/tickets/" + encodeURIComponent(riskSelect.dataset.id) + "/risk", {
            risk: riskSelect.value,
          });
          if (res && res.error) { window.alert(res.error); riskSelect.value = t.risk || "reversible"; }
          else t.risk = riskSelect.value;
        } finally {
          riskSelect.disabled = false;
        }
      });
    }
    var loadLog = ticketModalBody.querySelector("#loadLog");
    if (loadLog) {
      loadLog.addEventListener("click", async function () {
        var box = ticketModalBody.querySelector("#ticketLog");
        loadLog.disabled = true;
        loadLog.textContent = "Reading transcripts…";
        try {
          var res = await fetch(withProject("/api/tickets/" + encodeURIComponent(loadLog.dataset.id) + "/log"))
            .then(function (r) { return r.json(); });
          box.innerHTML = renderTicketLog(res);
        } catch (e) {
          box.innerHTML = '<p class="empty-note">Could not read the transcripts.</p>';
        }
      });
    }
    var commentBtn = ticketModalBody.querySelector("#commentAdd");
    var commentText = ticketModalBody.querySelector("#commentText");
    if (commentBtn && commentText) {
      commentBtn.addEventListener("click", async function () {
        var text = commentText.value.trim();
        if (!text) return;
        commentBtn.disabled = true;
        try {
          var res = await apiPost("/api/tickets/" + encodeURIComponent(commentBtn.dataset.id) + "/comments", { text: text });
          if (res && res.error) { window.alert(res.error); return; }
          // Re-open against the stored ticket so the new comment shows without a round trip.
          var fresh = (latestTickets || []).find(function (x) { return x.id === t.id; });
          openTicketModal(fresh && fresh.comments ? fresh : (res.ticket || t));
        } finally {
          commentBtn.disabled = false;
        }
      });
    }
    var epicInput = ticketModalBody.querySelector(".epic-input");
    if (epicInput) {
      // On change (blur/Enter), not on every keystroke — each write is a commit.
      epicInput.addEventListener("change", async function () {
        var value = epicInput.value.trim();
        epicInput.disabled = true;
        try {
          var res = await apiPost("/api/tickets/" + encodeURIComponent(epicInput.dataset.id) + "/epic", {
            epic: value || null, actor: "peephole-ui",
          });
          if (res && res.error) {
            window.alert(res.error);
            epicInput.value = t.epic || "";
          } else {
            t.epic = value || null;
          }
        } finally {
          epicInput.disabled = false;
        }
      });
    }
    var assignSelect = ticketModalBody.querySelector(".assign-select");
    if (assignSelect) {
      assignSelect.addEventListener("change", async function () {
        assignSelect.disabled = true;
        try {
          var result = await apiPost("/api/tickets/" + encodeURIComponent(assignSelect.dataset.id) + "/assign", {
            assignee: assignSelect.value || null, actor: "peephole-ui",
          });
          // The server refuses to reassign a ticket somebody is actively working; surface that
          // instead of leaving the select showing a change that never landed.
          if (result && result.error) {
            window.alert(result.error);
            assignSelect.value = t.assignee || "";
          } else {
            t.assignee = assignSelect.value || null;
          }
        } finally {
          assignSelect.disabled = false;
        }
      });
    }
    ticketModalBackdrop.hidden = false;
  }
  function closeTicketModal() {
    ticketModalBackdrop.hidden = true;
  }
  ticketModalClose.addEventListener("click", closeTicketModal);
  ticketModalBackdrop.addEventListener("click", function (ev) {
    if (ev.target === ticketModalBackdrop) closeTicketModal();
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !ticketModalBackdrop.hidden) closeTicketModal();
    if (ev.key === "Escape" && !newTicketBackdrop.hidden) closeNewTicketModal();
  });

  // "Created by" defaults to this machine's git identity (server-resolved, see state.gitUser) —
  // the same identity every commit peephole makes already goes out under. A one-time manual
  // override is remembered locally so re-opening the form doesn't reset it.
  var CREATED_BY_KEY = "peephole.createdBy";
  function openNewTicketModal() {
    newTicketForm.reset();
    var state = latestState || {};
    newTicketForm.project.value = state.project || "";
    var savedCreatedBy = null;
    try { savedCreatedBy = localStorage.getItem(CREATED_BY_KEY); } catch (e) {}
    var gitUser = state.gitUser || {};
    newTicketForm.createdBy.value = savedCreatedBy || gitUser.name || gitUser.email || "";
    newTicketBackdrop.hidden = false;
    newTicketForm.intent.focus();
  }
  function closeNewTicketModal() {
    newTicketBackdrop.hidden = true;
  }
  newTicketBtn.addEventListener("click", openNewTicketModal);
  newTicketClose.addEventListener("click", closeNewTicketModal);
  newTicketBackdrop.addEventListener("click", function (ev) {
    if (ev.target === newTicketBackdrop) closeNewTicketModal();
  });
  newTicketForm.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var submitBtn = newTicketForm.querySelector('button[type="submit"]');
    var createdBy = newTicketForm.createdBy.value.trim();
    try {
      localStorage.setItem(CREATED_BY_KEY, createdBy);
    } catch (e) {}
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating…";
    try {
      var res = await apiPost("/api/tickets", {
        project: newTicketForm.project.value.trim(),
        intent: newTicketForm.intent.value.trim(),
        acceptance: newTicketForm.acceptance.value.trim(),
        risk: newTicketForm.risk.value,
        epic: newTicketForm.epic.value.trim() || null,
        createdBy: createdBy || null,
      });
      if (res && res.error) {
        alert("Could not create ticket: " + res.error);
        return;
      }
      closeNewTicketModal();
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create ticket";
    }
  });

  // One shared sort direction across every lane (not per-lane — a ticket's rank should mean the
  // same thing wherever it's looked at). "desc" (default) = latest-modified-first, the useful
  // default since it surfaces whatever just changed; "asc" = oldest-modified-first.
  var LANE_SORT_KEY = "peephole.laneSortDir";
  function getLaneSortDir() {
    try { return localStorage.getItem(LANE_SORT_KEY) === "asc" ? "asc" : "desc"; } catch (e) { return "desc"; }
  }
  function sortByModified(list, dir) {
    return list.slice().sort(function (a, b) {
      var diff = Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
      return dir === "asc" ? -diff : diff;
    });
  }

  // Grouping is a view preference, not ticket data — same treatment as the sort direction.
  var EPIC_GROUP_KEY = "peephole.groupByEpic";
  function getGroupByEpic() {
    try { return localStorage.getItem(EPIC_GROUP_KEY) === "1"; } catch (e) { return false; }
  }
  var NO_EPIC = "\u0000none"; // sorts nowhere near a real epic name, can't collide with one

  /** One board = one project. A repo's `.peephole/tickets` can hold tickets filed against other
   *  projects (Peephole's own tickets living in the repo it watches, say); showing them turned
   *  the project tag into a permanent chip on every card and mixed two backlogs in one board. */
  function forThisProject(tickets) {
    var project = latestState && latestState.project;
    if (!project) return tickets;
    return tickets.filter(function (t) { return !t.project || t.project === project; });
  }

  // Selected member names, persisted like the other view preferences. Empty = no filter at all,
  // which is a different thing from "nobody selected" — an empty set must never blank the board.
  var MEMBER_FILTER_KEY = "peephole.memberFilter";
  // NOT a NUL-prefixed sentinel like NO_EPIC: this one is written into a checkbox's value
  // attribute, and the HTML parser rewrites a literal NUL to U+FFFD — the value read back never
  // equalled the constant, so selecting "Unassigned" silently matched nothing.
  var UNASSIGNED = "__peephole:unassigned__";
  function getMemberFilter() {
    try {
      var raw = JSON.parse(localStorage.getItem(MEMBER_FILTER_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function setMemberFilter(list) {
    try { localStorage.setItem(MEMBER_FILTER_KEY, JSON.stringify(list)); } catch (e) {}
  }

  /** A ticket belongs to whoever is working it (owner) OR whoever it is reserved for (assignee) —
   *  both, because a filter on "my work" has to surface the queue waiting for me as well as what
   *  I already hold. A ticket with neither matches only the explicit "Unassigned" choice. */
  // "all" | "selected" | "unselected" — a lane full of ticked and unticked cards is hard to scan
  // when you are building a batch, so the board can narrow to one or the other.
  var SELECTION_FILTER_KEY = "peephole.selectionFilter";
  function getSelectionFilter() {
    try { return localStorage.getItem(SELECTION_FILTER_KEY) || "all"; } catch (e) { return "all"; }
  }
  function matchesSelection(t, mode) {
    if (mode === "selected") return Boolean(t.selected);
    if (mode === "unselected") return !t.selected;
    return true;
  }

  function matchesMembers(t, selected) {
    if (!selected.length) return true;
    var owner = ownerNameOf(t);
    if (owner && selected.indexOf(owner) !== -1) return true;
    if (t.assignee && selected.indexOf(t.assignee) !== -1) return true;
    if (!owner && !t.assignee && selected.indexOf(UNASSIGNED) !== -1) return true;
    return false;
  }

  // Tag filter — selected tag names, persisted like the member filter. Empty = no filter, and a
  // card matches when it carries ANY selected tag (OR, same as members): narrowing to "docs" OR
  // "infra" shows the union, which is what picking two chips reads as.
  var TAG_FILTER_KEY = "peephole.tagFilter";
  function getTagFilter() {
    try {
      var raw = JSON.parse(localStorage.getItem(TAG_FILTER_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function setTagFilter(list) {
    try { localStorage.setItem(TAG_FILTER_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function matchesTags(t, selected) {
    if (!selected.length) return true;
    var tags = Array.isArray(t.tags) ? t.tags : [];
    return tags.some(function (tg) { return selected.indexOf(tg) !== -1; });
  }

  // Epic filter — selected epic names. NO_EPIC's NUL prefix can't ride in a checkbox value (the
  // HTML parser rewrites a literal NUL to U+FFFD, so it never reads back equal — the same trap
  // UNASSIGNED exists to dodge), so "No epic" is this plain sentinel instead.
  var EPIC_FILTER_KEY = "peephole.epicFilter";
  var NO_EPIC_FILTER = "__peephole:noepic__";
  function getEpicFilter() {
    try {
      var raw = JSON.parse(localStorage.getItem(EPIC_FILTER_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function setEpicFilter(list) {
    try { localStorage.setItem(EPIC_FILTER_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function matchesEpics(t, selected) {
    if (!selected.length) return true;
    if (t.epic) return selected.indexOf(t.epic) !== -1;
    return selected.indexOf(NO_EPIC_FILTER) !== -1;
  }

  // Mirrored from the server's queue so a card can show "queued"/"running" without asking.
  var queuedIds = [];
  var runningId = null;
  var chatSessions = {}; // ticketId -> sessionId of an open conversation

  var latestTickets = [];
  function renderBoard(tickets) {
    latestTickets = tickets;
    var dir = getLaneSortDir();
    var grouped = getGroupByEpic();
    var selected = getMemberFilter();
    var selMode = getSelectionFilter();
    var tagSel = getTagFilter();
    var epicSel = getEpicFilter();
    var visible = forThisProject(tickets).filter(function (t) {
      return matchesMembers(t, selected) && matchesSelection(t, selMode) &&
        matchesTags(t, tagSel) && matchesEpics(t, epicSel);
    });
    board.innerHTML = "";
    LANES.forEach(function (s) {
      var inLane = sortByModified(visible.filter(function (t) { return s.states.indexOf(t.state) !== -1; }), dir);
      var lane = document.createElement("section");
      lane.className = "lane";
      // A lane fills with tickets finished in every sense except the last click — forty verified at
      // once here. The header offers the move for whichever state is one step from the lane's end,
      // so clearing them is one action rather than forty.
      var ready = inLane.filter(function (t) {
        return s.bulk && t.state === s.bulk.from && (!t.control || t.control === "run");
      });
      var bulkBtn = ready.length
        ? '<button class="bulk-btn" data-bulk="' + esc(s.bulk.to) + '" data-count="' + ready.length +
          '" title="Move ' + ready.length + " ticket" + (ready.length === 1 ? "" : "s") + " from " +
          esc(s.bulk.from) + " to " + esc(s.bulk.to) + '" type="button">' + esc(s.bulk.label) + " " + ready.length + "</button>"
        : "";
      lane.innerHTML =
        "<header><h2>" + s.label + '</h2><span class="count mono">' + inLane.length + "</span>" + bulkBtn +
        '<button class="sort-btn" data-lane-sort type="button" title="Sort: ' +
        (dir === "desc" ? "latest modified first" : "oldest modified first") + '" aria-pressed="' + (dir === "asc") + '">' +
        (dir === "desc" ? "↓" : "↑") + "</button></header>" +
        '<div class="lane-body"></div>';
      var body = lane.querySelector(".lane-body");
      if (inLane.length === 0) {
        body.innerHTML = '<div class="lane-empty">No tickets</div>';
      } else if (grouped) {
        // Epics keep their order across lanes (alphabetical, un-filed last) so one epic's work
        // reads as a row across the board rather than shuffling per column.
        var byEpic = {};
        inLane.forEach(function (t) {
          var key = t.epic || NO_EPIC;
          (byEpic[key] = byEpic[key] || []).push(t);
        });
        // Alphabetical, but the un-filed pile always sinks to the bottom of the lane: it is the
        // residue, not a group anyone is tracking. (NO_EPIC's NUL prefix would otherwise sort it
        // first, above every real epic.)
        var keys = Object.keys(byEpic).sort().filter(function (k) { return k !== NO_EPIC; });
        if (byEpic[NO_EPIC]) keys.push(NO_EPIC);
        keys.forEach(function (key) {
          var group = document.createElement("div");
          group.className = "lane-group";
          group.innerHTML = '<h3 class="group-head">' +
            (key === NO_EPIC ? '<span class="dim">No epic</span>' : esc(key)) +
            '<span class="count mono">' + byEpic[key].length + "</span></h3>";
          byEpic[key].forEach(function (t) { group.appendChild(cardEl(t)); });
          body.appendChild(group);
        });
      } else {
        inLane.forEach(function (t) { body.appendChild(cardEl(t)); });
      }
      var bulkEl = lane.querySelector("[data-bulk]");
      if (bulkEl) {
        bulkEl.addEventListener("click", async function () {
          var ids = ready.map(function (t) { return t.id; });
          if (!window.confirm("Move " + ids.length + " ticket" + (ids.length === 1 ? "" : "s") + " from " +
            s.bulk.from + " to " + s.bulk.to + "?\n\nThis is one commit on the ledger, and state only moves forward.")) return;
          bulkEl.disabled = true;
          bulkEl.textContent = "Moving…";
          var res = await apiPost("/api/tickets/advance", { ticketIds: ids, state: s.bulk.to });
          if (res && res.error) { window.alert(res.error); return; }
          // Anything the server refused is named rather than silently left behind.
          if (res && res.skipped && res.skipped.length) {
            window.alert("Moved " + res.moved.length + ", skipped " + res.skipped.length + ":\n\n" +
              res.skipped.slice(0, 8).map(function (x) { return "  " + x.id + " — " + x.reason; }).join("\n"));
          }
          if (res && res.state) render(res.state);
        });
      }
      lane.querySelector("[data-lane-sort]").addEventListener("click", function () {
        var next = getLaneSortDir() === "desc" ? "asc" : "desc";
        try { localStorage.setItem(LANE_SORT_KEY, next); } catch (e) {}
        renderBoard(latestTickets);
      });
      board.appendChild(lane);
    });
  }

  function renderAgents(agents) {
    if (!agents || agents.length === 0) {
      agentList.innerHTML = '<p class="empty-note">No live sessions.</p>';
      return;
    }
    agentList.innerHTML = agents.map(function (a) {
      var status = a.stale ? "stale" : (a.status || "idle");
      // The heartbeat has carried the git identity since SessionStart started reporting it; the
      // panel was still showing only a UUID, so "who is running this" was unanswerable from the
      // one screen whose entire job is answering it.
      var author = a.author || {};
      var who = author.name || a.sessionId || "?";
      return (
        '<div class="agent">' +
        '<span class="who">' + esc(who) + "</span>" +
        (author.email ? ' <span class="email dim">' + esc(author.email) + "</span>" : "") +
        '<span class="status ' + status + '">' + status + "</span>" +
        (a.activeTicket ? '<div class="ticket mono">#' + esc(a.activeTicket) + "</div>" : "") +
        '<div class="session mono dim">' + esc(a.sessionId || "?") +
        (a.host ? " · " + esc(a.host) : "") + "</div>" +
        '<div class="since">last seen ' + relTime(a.lastSeenAt) + "</div>" +
        (a.tokens
          ? '<div class="tokens mono">' + fmtNum(a.tokens.totalTokens) + " tokens" +
            // Cache reads are excluded from the headline (re-sent context, billed at a fraction),
            // but at this scale they are 100x the counted total — hiding them entirely made the
            // number read as "this session's usage", which it is not.
            (a.tokens.cacheReadTokens ? ' <span class="dim">+ ' + fmtNum(a.tokens.cacheReadTokens) + " cached reads</span>" : "") +
            "</div>"
          : "") +
        "</div>"
      );
    }).join("");
  }

  /** Per-session token usage, sorted highest first. `a.tokens.totalTokens` is input +
   *  output + cache-writes (see src/tokens.js) — cache-READ tokens are excluded from this
   *  headline number since they're re-sent context, not new work. */
  function renderTokenUsage(agents) {
    var withTokens = (agents || []).filter(function (a) { return a.tokens && a.tokens.totalTokens > 0; });
    if (withTokens.length === 0) {
      tokenUsage.innerHTML = "";
      tokenUsage.hidden = true;
      return;
    }
    tokenUsage.hidden = false;
    withTokens.sort(function (a, b) { return b.tokens.totalTokens - a.tokens.totalTokens; });
    var max = withTokens[0].tokens.totalTokens;
    tokenUsage.innerHTML =
      "<h3>Tokens by session</h3>" +
      withTokens.map(function (a) {
        var pct = max > 0 ? Math.round((a.tokens.totalTokens / max) * 100) : 0;
        return (
          '<div class="token-row"><span class="name mono">' + esc(a.sessionId || "?") + '</span>' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="amount mono">' + fmtNum(a.tokens.totalTokens) + "</span></div>"
        );
      }).join("");
  }

  /** The user matrix — one row per contributor, one column per metric. Commit count and token
   *  usage are joined server-side by mailmap-resolved name (see hooks/identity.js) so
   *  "ehthisham" and "Ehthisham <other-email>" land on one row. Sorted by tokens first (the
   *  more AI-era-relevant figure when present), falling back to commits — never by name, which
   *  would bury whoever's actually doing the most right now at the bottom of an alphabetical list. */
  /** Everything one person did on this board, from the ledger alone — no git blame, no extra
   *  round trip. A ticket belongs to someone if they own it (by recorded name, or by a session
   *  they dispatched), if it is assigned to them, or if they wrote a comment on it. */
  function memberWork(name, tickets) {
    var mine = forThisProject(tickets || []);
    // A finished ticket nobody claimed still has someone who closed it. That is weaker than
    // ownership and is treated as such — counted, but never described as "theirs".
    var owned = mine.filter(function (t) { return ownerNameOf(t) === name; });
    var finished = mine.filter(function (t) {
      return TERMINAL_STATES.has(t.state) && t.finishedBy === name && ownerNameOf(t) !== name;
    });
    var assigned = mine.filter(function (t) { return t.assignee === name && ownerNameOf(t) !== name; });
    var commented = mine.filter(function (t) {
      return (t.comments || []).some(function (c) { return c.by === name; }) &&
        ownerNameOf(t) !== name && t.assignee !== name;
    });

    var shipped = owned.filter(function (t) { return TERMINAL_STATES.has(t.state); });
    var open = owned.filter(function (t) { return !TERMINAL_STATES.has(t.state); });

    // Hand-worked vs dispatched: a ticket owned under a person's own name was claimed by a human,
    // while one owned by a session id with their name recorded beside it was work they DIRECTED.
    // Nothing else on this board can tell those apart, and they are different skills.
    var dispatched = owned.filter(function (t) { return t.owner && SESSION_ID_RE.test(t.owner); });
    var handWorked = owned.filter(function (t) { return t.owner && !SESSION_ID_RE.test(t.owner); });

    var durations = [];
    var tokens = 0;
    var tokenTickets = 0;
    shipped.forEach(function (t) {
      var cost = ticketCost(t);
      if (cost.workMs != null) durations.push(cost.workMs);
      if (cost.tokens != null && cost.tokens > 0) { tokens += cost.tokens; tokenTickets += 1; }
    });

    var epics = {};
    owned.forEach(function (t) { var k = t.epic || NO_EPIC; epics[k] = (epics[k] || 0) + 1; });

    // Pauses and skips they explained. The reason text is the richest thing on the board about
    // how somebody supervises agents, and it exists nowhere else.
    var interventions = [];
    mine.forEach(function (t) {
      (t.comments || []).forEach(function (c) {
        if (c.by === name && c.control) interventions.push({ ticket: t, at: c.at, control: c.control, text: c.text });
      });
    });
    interventions.sort(function (a, b) { return Date.parse(b.at || 0) - Date.parse(a.at || 0); });

    return {
      name: name, owned: owned, shipped: shipped, open: open, assigned: assigned, commented: commented,
      finished: finished,
      dispatched: dispatched, handWorked: handWorked,
      medianWorkMs: median(durations), tokensPerShipped: tokenTickets ? Math.round(tokens / tokenTickets) : null,
      tokenTickets: tokenTickets, epics: epics, interventions: interventions,
      irreversible: shipped.filter(function (t) { return t.risk === "irreversible"; }).length,
    };
  }

  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  /** The team's median, so a person's numbers can be read as "typical / faster / slower" rather
   *  than as a rank. Ranking a four-person team by tickets shipped teaches people to split
   *  tickets, which is the opposite of what this board is for. */
  function teamMedians(names, tickets) {
    var shipped = [];
    var work = [];
    names.forEach(function (n) {
      var w = memberWork(n, tickets);
      shipped.push(w.shipped.length);
      if (w.medianWorkMs != null) work.push(w.medianWorkMs);
    });
    return { shipped: median(shipped), workMs: median(work) };
  }

  function comparison(value, mid) {
    if (value == null || mid == null || mid === 0) return "";
    var ratio = value / mid;
    if (ratio > 1.25) return ' <span class="cmp above">above the team median</span>';
    if (ratio < 0.8) return ' <span class="cmp below">below the team median</span>';
    return ' <span class="cmp">about the team median</span>';
  }

  function ticketLinkList(tickets, emptyText) {
    if (!tickets.length) return '<p class="empty-note">' + esc(emptyText) + "</p>";
    return '<ul class="member-tickets">' + tickets.map(function (t) {
      return '<li><button type="button" class="tlink" data-ticket="' + esc(t.id) + '">' +
        esc(t.intent || t.id) + '</button><span class="st">' + esc(t.state) + "</span></li>";
    }).join("") + "</ul>";
  }

  /**
   * What the project loses if one person stops. For each package they have touched in the window:
   * their share of its commits, whether anyone else touched it at all, and — joined from the
   * coverage profile — how much of it tests would catch a mistake in.
   *
   * Sole-owned and untested is the cell that matters. Ownership alone says "one person knows this",
   * coverage alone says "this is unverified"; neither is urgent on its own. Their product is what
   * actually breaks when somebody leaves, and Peephole is holding both halves already.
   */
  function removalRisk(name, state) {
    var own = state.ownership;
    if (!own || !own.packages) return null;
    var cov = {};
    ((state.coverage && state.coverage.modules) || []).forEach(function (m) { cov[m.pkg] = m; });

    var touched = [];
    own.packages.forEach(function (p) {
      var mine = p.authors[name];
      if (!mine) return;
      var others = Object.keys(p.authors).filter(function (a) { return a !== name; });
      var share = mine / p.commits;
      var c = cov[p.pkg] || null;
      var uncovered = c ? Math.round(c.total * (1 - c.pct / 100)) : null;
      touched.push({
        pkg: p.pkg, share: share, commits: p.commits, mine: mine,
        others: others, sole: others.length === 0,
        coverage: c ? c.pct : null, statements: c ? c.total : null,
        uncoveredStatements: uncovered,
        lastTouched: p.lastBy[name] || null,
      });
    });
    touched.sort(function (a, b) { return b.share - a.share || b.commits - a.commits; });

    var sole = touched.filter(function (t) { return t.sole; });
    // Only packages nobody else has touched count as exposure — a package with a second author has
    // somebody to ask, whatever the coverage says.
    var exposure = sole.reduce(function (sum, t) { return sum + (t.uncoveredStatements || 0); }, 0);
    var untestedSole = sole.filter(function (t) { return t.coverage != null && t.coverage < 50; });

    // Who else has touched the things they touch — the handover shortlist, by weight of overlap.
    var peers = {};
    touched.forEach(function (t) {
      t.others.forEach(function (o) { peers[o] = (peers[o] || 0) + 1; });
    });
    var peerList = Object.keys(peers).sort(function (a, b) { return peers[b] - peers[a]; });

    return {
      windowMonths: own.windowMonths, touched: touched, sole: sole, untestedSole: untestedSole,
      exposure: exposure, peers: peerList, peerCounts: peers,
    };
  }

  function pkgRow(t) {
    var covLabel = t.coverage == null ? "no coverage data" : t.coverage.toFixed(0) + "% covered";
    return (
      '<div class="own-row"><span class="name mono" title="' + esc(t.pkg) + '">' + esc(t.pkg) + "</span>" +
      '<span class="bar-track"><span class="bar-fill" style="width:' + (t.share * 100).toFixed(1) +
      '%;background:' + (t.sole ? "var(--accent)" : "var(--progress)") + '"></span></span>' +
      '<span class="amount mono">' + Math.round(t.share * 100) + "%</span>" +
      '<span class="cov ' + (t.coverage != null && t.coverage < 50 ? "low" : "") + '">' + esc(covLabel) + "</span>" +
      '<span class="who dim">' + (t.sole ? "only author" : t.others.length + " other" + (t.others.length === 1 ? "" : "s")) + "</span></div>"
    );
  }

  var openMember = null;

  /** One member's page: what they moved, how they worked with agents, and what would need a new
   *  owner if they stopped. Deliberately not a score — every figure is either a count, a median,
   *  or a comparison to the team's median. */
  function renderMemberDetail(name, state) {
    var w = memberWork(name, state.tickets);
    var names = ((state.stats && state.stats.contributorList) || []).map(function (c) { return c.name; });
    var mid = teamMedians(names, state.tickets);
    var contributor = ((state.stats && state.stats.contributorList) || []).find(function (c) { return c.name === name; }) || {};
    var epicRows = Object.keys(w.epics).sort(function (a, b) { return w.epics[b] - w.epics[a]; });

    memberList.innerHTML =
      '<button class="back-link" id="memberBack" type="button">← All members</button>' +
      '<h2 class="member-name">' + esc(name) + "</h2>" +
      '<div class="stat-row">' +
      [
        { value: fmtNum(w.shipped.length), label: "Shipped", sub: "tickets they owned" + comparison(w.shipped.length, mid.shipped) },
        { value: fmtNum(w.finished.length), label: "Closed out", sub: "finished without claiming" },
        { value: w.medianWorkMs != null ? fmtDuration(w.medianWorkMs) : "—", label: "Median time to ship",
          // The sample size is part of the number: a median over three tickets is a coincidence,
          // and one over three tickets that were bulk-advanced is an artefact of the CLI.
          sub: "claim → shipped, " + w.shipped.length + " ticket" + (w.shipped.length === 1 ? "" : "s") + comparison(w.medianWorkMs, mid.workMs) },
        { value: w.tokensPerShipped != null ? fmtNum(w.tokensPerShipped) : "—", label: "Tokens per ticket", sub: w.tokenTickets ? "across " + w.tokenTickets + " measured" : "none measured yet" },
        { value: fmtNum(contributor.commits || 0), label: "Commits", sub: "on the checked-out branch" },
      ].map(function (t) {
        return '<div class="stat-tile"><div class="value">' + t.value + '</div><div class="label">' + esc(t.label) +
          '</div><div class="sub">' + t.sub + "</div></div>";
      }).join("") +
      "</div>" +

      '<div class="member-panels">' +
      '<section class="member-panel"><h3>How the work got done</h3>' +
      '<div class="split-bar"><span style="width:' +
        (w.owned.length ? (w.handWorked.length / w.owned.length) * 100 : 0).toFixed(1) +
        '%" class="hand"></span><span style="width:' +
        (w.owned.length ? (w.dispatched.length / w.owned.length) * 100 : 0).toFixed(1) + '%" class="dispatched"></span></div>' +
      '<p class="split-key"><b>' + w.handWorked.length + "</b> worked by hand · <b>" + w.dispatched.length +
        "</b> dispatched to an agent" + (w.irreversible ? " · <b>" + w.irreversible + "</b> irreversible shipped" : "") + "</p>" +
      (epicRows.length
        ? '<p class="split-key dim">Epics: ' + epicRows.map(function (k) {
            return (k === NO_EPIC ? "unfiled" : esc(k)) + " (" + w.epics[k] + ")";
          }).join(" · ") + "</p>"
        : "") +
      "</section>" +

      '<section class="member-panel"><h3>Interventions</h3>' +
      (w.interventions.length
        ? '<ul class="member-tickets">' + w.interventions.slice(0, 6).map(function (i) {
            return "<li><b>" + esc(i.control) + "</b> " + esc(i.text) +
              '<span class="st">' + relTime(i.at) + "</span></li>";
          }).join("") + "</ul>"
        : '<p class="empty-note">No pauses or skips explained yet — the reason box on ⏸/⏭ fills this.</p>') +
      "</section>" +

      // Only on your own page: the data comes from this machine's transcripts and exists for
      // nobody else. Loaded on demand so opening a colleague's page never touches it.
      (state.gitUser && state.gitUser.name === name
        ? '<section class="member-panel wide you-panel"><h3>You, on this machine</h3>' +
          '<button class="ghost" id="loadMe" type="button">Show my last 7 days</button>' +
          '<p class="split-key dim">Read from your own Claude transcripts. Local only — never committed, ' +
          "never shown on anyone else's page, and there is no way to ask this about another member.</p></section>"
        : "") +
      ownershipPanels(name, state) +

      '<section class="member-panel wide"><h3>Would need a new owner</h3>' +
      '<p class="split-key dim">Open work that stops if ' + esc(name) + " does.</p>" +
      ticketLinkList(w.open.concat(w.assigned), "Nothing open — nothing to hand over.") +
      "</section>" +
      "</div>";

    var loadMe = memberList.querySelector("#loadMe");
    if (loadMe) {
      loadMe.addEventListener("click", async function () {
        loadMe.disabled = true;
        loadMe.textContent = "Reading your transcripts…";
        try {
          var me = await fetch("/api/me?days=7").then(function (r) { return r.json(); });
          loadMe.parentNode.innerHTML = renderYou(me);
        } catch (e) {
          loadMe.textContent = "Could not read them";
          loadMe.disabled = false;
        }
      });
    }
    var back = document.getElementById("memberBack");
    if (back) back.addEventListener("click", function () { openMember = null; renderMembers((state.stats && state.stats.contributorList) || []); });
    Array.prototype.forEach.call(memberList.querySelectorAll(".tlink"), function (btn) {
      btn.addEventListener("click", function () {
        var t = (latestState.tickets || []).find(function (x) { return x.id === btn.dataset.ticket; });
        if (t) openTicketModal(t);
      });
    });
  }

  /** How much of the board these figures do NOT cover. A ticket nobody claimed belongs to nobody,
   *  and per-member counts that quietly omit two thirds of the work invite exactly the wrong
   *  conclusion about who did what. */
  function unattributedNote(tickets) {
    var mine = forThisProject(tickets || []);
    var shipped = mine.filter(function (t) { return TERMINAL_STATES.has(t.state); });
    var unowned = shipped.filter(function (t) { return !ownerNameOf(t) && !t.finishedBy; });
    if (!unowned.length) return "";
    return '<p class="empty-note attribution">' + unowned.length + " of " + shipped.length +
      " finished tickets record neither an owner nor who closed them — they were advanced before " +
      "either was tracked, by a CLI that wrote the literal string \"agent\" — so they count towards " +
      "nobody here. Nothing can recover a name that was never written down; tickets finished from " +
      "now on carry one.</p>";
  }

  /** Your own week: hours actually worked, what you asked for, what the model did about it. Focused
   *  time is the sum of gaps shorter than twelve minutes, not first-to-last — a session left open
   *  overnight is not a fourteen-hour day. */
  function renderYou(me) {
    if (me && me.error) return '<h3>You, on this machine</h3><p class="empty-note">' + esc(me.error) + "</p>";
    var days = (me && me.days) || [];
    if (!days.length) {
      return '<h3>You, on this machine</h3><p class="empty-note">No sessions in the last ' +
        esc(String((me && me.windowDays) || 7)) + " days.</p>";
    }
    var max = Math.max.apply(null, days.map(function (d) { return d.focusedMinutes; }).concat([1]));
    var t = me.totals || {};
    return (
      '<h3>You, on this machine</h3>' +
      '<div class="you-tiles">' +
      [[fmtDuration(t.focusedMinutes * 60000), "focused time", "sum of working stretches"],
       [fmtNum(t.prompts), "things you asked", fmtNum(t.sessions) + " sessions"],
       [fmtNum(t.tools), "tool calls it made", fmtNum(t.replies) + " replies"],
       [fmtNum(t.steers), "steers (rough)", "short corrective replies"]].map(function (x) {
        return '<div class="you-tile"><span class="v">' + x[0] + '</span><span class="l">' + esc(x[1]) +
          '</span><span class="s">' + esc(x[2]) + "</span></div>";
      }).join("") +
      "</div>" +
      '<div class="you-days">' + days.map(function (d) {
        return '<div class="you-day"><span class="d">' + esc(d.date.slice(5)) + "</span>" +
          '<span class="bar-track"><span class="bar-fill" style="width:' +
          ((d.focusedMinutes / max) * 100).toFixed(1) + '%"></span></span>' +
          '<span class="m mono">' + fmtDuration(d.focusedMinutes * 60000) + "</span>" +
          '<span class="p dim">' + d.prompts + " asks · " + d.tools + " tools" +
          (d.steers ? " · " + d.steers + " steers" : "") + "</span></div>";
      }).join("") + "</div>" +
      '<p class="split-key dim">Steers are a heuristic — short replies that read like a correction ' +
      '("no", "revert", "that\'s not…"). Treat it as a nudge, not a number. Local only: read from ' +
      esc(String(me.scannedFiles)) + " transcripts on this machine and sent nowhere.</p>"
    );
  }

  /** Stages 2 and 3 of the member view: where their knowledge sits, and what it would cost to lose
   *  it. Absent entirely when the ownership map has not been computed — a risk figure built on
   *  missing data is worse than no figure. */
  function ownershipPanels(name, state) {
    var risk = removalRisk(name, state);
    if (!risk) return "";
    if (!risk.touched.length) {
      return '<section class="member-panel wide"><h3>Ownership</h3><p class="empty-note">No commits in the last ' +
        risk.windowMonths + " months.</p></section>";
    }

    var worst = risk.untestedSole.slice().sort(function (a, b) {
      return (b.uncoveredStatements || 0) - (a.uncoveredStatements || 0);
    });

    return (
      '<section class="member-panel wide"><h3>Where their knowledge sits</h3>' +
      '<p class="split-key dim">Share of commits per package, last ' + risk.windowMonths +
      " months. Red means nobody else has touched it.</p>" +
      risk.touched.slice(0, 12).map(pkgRow).join("") +
      (risk.touched.length > 12 ? '<p class="split-key dim">+ ' + (risk.touched.length - 12) + " more</p>" : "") +
      "</section>" +

      '<section class="member-panel wide risk-panel"><h3>If they stop</h3>' +
      '<div class="risk-head"><span class="risk-num">' + fmtNum(risk.sole.length) + "</span>" +
      '<span class="risk-label">package' + (risk.sole.length === 1 ? "" : "s") +
      " nobody else has touched in " + risk.windowMonths + " months</span>" +
      (risk.exposure
        ? '<span class="risk-num accent">' + fmtNum(risk.exposure) + "</span>" +
          '<span class="risk-label">statements in them that tests would not catch</span>'
        : "") +
      "</div>" +
      (worst.length
        ? '<p class="split-key">Least protected:</p>' + worst.slice(0, 5).map(pkgRow).join("")
        : '<p class="split-key dim">Nothing sole-owned is under 50% covered.</p>') +
      '<p class="split-key">' +
      (risk.peers.length
        ? "Nearest peers by overlapping work: " + risk.peers.slice(0, 3).map(function (p) {
            return esc(p) + " (" + risk.peerCounts[p] + " shared package" + (risk.peerCounts[p] === 1 ? "" : "s") + ")";
          }).join(" · ")
        : "<b>No peers.</b> Nobody else has committed to any package they touch — the handover target would have to be chosen, not found.") +
      "</p></section>"
    );
  }

  function renderMembers(list) {
    if (!list || list.length === 0) {
      memberList.innerHTML = '<p class="empty-note">No commits yet.</p>';
      return;
    }
    var rows = list.slice().sort(function (a, b) {
      return (b.tokens || 0) - (a.tokens || 0) || b.commits - a.commits;
    });
    // The list gains the two ledger counts that make a row worth clicking: what they shipped and
    // what is still open in their name.
    memberList.innerHTML =
      "<table class=\"matrix members\"><thead><tr>" +
      "<th>Member</th><th>Shipped</th><th>Open</th><th>Commits</th><th>Tokens</th>" +
      "</tr></thead><tbody>" +
      rows.map(function (m) {
        var w = memberWork(m.name, (latestState && latestState.tickets) || []);
        return (
          '<tr class="member-row" data-member="' + esc(m.name) + '">' +
          "<td>" + esc(m.name) + "</td>" +
          '<td class="mono">' + fmtNum(w.shipped.length) + "</td>" +
          '<td class="mono">' + (w.open.length || w.assigned.length
            ? fmtNum(w.open.length + w.assigned.length)
            : "—") + "</td>" +
          '<td class="mono">' + fmtNum(m.commits) + "</td>" +
          '<td class="mono">' + (m.tokens ? fmtNum(m.tokens) : "—") + "</td></tr>"
        );
      }).join("") +
      "</tbody></table>" +
      unattributedNote((latestState && latestState.tickets) || []);

    Array.prototype.forEach.call(memberList.querySelectorAll(".member-row"), function (tr) {
      tr.addEventListener("click", function () {
        openMember = tr.dataset.member;
        renderMemberDetail(openMember, latestState);
      });
    });
  }

  var latestState = null;

  function render(state) {
    latestState = state;
    var q = state.queue || { pending: [], running: null };
    queuedIds = (q.pending || []).map(function (p) { return p.ticketId; });
    runningId = q.running ? q.running.ticketId : null;
    chatSessions = {};
    (q.chats || []).forEach(function (c) { chatSessions[c.ticketId] = c.sessionId; });
    renderQueueBar(q);
    authorBySession = {};
    (state.agents || []).forEach(function (a) {
      if (a.sessionId && a.author && a.author.name) authorBySession[a.sessionId] = a.author.name;
    });
    projectName.textContent = state.project || "—";
    projectBtn.title = "Switch project — " + (state.repoRoot || "");

    // Only the branch you are actually on. The ledger branch, the remote and where the ledger is
    // checked out describe the setup rather than the moment, so they live in Configuration instead
    // of sitting in the chrome of every screen.
    if (state.checkoutBranch) {
      checkoutBranchEl.className = "branch mono checkout-branch";
      checkoutBranchEl.textContent = state.checkoutBranch;
      checkoutBranchEl.title = "The branch checked out in " + (state.repoRoot || "this repo") +
        " — tickets live on " + (state.stateBranch || "the ledger branch") + " (see Configuration)";
    } else {
      checkoutBranchEl.textContent = "";
      checkoutBranchEl.title = "";
    }
    lastUpdated.textContent = "Updated " + relTime(state.lastFetchedAt);

    // Three states, not two. `hookConfigured` means "a session checked in recently" — liveness —
    // while `hooksInstalled` means the hooks are actually wired into this machine's
    // .claude/settings.local.json. Collapsing them told a correctly-configured repo with nothing
    // running that it was "not configured", and sent people to re-run a setup that was already done.
    var sync = state.autoFetch && state.autoFetch.enabled
      ? " · autosync every " + state.autoFetch.intervalMinutes + " min"
      : "";
    if (state.hookConfigured) {
      hookState.innerHTML = "Hooks: <b>live</b> — a session is checking in" + esc(sync);
    } else if (state.hooksInstalled) {
      hookState.innerHTML = "Hooks: <b>wired</b> — no session running right now" + esc(sync);
    } else {
      hookState.innerHTML = "Hooks: <b>not configured</b> — run Fix it to wire them" + esc(sync);
    }
    autoFetchToggle.setAttribute("aria-pressed", String(Boolean(state.autoFetch && state.autoFetch.enabled)));
    if (state.autoFetch) intervalInput.value = state.autoFetch.intervalMinutes;

    groupToggle.setAttribute("aria-pressed", String(getGroupByEpic()));
    // latestTickets is what the selected-count and the filter menu read; renderBoard sets it too,
    // but it runs later in this function — without this the toolbar was always one refresh behind.
    latestTickets = state.tickets || [];
    renderFilterState();
    renderExecSelected();
    renderWorkerButton();
    // Filtering to one project is silent otherwise — a ticket filed against another project would
    // simply never appear, with no way to tell that from "never created".
    var all = state.tickets || [];
    var hidden = all.length - forThisProject(all).length;
    otherProjects.hidden = hidden === 0;
    otherProjects.textContent = hidden
      ? hidden + (hidden === 1 ? " ticket" : " tickets") + " from other projects hidden"
      : "";
    epicOptions.innerHTML = knownEpics().map(function (e) { return '<option value="' + esc(e) + '">'; }).join("");

    var issues = state.issues || [];
    if (issues.length) {
      issuesBanner.hidden = false;
      issuesList.innerHTML = issues.map(function (i) { return "<li>" + esc(i.message) + "</li>"; }).join("");
      fixBtn.hidden = !issues.some(function (i) { return STRUCTURAL_ISSUES.has(i.kind); });
    } else {
      issuesBanner.hidden = true;
    }

    var sync = state.autoFetch || {};
    if (sync.enabled && sync.lastPushError) {
      // A silent refusal is the worst outcome for a toggle whose whole promise is "you don't have
      // to think about pushing" — say why nothing went out.
      pushBanner.hidden = false;
      pushText.textContent = "Autosync: " + sync.lastPushError;
      pushBtn.hidden = false;
      return;
    }
    pushBtn.hidden = false;
    if (state.unpushed > 0) {
      pushBanner.hidden = false;
      // A ledger branch that has never been pushed is a different situation from commits waiting on
      // a branch everyone already has: nobody else can see ANY of this board until the first push
      // creates the branch, which is worth saying rather than counting commits at them.
      pushText.textContent = state.stateBranchOnRemote === false
        ? state.stateBranch + " is not on the remote yet — Push to remote creates it (" +
          state.unpushed + " commit" + (state.unpushed === 1 ? "" : "s") + ")"
        : state.unpushed + " unpushed commit" + (state.unpushed === 1 ? "" : "s") + " on " + state.stateBranch;
    } else {
      pushBanner.hidden = true;
    }

    renderInsights(state.stats, state.coverage, state.agents);
    renderCompletion(state.tickets);
    renderStateChart(state.tickets || []);
    renderBoard(state.tickets || []);
    renderAgents(state.agents || []);
    renderTokenUsage(state.agents || []);
    if (openMember) renderMemberDetail(openMember, state);
    else renderMembers((state.stats && state.stats.contributorList) || []);
    renderConfig(state);
  }

  pullBtn.addEventListener("click", async function () {
    pullBtn.disabled = true;
    pullBtn.textContent = "Pulling…";
    try {
      await apiPost("/api/pull");
    } finally {
      pullBtn.disabled = false;
      pullBtn.textContent = "Pull latest";
    }
  });

  var PERM_KEY = "peephole.permissionMode";
  var PERM_MODES = [
    { key: "acceptEdits", label: "Accept edits", sub: "writes files; bash and network refused" },
    { key: "plan", label: "Plan only", sub: "investigates and reports, changes nothing" },
    { key: "bypassPermissions", label: "Bypass all", sub: "any tool, unattended — including bash" },
  ];

  /** Asked per dispatch rather than configured once: "let an agent edit files unattended" and
   *  "let it run any command unattended" are different decisions, and which is appropriate depends
   *  on the ticket. Resolves to null when dismissed — dismissing must never dispatch. */
  function askPermissionMode(ids) {
    var list = Array.isArray(ids) ? ids : [];
    var count = list.length;
    // An irreversible ticket is one a revert cannot undo — a migration, a deleted column, a pushed
    // release. Dispatching one starts an agent doing exactly that with nobody watching, so it is
    // the one case where picking a permission mode is not consent enough.
    var risky = list
      .map(function (id) { return (latestTickets || []).find(function (t) { return t.id === id; }); })
      .filter(function (t) { return t && t.risk === "irreversible"; });
    var last = "acceptEdits";
    try { last = localStorage.getItem(PERM_KEY) || last; } catch (e) {}
    return new Promise(function (resolve) {
      execTitle.textContent = count > 1 ? "Execute " + count + " tickets" : "Execute ticket";
      // Only what this server will actually accept: `bypassPermissions` needs PEEPHOLE_ALLOW_BYPASS=1,
      // and offering a choice the API refuses is worse than not offering it.
      var allowed = (latestState && latestState.permissionModes) || ["plan", "acceptEdits"];
      var offered = PERM_MODES.filter(function (m) { return allowed.indexOf(m.key) !== -1; });
      if (allowed.indexOf(last) === -1) last = "acceptEdits";
      var LAUNCH_KEY = "peephole.launchMode";
      var lastLaunch = "terminal";
      try { lastLaunch = localStorage.getItem(LAUNCH_KEY) || lastLaunch; } catch (e) {}
      var launchHtml =
        '<div class="launch-row">' +
        [["terminal", "In a new terminal", "a fresh session you sit with and can interrupt"],
         ["existing", "In an existing session", "continue a conversation that already has context"],
         ["background", "In the background", "unattended; join later with claude attach"]].map(function (l) {
          return '<label class="perm-opt"><input type="radio" name="launch" value="' + l[0] + '"' +
            (l[0] === lastLaunch ? " checked" : "") + "><span><b>" + esc(l[1]) + "</b><small>" + esc(l[2]) + "</small></span></label>";
        }).join("") +
        '<div class="session-pick" id="sessionPick" hidden>' +
        '<select id="sessionSelect"><option value="">Loading sessions…</option></select>' +
        '<input id="sessionManual" placeholder="…or paste a session id" autocomplete="off" spellcheck="false">' +
        '<p class="perm-note" id="sessionNote"></p></div>' +
        "</div>";
      execModes.innerHTML = launchHtml + '<div class="perm-head">Permissions</div>' + offered.map(function (m) {
        return '<label class="perm-opt"><input type="radio" name="perm" value="' + m.key + '"' +
          (m.key === last ? " checked" : "") + '><span><b>' + esc(m.label) + "</b><small>" + esc(m.sub) + "</small></span></label>";
      }).join("") +
        (allowed.indexOf("bypassPermissions") === -1
          ? '<p class="perm-note">Unattended “bypass all” dispatch is disabled on this server. ' +
            "Restart it with <code>PEEPHOLE_ALLOW_BYPASS=1</code> to enable it.</p>"
          : "") +
        (risky.length
          ? '<div class="risk-warn"><b>⚠ ' + risky.length +
            (risky.length === 1 ? " ticket is marked irreversible" : " tickets are marked irreversible") + "</b>" +
            "<ul>" + risky.map(function (t) { return "<li>" + esc(t.intent || t.id) + "</li>"; }).join("") + "</ul>" +
            '<label class="risk-ack"><input type="checkbox" id="riskAck"> Run ' +
            (risky.length === 1 ? "it" : "them") + " anyway — this work cannot be undone by a revert</label></div>"
          : "");
      execBackdrop.hidden = false;

      // The session picker only matters for one of the three choices, and it needs a live list —
      // sessions come and go while the dialog is open.
      var pick = execModes.querySelector("#sessionPick");
      var select = execModes.querySelector("#sessionSelect");
      var manual = execModes.querySelector("#sessionManual");
      var noteEl = execModes.querySelector("#sessionNote");
      function syncPicker() {
        var chosen = execModes.querySelector('input[name="launch"]:checked');
        pick.hidden = !chosen || chosen.value !== "existing";
        if (!pick.hidden && select.dataset.loaded !== "1") loadSessions();
      }
      async function loadSessions() {
        select.dataset.loaded = "1";
        try {
          var data = await fetch(withProject("/api/sessions")).then(function (r) { return r.json(); });
          var list = data.sessions || [];
          if (!list.length) {
            select.innerHTML = '<option value="">No live sessions — paste an id below</option>';
            return;
          }
          select.innerHTML = '<option value="">Choose a session…</option>' + list.map(function (s) {
            var label = (s.name || s.sessionId.slice(0, 8)) + " · " + s.kind + " · " + s.status +
              (s.inThisRepo ? "" : " · " + s.cwd);
            return '<option value="' + esc(s.sessionId) + '" data-status="' + esc(s.status) + '">' + esc(label) + "</option>";
          }).join("");
        } catch (e) {
          select.innerHTML = '<option value="">Could not list sessions — paste an id below</option>';
        }
      }
      function noteForChoice() {
        var opt = select.options[select.selectedIndex];
        // The CLI's own behaviour, said out loud rather than discovered afterwards.
        noteEl.textContent = opt && opt.dataset && opt.dataset.status === "busy"
          ? "That session is mid-turn. Resuming a running session starts a copy under a new id — wait for it to go idle if you meant to continue this one."
          : "";
      }
      Array.prototype.forEach.call(execModes.querySelectorAll('input[name="launch"]'), function (r) {
        r.addEventListener("change", syncPicker);
      });
      select.addEventListener("change", noteForChoice);
      syncPicker();
      // Execute stays disabled until the acknowledgement is ticked; the checkbox is the consent,
      // not the button.
      var ack = execModes.querySelector("#riskAck");
      execGo.disabled = Boolean(risky.length);
      if (ack) ack.addEventListener("change", function () { execGo.disabled = !ack.checked; });

      function cleanup() {
        execBackdrop.hidden = true;
        execGo.removeEventListener("click", go);
        execCancel.removeEventListener("click", cancel);
        execBackdrop.removeEventListener("click", backdropClick);
      }
      function go() {
        var picked = execModes.querySelector('input[name="perm"]:checked');
        var mode = picked ? picked.value : "acceptEdits";
        var launchPick = execModes.querySelector('input[name="launch"]:checked');
        var launch = launchPick ? launchPick.value : "terminal";
        var sessionId = null;
        if (launch === "existing") {
          var typed = execModes.querySelector("#sessionManual");
          var chosen = execModes.querySelector("#sessionSelect");
          sessionId = (typed && typed.value.trim()) || (chosen && chosen.value) || "";
          if (!sessionId) {
            window.alert("Choose a session, or paste a session id.");
            return;
          }
        }
        try {
          localStorage.setItem(PERM_KEY, mode);
          localStorage.setItem(LAUNCH_KEY, launch);
        } catch (e) {}
        cleanup();
        execGo.disabled = false;
        resolve({ permissionMode: mode, launch: launch, sessionId: sessionId });
      }
      function cancel() { cleanup(); execGo.disabled = false; resolve(null); }
      function backdropClick(ev) { if (ev.target === execBackdrop) cancel(); }
      execGo.addEventListener("click", go);
      execCancel.addEventListener("click", cancel);
      execBackdrop.addEventListener("click", backdropClick);
    });
  }

  /** Every repo this install has served, most recently opened first. The list is built simply by
   *  running the board against a repo — there is no "add project" step to forget — so the menu is a
   *  history of what you actually work on. An entry whose checkout has since moved is shown but
   *  disabled rather than hidden, because a silently missing project looks like a bug. */
  async function renderProjectMenu() {
    // Fetched live rather than read from the board's state: the registry is global, while a state
    // payload is a snapshot of ONE project's last refresh — so a project added from this tab was
    // missing from the menu until the project it was added from happened to refresh again.
    var projects = [];
    try {
      var listed = await fetch("/api/projects").then(function (r) { return r.json(); });
      projects = (listed.projects || []).slice().sort(function (a, b) {
        return String(b.lastOpenedAt || "").localeCompare(String(a.lastOpenedAt || ""));
      });
    } catch (e) {
      projects = ((latestState && latestState.projects) || []).slice();
    }
    var addRow = '<button type="button" role="menuitem" class="pm-add" data-add="1">+ Add project…</button>';
    if (!projects.length) {
      projectMenu.innerHTML = '<p class="pm-note">No projects yet.</p>' + addRow;
      wireAddRow();
      return;
    }
    projectMenu.innerHTML = projects.map(function (p) {
      var active = p.repoRoot === (latestState && latestState.repoRoot);
      return (
        '<div class="pm-row' + (active ? " pm-active" : "") + '">' +
        '<button type="button" role="menuitem" data-root="' + esc(p.repoRoot) + '"' +
        (active ? ' aria-current="true"' : "") + (p.missing ? " disabled" : "") + ">" +
        esc(p.name) + (p.missing ? " <span class=\"pm-path\">checkout not found</span>" : "") +
        '<span class="pm-path">' + esc(p.repoRoot) + "</span></button>" +
        // Forgetting drops the menu entry only. The repo, its ledger and its tickets are untouched
        // — opening it again re-adds it — so this needs no confirmation beyond saying as much.
        '<button type="button" class="pm-forget" data-forget="' + esc(p.repoRoot) +
        '" title="Remove from this list (the repo and its tickets are untouched)" aria-label="Forget ' +
        esc(p.name) + '">✕</button></div>'
      );
    }).join("") + addRow;
    wireAddRow();
    Array.prototype.forEach.call(projectMenu.querySelectorAll("button[data-forget]"), function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.stopPropagation(); // forgetting must not also open the project
        var root = btn.dataset.forget;
        // The ✕ sits a few pixels from the row you click to OPEN a project, so a misclick is easy
        // and the result looks like a deleted project even though nothing but a menu row is gone.
        // Confirm says exactly what is and is not being removed.
        if (!window.confirm("Remove " + root + " from this project list?\n\nThe repository, its ledger branch and its tickets are not touched — opening it again re-adds it.")) return;
        var isActive = root === (latestState && latestState.repoRoot);
        await apiPost("/api/projects/forget", { repoRoot: root });
        if (isActive) {
          // The tab is looking at what it just forgot; fall back to the server's own project.
          currentProject = null;
          rememberProjectChoice(null);
          connectStream();
        }
        var fresh = await fetch(withProject("/api/state")).then(function (r) { return r.json(); });
        render(fresh);
        renderProjectMenu();
      });
    });
    Array.prototype.forEach.call(projectMenu.querySelectorAll("button[data-root]"), function (btn) {
      btn.addEventListener("click", function () {
        projectMenu.hidden = true;
        projectBtn.setAttribute("aria-expanded", "false");
        if (btn.getAttribute("aria-current") === "true") return;
        switchTo(btn.dataset.root, "/api/projects/switch");
      });
    });
  }

  function wireAddRow() {
    var add = projectMenu.querySelector("[data-add]");
    if (add) {
      add.addEventListener("click", function () {
        projectMenu.hidden = true;
        projectBtn.setAttribute("aria-expanded", "false");
        openAddProject();
      });
    }
  }

  /** Switching re-resolves a ledger, which can mean a fetch or a first clone — seconds, not
   *  milliseconds. Without a visible busy state the board just sat there showing the old project's
   *  cards, which reads as a broken menu rather than as work in progress. */
  var switching = false;
  async function switchTo(repoRoot, endpoint) {
    if (switching) return null;
    switching = true;
    projectBtn.classList.add("busy");
    projectName.textContent = "opening…";
    board.innerHTML = '<p class="empty-note">Opening project…</p>';
    var previous = currentProject;
    try {
      // Point this tab at the project first: the POST that registers/validates it is then made
      // against that project's own context, and so is everything the tab does afterwards.
      currentProject = repoRoot;
      var res = await apiPost(endpoint, { repoRoot: repoRoot });
      if (res && res.error) {
        currentProject = previous;
        window.alert(res.error);
        if (latestState) render(latestState); // put the board that is actually open back on screen
        return res;
      }
      rememberProjectChoice(repoRoot);
      render(res);
      connectStream();
      return res;
    } finally {
      switching = false;
      projectBtn.classList.remove("busy");
    }
  }

  function openAddProject() {
    addProjectError.hidden = true;
    addProjectPath.value = "";
    addProjectBackdrop.hidden = false;
    addProjectPath.focus();
  }
  function closeAddProject() { addProjectBackdrop.hidden = true; }
  addProjectCancel.addEventListener("click", closeAddProject);
  addProjectClose.addEventListener("click", closeAddProject);
  addProjectBackdrop.addEventListener("click", function (ev) {
    if (ev.target === addProjectBackdrop) closeAddProject();
  });
  addProjectPath.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") addProjectGo.click();
  });
  addProjectGo.addEventListener("click", async function () {
    var value = addProjectPath.value.trim();
    if (!value) return;
    addProjectGo.disabled = true;
    try {
      var res = await switchTo(value, "/api/projects/add");
      if (res && res.error) {
        // Shown in the dialog, not an alert: the path is right there to correct.
        addProjectError.hidden = false;
        addProjectError.textContent = res.error;
        return;
      }
      closeAddProject();
    } finally {
      addProjectGo.disabled = false;
    }
  });

  projectBtn.addEventListener("click", async function (ev) {
    ev.stopPropagation();
    var open = projectMenu.hidden;
    if (open) {
      projectMenu.innerHTML = '<p class="pm-note">Loading…</p>';
      projectMenu.hidden = false;
      projectBtn.setAttribute("aria-expanded", "true");
      await renderProjectMenu();
      return;
    }
    projectMenu.hidden = true;
    projectBtn.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", function (ev) {
    if (!projectMenu.hidden && !projectMenu.contains(ev.target) && !projectBtn.contains(ev.target)) {
      projectMenu.hidden = true;
      projectBtn.setAttribute("aria-expanded", "false");
    }
  });

  /** The queue's own strip: what is running, what is waiting, and why nothing started when every
   *  session in the repo is busy — a queue that holds silently looks identical to one that broke. */
  function renderQueueBar(q) {
    var running = q.running;
    var pending = q.pending || [];
    if (!running && !pending.length && !(q.chats || []).length && !q.lastError) {
      queueBar.hidden = true;
      return;
    }
    queueBar.hidden = false;
    var bits = [];
    if (running && running.needsInput) {
      // An agent that stopped to ask something is not progress and not failure; it needs a person.
      bits.push('<span class="q-wait-input">⏸ <b>' + esc(running.ticketId) + "</b> is waiting for input — " +
        '<code>claude attach ' + esc((running.sessionId || "").slice(0, 8)) + "</code></span>");
    } else if (running && running.launch === "terminal") {
      bits.push('<span class="q-run">▶ <b>' + esc(running.ticketId) + "</b> is open in a terminal" +
        '<span class="dim"> — waiting for it to reach shipped or closed</span>' +
        '<span class="dim mono"> ' + esc((running.sessionId || "").slice(0, 8)) + "</span></span>");
    } else if (running) {
      bits.push('<span class="q-run">▶ running <b>' + esc(running.ticketId) + "</b>" +
        (running.sessionId ? ' <span class="dim mono">' + esc(running.sessionId.slice(0, 6)) + "</span>" : "") + "</span>");
    }
    if (pending.length) {
      bits.push('<span class="q-wait">' + pending.length + " queued" +
        (running ? "" : " — waiting for a free session") + "</span>");
    }
    (q.chats || []).forEach(function (c) {
      bits.push('<span class="q-chat">💬 discussing <b>' + esc(c.ticketId) + "</b>" +
        (c.launch === "terminal"
          ? ' <span class="dim">in a terminal</span>'
          : ' — <code>claude attach ' + esc((c.sessionId || "").slice(0, 8)) + "</code>") + "</span>");
    });
    if (q.lastError) bits.push('<span class="q-err">' + esc(q.lastError) + "</span>");
    var auto = q.autoContinue !== false;
    queueBar.innerHTML = bits.join('<span class="q-sep">·</span>') +
      '<span class="q-actions">' +
      (pending.length || running
        ? '<button class="ghost q-auto" id="queueAuto" type="button" aria-pressed="' + auto + '">' +
          (auto ? "Continuing automatically" : "Holding after each ticket") + "</button>"
        : "") +
      (running ? '<button class="ghost q-stop" id="queueStop" type="button">Stop</button>' : "") +
      "</span>";
    var stopBtn = document.getElementById("queueStop");
    if (stopBtn) stopBtn.addEventListener("click", function () { apiPost("/api/execute/stop", {}); });
    var autoBtn = document.getElementById("queueAuto");
    if (autoBtn) {
      autoBtn.addEventListener("click", function () {
        apiPost("/api/execute/continue", { autoContinue: !auto });
      });
    }
  }

  /** The menu is rebuilt from the current ticket set each time it opens, so it never offers a
   *  person who has nothing on this board — and never hides a selection that is still active. */
  function renderFilterMenu() {
    var selected = getMemberFilter();
    // Candidates come from the tickets themselves first (an owner or assignee who has never
    // committed to this repo still belongs in the list), then anyone else already known.
    var pool = [];
    (latestTickets || []).forEach(function (t) {
      var owner = ownerNameOf(t);
      if (owner) pool.push(owner);
      if (t.assignee) pool.push(t.assignee);
    });
    knownPeople(null).forEach(function (n) { pool.push(n); });
    selected.forEach(function (n) { if (n !== UNASSIGNED) pool.push(n); });
    var people = pool
      .filter(function (n, i) { return n && pool.indexOf(n) === i; })
      .filter(function (name) {
        return selected.indexOf(name) !== -1 || (latestTickets || []).some(function (t) {
          return ownerNameOf(t) === name || t.assignee === name;
        });
      })
      .sort();
    var opts = people.map(function (name) {
      return { value: name, label: name };
    });
    opts.push({ value: UNASSIGNED, label: "Unassigned" });
    var selMode = getSelectionFilter();
    var epicSel = getEpicFilter();
    var tagSel = getTagFilter();
    // "No epic" is only worth offering once a real epic exists — on a board where nothing is filed,
    // every card is "no epic" and the choice narrows nothing.
    var realEpics = knownEpics();
    var epicOpts = realEpics.length
      ? realEpics.map(function (e) { return { value: e, label: e }; }).concat([{ value: NO_EPIC_FILTER, label: "No epic" }])
      : [];
    var tagOpts = knownTags();
    filterMenu.innerHTML =
      '<div class="filter-head">Selected for execution</div>' +
      [["all", "Show all"], ["selected", "Selected only"], ["unselected", "Not selected only"]].map(function (o) {
        return '<label><input type="radio" name="selfilter" value="' + o[0] + '"' +
          (selMode === o[0] ? " checked" : "") + "> " + o[1] + "</label>";
      }).join("") +
      '<div class="filter-head">Member</div>' +
      opts.map(function (o) {
        return '<label><input type="checkbox" data-filter="member" value="' + esc(o.value) + '"' +
          (selected.indexOf(o.value) !== -1 ? " checked" : "") + "> " + esc(o.label) + "</label>";
      }).join("") +
      (epicOpts.length
        ? '<div class="filter-head">Epic</div>' +
          epicOpts.map(function (o) {
            return '<label><input type="checkbox" data-filter="epic" value="' + esc(o.value) + '"' +
              (epicSel.indexOf(o.value) !== -1 ? " checked" : "") + "> " + esc(o.label) + "</label>";
          }).join("")
        : "") +
      (tagOpts.length
        ? '<div class="filter-head">Tag</div>' +
          tagOpts.map(function (tg) {
            return '<label><input type="checkbox" data-filter="tag" value="' + esc(tg) + '"' +
              (tagSel.indexOf(tg) !== -1 ? " checked" : "") + "> " + esc(tg) + "</label>";
          }).join("")
        : "") +
      (selected.length || selMode !== "all" || epicSel.length || tagSel.length
        ? '<div class="filter-foot"><button class="clear-filter" type="button">Clear filter</button></div>'
        : "");

    Array.prototype.forEach.call(filterMenu.querySelectorAll('input[name="selfilter"]'), function (radio) {
      radio.addEventListener("change", function () {
        try { localStorage.setItem(SELECTION_FILTER_KEY, radio.value); } catch (e) {}
        renderFilterState();
        renderBoard(latestTickets);
        renderFilterMenu();
      });
    });

    function applyFilterChange() {
      renderFilterState();
      renderBoard(latestTickets);
      renderFilterMenu();
    }
    // Each group edits its own stored list; the data-filter attribute keeps the member, epic and tag
    // checkboxes from being read into one another's state (they were all plain input[type=checkbox]).
    function bindFilterBoxes(selector, get, set) {
      Array.prototype.forEach.call(filterMenu.querySelectorAll(selector), function (box) {
        box.addEventListener("change", function () {
          var next = get().filter(function (v) { return v !== box.value; });
          if (box.checked) next.push(box.value);
          set(next);
          applyFilterChange();
        });
      });
    }
    bindFilterBoxes('input[data-filter="member"]', getMemberFilter, setMemberFilter);
    bindFilterBoxes('input[data-filter="epic"]', getEpicFilter, setEpicFilter);
    bindFilterBoxes('input[data-filter="tag"]', getTagFilter, setTagFilter);
    var clear = filterMenu.querySelector(".clear-filter");
    if (clear) {
      clear.addEventListener("click", function () {
        setMemberFilter([]);
        setTagFilter([]);
        setEpicFilter([]);
        try { localStorage.setItem(SELECTION_FILTER_KEY, "all"); } catch (e) {}
        applyFilterChange();
      });
    }
  }

  /** How many people are selected, on the button itself — an active filter that only shows up
   *  inside a closed menu is how a board ends up silently missing half its tickets. */
  function renderFilterState() {
    var n = getMemberFilter().length + getTagFilter().length + getEpicFilter().length +
      (getSelectionFilter() === "all" ? 0 : 1);
    filterCount.hidden = n === 0;
    filterCount.textContent = String(n);
    filterBtn.setAttribute("aria-pressed", String(n > 0));
  }

  filterBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var open = filterMenu.hidden;
    if (open) renderFilterMenu();
    filterMenu.hidden = !open;
    filterBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", function (ev) {
    if (!filterMenu.hidden && !filterMenu.contains(ev.target) && ev.target !== filterBtn) {
      filterMenu.hidden = true;
      filterBtn.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !addProjectBackdrop.hidden) closeAddProject();
    if (ev.key === "Escape" && !filterMenu.hidden) {
      filterMenu.hidden = true;
      filterBtn.setAttribute("aria-expanded", "false");
    }
  });

  /** Selected tickets in the order the board reads them — lane order, then the lane's own sort —
   *  so "execute all selected" runs them in the order you see, not the order you clicked. */
  function selectedInBoardOrder() {
    var dir = getLaneSortDir();
    var visible = forThisProject(latestTickets || []);
    var ids = [];
    LANES.forEach(function (lane) {
      sortByModified(visible.filter(function (t) {
        return lane.states.indexOf(t.state) !== -1 && t.selected && t.state === "proposed";
      }), dir).forEach(function (t) { ids.push(t.id); });
    });
    return ids;
  }

  function renderExecSelected() {
    var n = selectedInBoardOrder().length;
    execSelectedBtn.disabled = n === 0;
    execSelectedBtn.textContent = n ? "Execute " + n + " selected" : "Execute selected";
  }

  /** One worker per project is the shape this is for: start it once, sit in it, and let every later
   *  dispatch continue that conversation rather than opening a fresh context each time. */
  /** The menu answers "what is this about" on sight: every background session, what it is doing,
   *  and the two things you can do to it. The button used to be start-only, so a label reporting
   *  three sessions could only offer to make a fourth. */
  function renderWorkerMenu() {
    var workers = (latestState && latestState.queue && latestState.queue.workers) || [];
    var rows = workers.map(function (w) {
      var status = w.status || "idle";
      return (
        '<div class="worker-row" data-session="' + esc(w.sessionId) + '">' +
        '<span class="wname">' + esc(w.name || w.sessionId.slice(0, 8)) +
        "<small>" + esc(w.sessionId.slice(0, 8)) + "</small></span>" +
        '<span class="wstatus ' + esc(status) + '">' + esc(status) + "</span>" +
        '<button type="button" class="wattach" data-attach="' + esc(w.sessionId) + '">Attach</button>' +
        '<button type="button" class="wstop" data-stop="' + esc(w.sessionId) + '">Stop</button>' +
        "</div>"
      );
    }).join("");

    workerMenu.innerHTML =
      (workers.length
        ? rows + '<p class="pm-note">Dispatches reuse an idle worker. "waiting" means it asked something and nobody has answered.</p>'
        : '<p class="pm-note">No background sessions for this repo.</p>') +
      '<div class="wfoot"><button type="button" id="workerStart">+ Start a worker</button></div>';

    Array.prototype.forEach.call(workerMenu.querySelectorAll("[data-attach]"), function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        var res = await apiPost("/api/worker/" + encodeURIComponent(btn.dataset.attach) + "/attach", {});
        if (res && res.opened) { closeWorkerMenu(); return; }
        var cmd = (res && res.command) || "";
        if (cmd && navigator.clipboard) { try { await navigator.clipboard.writeText(cmd); } catch (e) {} }
        window.alert((res && res.reason ? res.reason : "Could not open a terminal here.") +
          (cmd ? "\n\nCopied to your clipboard:\n\n  " + cmd : ""));
      });
    });

    Array.prototype.forEach.call(workerMenu.querySelectorAll("[data-stop]"), function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        var id = btn.dataset.stop;
        // Worth saying what stop does NOT do: the conversation survives and can be reopened.
        if (!window.confirm("Stop session " + id.slice(0, 8) + "?\n\nIt ends the current turn. The conversation is kept — " +
          "`claude attach " + id.slice(0, 8) + "` reopens it.")) return;
        btn.disabled = true;
        btn.textContent = "Stopping…";
        var res = await apiPost("/api/worker/" + encodeURIComponent(id) + "/stop", {});
        if (res && res.error) window.alert(res.error);
        if (res && res.state) render(res.state);
        renderWorkerMenu();
      });
    });

    var start = workerMenu.querySelector("#workerStart");
    if (start) {
      start.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        start.disabled = true;
        start.textContent = "Starting…";
        try {
          var res = await apiPost("/api/worker", { attach: true });
          if (res && res.error) { window.alert(res.error); return; }
          if (res && !res.started) { window.alert("Could not start a worker: " + (res.reason || "unknown")); return; }
          if (!res.attached && res.command) {
            if (navigator.clipboard) { try { await navigator.clipboard.writeText(res.command); } catch (e) {} }
            window.alert("Worker " + res.sessionId.slice(0, 8) + " started.\n\nNo terminal opened here — join it with " +
              "(copied to your clipboard):\n\n  " + res.command);
          }
          if (res && res.state) render(res.state);
        } finally {
          closeWorkerMenu();
        }
      });
    }
  }

  function closeWorkerMenu() {
    workerMenu.hidden = true;
    workerBtn.setAttribute("aria-expanded", "false");
  }

  workerBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (!workerMenu.hidden) return closeWorkerMenu();
    renderWorkerMenu();
    workerMenu.hidden = false;
    workerBtn.setAttribute("aria-expanded", "true");
  });
  document.addEventListener("click", function (ev) {
    if (!workerMenu.hidden && !workerMenu.contains(ev.target) && !workerBtn.contains(ev.target)) closeWorkerMenu();
  });

  function renderWorkerButton() {
    var workers = (latestState && latestState.queue && latestState.queue.workers) || [];
    if (!workers.length) {
      workerBtn.textContent = "Start a worker";
      workerBtn.removeAttribute("aria-pressed");
      workerBtn.title = "Start a background session for this repo that later dispatches reuse";
      return;
    }
    // Lead with a worker a dispatch could actually use. The old label took workers[0], which was
    // often one parked on an unanswered question — the least representative session there is.
    var idle = workers.filter(function (w) { return w.status === "idle"; });
    var waiting = workers.filter(function (w) { return w.status === "waiting"; });
    workerBtn.textContent = idle.length
      ? (workers.length === 1 ? "Worker ready" : idle.length + " of " + workers.length + " workers ready")
      : workers.length + " worker" + (workers.length === 1 ? "" : "s") + (waiting.length ? ", none free" : " busy");
    workerBtn.setAttribute("aria-pressed", String(idle.length > 0));
    workerBtn.title = workers.map(function (w) { return w.sessionId.slice(0, 8) + " · " + w.status; }).join("\n") +
      (waiting.length ? "\n\n" + waiting.length + " waiting on an unanswered question" : "");
  }

  execSelectedBtn.addEventListener("click", async function () {
    var ids = selectedInBoardOrder();
    if (!ids.length) return;
    var choice = await askPermissionMode(ids);
    if (!choice) return;
    execSelectedBtn.disabled = true;
    try {
      await apiPost("/api/execute", {
        ticketIds: ids, permissionMode: choice.permissionMode, launch: choice.launch, sessionId: choice.sessionId,
      });
    } finally {
      renderExecSelected();
    }
  });

  groupToggle.addEventListener("click", function () {
    var next = !getGroupByEpic();
    try { localStorage.setItem(EPIC_GROUP_KEY, next ? "1" : "0"); } catch (e) {}
    groupToggle.setAttribute("aria-pressed", String(next));
    renderBoard(latestTickets);
  });

  autoFetchToggle.addEventListener("click", async function () {
    var enabled = autoFetchToggle.getAttribute("aria-pressed") !== "true";
    await apiPost("/api/autosync", { enabled: enabled, intervalMinutes: Number(intervalInput.value) || 5, push: true });
  });

  intervalInput.addEventListener("change", async function () {
    if (autoFetchToggle.getAttribute("aria-pressed") === "true") {
      await apiPost("/api/autofetch", { enabled: true, intervalMinutes: Number(intervalInput.value) || 5 });
    }
  });

  fixBtn.addEventListener("click", async function () {
    fixBtn.disabled = true;
    try {
      await apiPost("/api/scaffold");
    } finally {
      fixBtn.disabled = false;
    }
  });

  pushBtn.addEventListener("click", async function () {
    if (!confirm("Push local .peephole commits to the remote now? This is visible to everyone on the repo.")) return;
    pushBtn.disabled = true;
    try {
      await apiPost("/api/push");
    } finally {
      pushBtn.disabled = false;
    }
  });

  // Tabs replace what used to be independently-collapsible sections stacked on one page —
  // one panel visible at a time instead, persisted so a reload/live-update doesn't reset
  // whichever one the user was looking at.
  var ACTIVE_TAB_KEY = "peephole.activeTab";
  var standardsLoaded = false;

  function setActiveTab(name) {
    tabButtons.forEach(function (btn) {
      var active = btn.dataset.tab === name;
      btn.setAttribute("aria-selected", String(active));
      var panel = document.getElementById("panel-" + btn.dataset.tab);
      if (panel) panel.hidden = !active;
    });
    try { localStorage.setItem(ACTIVE_TAB_KEY, name); } catch (e) {}
    if (name === "standards" && !standardsLoaded) loadStandards();
  }
  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () { setActiveTab(btn.dataset.tab); });
  });
  var storedTab = "tasks";
  try { storedTab = localStorage.getItem(ACTIVE_TAB_KEY) || "tasks"; } catch (e) {}
  if (!tabButtons.some(function (b) { return b.dataset.tab === storedTab; })) storedTab = "tasks";
  setActiveTab(storedTab);

  /** Whichever standards documents this checkout has — including the agent-rules files, which are
   *  policy applied before code is written rather than after. One tab, a picker when there is more
   *  than one, and an explanation of what was looked for when there are none. */
  async function loadStandards(file) {
    standardsLoaded = true;
    try {
      var url = "/api/standards" + (file ? "?file=" + encodeURIComponent(file) : "");
      var data = await fetch(withProject(url)).then(function (r) { return r.json(); });
      if (!data.content) {
        standardsContent.innerHTML =
          '<p class="empty-note">No standards document in this checkout. Peephole looks for:</p>' +
          '<ul class="looked-for">' + (data.lookedFor || []).map(function (n) {
            return "<li><code>" + esc(n) + "</code></li>";
          }).join("") + "</ul>" +
          '<p class="empty-note">Add one, or name your own in <code>.peephole/config.yaml</code> as ' +
          "<code>standardsFiles</code>.</p>";
        return;
      }
      var picker = (data.files || []).length > 1
        ? '<div class="std-picker">' + data.files.map(function (f) {
            return '<button type="button" class="std-tab' + (f.name === data.file ? " on" : "") +
              '" data-file="' + esc(f.name) + '">' + esc(f.name) + "</button>";
          }).join("") + "</div>"
        : '<p class="std-single mono">' + esc(data.file) + "</p>";
      standardsContent.innerHTML = picker +
        (data.truncated ? '<p class="empty-note">Showing the first 1MB.</p>' : "") +
        renderMarkdown(data.content);
      Array.prototype.forEach.call(standardsContent.querySelectorAll(".std-tab"), function (btn) {
        btn.addEventListener("click", function () { loadStandards(btn.dataset.file); });
      });
    } catch (e) {
      standardsLoaded = false;
      standardsContent.innerHTML = '<p class="empty-note">Could not load the standards doc.</p>';
    }
  }

  /** The live stream is per project too: each project broadcasts to its own subscribers, so a tab
   *  watching repo A never receives repo B's refreshes. Reconnected when the tab changes project. */
  var es = null;
  function connectStream() {
    if (es) es.close();
    es = new EventSource(withProject("/api/events"));
    es.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === "state") render(msg.payload);
      } catch (e) {}
    };
  }

  function loadProject() {
    fetch(withProject("/api/state"))
      .then(function (r) { return r.json(); })
      .then(function (state) {
        if (state && state.error) {
          // A remembered project that has since moved must not leave the tab stuck on an error —
          // forget the selection and fall back to whatever the server was started on.
          currentProject = null;
          rememberProjectChoice(null);
          return loadProject();
        }
        render(state);
        connectStream();
      })
      .catch(function () {});
  }

  loadProject();
})();
