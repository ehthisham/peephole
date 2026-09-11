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

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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

  function renderInsights(stats) {
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

  function cardEl(t) {
    var card = document.createElement("article");
    card.className = "card";
    var risk = t.risk === "irreversible" ? '<span class="badge risk">⚠ irreversible</span>' : "";
    var blocked = t.blockedOn ? '<span class="badge blocked">⛓ ' + esc(t.blockedOn) + "</span>" : "";
    var owner = t.owner ? '<span class="badge owner">' + esc(t.owner) + "</span>" : "";
    var controls = CONTROLS.map(function (c) {
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
      '<div class="controls">' + controls + "</div>";
    Array.prototype.forEach.call(card.querySelectorAll(".ctl"), function (btn) {
      btn.addEventListener("click", async function () {
        Array.prototype.forEach.call(card.querySelectorAll(".ctl"), function (b) { b.disabled = true; });
        try {
          await apiPost("/api/tickets/" + encodeURIComponent(btn.dataset.id) + "/control", { control: btn.dataset.ctl });
        } finally {
          Array.prototype.forEach.call(card.querySelectorAll(".ctl"), function (b) { b.disabled = false; });
        }
      });
    });
    return card;
  }

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
      return;
    }
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

  /** Each contributor's name + commit count on the active branch — the "contribution" figure. */
  function renderMembers(list) {
    if (!list || list.length === 0) {
      memberList.innerHTML = '<p class="empty-note">No commits yet.</p>';
      return;
    }
    memberList.innerHTML = list.map(function (m) {
      return (
        '<div class="member">' +
        '<span class="name">' + esc(m.name) + "</span>" +
        '<span class="contribution mono">' + fmtNum(m.commits) + " commit" + (m.commits === 1 ? "" : "s") + "</span>" +
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

    renderInsights(state.stats);
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

  fetch("/api/state").then(function (r) { return r.json(); }).then(render).catch(function () {});

  var es = new EventSource("/api/events");
  es.onmessage = function (ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (msg.type === "state") render(msg.payload);
    } catch (e) {}
  };
})();
