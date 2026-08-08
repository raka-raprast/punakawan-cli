// Read-only web dashboard for watching pkwn sessions live — session list
// with status, click through to a session's conversation log, streamed
// live over the same `/v1/sessions/:id/attach` WS the CLI's own `sessions
// attach` and the chat TUI use. No build step: one self-contained HTML
// string, vanilla JS, served straight off the daemon's existing HTTP API
// (`/v1/sessions`, `/v1/sessions/:id`, WS attach) — same auth as every
// other route (`?token=` in the URL works, since a browser tab can't set
// a bearer header on navigation).
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pkwn dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; background: #0d1117; color: #c9d1d9; }
  header { padding: 10px 16px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 14px; margin: 0; color: #58a6ff; font-weight: 600; }
  header .hint { color: #6e7681; font-size: 12px; }
  #layout { display: flex; height: calc(100vh - 41px); }
  #sessions { width: 320px; overflow-y: auto; border-right: 1px solid #21262d; flex-shrink: 0; }
  .session-row { padding: 10px 14px; border-bottom: 1px solid #161b22; cursor: pointer; }
  .session-row:hover { background: #161b22; }
  .session-row.active { background: #1c2333; border-left: 3px solid #58a6ff; padding-left: 11px; }
  .session-row .title { font-weight: 600; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session-row .meta { color: #6e7681; font-size: 11px; margin-top: 3px; display: flex; gap: 6px; align-items: center; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
  .badge.running { background: #1a7f37; color: #fff; animation: pulse 1.4s ease-in-out infinite; }
  .badge.idle { background: #30363d; color: #8b949e; }
  .badge.error, .badge.rate_limited { background: #a40e26; color: #fff; }
  .badge.interrupted, .badge.stopped { background: #9a6700; color: #fff; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #transcript-header { padding: 10px 16px; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; }
  #transcript-header .live { font-size: 11px; }
  #transcript-header .live.on { color: #3fb950; }
  #transcript-header .live.off { color: #6e7681; }
  #transcript { flex: 1; overflow-y: auto; padding: 16px; }
  #empty { color: #6e7681; padding: 40px; text-align: center; }
  .bubble { max-width: 80%; margin-bottom: 14px; padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
  .bubble.user { background: #1c2333; margin-left: auto; border: 1px solid #30363d; }
  .bubble.assistant { background: #161b22; border: 1px solid #21262d; }
  .bubble.assistant.streaming { border-color: #58a6ff; }
  .bubble.tool { background: #0d1520; border: 1px solid #21262d; font-size: 12px; }
  .bubble.tool .cmd { color: #d29922; }
  .bubble.tool .out { color: #8b949e; margin-top: 6px; white-space: pre-wrap; max-height: 240px; overflow-y: auto; }
  .bubble.tool.error { border-color: #a40e26; }
  .bubble.error { background: #2d0a0f; border: 1px solid #a40e26; color: #ffb3b8; }
  .bubble.sys { color: #6e7681; font-style: italic; font-size: 11px; background: none; border: none; padding: 2px 0; }
  .row { display: flex; }
  #compose { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid #21262d; }
  #compose input { flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 8px 10px; font: inherit; }
  #compose button { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer; }
  #compose button:disabled { background: #21262d; color: #6e7681; cursor: not-allowed; }
  #keygate { position: fixed; inset: 0; background: #0d1117; display: flex; align-items: center; justify-content: center; }
  #keygate input { width: 320px; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 10px; font: inherit; }
  #keygate button { margin-left: 8px; background: #238636; color: #fff; border: none; border-radius: 6px; padding: 10px 16px; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<div id="keygate" style="display:none">
  <div>
    <div style="margin-bottom:8px;color:#8b949e">This daemon requires an API key.</div>
    <input id="keyinput" placeholder="PKWN_API_KEY" autofocus>
    <button onclick="saveKey()">Connect</button>
  </div>
</div>
<header>
  <h1>pkwn</h1>
  <span class="hint" id="conn-hint"></span>
</header>
<div id="layout">
  <div id="sessions"></div>
  <div id="main">
    <div id="transcript-header">
      <span id="transcript-title">select a session</span>
      <span class="live off" id="live-indicator">○ not attached</span>
    </div>
    <div id="transcript"><div id="empty">Pick a session on the left to watch its conversation live.</div></div>
    <div id="compose" style="display:none">
      <input id="compose-input" placeholder="Send a message to this session…" onkeydown="if(event.key==='Enter')sendCompose()">
      <button id="compose-btn" onclick="sendCompose()">Send</button>
    </div>
  </div>
</div>
<script>
let token = new URLSearchParams(location.search).get('token') || localStorage.getItem('pkwn_token') || '';
let activeId = null;
let ws = null;
let bubbleByToolId = {};
let streamingBubble = null;

function saveKey() {
  token = document.getElementById('keyinput').value.trim();
  localStorage.setItem('pkwn_token', token);
  document.getElementById('keygate').style.display = 'none';
  boot();
}

function authedFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(path + (token ? sep + 'token=' + encodeURIComponent(token) : ''));
}

function relTime(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshSessions() {
  let data;
  try {
    const res = await authedFetch('/v1/sessions');
    if (res.status === 401) { showKeygate(); return; }
    data = await res.json();
  } catch { return; }
  const container = document.getElementById('sessions');
  const sorted = [...data.sessions].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  container.innerHTML = sorted.map((s) => \`
    <div class="session-row \${s.id === activeId ? 'active' : ''}" onclick="openSession('\${s.id}')">
      <div class="title">\${escapeHtml(s.title || '(untitled)')}</div>
      <div class="meta">
        <span class="badge \${s.status}">\${s.status}</span>
        <span>\${s.backend}</span>
        <span>\${relTime(s.updatedAt)}</span>
      </div>
    </div>\`).join('') || '<div id="empty">No sessions yet.</div>';
}

function clearTranscript() {
  document.getElementById('transcript').innerHTML = '';
  bubbleByToolId = {};
  streamingBubble = null;
}

function addBubble(role, text, extraClass) {
  const t = document.getElementById('transcript');
  const el = document.createElement('div');
  el.className = 'bubble ' + role + (extraClass ? ' ' + extraClass : '');
  el.textContent = text;
  t.appendChild(el);
  t.scrollTop = t.scrollHeight;
  return el;
}

function addToolBubble(id, name, input) {
  const t = document.getElementById('transcript');
  const el = document.createElement('div');
  el.className = 'bubble tool';
  el.innerHTML = '<div class="cmd">▸ ' + escapeHtml(name) + '</div><div>' + escapeHtml(typeof input === 'string' ? input : JSON.stringify(input)) + '</div><div class="out">running…</div>';
  t.appendChild(el);
  t.scrollTop = t.scrollHeight;
  bubbleByToolId[id] = el;
}

function setLive(on, label) {
  const el = document.getElementById('live-indicator');
  el.className = 'live ' + (on ? 'on' : 'off');
  el.textContent = (on ? '● ' : '○ ') + label;
}

// Normalizes both a REST TranscriptEntry ({direction, payload}) and a raw
// live-WS AgentEvent into one incremental rendering pass, so history
// replay and live updates share the exact same code path.
function applyEntry(direction, event) {
  if (direction === 'in') {
    streamingBubble = null;
    addBubble('user', event.text);
    return;
  }
  switch (event.type) {
    case 'text':
      if (!streamingBubble) streamingBubble = addBubble('assistant', event.text, 'streaming');
      else streamingBubble.textContent = event.text;
      if (!event.partial) { streamingBubble.classList.remove('streaming'); streamingBubble = null; }
      break;
    case 'tool_call':
      addToolBubble(event.id, event.name, event.input);
      break;
    case 'tool_result': {
      const el = bubbleByToolId[event.id];
      if (el) {
        const out = el.querySelector('.out');
        out.textContent = typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
        if (event.isError) el.classList.add('error');
      }
      break;
    }
    case 'error':
      streamingBubble = null;
      addBubble('error', '⚠️ ' + event.message);
      break;
    case 'warning':
      addBubble('sys', '⚠ ' + event.message);
      break;
    case 'turn_complete':
      streamingBubble = null;
      break;
    default:
      break; // started/usage/reasoning — no visible bubble, keeps the log readable
  }
}

async function openSession(id) {
  activeId = id;
  clearTranscript();
  document.getElementById('compose').style.display = 'flex';
  document.getElementById('empty')?.remove();
  refreshSessions();
  if (ws) { ws.close(); ws = null; }

  const res = await authedFetch('/v1/sessions/' + id + '?tail=200');
  const meta = await res.json();
  document.getElementById('transcript-title').textContent = (meta.title || meta.id) + '  ·  ' + meta.backend + '  ·  ' + meta.cwd;
  for (const entry of meta.transcriptTail) applyEntry(entry.direction, entry.payload.text !== undefined && entry.direction === 'in' ? entry.payload : entry.payload);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/v1/sessions/' + id + '/attach' + (token ? '?token=' + encodeURIComponent(token) : ''));
  ws.onopen = () => setLive(true, 'live');
  ws.onclose = () => setLive(false, 'disconnected');
  ws.onerror = () => setLive(false, 'error');
  ws.onmessage = (msg) => {
    try { applyEntry('out', JSON.parse(msg.data)); } catch {}
    refreshSessions();
  };
}

function sendCompose() {
  const input = document.getElementById('compose-input');
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  applyEntry('in', { text });
  ws.send(JSON.stringify({ text }));
  input.value = '';
}

function showKeygate() {
  document.getElementById('keygate').style.display = 'flex';
}

async function boot() {
  document.getElementById('conn-hint').textContent = location.host;
  const res = await authedFetch('/healthz');
  if (res.ok) {
    // healthz never requires auth — confirm the *real* key by hitting an
    // authed route before assuming we're actually allowed in.
    const check = await authedFetch('/v1/sessions');
    if (check.status === 401) { showKeygate(); return; }
  }
  await refreshSessions();
  setInterval(refreshSessions, 4000);
}
boot();
</script>
</body>
</html>
`;
