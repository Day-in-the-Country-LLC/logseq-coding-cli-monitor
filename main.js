(function () {
  const API = "http://127.0.0.1:31274/status";
  const START_CMD = "cli-monitor daemon";
  const WRAP_CMD = 'cli-monitor run --name "Appforge issue 42" codex';
  const DOCK_ID = "coding-cli-monitor-dock";
  const REFRESH_MS = 5000;
  const app = document.getElementById("app");
  let visible = false;
  let status = null;
  let lastEventId = localStorage.getItem("coding-cli-monitor:last-event-id") || "";
  let panelTimer = null;
  let dockTimer = null;
  let dockRefreshing = false;
  let panelRefreshing = false;
  let lastManualRefreshAt = 0;
  let panelPosition = readPanelPosition();

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[ch]);
  }

  function sessionLabel(session) {
    const args = Array.isArray(session.args) && session.args.length ? ` ${session.args.join(" ")}` : "";
    const command = `${session.command || session.cli || "unknown"}${args}`;
    return session.name ? `${session.name} · ${command}` : command;
  }

  function normalizedSessionStatus(session) {
    if (!session || session.status === "finished" || session.status === "failed") return null;
    return session.status === "attention" ? "attention" : "working";
  }

  function activeSessions() {
    return (status?.sessions || [])
      .map((session) => ({ ...session, monitorStatus: normalizedSessionStatus(session) }))
      .filter((session) => session.monitorStatus);
  }

  function formatTime(value) {
    if (!value) return "";
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function refreshText() {
    if (lastManualRefreshAt) return `Refresh clicked ${formatTime(lastManualRefreshAt)}`;
    return "";
  }

  function readPanelPosition() {
    try {
      const raw = localStorage.getItem("coding-cli-monitor:panel-position");
      const parsed = raw ? JSON.parse(raw) : null;
      if (Number.isFinite(parsed?.left) && Number.isFinite(parsed?.top)) return parsed;
    } catch {}
    return null;
  }

  function storePanelPosition(position) {
    panelPosition = position;
    localStorage.setItem("coding-cli-monitor:panel-position", JSON.stringify(position));
  }

  function defaultPanelPosition() {
    const doc = top.document;
    const banner = doc.getElementById("banner");
    const bannerRect = banner?.getBoundingClientRect();
    const topOffset = bannerRect && bannerRect.height > 0 ? Math.max(12, bannerRect.bottom + 12) : 12;
    const width = 420;
    const viewportWidth = top.innerWidth || doc.documentElement.clientWidth || 1024;
    return {
      left: Math.max(12, viewportWidth - width - 28),
      top: topOffset,
    };
  }

  function clampPanelPosition(position) {
    const viewportWidth = top.innerWidth || 1024;
    const viewportHeight = top.innerHeight || 768;
    const width = 420;
    const height = Math.min(560, Math.max(320, viewportHeight * 0.7));
    return {
      left: Math.min(Math.max(8, position.left), Math.max(8, viewportWidth - width - 8)),
      top: Math.min(Math.max(8, position.top), Math.max(8, viewportHeight - height - 8)),
    };
  }

  function applyPanelPosition(position = panelPosition || defaultPanelPosition()) {
    const next = clampPanelPosition(position);
    logseq.setMainUIInlineStyle({
      position: "fixed",
      top: `${next.top}px`,
      left: `${next.left}px`,
      right: "auto",
      bottom: "auto",
      width: "420px",
      maxHeight: "70vh",
      height: "560px",
      zIndex: 11,
      borderRadius: "14px",
      overflow: "auto",
      boxShadow: "0 18px 70px rgba(0,0,0,.35)",
    });
    return next;
  }

  function processRows() {
    const sessions = activeSessions();
    const external = status?.external || [];
    const wrappedRows = sessions.map((session) => ({
      label: sessionLabel(session),
      meta: session.pid ? `wrapped ${session.command || "session"} pid ${session.pid}` : "wrapped session",
      status: session.monitorStatus,
    }));
    const externalRows = external.map((proc) => ({
      label: proc.cli,
      meta: `detected pid ${proc.pid}`,
      status: "working",
    }));
    return [...wrappedRows, ...externalRows];
  }

  async function fetchStatus() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
      const response = await fetch(API, { cache: "no-store", signal: controller.signal });
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function handleEvents(nextStatus) {
    const newest = nextStatus?.events?.[nextStatus.events.length - 1];
    if (newest && newest.id !== lastEventId) {
      lastEventId = newest.id;
      localStorage.setItem("coding-cli-monitor:last-event-id", lastEventId);
      if (newest.type === "attention") {
        logseq.App.showMsg(newest.message, "warning");
      }
    }
  }

  function summarize() {
    const sessions = activeSessions();
    const external = status?.external || [];
    const latest = status?.events?.[status.events.length - 1];
    const attention = sessions.find((session) => session.monitorStatus === "attention");
    const working = sessions.find((session) => session.monitorStatus === "working");

    if (!status?.ok) {
      return {
        state: "offline",
        title: "CLI monitor offline",
        detail: `Start with ${START_CMD}`,
        count: "setup",
      };
    }

    if (attention) {
      return {
        state: "attention",
        title: "CLI needs attention",
        detail: sessionLabel(attention),
        count: "attention",
      };
    }

    if (working) {
      const workingCount = sessions.filter((session) => session.monitorStatus === "working").length;
      return {
        state: "working",
        title: `${workingCount} CLI session${workingCount === 1 ? "" : "s"} working`,
        detail: sessionLabel(working),
        count: "working",
      };
    }

    if (external.length) {
      return {
        state: "working",
        title: `${external.length} CLI session${external.length === 1 ? "" : "s"} working`,
        detail: `${external[0].cli} pid ${external[0].pid}`,
        count: "working",
      };
    }

    return {
      state: "idle",
      title: "CLI monitor idle",
      detail: latest ? latest.message : "No active sessions",
      count: "idle",
    };
  }

  function renderPanel() {
    const sessions = activeSessions();
    const external = status?.external || [];
    const events = status?.events || [];
    const installed = status?.installed || {};

    const refreshNotice = refreshText();
    app.innerHTML = `
      <main>
        <header data-drag-handle="panel">
          <div>
            <h1>Coding CLI Monitor</h1>
            <p>${status?.ok ? "Daemon connected" : "Daemon not running"}${refreshNotice ? ` · ${esc(refreshNotice)}` : ""}</p>
          </div>
          <div class="panel-actions">
            <button data-action="refresh" ${panelRefreshing ? "disabled" : ""}>${panelRefreshing ? "Refreshing..." : "Refresh"}</button>
            <button data-action="close">Close</button>
          </div>
        </header>

        <section class="card">
          <h2>Wrapped Sessions</h2>
          ${sessions.length ? sessions.map((session) => `
            <div class="row ${esc(session.monitorStatus)}">
              <span>${esc(sessionLabel(session))}</span>
              <b>${esc(session.monitorStatus)}</b>
            </div>
          `).join("") : "<p>No wrapped sessions yet.</p>"}
        </section>

        <section class="card">
          <h2>Detected Processes</h2>
          ${external.length ? external.map((proc) => `
            <div class="row working">
              <span>${esc(proc.cli)} <small>pid ${esc(proc.pid)}</small></span>
              <b>working</b>
            </div>
          `).join("") : "<p>No unwrapped coding CLI processes detected.</p>"}
        </section>

        <section class="card">
          <h2>Recent Events</h2>
          ${events.length ? events.slice(-8).reverse().map((event) => `
            <div class="event">
              <b>${esc(event.type)}</b>
              <span>${esc(event.message)}</span>
            </div>
          `).join("") : "<p>No events yet.</p>"}
        </section>

        <section class="grid">
          ${status?.ok ? "" : `
            <div class="card warn">
              <h2>Start Daemon</h2>
              <code>${START_CMD}</code>
              <p>Keep this running in a terminal, or add it to your login items later.</p>
            </div>
          `}
          <div class="card">
            <h2>Use Wrapper</h2>
            <code>${WRAP_CMD}</code>
            <p>Use <code>cli-monitor run --name "Issue 42" claude</code>, <code>cli-monitor run --name "PR review" codex</code>, or <code>cli-monitor run opencode</code> for attention and working-state detection.</p>
          </div>
          <div class="card">
            <h2>Installed</h2>
            <p>Claude: <b>${installed.claude ? "yes" : "no"}</b></p>
            <p>Codex: <b>${installed.codex ? "yes" : "no"}</b></p>
            <p>OpenCode: <b>${installed.opencode ? "yes" : "no"}</b></p>
          </div>
        </section>
      </main>
    `;
  }

  function renderDock() {
    const dock = top.document.getElementById(DOCK_ID);
    if (!dock) return;
    const summary = summarize();
    const rows = processRows();
    const updated = status?.generatedAt ? `Updated ${formatTime(status.generatedAt)}` : "Not connected";
    const refreshNotice = refreshText();
    dock.className = `coding-cli-monitor-dock is-${summary.state}${dockRefreshing ? " is-refreshing" : ""}`;
    dock.innerHTML = `
      <div class="ccm-header">
        <div class="ccm-title">
          <div class="ccm-pulse"></div>
          <div>
            <strong>Coding CLI Monitor</strong>
            <span>${esc(summary.title)} · ${esc(updated)}${refreshNotice ? ` · ${esc(refreshNotice)}` : ""}</span>
          </div>
        </div>
        <div class="ccm-actions">
          <button type="button" data-ccm-action="refresh" ${dockRefreshing ? "disabled" : ""}>${dockRefreshing ? "Refreshing..." : "Refresh"}</button>
          <button type="button" data-ccm-action="panel">Setup</button>
        </div>
      </div>
      <div class="ccm-processes">
        ${status?.ok ? (rows.length ? rows.map((row) => `
          <div class="ccm-row is-${esc(row.status)}">
            <span>
              <b>${esc(row.label)}</b>
              <small>${esc(row.meta)}</small>
            </span>
            <em>${esc(row.status)}</em>
          </div>
        `).join("") : `
          <div class="ccm-empty">No coding CLI processes detected.</div>
        `) : `
          <div class="ccm-empty">Start the daemon with <code>${esc(START_CMD)}</code>.</div>
        `}
      </div>
    `;
  }

  function findDockAnchor() {
    const doc = top.document;
    const banner = doc.getElementById("banner");
    if (banner) return { target: banner, position: "afterend" };
    const main = doc.getElementById("main-content-container");
    if (main) return { target: main, position: "afterbegin" };
    return null;
  }

  function mountDock() {
    const doc = top.document;
    if (doc.getElementById(DOCK_ID)) {
      renderDock();
      return;
    }
    const anchor = findDockAnchor();
    if (!anchor) return;
    const dock = doc.createElement("div");
    dock.id = DOCK_ID;
    anchor.target.insertAdjacentElement(anchor.position, dock);
    renderDock();
  }

  async function pollDock(options = {}) {
    if (options.manual) {
      dockRefreshing = true;
      lastManualRefreshAt = Date.now();
      renderDock();
    }
    try {
      status = await fetchStatus();
      handleEvents(status);
    } catch {
      status = null;
    } finally {
      dockRefreshing = false;
    }
    mountDock();
    renderDock();
  }

  async function pollPanel(options = {}) {
    if (options.manual) {
      panelRefreshing = true;
      lastManualRefreshAt = Date.now();
      renderPanel();
      renderDock();
    }
    try {
      status = await fetchStatus();
      handleEvents(status);
    } catch {
      status = null;
    } finally {
      panelRefreshing = false;
    }
    renderPanel();
    renderDock();
  }

  function openPanel() {
    visible = true;
    panelPosition = applyPanelPosition(panelPosition || defaultPanelPosition());
    renderPanel();
    logseq.showMainUI();
    pollPanel();
    panelTimer ||= setInterval(pollPanel, REFRESH_MS);
  }

  function closePanel() {
    visible = false;
    logseq.hideMainUI();
    clearInterval(panelTimer);
    panelTimer = null;
  }

  function togglePanel() {
    if (!visible) openPanel();
    else closePanel();
  }

  function showSetupMessage() {
    logseq.App.showMsg(`Start the monitor daemon in Terminal: ${START_CMD}`, "info");
  }

  function registerSlashCommands() {
    logseq.Editor.registerSlashCommand("CLI Monitor", openPanel);
    logseq.Editor.registerSlashCommand("CLI Monitor Setup", showSetupMessage);
  }

  function safeSetup(label, fn) {
    try {
      return fn();
    } catch (error) {
      console.error(`[coding-cli-monitor] ${label} failed`, error);
      return null;
    }
  }

  function actionFor(target, attr) {
    return target?.closest?.(`[${attr}]`)?.getAttribute(attr) || "";
  }

  function installPanelDrag() {
    let drag = null;
    document.addEventListener("pointerdown", (event) => {
      if (!event.target?.closest?.('[data-drag-handle="panel"]')) return;
      if (event.target?.closest?.("button")) return;
      const current = panelPosition || defaultPanelPosition();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: current.left,
        top: current.top,
      };
      event.target.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    document.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const next = applyPanelPosition({
        left: drag.left + event.clientX - drag.startX,
        top: drag.top + event.clientY - drag.startY,
      });
      panelPosition = next;
    });
    document.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      storePanelPosition(panelPosition || defaultPanelPosition());
      drag = null;
    });
    document.addEventListener("pointercancel", () => {
      if (panelPosition) storePanelPosition(panelPosition);
      drag = null;
    });
  }

  function setHostStyle() {
    panelPosition = applyPanelPosition(panelPosition || defaultPanelPosition());
    logseq.provideStyle(`
      #${DOCK_ID}.coding-cli-monitor-dock {
        width: min(100% - 48px, 920px);
        margin: 10px auto 18px;
        padding: 12px;
        display: block;
        border: 1px solid rgba(130, 167, 148, .22);
        border-radius: 16px;
        background: linear-gradient(135deg, rgba(28, 38, 34, .92), rgba(47, 58, 52, .82));
        color: #dce7de;
        box-shadow: 0 16px 45px rgba(0,0,0,.2);
        backdrop-filter: blur(10px);
      }
      #${DOCK_ID} .ccm-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      #${DOCK_ID} .ccm-title {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #${DOCK_ID} .ccm-pulse {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #9cc8b2;
        box-shadow: 0 0 0 5px rgba(156,200,178,.12);
        flex: 0 0 auto;
      }
      #${DOCK_ID}.is-idle .ccm-pulse { background: #87958d; box-shadow: 0 0 0 5px rgba(135,149,141,.12); }
      #${DOCK_ID}.is-working .ccm-pulse { background: #009e73; box-shadow: 0 0 0 5px rgba(0,158,115,.18); }
      #${DOCK_ID}.is-attention .ccm-pulse { background: #e8d8a8; box-shadow: 0 0 0 5px rgba(232,216,168,.16); }
      #${DOCK_ID}.is-offline .ccm-pulse { background: #d78d80; box-shadow: 0 0 0 5px rgba(215,141,128,.14); }
      #${DOCK_ID} strong { font-size: 13px; letter-spacing: .03em; }
      #${DOCK_ID} span { margin-top: 3px; font-size: 12px; color: rgba(220,231,222,.78); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${DOCK_ID} .ccm-title span { display: block; }
      #${DOCK_ID} .ccm-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 auto;
      }
      #${DOCK_ID} button {
        border: 0;
        border-radius: 999px;
        padding: 6px 10px;
        background: rgba(220,231,222,.1);
        color: #dce7de;
        font-size: 12px;
        cursor: pointer;
      }
      #${DOCK_ID} button:hover { background: rgba(220,231,222,.18); }
      #${DOCK_ID} button:disabled { opacity: .65; cursor: wait; }
      #${DOCK_ID}.is-refreshing { border-color: rgba(240,228,66,.55); }
      #${DOCK_ID}.is-refreshing .ccm-pulse { animation: ccm-refresh-pulse .75s ease-in-out infinite alternate; }
      @keyframes ccm-refresh-pulse {
        from { transform: scale(.85); opacity: .65; }
        to { transform: scale(1.15); opacity: 1; }
      }
      #${DOCK_ID} .ccm-processes {
        margin-top: 10px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px;
      }
      #${DOCK_ID} .ccm-row,
      #${DOCK_ID} .ccm-empty {
        min-width: 0;
        padding: 9px 10px;
        border-radius: 12px;
        background: rgba(255,255,255,.055);
        border: 1px solid rgba(255,255,255,.065);
      }
      #${DOCK_ID} .ccm-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      #${DOCK_ID} .ccm-row span { min-width: 0; display: flex; flex-direction: column; }
      #${DOCK_ID} .ccm-row b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${DOCK_ID} small { color: rgba(220,231,222,.58); }
      #${DOCK_ID} em {
        flex: 0 0 auto;
        font-style: normal;
        font-size: 11px;
        color: #111615;
        background: #6f8fa7;
        border-radius: 999px;
        padding: 3px 8px;
        font-weight: 700;
      }
      #${DOCK_ID} .is-working em { background: #009e73; color: #ffffff; }
      #${DOCK_ID} .is-attention em { background: #f0e442; color: #111615; }
      #${DOCK_ID} .ccm-empty { color: rgba(220,231,222,.78); font-size: 12px; }
      #${DOCK_ID} code { color: #e8d8a8; }
      @media (max-width: 720px) {
        #${DOCK_ID}.coding-cli-monitor-dock { width: calc(100% - 24px); flex-wrap: wrap; }
        #${DOCK_ID} .ccm-header { align-items: flex-start; flex-direction: column; }
      }
    `);
  }

  function setPanelStyle() {
    const style = document.createElement("style");
    style.textContent = `
      body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #1f2423; color: #dce7de; }
      main { padding: 16px; }
      header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      header[data-drag-handle="panel"] { cursor: move; user-select: none; }
      .panel-actions { display: flex; gap: 8px; }
      h1 { margin: 0; font-size: 18px; }
      h2 { margin: 0 0 8px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #9cc8b2; }
      p { margin: 4px 0; color: #b8c7be; }
      button { border: 0; border-radius: 999px; padding: 6px 10px; background: #9cc8b2; color: #17201c; font-weight: 700; }
      button:disabled { opacity: .65; cursor: wait; }
      code { display: block; padding: 8px; border-radius: 8px; background: #111615; color: #e8d8a8; white-space: pre-wrap; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: stretch; }
      .card { margin: 10px 0; padding: 12px; border: 1px solid rgba(156,200,178,.18); border-radius: 12px; background: rgba(255,255,255,.04); }
      .warn { border-color: rgba(232,216,168,.4); }
      .row, .event { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.07); }
      .row:first-of-type, .event:first-of-type { border-top: 0; }
      .attention b { color: #e8d8a8; }
      .working b { color: #41d69f; }
      small { color: #87958d; }
      @media (max-width: 560px) {
        .grid { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);
  }

  document.addEventListener("click", (event) => {
    const action = actionFor(event.target, "data-action");
    if (action === "refresh") pollPanel({ manual: true });
    if (action === "close") closePanel();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });

  logseq.ready(() => {
    safeSetup("slash command registration", registerSlashCommands);
    safeSetup("model registration", () => logseq.provideModel({ toggleCodingCliMonitor: togglePanel }));
    safeSetup("host style", setHostStyle);
    safeSetup("panel style", setPanelStyle);
    safeSetup("panel drag", installPanelDrag);
    safeSetup("dock click listener", () => top.document.addEventListener("click", (event) => {
      const action = actionFor(event.target, "data-ccm-action");
      if (action === "refresh") pollDock({ manual: true });
      if (action === "panel") openPanel();
    }));
    safeSetup("route listener", () => logseq.App.onRouteChanged(() => setTimeout(mountDock, 250)));
    app.innerHTML = "<main><p>Loading monitor status...</p></main>";
    mountDock();
    pollDock();
    dockTimer = setInterval(pollDock, REFRESH_MS);
    logseq.beforeunload(() => {
      clearInterval(dockTimer);
      clearInterval(panelTimer);
      top.document.getElementById(DOCK_ID)?.remove();
    });
  });
})();
