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
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111114; --fg: #ececf1; --muted: #9a9aa6; --line: #26262e;
      --card: #1a1a20; --accent: #5b8cff; --accent-fg: #0b0b0e; --danger: #ff6b5e;
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
  .msg.tool { background: transparent; border: 1px dashed var(--line); color: var(--muted); font-size: 13px; }
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
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: #2ecc71; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  var TOKEN_KEY = "racp.token";
  var app = document.getElementById("app");
  var state = { view: "loading", sessions: [], sessionId: null, messages: [], error: null, busy: false };
  var stream = null;

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
    return fetch(path, {
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

  function render() {
    if (state.view === "login") return renderLogin();
    if (state.view === "sessions") return renderSessions();
    if (state.view === "chat") return renderChat();
    app.innerHTML = '<main><div class="empty">Connecting…</div></main>';
  }

  function renderLogin() {
    app.innerHTML =
      '<header><h1>QianNing Agent</h1></header>' +
      '<main>' +
        '<p class="empty">Paste the device token issued on your computer.</p>' +
        '<form id="login">' +
          '<span class="field"><label for="t">Device token</label>' +
            '<input id="t" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="pdt1.…"></span>' +
          '<button type="submit">Connect</button>' +
        '</form>' +
        '<p class="error" id="err"></p>' +
      '</main>';
    var form = document.getElementById("login");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = document.getElementById("t").value.trim();
      if (!value) return;
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
      '<header><h1>Sessions</h1><button class="ghost" id="signout">Sign out</button></header>' +
      '<main>' + (items || '<div class="empty">No sessions yet.</div>') +
        (state.error ? '<p class="error">' + esc(state.error) + '</p>' : '') +
      '</main>';
    Array.prototype.forEach.call(document.querySelectorAll(".row"), function (node) {
      node.addEventListener("click", function () { openChat(node.getAttribute("data-id")); });
    });
    document.getElementById("signout").addEventListener("click", function () {
      setToken(""); state.view = "login"; render();
    });
  }

  function renderChat() {
    var messages = state.messages.map(function (message) {
      var kind = message.role === "user" ? "user" : message.itemType === "tool" ? "tool" : "agent";
      return '<div class="msg ' + kind + '">' + esc(message.text || "") + '</div>';
    }).join("");
    app.innerHTML =
      '<header><button class="ghost" id="back">Back</button><h1>Conversation</h1>' +
        '<span class="dot' + (stream ? " live" : "") + '" title="' + (stream ? "live" : "offline") + '"></span></header>' +
      '<main id="log">' + (messages || '<div class="empty">No messages yet.</div>') +
        (state.error ? '<p class="error">' + esc(state.error) + '</p>' : '') +
      '</main>' +
      '<div class="composer">' +
        '<textarea id="text" rows="1" placeholder="Message…"></textarea>' +
        '<button id="send"' + (state.busy ? " disabled" : "") + '>Send</button>' +
      '</div>';
    document.getElementById("back").addEventListener("click", function () {
      closeStream(); state.view = "sessions"; state.sessionId = null; render(); loadSessions();
    });
    var send = document.getElementById("send");
    send.addEventListener("click", function () {
      var field = document.getElementById("text");
      var text = field.value.trim();
      if (!text) return;
      field.value = "";
      submit(text);
    });
    var log = document.getElementById("log");
    log.scrollTop = log.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
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

  function loadHistory() {
    return call("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/history").then(function (result) {
      var items = result.items || [];
      state.messages = items.map(function (item) {
        var payload = item.payload || item;
        return {
          itemType: payload.itemType || item.itemType,
          role: payload.role || (payload.itemType === "message" ? payload.role : undefined),
          text: payload.text || payload.content || (typeof payload === "string" ? payload : ""),
        };
      });
      render();
    });
  }

  function openChat(sessionId) {
    closeStream();
    state.sessionId = sessionId;
    state.messages = [];
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
    fetch("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/events", {
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
    // The Host is authoritative for transcript state, so a completed item simply
    // re-reads history instead of merging deltas client-side.
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
