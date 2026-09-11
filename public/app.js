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
  var memberList = document.getElementById("memberList");
  var insightsToggle = document.getElementById("insightsToggle");
  var insightsBody = document.getElementById("insightsBody");
  var agentsToggle = document.getElementById("agentsToggle");
  var agentsBody = document.getElementById("agentsBody");
  var ticketModalBackdrop = document.getElementById("ticketModalBackdrop");
  var ticketModalTitle = document.getElementById("ticketModalTitle");
  var ticketModalClose = document.getElementById("ticketModalClose");
  var ticketModalBody = document.getElementById("ticketModalBody");

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

  function renderInsights(stats, coverage) {
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

  function cardEl(t) {
    var card = document.createElement("article");
    card.className = "card";
    var risk = t.risk === "irreversible" ? '<span class="badge risk">⚠ irreversible</span>' : "";
    var blocked = t.blockedOn ? '<span class="badge blocked">⛓ ' + esc(t.blockedOn) + "</span>" : "";
    var owner = t.owner ? '<span class="badge owner">' + esc(t.owner) + "</span>" : "";
    var isTerminal = TERMINAL_STATES.has(t.state);
    var controls = isTerminal ? "" : CONTROLS.map(function (c) {
      return (
        '<button class="ctl ' + c + '" data-ctl="' + c + '" data-id="' + esc(t.id) + '" aria-pressed="' +
        (t.control === c) + '" type="button">' + c + "</button>"
      );
    }).join("");
    card.innerHTML =
      '<div class="card-top"><span class="project-tag">' + esc(t.project || "—") + "</span>" + risk + owner + "</div>" +
      '<p class="intent">' + esc(t.intent) + "</p>" +
      (blocked ? "<div>" + blocked + "</div>" : "") +
      '<div class="card-foot"><span class="id mono">#' + esc(t.id) + "</span></div>" +
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
      ["Owner", t.owner ? esc(t.owner) : "—"],
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

  /** Each contributor's name, commit count, and (when any Claude Code session reported a
   *  matching git identity — see hooks/identity.js) their token usage — joined server-side by
   *  mailmap-resolved name so "ehthisham" and "Ehthisham <other-email>" land on one row. */
  function renderMembers(list) {
    if (!list || list.length === 0) {
      memberList.innerHTML = '<p class="empty-note">No commits yet.</p>';
      return;
    }
    memberList.innerHTML = list.map(function (m) {
      return (
        '<div class="member">' +
        '<span class="name">' + esc(m.name) + "</span>" +
        '<span class="contribution mono">' + fmtNum(m.commits) + " commit" + (m.commits === 1 ? "" : "s") +
        (m.tokens ? " · " + fmtNum(m.tokens) + " tokens" : "") +
        "</span>" +
        "</div>"
      );
    }).join("");
  }

  function render(state) {
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

    renderInsights(state.stats, state.coverage);
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
