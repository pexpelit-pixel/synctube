// Cloudflare Worker: SyncTube batch adder + HTML interface
// Optional KV binding: SYNC_ROOM_STATE

const API_BASE = "https://sync-tube.de/api";
const WS_BASE = "wss://sync-tube.de/ws";
const ROOM_BASE = "https://sync-tube.de/room";
const EVENT_PLAYLIST_ADD = 30;
const STATE_KEY = "sync_room_state";
const MEMORY_STATE = {
  room_id: null,
  room_url: null,
  created_at: null,
  last_validated_at: null,
  added_keys: [],
};

function now() {
  return Math.floor(Date.now() / 1000);
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function textResponse(text, init = {}) {
  return new Response(text, {
    status: init.status || 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bundleWd(text) {
  let binary = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary).replace(/\//g, "-");
}

function normalizeVideoItem(item) {
  const title = String(item.title || item.name || item.id || "Untitled");
  const src = item.video_url || item.src || item.url;
  if (!src || typeof src !== "string") {
    throw new Error(`Invalid video item, missing video_url/url/src: ${JSON.stringify(item)}`);
  }
  return { title, src };
}

function buildVideoKey(item) {
  const vid = String(item.id || "").trim();
  const src = String(item.video_url || item.src || item.url || "").trim();
  const title = String(item.title || "").trim();
  if (vid) return `id:${vid}`;
  if (src) return `src:${src}`;
  return `title:${title}`;
}

function makeRoomState(roomId) {
  return {
    room_id: roomId,
    room_url: `${ROOM_BASE}/${roomId}`,
    created_at: now(),
    last_validated_at: now(),
    added_keys: [],
  };
}

async function loadState(env) {
  try {
    if (env?.SYNC_ROOM_STATE?.get) {
      const raw = await env.SYNC_ROOM_STATE.get(STATE_KEY);
      if (!raw) return structuredClone(MEMORY_STATE);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return structuredClone(MEMORY_STATE);
      parsed.room_id ??= null;
      parsed.room_url ??= null;
      parsed.created_at ??= null;
      parsed.last_validated_at ??= null;
      parsed.added_keys = Array.isArray(parsed.added_keys) ? parsed.added_keys : [];
      return parsed;
    }
  } catch (_) {}
  return structuredClone(MEMORY_STATE);
}

async function saveState(env, state) {
  const safe = {
    room_id: state?.room_id ?? null,
    room_url: state?.room_url ?? null,
    created_at: state?.created_at ?? null,
    last_validated_at: state?.last_validated_at ?? null,
    added_keys: Array.isArray(state?.added_keys) ? state.added_keys : [],
    join_info: state?.join_info ?? undefined,
  };

  try {
    if (env?.SYNC_ROOM_STATE?.put) {
      await env.SYNC_ROOM_STATE.put(STATE_KEY, JSON.stringify(safe));
      return;
    }
  } catch (_) {}

  MEMORY_STATE.room_id = safe.room_id;
  MEMORY_STATE.room_url = safe.room_url;
  MEMORY_STATE.created_at = safe.created_at;
  MEMORY_STATE.last_validated_at = safe.last_validated_at;
  MEMORY_STATE.added_keys = safe.added_keys;
}

async function apiJson(url, init = {}) {
  const resp = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      origin: "https://sync-tube.de",
      referer: "https://sync-tube.de/",
      ...(init.headers || {}),
    },
  });
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!resp.ok) {
    const message =
      typeof data === "string"
        ? data
        : JSON.stringify(data).slice(0, 500);
    throw new Error(`HTTP ${resp.status}: ${message}`);
  }
  return data;
}

async function createRoom() {
  const data = await apiJson(`${API_BASE}/create`, {
    method: "POST",
  });
  if (!data || typeof data !== "object" || !data.id) {
    throw new Error(`Invalid create response: ${JSON.stringify(data)}`);
  }
  return String(data.id);
}

async function joinRoom(roomId) {
  return await apiJson(`${API_BASE}/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: roomId,
      preferences: { user: null },
    }),
  });
}

function buildWsUrl(roomId, userPref = null) {
  const token = bundleWd(JSON.stringify({ user: userPref }, null, 0));
  return `${WS_BASE}/${roomId}/${token}`;
}

async function isRoomActive(roomId) {
  try {
    const info = await joinRoom(roomId);
    if (!info || typeof info !== "object") return false;
    if (info.error) return false;
    if (info.id && String(info.id) !== String(roomId)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function restoreRoomStateForCurrentRoom(roomState, roomId) {
  if (String(roomState?.room_id || "") !== String(roomId)) {
    return makeRoomState(roomId);
  }
  roomState.added_keys = Array.isArray(roomState.added_keys) ? roomState.added_keys : [];
  return roomState;
}

async function ensureExistingOrNewRoom(env, forceNew = false) {
  const state = await loadState(env);

  if (!forceNew && state?.room_id) {
    const roomId = String(state.room_id);
    if (await isRoomActive(roomId)) {
      state.last_validated_at = now();
      await saveState(env, state);
      return state;
    }
  }

  const roomId = await createRoom();
  const joinInfo = await joinRoom(roomId);
  const newState = makeRoomState(roomId);
  newState.join_info = joinInfo;
  await saveState(env, newState);
  return newState;
}

class SyncTubeWS {
  constructor(roomId) {
    this.roomId = roomId;
    this.wsUrl = buildWsUrl(roomId, null);
    this.ws = null;
    this.messages = [];
    this.waiters = new Set();
    this.nonceSeq = 0;
    this.closed = false;
  }

  _wakeAll() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async connect() {
    this.close();

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    this.closed = false;

    ws.addEventListener("message", (event) => {
      this.messages.push(
        typeof event.data === "string" ? event.data : String(event.data)
      );
      this._wakeAll();
    });

    ws.addEventListener("close", () => {
      this.closed = true;
      this._wakeAll();
    });

    ws.addEventListener("error", () => {
      this.closed = true;
      this._wakeAll();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("WebSocket open timeout"));
      }, 15000);

      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );

      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("WebSocket connection failed"));
        },
        { once: true }
      );
    });

    await this.recvAll(1000, 5);
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
    }
    this.ws = null;
    this.closed = true;
    this._wakeAll();
  }

  connected() {
    return !!this.ws && this.ws.readyState === 1;
  }

  async waitForMessage(timeoutMs) {
    if (this.messages.length > 0) return true;
    if (this.closed) return false;

    return await new Promise((resolve) => {
      const onWake = () => {
        clearTimeout(timer);
        this.waiters.delete(onWake);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(onWake);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(onWake);
    });
  }

  async recvAll(timeout = 1000, maxMessages = 20) {
    const out = [];
    const deadline = Date.now() + timeout;

    while (out.length < maxMessages) {
      if (this.messages.length > 0) {
        out.push(this.messages.shift());
        continue;
      }

      const left = deadline - Date.now();
      if (left <= 0) break;
      const ok = await this.waitForMessage(left);
      if (!ok) break;
    }

    return out;
  }

  sendRequest(eventCode, payload) {
    if (!this.ws || !this.connected()) {
      throw new Error("WebSocket not connected");
    }
    const nonce = Date.now() + this.nonceSeq++;
    const frame = [eventCode, payload, nonce];
    this.ws.send(JSON.stringify(frame));
    return nonce;
  }

  async addOne({
    mediaUrl,
    insertTop = false,
    asPlaylist = false,
    waitTimeout = 2000,
    maxMessages = 30,
  }) {
    const payload = { src: mediaUrl };
    if (asPlaylist) payload.playlist = true;
    if (insertTop) payload.position = 0;

    const nonce = this.sendRequest(EVENT_PLAYLIST_ADD, payload);
    const replies = await this.recvAll(waitTimeout, maxMessages);

    let response = null;
    for (const msg of replies) {
      try {
        const data = JSON.parse(msg);
        if (Array.isArray(data) && data.length === 3 && data[2] === nonce) {
          response = data;
          break;
        }
      } catch (_) {}
    }

    let success = true;
    let error = null;

    if (response !== null) {
      if (response[1] === null) {
        success = true;
      } else if (response[1] && typeof response[1] === "object") {
        success = response[1].success ?? true;
        error = response[1].error ?? null;
      }
    }

    return {
      nonce,
      payload,
      response,
      all_replies: replies,
      success,
      error,
    };
  }
}

async function refreshOrRotateRoom(env, currentRoomState, ws, forceNew = false) {
  let sameRoom = false;

  if (currentRoomState?.room_id) {
    sameRoom = await isRoomActive(String(currentRoomState.room_id));
  }

  if (sameRoom && !forceNew) {
    const roomId = String(currentRoomState.room_id);
    if (!ws || ws.roomId !== roomId || !ws.connected()) {
      ws = new SyncTubeWS(roomId);
      await ws.connect();
      await ws.recvAll(1000, 5);
    }
    currentRoomState.last_validated_at = now();
    await saveState(env, currentRoomState);
    return [currentRoomState, ws];
  }

  const newRoomState = await ensureExistingOrNewRoom(env, true);
  const roomId = String(newRoomState.room_id);

  if (ws) ws.close();
  ws = new SyncTubeWS(roomId);
  await ws.connect();
  await ws.recvAll(1000, 5);

  return [newRoomState, ws];
}

async function batchAdd({
  env,
  roomState,
  ws,
  videos,
  delay = 0.35,
  insertTop = false,
  asPlaylist = false,
  refreshRoomEvery = 50,
  log = () => {},
}) {
  const results = [];
  let addedKeys = new Set((roomState.added_keys || []).map(String));
  let roomId = String(roomState.room_id);
  const total = videos.length;

  await ws.recvAll(1000, 5);

  for (let idx = 1; idx <= total; idx++) {
    const item = videos[idx - 1];
    const { title, src: mediaUrl } = normalizeVideoItem(item);
    const key = buildVideoKey(item);

    if (addedKeys.has(key)) {
      log(`[${idx}/${total}] SKIP - ${title} (duplikat di room ${roomId})`);
      results.push({
        index: idx,
        title,
        video_id: item.id,
        media_url: mediaUrl,
        room_id: roomId,
        success: true,
        skipped: true,
        reason: "duplicate",
      });
      continue;
    }

    try {
      const result = await ws.addOne({
        mediaUrl,
        insertTop: insertTop && idx === 1,
        asPlaylist,
        waitTimeout: 2000,
        maxMessages: 30,
      });

      result.index = idx;
      result.title = title;
      result.video_id = item.id;
      result.media_url = mediaUrl;
      result.room_id = roomId;
      result.skipped = false;

      const ok = !!result.success;
      if (ok) {
        addedKeys.add(key);
        roomState.added_keys = Array.from(addedKeys).sort();
        roomState.last_validated_at = now();
        roomState.room_id = roomId;
        roomState.room_url = `${ROOM_BASE}/${roomId}`;
        await saveState(env, roomState);
      }

      results.push(result);
      log(`[${idx}/${total}] ${ok ? "OK" : "FAIL"} - ${title}`);
    } catch (exc) {
      log(`[${idx}/${total}] ROOM DOWN - ${title} - ${exc?.message || exc}`);
      let currentState = await loadState(env);
      currentState = restoreRoomStateForCurrentRoom(currentState, roomId);
      [currentState, ws] = await refreshOrRotateRoom(env, currentState, ws, true);
      roomState = currentState;
      roomId = String(roomState.room_id);
      addedKeys = new Set((roomState.added_keys || []).map(String));

      results.push({
        index: idx,
        title,
        video_id: item.id,
        media_url: mediaUrl,
        room_id: roomId,
        success: false,
        skipped: false,
        error: exc?.message || String(exc),
        room_rotated: true,
      });
    }

    if (refreshRoomEvery > 0 && idx % refreshRoomEvery === 0 && idx !== total) {
      if (!(await isRoomActive(roomId))) {
        let currentState = await loadState(env);
        currentState = restoreRoomStateForCurrentRoom(currentState, roomId);
        [currentState, ws] = await refreshOrRotateRoom(env, currentState, ws, true);
        roomState = currentState;
        roomId = String(roomState.room_id);
        addedKeys = new Set((roomState.added_keys || []).map(String));
      }
    }

    if (delay > 0 && idx !== total) {
      await new Promise((r) => setTimeout(r, Math.max(0, delay * 1000)));
    }
  }

  return { results, roomState, ws };
}

async function loadVideosJsonText(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error("video.json harus berisi array/list JSON");
  }

  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || typeof data[i] !== "object" || Array.isArray(data[i])) {
      throw new Error(`Item ke-${i + 1} bukan object JSON`);
    }
    normalizeVideoItem(data[i]);
    out.push(data[i]);
  }
  return out;
}

function makeHtml() {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SyncTube Batch Worker</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1020;
      --card: #111833;
      --muted: #9aa4c7;
      --text: #ecf2ff;
      --line: #263055;
      --accent: #7c9cff;
      --accent2: #8de1ff;
      --bad: #ff7f9f;
      --ok: #77e6a7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top, rgba(124,156,255,.18), transparent 32%),
        radial-gradient(circle at bottom right, rgba(141,225,255,.12), transparent 26%),
        var(--bg);
      color: var(--text);
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      display: grid;
      gap: 8px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 44px);
      letter-spacing: -0.04em;
    }
    .sub {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.1fr .9fr;
      gap: 16px;
    }
    @media (max-width: 920px) {
      .grid { grid-template-columns: 1fr; }
    }
    .card {
      background: rgba(17,24,51,.88);
      border: 1px solid rgba(38,48,85,.95);
      border-radius: 20px;
      padding: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,.2);
      backdrop-filter: blur(10px);
    }
    label {
      display: block;
      margin: 0 0 8px;
      font-size: 13px;
      color: var(--muted);
    }
    input[type="text"], input[type="number"], textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: #091025;
      color: var(--text);
      border-radius: 14px;
      padding: 12px 14px;
      outline: none;
      transition: border-color .15s, transform .15s;
    }
    textarea {
      min-height: 430px;
      resize: vertical;
      line-height: 1.45;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    input:focus, textarea:focus {
      border-color: rgba(124,156,255,.85);
    }
    .row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    .row4 {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }
    @media (max-width: 680px) {
      .row, .row4 { grid-template-columns: 1fr; }
    }
    .checks {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    .checks label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      color: var(--muted);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 14px;
    }
    button {
      border: 0;
      border-radius: 14px;
      padding: 12px 16px;
      cursor: pointer;
      font-weight: 700;
      color: #08101e;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      box-shadow: 0 10px 30px rgba(124,156,255,.25);
    }
    button.secondary {
      background: #1a2446;
      color: var(--text);
      border: 1px solid var(--line);
      box-shadow: none;
    }
    button:disabled { opacity: .65; cursor: not-allowed; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      background: #08101e;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      min-height: 180px;
      max-height: 640px;
      overflow: auto;
    }
    .muted { color: var(--muted); }
    .tiny { font-size: 12px; color: var(--muted); }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(124,156,255,.12);
      border: 1px solid rgba(124,156,255,.22);
      color: #d7e0ff;
      font-size: 12px;
      width: fit-content;
    }
    .ok { color: var(--ok); }
    .bad { color: var(--bad); }
    .split {
      display: grid;
      gap: 10px;
    }
    .footer {
      margin-top: 14px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    code.inline {
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.08);
      padding: 2px 6px;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="pill">SyncTube batch adder • Cloudflare Worker</div>
      <h1>Tambah playlist dari JSON, langsung dari browser</h1>
      <p class="sub">Paste array JSON video, lalu Worker akan bikin room, cek duplikat, dan kirim item satu per satu.</p>
    </div>

    <div class="grid">
      <div class="card">
        <label for="videoJson">video.json</label>
        <textarea id="videoJson" spellcheck="false">[
  {
    "title": "Contoh Video",
    "video_url": "https://example.com/video.mp4"
  }
]</textarea>

        <div class="actions">
          <input id="fileInput" type="file" accept=".json,application/json" hidden />
          <button id="loadFileBtn" type="button" class="secondary">Load file JSON</button>
          <button id="runBtn" type="button">Jalankan</button>
        </div>

        <div class="footer">
          Format tiap item minimal punya <code class="inline">video_url</code> atau <code class="inline">src</code> atau <code class="inline">url</code>.
        </div>
      </div>

      <div class="card split">
        <div class="row">
          <div>
            <label for="roomId">Room ID</label>
            <input id="roomId" type="text" placeholder="Kosongkan untuk pakai room tersimpan / baru" />
          </div>
          <div>
            <label for="delay">Delay (detik)</label>
            <input id="delay" type="number" min="0" step="0.05" value="0.35" />
          </div>
        </div>

        <div class="row">
          <div>
            <label for="refreshEvery">Refresh room tiap N item</label>
            <input id="refreshEvery" type="number" min="0" step="1" value="50" />
          </div>
          <div>
            <label for="stateInfo">State</label>
            <input id="stateInfo" type="text" readonly placeholder="Memuat..." />
          </div>
        </div>

        <div class="checks">
          <label><input id="insertTop" type="checkbox" /> insert-top</label>
          <label><input id="asPlaylist" type="checkbox" /> as-playlist</label>
          <label><input id="forceNewRoom" type="checkbox" /> force-new-room</label>
        </div>

        <div>
          <label>Hasil</label>
          <pre id="output">{}</pre>
        </div>
      </div>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);

    async function loadState() {
      const out = $("stateInfo");
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        const data = await r.json();
        out.value = data.room_id ? \`\${data.room_id} • \${data.room_url || ""}\` : "Belum ada room";
      } catch (e) {
        out.value = "State tidak tersedia";
      }
    }

    $("loadFileBtn").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const text = await file.text();
      $("videoJson").value = text;
    });

    $("runBtn").addEventListener("click", async () => {
      const btn = $("runBtn");
      const out = $("output");
      btn.disabled = true;
      out.textContent = "Memproses...";

      try {
        const body = {
          video_json: $("videoJson").value,
          room_id: $("roomId").value.trim() || null,
          delay: Number($("delay").value || 0.35),
          insert_top: $("insertTop").checked,
          as_playlist: $("asPlaylist").checked,
          force_new_room: $("forceNewRoom").checked,
          refresh_room_every: Number($("refreshEvery").value || 50),
        };

        const resp = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        const text = await resp.text();
        try {
          const data = JSON.parse(text);
          out.textContent = JSON.stringify(data, null, 2);
        } catch {
          out.textContent = text;
        }

        await loadState();
      } catch (e) {
        out.textContent = String(e && e.stack ? e.stack : e);
      } finally {
        btn.disabled = false;
      }
    });

    loadState();
  </script>
</body>
</html>`;
}

async function handleRun(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Body JSON tidak valid" }, { status: 400 });
  }

  const videoText = String(body.video_json || "");
  const delay = Number.isFinite(Number(body.delay)) ? Number(body.delay) : 0.35;
  const insertTop = !!body.insert_top;
  const asPlaylist = !!body.as_playlist;
  const forceNewRoom = !!body.force_new_room;
  const refreshRoomEvery = Number.isFinite(Number(body.refresh_room_every))
    ? Number(body.refresh_room_every)
    : 50;

  let roomState;
  let roomId;

  if (body.room_id && String(body.room_id).trim()) {
    roomId = String(body.room_id).trim();
    roomState = makeRoomState(roomId);
    roomState.join_info = await joinRoom(roomId);
    await saveState(env, roomState);
  } else {
    roomState = await ensureExistingOrNewRoom(env, forceNewRoom);
    roomId = String(roomState.room_id);
  }

  roomState = restoreRoomStateForCurrentRoom(roomState, roomId);
  const roomUrl = `${ROOM_BASE}/${roomId}`;

  try {
    const joinInfo = await joinRoom(roomId);
    roomState.join_info = joinInfo;
    roomState.last_validated_at = now();
    roomState.room_url = roomUrl;
    roomState.room_id = roomId;
    await saveState(env, roomState);
  } catch (_) {
    if (forceNewRoom) {
      roomState = await ensureExistingOrNewRoom(env, true);
    } else if (await isRoomActive(roomId)) {
      roomState = restoreRoomStateForCurrentRoom(await loadState(env), roomId);
    } else {
      roomState = await ensureExistingOrNewRoom(env, true);
    }
    roomId = String(roomState.room_id);
  }

  const ws = new SyncTubeWS(roomId);
  await ws.connect();

  const videos = await loadVideosJsonText(videoText);

  const logs = [];
  const log = (line) => logs.push(line);

  const { results, roomState: finalState } = await batchAdd({
    env,
    roomState,
    ws,
    videos,
    delay,
    insertTop,
    asPlaylist,
    refreshRoomEvery,
    log,
  });

  const finalMessages = await ws.recvAll(1000, 20);

  const successCount = results.filter((r) => r.success && !r.skipped).length;
  const skipCount = results.filter((r) => r.skipped).length;
  const failCount = results.filter((r) => !r.success && !r.skipped).length;

  finalState.last_validated_at = now();
  finalState.room_id = roomId;
  finalState.room_url = roomUrl;
  await saveState(env, finalState);

  ws.close();

  return jsonResponse({
    room_id: roomId,
    room_url: roomUrl,
    join_info: finalState.join_info || null,
    total: results.length,
    success: successCount,
    skipped: skipCount,
    failed: failCount,
    results,
    logs,
    final_messages: finalMessages,
  });
}

async function handleState(env) {
  const state = await loadState(env);
  return jsonResponse(state);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/") {
      return new Response(makeHtml(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (request.method === "GET" && path === "/api/state") {
      return handleState(env);
    }

    if (request.method === "POST" && path === "/api/run") {
      return handleRun(request, env);
    }

    return textResponse("Not Found", { status: 404 });
  },
};
