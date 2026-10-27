/**
 * The client shell served at `/app` (ADR 0333 P2, mobile first).
 *
 * One file, no build step, no framework: the page a phone opens has to travel
 * over the same listener it will then talk to, so every kilobyte here is paid
 * for on a phone network. It is served without a credential because it is the
 * page that collects one; nothing in it is derived from a session.
 *
 * The event stream is read with `fetch` rather than `EventSource` because
 * `EventSource` cannot carry an `Authorization` header, and the protocol
 * forbids putting a token in a URL.
 */

export type StaticAsset = { body: string; contentType: string };

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#111114">
<title>QianNing Agent</title>
<style>
  :root {
    --bg: #ffffff; --fg: #16161a; --muted: #6b6b76; --line: #e4e4ea;
    --card: #f6f6f9; --accent: #2f6df6; --accent-fg: #ffffff; --danger: #c0392b;
    --ok: #1f8a4c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111114; --fg: #ececf1; --muted: #9a9aa6; --line: #26262e;
      --card: #1a1a20; --accent: #5b8cff; --accent-fg: #0b0b0e; --danger: #ff6b5e;
      --ok: #4ec98a;
    }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  header {
    position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
    padding: 12px 14px; background: var(--bg); border-bottom: 1px solid var(--line);
  }
  header h1 { font-size: 16px; margin: 0; flex: 1; font-weight: 600; }
  button {
    font: inherit; border: 0; border-radius: 10px; padding: 10px 14px;
    background: var(--accent); color: var(--accent-fg); font-weight: 600;
  }
  button.ghost { background: transparent; color: var(--accent); padding: 8px 10px; }
  button:disabled { opacity: .5; }
  main { padding: 12px 14px 96px; }
  .row {
    display: block; width: 100%; text-align: left; background: var(--card);
    color: var(--fg); border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; font-weight: 500;
  }
  .row small { display: block; color: var(--muted); font-weight: 400; margin-top: 2px; }
  .empty { color: var(--muted); text-align: center; padding: 40px 12px; }
  .msg { padding: 10px 12px; border-radius: 12px; margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; }
  .msg.user { background: var(--accent); color: var(--accent-fg); margin-left: 14%; }
  .msg.agent { background: var(--card); margin-right: 14%; }
  .msg.tool { background: transparent; border: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  .msg.tool .tool-name { color: var(--fg); font-weight: 600; }
  .msg.tool .tool-detail {
    display: block; margin-top: 4px; font-family: ui-monospace, monospace;
    font-size: 12px; white-space: pre-wrap; word-break: break-all;
  }
  .msg.tool.failed { border-color: var(--danger); }
  .diff-file { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .diff-file > summary {
    list-style: none; cursor: pointer; padding: 10px 12px;
    display: flex; gap: 8px; align-items: baseline;
  }
  .diff-file > summary::-webkit-details-marker { display: none; }
  .diff-path { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; flex: 1; }
  .diff-count { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .diff-count .add { color: var(--ok); }
  .diff-count .del { color: var(--danger); }
  .diff-body { border-top: 1px solid var(--line); overflow-x: auto; }
  .diff-hunk { font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.5; }
  .diff-hunk > .hunk-head { color: var(--muted); padding: 4px 8px; background: rgba(255,255,255,0.03); }
  .diff-line { padding: 0 8px; white-space: pre; }
  .diff-line.add { background: rgba(80, 200, 120, 0.12); color: #9be0b0; }
  .diff-line.del { background: rgba(220, 80, 80, 0.12); color: #f0a0a0; }
  .composer {
    position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 8px;
    padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
    background: var(--bg); border-top: 1px solid var(--line);
  }
  .composer textarea {
    flex: 1; resize: none; font: inherit; color: var(--fg); background: var(--card);
    border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; max-height: 40vh;
  }
  .field { display: block; margin-bottom: 12px; }
  .field label { display: block; color: var(--muted); font-size: 13px; margin-bottom: 6px; }
  .field input {
    width: 100%; font: inherit; color: var(--fg); background: var(--card);
    border: 1px solid var(--line); border-radius: 10px; padding: 12px;
  }
  .error { color: var(--danger); margin: 8px 0; }
  .approvals {
    position: fixed; left: 0; right: 0; bottom: calc(64px + env(safe-area-inset-bottom));
    padding: 0 14px; display: flex; flex-direction: column; gap: 8px; z-index: 3;
  }
  .approval {
    background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px;
    box-shadow: 0 6px 24px rgba(0,0,0,.18);
  }
  .approval h3 { margin: 0 0 4px; font-size: 14px; }
  .approval p { margin: 0 0 10px; color: var(--muted); font-size: 13px; white-space: pre-wrap; }
  .approval .actions { display: flex; gap: 8px; }
  .approval .actions button { flex: 1; padding: 9px 10px; font-size: 14px; }
  .approval .deny { background: transparent; color: var(--danger); border: 1px solid var(--line); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: #2ecc71; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  var TOKEN_KEY = "racp.token";
  var BASE_KEY = "racp.base";
  var app = document.getElementById("app");
  var state = { view: "loading", sessions: [], sessionId: null, messages: [], approvals: [], error: null, busy: false, activeTurnId: null, diff: null, projects: null };
  var stream = null;

  /**
   * Where the Host lives. Empty means "the origin this page came from", which
   * is right for a browser tab served by the Host and wrong for the phone
   * shell, where the page comes from the app bundle.
   */
  // Trimmed by hand rather than with a regex: this code lives inside a template
  // string, and the escaping a regex needs there is exactly the kind that turns
  // into a comment in the delivered file.
  function trimSlash(value) {
    var out = value;
    while (out.length > 1 && out.charAt(out.length - 1) === "/") out = out.slice(0, -1);
    return out;
  }
  function base() {
    var stored = localStorage.getItem(BASE_KEY);
    return stored ? trimSlash(stored) : "";
  }
  function setBase(value) {
    if (value) localStorage.setItem(BASE_KEY, trimSlash(value));
    else localStorage.removeItem(BASE_KEY);
  }
  function defaultBase() {
    return window.Capacitor ? "" : location.origin;
  }

  function token() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(value) {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function call(path, init) {
    init = init || {};
    var headers = { authorization: "Bearer " + token() };
    if (init.body) headers["content-type"] = "application/json";
    return fetch(base() + path, {
      method: init.method || "GET",
      headers: headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (response.status === 401) { setToken(""); state.view = "login"; render(); throw new Error("token rejected"); }
        if (!response.ok) throw new Error(payload.message || payload.error || ("HTTP " + response.status));
        return payload.result === undefined ? payload : payload.result;
      });
    });
  }

  /**
   * A pairing link puts the token in the fragment — the one part of a URL a
   * browser never sends to the server. Opening the link the desktop shows is
   * then a single tap: no address to type, no token to paste.
   */
  function adoptPairingLink() {
    var hash = location.hash || "";
    if (hash.indexOf("#t=") !== 0) return false;
    var value = decodeURIComponent(hash.slice(3));
    if (!value || token()) return false;
    setBase(location.origin);
    setToken(value);
    // Cleared from the address bar so it does not linger in a screenshot or a
    // shared history entry.
    history.replaceState(null, "", location.pathname);
    return true;
  }

  function render() {
    if (!token() && adoptPairingLink()) state.view = "sessions";
    if (state.view === "login") return renderLogin();
    if (state.view === "sessions") return renderSessions();
    if (state.view === "chat") return renderChat();
    if (state.view === "projects") return renderProjects();
    if (state.view === "diff") return renderDiff();
    app.innerHTML = '<main><div class="empty">Connecting…</div></main>';
  }

  function renderLogin() {
    app.innerHTML =
      '<header><h1>QianNing Agent</h1></header>' +
      '<main>' +
        '<p class="empty">Point this at the computer running QianNing Agent, then paste its device token.</p>' +
        '<p class="empty">If this page warned about the connection before loading, install the certificate first: ' +
          '<a href="/cert" download="qianning-agent-ca.crt">download it</a>.</p>' +
        '<form id="login">' +
          '<span class="field"><label for="b">Server address</label>' +
            '<input id="b" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://192.168.1.10:11400" value="' + esc(defaultBase()) + '"></span>' +
          '<span class="field"><label for="t">Device token</label>' +
            '<input id="t" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="pdt1.…"></span>' +
          '<button type="submit">Connect</button>' +
        '</form>' +
        '<p class="error" id="err"></p>' +
      '</main>';
    var form = document.getElementById("login");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var address = document.getElementById("b").value.trim();
      var value = document.getElementById("t").value.trim();
      if (!value) return;
      setBase(address);
      setToken(value);
      state.view = "sessions";
      render();
      loadSessions();
    });
  }

  function renderSessions() {
    var items = state.sessions.map(function (session) {
      return '<button class="row" data-id="' + esc(session.sessionId || session.id) + '">' +
        esc(session.title || "Untitled session") +
        '<small>' + esc(session.updatedAt || session.createdAt || "") + '</small></button>';
    }).join("");
    app.innerHTML =
      '<header><h1>Sessions</h1>' +
        '<button class="ghost" id="fresh" title="New session">+</button>' +
        '<button class="ghost" id="signout">Sign out</button></header>' +
      '<main>' + (items || '<div class="empty">No sessions yet. Tap + to start one.</div>') +
        (state.error ? '<p class="error">' + esc(state.error) + '</p>' : '') +
      '</main>';
    Array.prototype.forEach.call(document.querySelectorAll(".row"), function (node) {
      node.addEventListener("click", function () { openChat(node.getAttribute("data-id")); });
    });
    document.getElementById("fresh").addEventListener("click", function () { newSession(); });
    document.getElementById("signout").addEventListener("click", function () {
      setToken(""); state.view = "login"; render();
    });
  }

  /**
   * Starts the new-session flow.
   *
   * A session without a project has no workspace, so the agent cannot read or
   * write files and the diff is empty. Picking the folder first is therefore part
   * of making a session, not an optional extra — but when the Host has no
   * projects at all there is nothing to pick, and the session is created anyway
   * so the phone is not blocked.
   */
  function newSession() {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    render();
    call("/v1/projects").then(function (result) {
      var projects = (result.projects || []).filter(function (project) { return !project.archived; });
      state.busy = false;
      if (projects.length === 0) { createSession(""); return; }
      state.projects = projects;
      state.view = "projects";
      render();
    }).catch(function (error) {
      state.busy = false;
      state.error = error.message;
      render();
    });
  }

  function renderProjects() {
    var items = state.projects.map(function (project) {
      return '<button class="row" data-id="' + esc(project.id) + '">' + esc(project.label || project.id) + '</button>';
    }).join("");
    app.innerHTML =
      '<header><button class="ghost" id="back">Cancel</button><h1>New session</h1></header>' +
      '<main>' + items +
        '<button class="row" data-id="">No project</button>' +
        '<p class="empty">A session needs a project folder before the agent can touch files.</p>' +
      '</main>';
    Array.prototype.forEach.call(document.querySelectorAll(".row"), function (node) {
      node.addEventListener("click", function () { createSession(node.getAttribute("data-id") || ""); });
    });
    document.getElementById("back").addEventListener("click", function () {
      state.view = "sessions"; state.projects = null; render();
    });
  }

  /** Creates the session on the Host and opens it. */
  function createSession(projectId) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    render();
    var body = { title: "From phone", mode: "agent" };
    if (projectId) body.projectId = projectId;
    call("/v1/sessions", { method: "POST", body: body }).then(function (result) {
      var created = result.session || result;
      var id = created.sessionId || created.id;
      state.busy = false;
      state.projects = null;
      if (!id) {
        state.error = "the Host did not return a session id";
        state.view = "sessions";
        render();
        loadSessions();
        return;
      }
      openChat(id);
    }).catch(function (error) {
      state.busy = false;
      state.error = error.message;
      state.view = "sessions";
      render();
    });
  }

  function renderChat() {
    var messages = state.messages.map(function (message) {
      if (message.role === "user") return '<div class="msg user">' + esc(message.text || "") + '</div>';
      if (message.itemType === "tool") return renderTool(message);
      return '<div class="msg agent">' + esc(message.text || "") + '</div>';
    }).join("");
    app.innerHTML =
      '<header><button class="ghost" id="back">Back</button><h1>Conversation</h1>' +
        '<button class="ghost" id="changes">Changes</button>' +
        '<span class="dot' + (stream ? " live" : "") + '" title="' + (stream ? "live" : "offline") + '"></span></header>' +
      '<main id="log">' + (messages || '<div class="empty">No messages yet.</div>') +
        (state.error ? '<p class="error">' + esc(state.error) + '</p>' : '') +
      '</main>' +
      '<div class="approvals" id="approvals">' + renderApprovals() + '</div>' +
      '<div class="composer">' +
        '<textarea id="text" rows="1" placeholder="Message…"></textarea>' +
        (state.activeTurnId ? '<button id="stop">Stop</button>' : '') +
        '<button id="send"' + (state.busy ? " disabled" : "") + '>Send</button>' +
      '</div>';
    document.getElementById("back").addEventListener("click", function () {
      closeStream(); state.view = "sessions"; state.sessionId = null; state.activeTurnId = null; render(); loadSessions();
    });
    var send = document.getElementById("send");
    send.addEventListener("click", function () {
      var field = document.getElementById("text");
      var text = field.value.trim();
      if (!text) return;
      field.value = "";
      submit(text);
    });
    var stop = document.getElementById("stop");
    if (stop) stop.addEventListener("click", function () { interrupt(); });
    document.getElementById("changes").addEventListener("click", function () { openDiff(); });
    Array.prototype.forEach.call(document.querySelectorAll(".approval button"), function (node) {
      node.addEventListener("click", function () {
        respond(node.getAttribute("data-id"), node.getAttribute("data-decision"), Number(node.getAttribute("data-revision")));
      });
    });
    var log = document.getElementById("log");
    log.scrollTop = log.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  }

  /**
   * One tool call, as the line a reader actually needs: what ran, on what, and
   * whether it worked.
   *
   * A tool item is the difference between "the agent changed something" and
   * knowing which file it touched. It is rendered even when nothing about it can
   * be read, because dropping the step silently is worse than an unnamed row.
   */
  function renderTool(message) {
    var failed = message.failed === true;
    var detail = message.toolDetail || "";
    return '<div class="msg tool' + (failed ? " failed" : "") + '">' +
      '<span class="tool-name">' + esc(message.toolName || "tool") + '</span>' +
      (detail ? '<span class="tool-detail">' + esc(detail) + '</span>' : '') +
      '</div>';
  }

  /**
   * What a stored tool item did, from whatever shape it arrived in.
   *
   * content is unknown in the protocol because the agent owns that shape, so
   * this looks in the places a tool record keeps its name, arguments and outcome
   * instead of assuming one exact structure. Anything missing degrades to the
   * item's plain text rather than hiding the call.
   */
  function toolSummary(item) {
    var outer = item.content && typeof item.content === "object" ? item.content : {};
    var inner = outer.content && typeof outer.content === "object" ? outer.content : outer;
    var name = inner.toolName || inner.name || outer.toolName || outer.name || "";
    var args = inner.input || inner.arguments || inner.args || outer.input || outer.arguments || null;
    var result = inner.output || inner.result || outer.output || outer.result || null;
    var failed = inner.isError === true || inner.failed === true || outer.isError === true ||
      inner.status === "failed" || inner.status === "error";
    var detail = "";
    if (args) detail = typeof args === "string" ? args : safeJson(args);
    else if (result) detail = typeof result === "string" ? result : safeJson(result);
    else detail = textOf(item);
    return { name: String(name || "tool"), detail: detail.slice(0, 400), failed: failed };
  }

  function safeJson(value) {
    try { return JSON.stringify(value); } catch (error) { return String(value); }
  }

  /**
   * Reads the working-tree diff for the open session.
   *
   * Only the file list is fetched up front; a hunk is only worth rendering once
   * the reader opens that file, and a long diff on a phone is worse than a list.
   */
  function openDiff() {
    if (!state.sessionId) return;
    state.view = "diff";
    state.diff = null;
    state.error = null;
    render();
    call("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/diff")
      .then(function (result) { state.diff = result; render(); })
      .catch(function (error) {
        var message = error.message || "";
        // A session made without a project has no workspace; the Host's wording
        // for that is accurate but means nothing to a reader.
        state.error = message.indexOf("no project root") >= 0
          ? "This session has no project folder, so there is no workspace to diff."
          : message;
        render();
      });
  }

  function renderDiff() {
    var diff = state.diff;
    var body;
    if (state.error) {
      body = '<p class="error">' + esc(state.error) + '</p>';
    } else if (!diff) {
      body = '<div class="empty">Reading changes…</div>';
    } else if (!diff.repo) {
      body = '<div class="empty">This workspace is not a git repository, so there is nothing to diff.</div>';
    } else if (diff.clean) {
      body = '<div class="empty">No pending changes.</div>';
    } else {
      body = diff.files.map(renderDiffFile).join("");
      if (diff.truncated) body += '<p class="empty">More files changed than are listed.</p>';
    }
    app.innerHTML =
      '<header><button class="ghost" id="back">Back</button><h1>Changes</h1></header>' +
      '<main id="log">' + body + '</main>';
    document.getElementById("back").addEventListener("click", function () {
      state.view = "chat"; state.diff = null; render();
    });
  }

  /**
   * One changed file: collapsed to its path and line counts, expandable to the
   * hunks the Host already parsed.
   *
   * A binary file or one over the per-file cap has no hunks; the row still shows
   * the path and counts so the change is not invisible.
   */
  function renderDiffFile(file) {
    var counts = '<span class="diff-count">' +
      '<span class="add">+' + (file.additions || 0) + '</span> ' +
      '<span class="del">-' + (file.deletions || 0) + '</span></span>';
    var path = file.oldPath ? file.oldPath + ' → ' + file.path : file.path;
    var label = (file.status || "modified") + " · " + path;
    var hunks = (file.hunks || []).map(function (hunk) {
      var lines = (hunk.lines || []).map(function (line) {
        var sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
        return '<div class="diff-line ' + esc(line.type) + '">' + esc(sign + line.text) + '</div>';
      }).join("");
      return '<div class="diff-hunk"><div class="hunk-head">' + esc(hunk.header) + '</div>' + lines + '</div>';
    }).join("");
    var empty = '<p class="empty">' +
      (file.binary ? "Binary file." : file.tooLarge ? "Too large to show." : "No line changes.") + '</p>';
    return '<details class="diff-file"><summary>' +
      '<span class="diff-path">' + esc(label) + '</span>' + counts + '</summary>' +
      '<div class="diff-body">' + (hunks || empty) + '</div></details>';
  }

  /** Stops the running turn. The turn id comes from the live event stream. */
  function interrupt() {
    if (!state.activeTurnId) return;
    var turnId = state.activeTurnId;
    state.busy = true;
    render();
    call("/v1/turns/" + encodeURIComponent(turnId) + ":interrupt", { method: "POST", body: {} })
      .catch(function (error) { state.error = error.message; })
      .then(function () {
        state.busy = false;
        state.activeTurnId = null;
        render();
      });
  }

  function renderApprovals() {
    return state.approvals.map(function (approval) {
      var title = approval.title || approval.toolName || "Approval required";
      var detail = approval.summary || approval.question || "";
      var risk = approval.risk ? "  ·  " + approval.risk + " risk" : "";
      return '<div class="approval">' +
        '<h3>' + esc(title) + esc(risk) + '</h3>' +
        '<p>' + esc(detail) + '</p>' +
        '<div class="actions">' +
          '<button data-id="' + esc(approval.id) + '" data-decision="allow-once" data-revision="' + esc(approval.revision) + '">Allow once</button>' +
          '<button data-id="' + esc(approval.id) + '" data-decision="allow-session" data-revision="' + esc(approval.revision) + '">Allow session</button>' +
          '<button class="deny" data-id="' + esc(approval.id) + '" data-decision="deny" data-revision="' + esc(approval.revision) + '">Deny</button>' +
        '</div></div>';
    }).join("");
  }

  function respond(approvalId, decision, revision) {
    state.busy = true;
    render();
    call("/v1/approvals/" + encodeURIComponent(approvalId) + ":respond", {
      method: "POST",
      body: {
        approvalId: approvalId,
        decision: decision,
        context: {
          requestId: "mobile_" + Date.now(),
          idempotencyKey: "approval:" + approvalId + ":" + decision,
          expectedRevision: revision,
        },
      },
    }).then(function () {
      state.approvals = state.approvals.filter(function (a) { return a.id !== approvalId; });
    }).catch(function (error) {
      state.error = error.message;
    }).then(function () {
      state.busy = false;
      render();
    });
  }

  function loadSessions() {
    state.error = null;
    call("/v1/sessions").then(function (result) {
      var list = result.sessions || result || [];
      state.sessions = Array.isArray(list) ? list : [];
      state.view = "sessions";
      render();
    }).catch(function (error) {
      state.error = error.message;
      if (state.view !== "login") { state.view = "sessions"; render(); }
    });
  }

  /**
   * The text of one history item, or "" when it has none a reader would want.
   *
   * A stored item is an object whose "content" field is itself an object:
   * content.content holds a plain string for user turns and an array of typed
   * blocks for assistant turns. Passing that inner object to String() is what
   * produced a screen of [object Object].
   */
  function textOf(item) {
    if (!item) return "";
    var payload = item.content && typeof item.content === "object" ? item.content : item;
    if (payload.modelSystem) return "";
    var body = payload.content;
    if (typeof body === "string") return body;
    if (Array.isArray(body)) {
      return body
        .map(function (part) {
          if (typeof part === "string") return part;
          if (!part) return "";
          return part.text || part.content || "";
        })
        .filter(Boolean)
        .join("\\n");
    }
    if (typeof payload.text === "string") return payload.text;
    return "";
  }

  function roleOf(item) {
    if (!item) return "";
    var payload = item.content && typeof item.content === "object" ? item.content : item;
    return typeof payload.role === "string" ? payload.role : "";
  }

  function loadHistory() {
    return call("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/history").then(function (result) {
      var items = result.items || [];
      state.messages = items
        .map(function (item) {
          var role = roleOf(item);
          var tool = item.itemType === "tool" ? toolSummary(item) : null;
          return {
            itemType: item.itemType,
            role: role,
            text: textOf(item),
            toolName: tool ? tool.name : "",
            toolDetail: tool ? tool.detail : "",
            failed: tool ? tool.failed : false,
          };
        })
        .filter(function (message) {
          // System scaffolding is not part of the conversation; showing it as an
          // empty bubble is worse than not showing it at all.
          if (message.role === "system") return false;
          // A tool call is a step in the work even when none of it is readable.
          // Dropping it would hide that the agent acted at all.
          if (message.itemType === "tool") return true;
          return message.text.length > 0;
        });
      render();
    });
  }

  function openChat(sessionId) {
    closeStream();
    state.sessionId = sessionId;
    state.messages = [];
    state.approvals = [];
    state.view = "chat";
    state.busy = false;
    render();
    loadHistory().catch(function (error) { state.error = error.message; render(); });
    subscribe();
  }

  function submit(text) {
    state.busy = true;
    render();
    call("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/turns", {
      method: "POST",
      body: { input: { text: text }, context: { requestId: "mobile_" + Date.now() } },
    }).catch(function (error) {
      state.error = error.message;
    }).then(function () {
      state.busy = false;
      return loadHistory();
    });
  }

  function closeStream() {
    if (stream) { stream.abort(); stream = null; }
  }

  /**
   * Reads the SSE body with fetch: EventSource cannot send the Authorization
   * header, and a token in the URL is rejected by the Host.
   */
  function subscribe() {
    closeStream();
    var controller = new AbortController();
    stream = controller;
    fetch(base() + "/v1/sessions/" + encodeURIComponent(state.sessionId) + "/events", {
      headers: { authorization: "Bearer " + token() },
      signal: controller.signal,
    }).then(function (response) {
      if (!response.ok || !response.body) throw new Error("stream refused");
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      render();
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          var index;
          while ((index = buffer.indexOf("\\n\\n")) >= 0) {
            var frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            var data = frame.split("\\n").filter(function (line) { return line.indexOf("data: ") === 0; })
              .map(function (line) { return line.slice(6); }).join("\\n");
            if (!data) continue;
            handleEvent(data);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (error) {
      if (error.name === "AbortError") return;
      stream = null;
      state.error = "live updates stopped: " + error.message;
      render();
    });
  }

  function handleEvent(data) {
    var parsed;
    try { parsed = JSON.parse(data); } catch (e) { return; }
    if (parsed.subscriptionId) return;
    var params = parsed.params || {};
    var kind = params.kind || "";
    var turnId = params.turnId || (params.payload && params.payload.turnId) || "";

    // The Stop button only exists while a turn is live, and the live turn id is
    // the only way to interrupt it — the Host does not expose a "current turn"
    // lookup over HTTP.
    if (turnId) {
      var running = kind.indexOf("turn.") === 0 && kind !== "turn.completed" &&
        kind !== "turn.interrupted" && kind !== "turn.failed" && kind !== "turn.cancelled";
      var finished = kind === "turn.completed" || kind === "turn.interrupted" ||
        kind === "turn.failed" || kind === "turn.cancelled";
      if (running && state.activeTurnId !== turnId) {
        state.activeTurnId = turnId;
        render();
      } else if (finished && state.activeTurnId === turnId) {
        state.activeTurnId = null;
        render();
      }
    }
    // The Host is authoritative for transcript state, so a completed item simply
    // re-reads history instead of merging deltas client-side.
    if (kind === "approval.requested") {
      var request = (params.payload && params.payload.approval) || params.payload || {};
      if (!request.id) return;
      var known = state.approvals.some(function (a) { return a.id === request.id; });
      if (!known) { state.approvals = state.approvals.concat([request]); render(); }
      return;
    }
    if (kind === "approval.resolved") {
      var resolved = (params.payload && params.payload.approval) || params.payload || {};
      state.approvals = state.approvals.filter(function (a) { return a.id !== resolved.id; });
      render();
      return;
    }
    if (kind.indexOf("item.") === 0 || kind.indexOf("turn.") === 0) loadHistory().catch(function () {});
  }

  if (!token()) { state.view = "login"; render(); }
  else { state.view = "sessions"; render(); loadSessions(); }
})();
</script>
</body>
</html>
`;

const ASSETS: Record<string, StaticAsset> = {
  "/app": { body: HTML, contentType: "text/html; charset=utf-8" },
  "/": { body: HTML, contentType: "text/html; charset=utf-8" },
};

/** Only the shell is public; everything else falls through to the protocol. */
export function serveClientShell(pathname: string): StaticAsset | null {
  return ASSETS[pathname] ?? null;
}
