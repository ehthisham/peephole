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
    { key: "in-progress", label: "In progress", states: ["in-progress", "built", "verified"] },
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
  var STRUCTURAL_ISSUES = new Set([
    "missing-config", "missing-tickets-dir", "missing-agents-dir",
    "missing-agent-note", "missing-readme-note", "missing-hook-setup",
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
  var remoteLink = document.getElementById("remoteLink");
  var branchName = document.getElementById("branchName");
  var statRow = document.getElementById("statRow");
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
    var rows = [
      ["Project", esc(cfg.project || state.project || "—")],
      ["Remote", state.remoteUrl ? '<span class="mono">' + esc(state.remoteUrl) + "</span>" : "—"],
      ["State branch", state.stateBranch ? '<span class="mono">' + esc(state.stateBranch) + "</span>" : "—"],
      ["Git identity", gitUser.name || gitUser.email ? esc(gitUser.name || "") + (gitUser.email ? " <" + esc(gitUser.email) + ">" : "") : "—"],
      ["Hook", state.hookConfigured ? "connected — live" : "not configured"],
      ["Autosync", state.autoFetch && state.autoFetch.enabled
        ? "every " + esc(state.autoFetch.intervalMinutes) + " min" + (state.autoFetch.push ? ", fetch + push" : ", fetch only")
        : "off"],
      ["State branch", esc(state.stateBranch || "—") + ' <span class="dim">(' + esc(state.stateBranchSource || "?") + ")</span>"],
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

  function toHttpUrl(remote) {
    if (!remote) return "#";
    var m = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
    if (m) return "https://" + m[1] + "/" + m[2];
    return remote.replace(/\.git$/, "");
  }

  async function apiPost(path, body) {
    var res = await fetch(path, {
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
    var blocked = t.blockedOn ? '<span class="badge blocked">⛓ ' + esc(t.blockedOn) + "</span>" : "";
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
    var ctlGroup = selectBtn || executeBtn || controls
      ? '<div class="controls">' + selectBtn + executeBtn + controls + "</div>"
      : "";
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
    var execBtn = card.querySelector(".ctl.execute:not([disabled])");
    if (execBtn) {
      execBtn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        var mode = await askPermissionMode([execBtn.dataset.execute]);
        if (!mode) return;
        execBtn.disabled = true;
        try {
          await apiPost("/api/tickets/" + encodeURIComponent(execBtn.dataset.execute) + "/execute", { permissionMode: mode });
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
      "<h3>Activity</h3>" + historyHtml;
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

  // Mirrored from the server's queue so a card can show "queued"/"running" without asking.
  var queuedIds = [];
  var runningId = null;

  var latestTickets = [];
  function renderBoard(tickets) {
    latestTickets = tickets;
    var dir = getLaneSortDir();
    var grouped = getGroupByEpic();
    var selected = getMemberFilter();
    var selMode = getSelectionFilter();
    var visible = forThisProject(tickets).filter(function (t) {
      return matchesMembers(t, selected) && matchesSelection(t, selMode);
    });
    board.innerHTML = "";
    LANES.forEach(function (s) {
      var inLane = sortByModified(visible.filter(function (t) { return s.states.indexOf(t.state) !== -1; }), dir);
      var lane = document.createElement("section");
      lane.className = "lane";
      lane.innerHTML =
        "<header><h2>" + s.label + '</h2><span class="count mono">' + inLane.length + '</span>' +
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
      return (
        '<div class="agent">' +
        '<span class="who">' + esc(a.sessionId || "?") + '</span>' +
        '<span class="status ' + status + '">' + status + "</span>" +
        (a.activeTicket ? '<div class="ticket mono">#' + esc(a.activeTicket) + "</div>" : "") +
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
  function renderMembers(list) {
    if (!list || list.length === 0) {
      memberList.innerHTML = '<p class="empty-note">No commits yet.</p>';
      return;
    }
    var rows = list.slice().sort(function (a, b) {
      return (b.tokens || 0) - (a.tokens || 0) || b.commits - a.commits;
    });
    memberList.innerHTML =
      "<table class=\"matrix\"><thead><tr>" +
      "<th>Member</th><th>Commits</th><th>Tokens</th>" +
      "</tr></thead><tbody>" +
      rows.map(function (m) {
        return (
          "<tr><td>" + esc(m.name) + "</td>" +
          '<td class="mono">' + fmtNum(m.commits) + "</td>" +
          '<td class="mono">' + (m.tokens ? fmtNum(m.tokens) : "—") + "</td></tr>"
        );
      }).join("") +
      "</tbody></table>";
  }

  var latestState = null;

  function render(state) {
    latestState = state;
    var q = state.queue || { pending: [], running: null };
    queuedIds = (q.pending || []).map(function (p) { return p.ticketId; });
    runningId = q.running ? q.running.ticketId : null;
    renderQueueBar(q);
    authorBySession = {};
    (state.agents || []).forEach(function (a) {
      if (a.sessionId && a.author && a.author.name) authorBySession[a.sessionId] = a.author.name;
    });
    projectName.textContent = state.project || "—";
    remoteLink.textContent = state.remoteUrl || "";
    remoteLink.href = toHttpUrl(state.remoteUrl);
    // Where the ledger lives, and on whose authority. A board reading a branch nobody declared is
    // one `git remote show` away from reading a different one — worth saying out loud.
    branchName.textContent = state.stateBranch ? "branch: " + state.stateBranch : "";
    branchName.title = state.stateBranchSource
      ? "ticket ledger branch — resolved from " + state.stateBranchSource
      : "";
    branchName.className = "branch mono" + (state.stateBranchSource === "remote default" ? " branch-unpinned" : "");
    lastUpdated.textContent = "Updated " + relTime(state.lastFetchedAt);

    if (state.hookConfigured) {
      hookState.innerHTML = "Hook: <b>connected — live</b>";
    } else if (state.autoFetch && state.autoFetch.enabled) {
      hookState.innerHTML = "Hook: not configured — autosync every <b>" + state.autoFetch.intervalMinutes + " min</b>";
    } else {
      hookState.textContent = "Hook: not configured — click Pull to refresh";
    }
    autoFetchToggle.setAttribute("aria-pressed", String(Boolean(state.autoFetch && state.autoFetch.enabled)));
    if (state.autoFetch) intervalInput.value = state.autoFetch.intervalMinutes;

    groupToggle.setAttribute("aria-pressed", String(getGroupByEpic()));
    // latestTickets is what the selected-count and the filter menu read; renderBoard sets it too,
    // but it runs later in this function — without this the toolbar was always one refresh behind.
    latestTickets = state.tickets || [];
    renderFilterState();
    renderExecSelected();
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
      pushText.textContent = state.unpushed + " unpushed commit" + (state.unpushed === 1 ? "" : "s") + " on " + state.stateBranch;
    } else {
      pushBanner.hidden = true;
    }

    renderInsights(state.stats, state.coverage, state.agents);
    renderStateChart(state.tickets || []);
    renderBoard(state.tickets || []);
    renderAgents(state.agents || []);
    renderTokenUsage(state.agents || []);
    renderMembers((state.stats && state.stats.contributorList) || []);
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
      execModes.innerHTML = offered.map(function (m) {
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
        var picked = execModes.querySelector("input:checked");
        var mode = picked ? picked.value : "acceptEdits";
        try { localStorage.setItem(PERM_KEY, mode); } catch (e) {}
        cleanup();
        execGo.disabled = false;
        resolve(mode);
      }
      function cancel() { cleanup(); execGo.disabled = false; resolve(null); }
      function backdropClick(ev) { if (ev.target === execBackdrop) cancel(); }
      execGo.addEventListener("click", go);
      execCancel.addEventListener("click", cancel);
      execBackdrop.addEventListener("click", backdropClick);
    });
  }

  /** The queue's own strip: what is running, what is waiting, and why nothing started when every
   *  session in the repo is busy — a queue that holds silently looks identical to one that broke. */
  function renderQueueBar(q) {
    var running = q.running;
    var pending = q.pending || [];
    if (!running && !pending.length && !q.lastError) {
      queueBar.hidden = true;
      return;
    }
    queueBar.hidden = false;
    var bits = [];
    if (running) {
      bits.push('<span class="q-run">▶ running <b>' + esc(running.ticketId) + "</b>" +
        (running.sessionId ? ' <span class="dim mono">' + esc(running.sessionId.slice(0, 6)) + "</span>" : "") + "</span>");
    }
    if (pending.length) {
      bits.push('<span class="q-wait">' + pending.length + " queued" +
        (running ? "" : " — waiting for a free session") + "</span>");
    }
    if (q.lastError) bits.push('<span class="q-err">' + esc(q.lastError) + "</span>");
    queueBar.innerHTML = bits.join('<span class="q-sep">·</span>') +
      (running ? '<button class="ghost q-stop" id="queueStop" type="button">Stop</button>' : "");
    var stopBtn = document.getElementById("queueStop");
    if (stopBtn) stopBtn.addEventListener("click", function () { apiPost("/api/execute/stop", {}); });
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
    filterMenu.innerHTML =
      '<div class="filter-head">Selected for execution</div>' +
      [["all", "Show all"], ["selected", "Selected only"], ["unselected", "Not selected only"]].map(function (o) {
        return '<label><input type="radio" name="selfilter" value="' + o[0] + '"' +
          (selMode === o[0] ? " checked" : "") + "> " + o[1] + "</label>";
      }).join("") +
      '<div class="filter-head">Member</div>' +
      opts.map(function (o) {
        return '<label><input type="checkbox" value="' + esc(o.value) + '"' +
          (selected.indexOf(o.value) !== -1 ? " checked" : "") + "> " + esc(o.label) + "</label>";
      }).join("") +
      (selected.length || selMode !== "all"
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

    Array.prototype.forEach.call(filterMenu.querySelectorAll('input[type="checkbox"]'), function (box) {
      box.addEventListener("change", function () {
        var next = getMemberFilter().filter(function (v) { return v !== box.value; });
        if (box.checked) next.push(box.value);
        setMemberFilter(next);
        renderFilterState();
        renderBoard(latestTickets);
        renderFilterMenu();
      });
    });
    var clear = filterMenu.querySelector(".clear-filter");
    if (clear) {
      clear.addEventListener("click", function () {
        setMemberFilter([]);
        try { localStorage.setItem(SELECTION_FILTER_KEY, "all"); } catch (e) {}
        renderFilterState();
        renderBoard(latestTickets);
        renderFilterMenu();
      });
    }
  }

  /** How many people are selected, on the button itself — an active filter that only shows up
   *  inside a closed menu is how a board ends up silently missing half its tickets. */
  function renderFilterState() {
    var n = getMemberFilter().length + (getSelectionFilter() === "all" ? 0 : 1);
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

  execSelectedBtn.addEventListener("click", async function () {
    var ids = selectedInBoardOrder();
    if (!ids.length) return;
    var mode = await askPermissionMode(ids);
    if (!mode) return;
    execSelectedBtn.disabled = true;
    try {
      await apiPost("/api/execute", { ticketIds: ids, permissionMode: mode });
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

  /** The project's own ENGINEERING-STANDARDS-GO.md, read at the same git ref repoStats scans —
   *  fetched once per page load (it doesn't change as often as tickets/agents do), rendered
   *  with the same small markdown renderer ticket bodies use. */
  async function loadStandards() {
    standardsLoaded = true;
    try {
      var res = await fetch("/api/standards");
      var data = await res.json();
      standardsContent.innerHTML = data.content
        ? renderMarkdown(data.content)
        : '<p class="empty-note">No ENGINEERING-STANDARDS-GO.md found in this repo.</p>';
    } catch (e) {
      standardsLoaded = false;
      standardsContent.innerHTML = '<p class="empty-note">Could not load standards doc.</p>';
    }
  }

  fetch("/api/state").then(function (r) { return r.json(); }).then(render).catch(function () {});

  var es = new EventSource("/api/events");
  es.onmessage = function (ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (msg.type === "state") render(msg.payload);
    } catch (e) {}
  };
})();
