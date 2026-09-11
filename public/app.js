(function () {
  var STATES = [
    { key: "proposed", label: "Proposed" },
    { key: "in-progress", label: "In progress" },
    { key: "built", label: "Built" },
    { key: "verified", label: "Verified" },
    { key: "shipped", label: "Shipped" },
    { key: "closed", label: "Closed" },
  ];
  var CONTROLS = ["run", "pause", "skip", "restart"];
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
  var insightsToggle = document.getElementById("insightsToggle");
  var insightsBody = document.getElementById("insightsBody");
  var agentsToggle = document.getElementById("agentsToggle");
  var agentsBody = document.getElementById("agentsBody");
  var ticketModalBackdrop = document.getElementById("ticketModalBackdrop");
  var ticketModalTitle = document.getElementById("ticketModalTitle");
  var ticketModalClose = document.getElementById("ticketModalClose");
  var ticketModalBody = document.getElementById("ticketModalBody");
  var newTicketBtn = document.getElementById("newTicketBtn");
  var newTicketBackdrop = document.getElementById("newTicketBackdrop");
  var newTicketClose = document.getElementById("newTicketClose");
  var newTicketForm = document.getElementById("newTicketForm");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Inline markdown within one already-escaped line: **bold**, `code`, [text](url). Order matters —
  // code spans are pulled out first so bold/link markers inside them are never touched.
  function mdInline(escapedLine) {
    var codeSpans = [];
    var withoutCode = escapedLine.replace(/`([^`]+)`/g, function (_, code) {
      codeSpans.push(code);
      return " " + (codeSpans.length - 1) + " ";
    });
    var withLinks = withoutCode.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, text, url) {
      // Only allow schemes that can't execute script (a ticket body's URL isn't necessarily
      // ours — anything writing .peephole/tickets/*.md controls what lands here).
      var safe = /^(https?:\/\/|mailto:|\/|#)/i.test(url) ? url : "#";
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
    });
    var withBold = withLinks.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return withBold.replace(/ (\d+) /g, function (_, i) {
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

  function renderInsights(stats, coverage, agents) {
    if (!stats) {
      statRow.innerHTML = '<p class="empty-note">Insights unavailable.</p>';
      langs.innerHTML = "";
      return;
    }
    var tiles = [
      { value: fmtNum(stats.linesOfCodeApprox), label: "Lines of code", sub: "approx." },
      { value: fmtNum(stats.totalFiles), label: "Tracked files" },
      { value: fmtNum(stats.commits), label: "Commits" },
      { value: fmtNum(stats.contributors), label: "Contributors" },
      {
        value: stats.lastCommit ? relTime(stats.lastCommit.date) : "—",
        label: "Last commit",
        sub: stats.lastCommit ? esc(stats.lastCommit.author) : "",
      },
    ];
    // Grand total across every session, not just ones that matched a git-identity'd member —
    // the same source renderTokenUsage sums per-session, so the two numbers can never disagree.
    var totalTokens = (agents || []).reduce(function (sum, a) {
      return sum + ((a.tokens && a.tokens.totalTokens) || 0);
    }, 0);
    if (totalTokens > 0) {
      tiles.push({ value: fmtNum(totalTokens), label: "Total tokens", sub: "all sessions" });
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

  function coverageColor(pct) {
    if (pct < 40) return "var(--accent)";
    if (pct < 70) return "var(--proposed)";
    return "var(--built)";
  }

  // Per-package breakdown ("how we developed tests" — module by module, worst-covered first),
  // not just one aggregate percentage. Absent entirely when no coverage.out/-summary.json was
  // found (no test run yet), same "omit, don't show a misleading 0%" rule as the tile above.
  function renderCoverageModules(coverage) {
    if (!coverage || !Array.isArray(coverage.modules) || coverage.modules.length === 0) {
      coverageModulesEl.innerHTML = "";
      return;
    }
    coverageModulesEl.innerHTML =
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

  function cardEl(t) {
    var card = document.createElement("article");
    card.className = "card";
    var risk = t.risk === "irreversible" ? '<span class="badge risk">⚠ irreversible</span>' : "";
    var blocked = t.blockedOn ? '<span class="badge blocked">⛓ ' + esc(t.blockedOn) + "</span>" : "";
    var owner = t.owner ? '<span class="badge owner">' + esc(t.owner) + "</span>" : "";
    var tags = Array.isArray(t.tags) && t.tags.length
      ? t.tags.map(function (tg) { return '<span class="badge tag">' + esc(tg) + "</span>"; }).join("")
      : "";
    var isTerminal = TERMINAL_STATES.has(t.state);
    var controls = isTerminal ? "" : CONTROLS.map(function (c) {
      return (
        '<button class="ctl ' + c + '" data-ctl="' + c + '" data-id="' + esc(t.id) + '" aria-pressed="' +
        (t.control === c) + '" type="button">' + c + "</button>"
      );
    }).join("");
    var next = nextStateOf(t.state);
    var advance = next
      ? '<button class="advance-btn" data-id="' + esc(t.id) + '" data-state="' + next.key + '" type="button">' +
        esc(next.label) + " →</button>"
      : "";
    card.innerHTML =
      '<div class="card-top"><span class="project-tag">' + esc(t.project || "—") + "</span>" + tags + risk + owner + "</div>" +
      '<p class="intent">' + esc(t.intent) + "</p>" +
      (blocked ? "<div>" + blocked + "</div>" : "") +
      '<div class="card-foot"><span class="id mono">#' + esc(t.id) + "</span>" + advance + "</div>" +
      (isTerminal ? "" : '<div class="controls">' + controls + "</div>");
    Array.prototype.forEach.call(card.querySelectorAll(".ctl"), function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.stopPropagation(); // a control click must not also open the detail modal
        Array.prototype.forEach.call(card.querySelectorAll(".ctl"), function (b) { b.disabled = true; });
        try {
          await apiPost("/api/tickets/" + encodeURIComponent(btn.dataset.id) + "/control", { control: btn.dataset.ctl });
        } finally {
          Array.prototype.forEach.call(card.querySelectorAll(".ctl"), function (b) { b.disabled = false; });
        }
      });
    });
    var advanceBtn = card.querySelector(".advance-btn");
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
    card.addEventListener("click", function () { openTicketModal(t); });
    return card;
  }

  /** Detail popup for one ticket — everything the compact card leaves out, including the
   *  branch it was (or is being) built on, if the ticket ever recorded one. */
  function openTicketModal(t) {
    ticketModalTitle.textContent = "#" + t.id;
    var rows = [
      ["State", esc(t.state || "—")],
      ["Risk", esc(t.risk || "—")],
      ["Tags", Array.isArray(t.tags) && t.tags.length ? t.tags.map(esc).join(", ") : "—"],
      ["Owner", t.owner ? esc(t.owner) : "—"],
      ["Created by", t.createdBy ? esc(t.createdBy) : "—"],
      ["Branch", t.branch ? '<span class="mono">' + esc(t.branch) + "</span>" : "—"],
      ["PR", t.pr ? esc(t.pr) : "—"],
      ["Estimate", t.estimate ? esc(t.estimate) : "—"],
      ["Blocked on", t.blockedOn ? esc(t.blockedOn) : "—"],
    ];
    var rowsHtml = rows.map(function (r) {
      return '<div class="modal-row"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + "</span></div>";
    }).join("");
    var history = Array.isArray(t.history) ? t.history.slice().reverse() : [];
    var historyHtml = history.length
      ? '<ul class="modal-history">' + history.map(function (h) {
          return (
            "<li>" + relTime(h.at) + " — " + esc(h.from || "—") + " → " + esc(h.to || "—") +
            ' <span class="by">' + esc(h.by || "") + "</span></li>"
          );
        }).join("") + "</ul>"
      : '<p class="empty-note">No history yet.</p>';
    ticketModalBody.innerHTML =
      rowsHtml +
      "<h3>Intent</h3><p>" + esc(t.intent || "—") + "</p>" +
      (t.acceptance ? "<h3>Acceptance</h3>" + renderMarkdown(t.acceptance) : "") +
      (t.body ? "<h3>Notes</h3>" + renderMarkdown(t.body) : "") +
      "<h3>History</h3>" + historyHtml;
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

  function renderBoard(tickets) {
    board.innerHTML = "";
    STATES.forEach(function (s) {
      var inLane = tickets.filter(function (t) { return t.state === s.key; });
      var lane = document.createElement("section");
      lane.className = "lane";
      lane.innerHTML =
        "<header><h2>" + s.label + '</h2><span class="count mono">' + inLane.length + "</span></header>" +
        '<div class="lane-body"></div>';
      var body = lane.querySelector(".lane-body");
      if (inLane.length === 0) {
        body.innerHTML = '<div class="lane-empty">No tickets</div>';
      } else {
        inLane.forEach(function (t) { body.appendChild(cardEl(t)); });
      }
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
        (a.tokens ? '<div class="tokens mono">' + fmtNum(a.tokens.totalTokens) + " tokens</div>" : "") +
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
    projectName.textContent = state.project || "—";
    remoteLink.textContent = state.remoteUrl || "";
    remoteLink.href = toHttpUrl(state.remoteUrl);
    branchName.textContent = state.stateBranch ? "branch: " + state.stateBranch : "";
    lastUpdated.textContent = "Updated " + relTime(state.lastFetchedAt);

    if (state.hookConfigured) {
      hookState.innerHTML = "Hook: <b>connected — live</b>";
    } else if (state.autoFetch && state.autoFetch.enabled) {
      hookState.innerHTML = "Hook: not configured — auto-fetching every <b>" + state.autoFetch.intervalMinutes + " min</b>";
    } else {
      hookState.textContent = "Hook: not configured — click Pull to refresh";
    }
    autoFetchToggle.setAttribute("aria-pressed", String(Boolean(state.autoFetch && state.autoFetch.enabled)));
    if (state.autoFetch) intervalInput.value = state.autoFetch.intervalMinutes;

    var issues = state.issues || [];
    if (issues.length) {
      issuesBanner.hidden = false;
      issuesList.innerHTML = issues.map(function (i) { return "<li>" + esc(i.message) + "</li>"; }).join("");
      fixBtn.hidden = !issues.some(function (i) { return STRUCTURAL_ISSUES.has(i.kind); });
    } else {
      issuesBanner.hidden = true;
    }

    if (state.unpushed > 0) {
      pushBanner.hidden = false;
      pushText.textContent = state.unpushed + " unpushed commit" + (state.unpushed === 1 ? "" : "s") + " on " + state.stateBranch;
    } else {
      pushBanner.hidden = true;
    }

    renderInsights(state.stats, state.coverage, state.agents);
    renderBoard(state.tickets || []);
    renderAgents(state.agents || []);
    renderTokenUsage(state.agents || []);
    renderMembers((state.stats && state.stats.contributorList) || []);
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

  autoFetchToggle.addEventListener("click", async function () {
    var enabled = autoFetchToggle.getAttribute("aria-pressed") !== "true";
    await apiPost("/api/autofetch", { enabled: enabled, intervalMinutes: Number(intervalInput.value) || 5 });
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

  function setInsightsExpanded(expanded) {
    insightsBody.hidden = !expanded;
    insightsToggle.setAttribute("aria-expanded", String(expanded));
    try { localStorage.setItem("peephole.insightsExpanded", expanded ? "1" : "0"); } catch (e) {}
  }
  insightsToggle.addEventListener("click", function () {
    setInsightsExpanded(insightsToggle.getAttribute("aria-expanded") !== "true");
  });
  var storedExpanded = true;
  try { storedExpanded = localStorage.getItem("peephole.insightsExpanded") !== "0"; } catch (e) {}
  setInsightsExpanded(storedExpanded);

  function setAgentsExpanded(expanded) {
    agentsBody.hidden = !expanded;
    agentsToggle.setAttribute("aria-expanded", String(expanded));
    try { localStorage.setItem("peephole.agentsExpanded", expanded ? "1" : "0"); } catch (e) {}
  }
  agentsToggle.addEventListener("click", function () {
    setAgentsExpanded(agentsToggle.getAttribute("aria-expanded") !== "true");
  });
  var storedAgentsExpanded = true;
  try { storedAgentsExpanded = localStorage.getItem("peephole.agentsExpanded") !== "0"; } catch (e) {}
  setAgentsExpanded(storedAgentsExpanded);

  fetch("/api/state").then(function (r) { return r.json(); }).then(render).catch(function () {});

  var es = new EventSource("/api/events");
  es.onmessage = function (ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (msg.type === "state") render(msg.payload);
    } catch (e) {}
  };
})();
