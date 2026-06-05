// ===========================================================
// ENDPOINT CATALOG
// ===========================================================
// Smart BASE — when served from local_ai_server.py via /gui mount, use same origin.
// When opened directly (file://) or from another origin, fall back to :7865.
// Tauri 2 on Windows serves bundled pages from http://tauri.localhost, so we
// must NOT use location.origin in that case (would point at the WebView itself).
const SEEKDEEP_BASE = (function() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:7865';
  if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
  if (window.__TAURI__ || (window.location.hostname || '') === 'tauri.localhost') {
    return 'http://127.0.0.1:7865';
  }
  const sameOrigin = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  if (sameOrigin && window.location.host) {
    // Drop the /gui prefix if present
    return window.location.origin;
  }
  return 'http://127.0.0.1:7865';
})();
const BASE = SEEKDEEP_BASE;

const ENDPOINTS = [
  // ======== HEALTH ========
  {
    group: 'STATUS',
    id: 'health', method: 'GET', path: '/health',
    title: 'Health',
    desc: 'Probe the local AI server. Returns currently-loaded model, CUDA state, keep-resident flags, and a nested <span class="mono">gpu</span> object with VRAM breakdown.',
    fields: [],
  },
  {
    group: 'STATUS',
    id: 'gpu', method: 'GET', path: '/gpu',
    title: 'GPU Snapshot',
    desc: 'One-shot VRAM read. Returns allocated / reserved / free / total MB plus utilization percentages and device name.',
    fields: [],
  },
  {
    group: 'STATUS',
    id: 'route_debug', method: 'GET', path: '/route/debug',
    title: 'Route Inspector',
    desc: 'Read-only routing diagnostic. Returns the full plan for a given role: which backend serves it, which model ID resolves, fallback chain, and (for HF) whether the model is already loaded or would require an evict-and-swap. The bot\'s regex-based <span class="mono">seekdeepSelectChatModelRole</span> still happens upstream in <span class="mono">index.js</span> — this endpoint describes what happens <em>after</em> role selection. Pass an optional <span class="mono">prompt</span> just to visualize the first 240 chars in the response.',
    fields: [
      { key: 'role', label: 'Role', type: 'select', options: ['default_chat','lightweight_chat','quality_text','reasoning_code','fallback_chat'], default: 'default_chat' },
      { key: 'prompt', label: 'Prompt (optional · echoes back the first 240 chars)', type: 'textarea', default: '' },
    ],
  },

  // ======== CHAT ========
  {
    group: 'GENERATION',
    id: 'chat', method: 'POST', path: '/chat',
    title: 'Chat',
    desc: 'Role-routed text generation. <span class="mono">role</span> selects which chat model loads: <span class="mono">default_chat</span> (Llama-3.1-8B), <span class="mono">quality_text</span>, <span class="mono">reasoning_code</span>, <span class="mono">lightweight_chat</span>, or <span class="mono">fallback_chat</span>.',
    fields: [
      { key: 'prompt', label: 'Prompt', type: 'textarea', required: true, default: 'What is bioluminescence?' },
      { key: 'role', label: 'Role', type: 'select', options: ['default_chat','quality_text','reasoning_code','lightweight_chat','fallback_chat'], default: 'default_chat' },
      { key: 'temperature', label: 'Temperature', type: 'number', default: 0.7, step: 0.05, min: 0, max: 2 },
      { key: 'max_new_tokens', label: 'Max new tokens', type: 'number', default: 1024 },
      { key: 'system_prompt', label: 'System prompt (optional)', type: 'textarea', default: '' },
    ],
  },

  // ======== IMAGE ========
  {
    group: 'GENERATION',
    id: 'image', method: 'POST', path: '/image',
    title: 'Image · txt2img',
    desc: 'SDXL generation through Dreamshaper-XL. <span class="mono">steps</span> 12/28/40 maps to quality low/standard/high. Default scheduler is <span class="mono">dpmsolver++</span>.',
    fields: [
      { key: 'prompt', label: 'Prompt', type: 'textarea', required: true, default: 'a colossal squid silhouetted at 10000m, bioluminescent, cinematic' },
      { key: 'negative_prompt', label: 'Negative prompt', type: 'textarea', default: 'blurry, low quality, watermark, signature' },
      { key: 'width', label: 'Width', type: 'number', default: 1024 },
      { key: 'height', label: 'Height', type: 'number', default: 1024 },
      { key: 'steps', label: 'Steps', type: 'number', default: 28 },
      { key: 'guidance_scale', label: 'Guidance scale', type: 'number', default: 7.0, step: 0.5 },
      { key: 'seed', label: 'Seed (-1 random)', type: 'number', default: -1 },
    ],
  },

  // ======== IMG2IMG ========
  {
    group: 'GENERATION',
    id: 'img2img', method: 'POST', path: '/img2img',
    title: 'Image · img2img',
    desc: 'Transform an image with a text prompt. Strength 0.05-1.0 — higher = more deviation from source. Reuses the Dreamshaper-XL pipeline.',
    fields: [
      { key: 'prompt', label: 'Prompt', type: 'textarea', required: true, default: 'same scene, black and white, film grain' },
      { key: 'image_b64', label: 'Image (base64)', type: 'textarea', default: '', desc: 'PNG/JPEG bytes encoded as base64. Server expects raw bytes or data-URI prefix.' },
      { key: 'strength', label: 'Strength', type: 'number', default: 0.6, step: 0.05, min: 0.05, max: 1 },
      { key: 'guidance_scale', label: 'Guidance scale', type: 'number', default: 5.0, step: 0.5 },
      { key: 'steps', label: 'Steps', type: 'number', default: 28 },
    ],
  },

  // ======== VISION ========
  {
    group: 'GENERATION',
    id: 'vision', method: 'POST', path: '/vision',
    title: 'Vision',
    desc: 'Qwen2.5-VL describes or OCRs an image. <span class="mono">mode</span>: <span class="mono">describe</span> (default) or <span class="mono">ocr</span>.',
    fields: [
      { key: 'prompt', label: 'Question', type: 'textarea', default: 'What is in this image?' },
      { key: 'image_b64', label: 'Image (base64)', type: 'textarea', default: '' },
      { key: 'mode', label: 'Mode', type: 'select', options: ['describe','ocr'], default: 'describe' },
      { key: 'max_new_tokens', label: 'Max tokens', type: 'number', default: 700 },
    ],
  },

  // ======== PIX2PIX ========
  {
    group: 'EDIT',
    id: 'pix2pix', method: 'POST', path: '/instruct-pix2pix',
    title: 'InstructPix2Pix',
    desc: 'Natural-language image editing — "make it darker", "add snow". Gated behind <span class="mono">SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX=on</span>.',
    fields: [
      { key: 'instruction', label: 'Instruction', type: 'textarea', required: true, default: 'make it darker' },
      { key: 'image_b64', label: 'Image (base64)', type: 'textarea', default: '' },
      { key: 'image_guidance_scale', label: 'Image guidance', type: 'number', default: 1.5, step: 0.1 },
      { key: 'guidance_scale', label: 'Text guidance', type: 'number', default: 9.0, step: 0.5 },
      { key: 'steps', label: 'Steps', type: 'number', default: 30 },
    ],
  },

  // ======== INPAINT ========
  {
    group: 'EDIT',
    id: 'inpaint', method: 'POST', path: '/inpaint',
    title: 'Inpaint · CLIPSeg + SDXL',
    desc: 'CLIPSeg builds an auto-mask from <span class="mono">remove_target</span>, then SDXL fills it. Gated behind <span class="mono">SEEKDEEP_FEATURE_INPAINT=on</span>.',
    fields: [
      { key: 'remove_target', label: 'Target to remove', type: 'text', required: true, default: 'the wizard' },
      { key: 'prompt', label: 'Replacement context', type: 'textarea', default: 'forest clearing, soft light' },
      { key: 'image_b64', label: 'Image (base64)', type: 'textarea', default: '' },
      { key: 'guidance_scale', label: 'Guidance scale', type: 'number', default: 5.0, step: 0.5 },
      { key: 'strength', label: 'Strength', type: 'number', default: 0.95, step: 0.05 },
      { key: 'steps', label: 'Steps', type: 'number', default: 30 },
    ],
  },

  // ======== UPSCALE ========
  {
    group: 'EDIT',
    id: 'upscale', method: 'POST', path: '/upscale',
    title: 'Upscale',
    desc: 'PIL Lanczos upscale with optional mild sharpening. <span class="mono">SEEKDEEP_UPSCALE_*</span> env knobs override sharpen radius/percent/threshold.',
    fields: [
      { key: 'image_b64', label: 'Image (base64)', type: 'textarea', default: '' },
      { key: 'scale', label: 'Scale', type: 'select', options: ['2','3','4'], default: '2' },
      { key: 'method', label: 'Method', type: 'select', options: ['lanczos','realesrgan'], default: 'lanczos' },
    ],
  },

  // ======== CHART ========
  {
    group: 'TOOLING',
    id: 'chart', method: 'POST', path: '/chart',
    title: 'Stats Chart',
    desc: 'Renders 30-day activity as a matplotlib line chart (Discord dark theme). Powers <span class="mono">@SeekDeep stats chart</span>.',
    fields: [
      // Backend ChartRequest.day_buckets is a date-keyed DICT, not
      // metric-keyed arrays. Previous default crashed the endpoint
      // with `'str' object has no attribute 'get'` because the
      // server iterated keys expecting per-day {images, chats, vision}.
      { key: 'day_buckets', label: 'Day buckets (JSON)', type: 'textarea',
        default: '{"2026-05-19":{"images":2,"chats":5,"vision":1},"2026-05-20":{"images":4,"chats":3,"vision":0},"2026-05-21":{"images":3,"chats":8,"vision":2},"2026-05-22":{"images":8,"chats":12,"vision":1},"2026-05-23":{"images":12,"chats":6,"vision":3},"2026-05-24":{"images":6,"chats":9,"vision":2},"2026-05-25":{"images":9,"chats":11,"vision":1},"2026-05-26":{"images":11,"chats":7,"vision":4}}',
        desc: 'Date-keyed dict: <span class="mono">{ "YYYY-MM-DD": { images, chats, vision } }</span>.' },
      { key: 'title', label: 'Chart title', type: 'text', default: 'SeekDeep · last 30 days' },
      { key: 'guild_name', label: 'Guild name (optional subtitle)', type: 'text', default: '' },
    ],
  },

  // ======== UNLOAD ========
  {
    group: 'TOOLING',
    id: 'unload', method: 'POST', path: '/unload',
    title: 'Unload',
    desc: 'Force-unload the currently resident model and clear CUDA cache. Useful when the task-LRU isn\'t aggressive enough. Token-required.',
    fields: [],
  },

  // ======== CONTROL CENTER WIRING (added during the post-v10.35 stabilization wave) ========
  {
    group: 'CONTROL',
    id: 'stats_snapshot', method: 'GET', path: '/stats/snapshot',
    title: 'Stats snapshot',
    desc: 'Aggregated dashboard payload: AI-server live counters (uptime, requests_24h, latency p50/p95, by_family_24h), bot lifetime totals (total_chats/images/vision, guild_count, user_count, 30-day day_buckets, by_persona / by_chat_model breakdowns), 30-day percent deltas, and HF cache size + Ollama tag count. Powers every Stats-pane widget in app.html. No token required.',
    fields: [],
  },
  {
    group: 'CONTROL',
    id: 'launchers_status', method: 'GET', path: '/launchers/status',
    title: 'Launcher status',
    desc: 'Per-service state for the Control Center launcher cards. Returns {services: {ai-server, bot, searxng}: {state, pid?, uptime_seconds?, started_at?}}. ai-server self-reports via os.getpid() (the request IS being served by it); searxng probes port 8080 via TCP; bot reads logs/bot.pid. No token required.',
    fields: [],
  },
  {
    group: 'CONTROL',
    id: 'cache_prune', method: 'POST', path: '/cache/prune',
    title: 'Prune HF cache',
    desc: 'Delete HuggingFace cache revisions that aren\'t referenced by any ref (i.e. orphaned downloads from older model versions). Returns {ok, freed_bytes, revisions_deleted, note}. Token-required (destructive).',
    fields: [],
  },
  {
    group: 'CONTROL',
    id: 'persona_get', method: 'GET', path: '/persona',
    title: 'Persona state',
    desc: 'Read the active global persona override + valid_personas list (built-in + any custom slugs from data/custom-personas.json). No token required.',
    fields: [],
  },
  {
    group: 'CONTROL',
    id: 'persona_post', method: 'POST', path: '/persona',
    title: 'Set persona',
    desc: 'Set or clear a global persona override. Body: {persona: "<slug>"} sets the override, {action: "clear"} removes it. Slug must be in valid_personas (built-in or a custom slug created via the Discord <span class="mono">@SeekDeep persona create</span> command). Token-required.',
    fields: [
      { key: 'persona', label: 'Persona slug', type: 'text', default: 'neurotic' },
      { key: 'scope',   label: 'Scope',        type: 'select', options: ['global','channel','server'], default: 'global' },
    ],
  },
  {
    group: 'CONTROL',
    id: 'memory_users', method: 'GET', path: '/memory/users',
    title: 'Memory · users',
    desc: 'Summary of every user with stored facts (Discord IDs + fact counts). Token-required after the v10.35.x sensitive-reads policy lockdown — user facts can contain arbitrary remembered text.',
    fields: [],
  },
];

// ===========================================================
// RAIL
// ===========================================================
const railEl = document.getElementById('epRail');
const groups = {};
ENDPOINTS.forEach(e => { groups[e.group] = groups[e.group] || []; groups[e.group].push(e); });
Object.entries(groups).forEach(([group, list]) => {
  const h = document.createElement('div');
  h.className = 'grp';
  h.textContent = group;
  railEl.appendChild(h);
  list.forEach(ep => {
    const el = document.createElement('div');
    el.className = 'ep';
    el.dataset.id = ep.id;
    el.innerHTML = `<span class="method ${ep.method.toLowerCase()}">${ep.method}</span><span class="path">${ep.path}</span><span class="ep-offline">OFFLINE</span>`;
    el.addEventListener('click', () => selectEndpoint(ep.id));
    railEl.appendChild(el);
  });
});

// Task 9 · drive per-rail-item offline state from a single /health ping (plus the bus when present).
// Timeout was 2000ms which was too tight — /health calls ollama_available()
// (up to 2s by itself) plus per-role backend resolution, so a healthy
// server with ollama configured often takes 2-3s to answer. Background
// probe was timing out RIGHT as the foreground SEND REQUEST succeeded —
// the rail showed every endpoint OFFLINE while the response panel
// showed a live 200 OK. Bumped to 8s to match what /health legitimately
// takes on a fully-loaded install.
async function probeBackendReachable() {
  try {
    // audit §5: retry via SeekDeepFetch when present (nav.js auto-loads it),
    // else fall back to a single native fetch.
    const r = (window.SeekDeepFetch && window.SeekDeepFetch.retry)
      ? await window.SeekDeepFetch.retry(BASE + '/health', { cache: 'no-store', attemptTimeoutMs: 4000, maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4000 })
      : await fetch(BASE + '/health', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}
function markAllOffline(off) {
  document.querySelectorAll('.ep').forEach(el => {
    if (off) el.setAttribute('data-offline', '');
    else el.removeAttribute('data-offline');
  });
}
async function refreshOfflineState() {
  const reachable = await probeBackendReachable();
  markAllOffline(!reachable);
}
// Initial + every 10s. Also flip on bus open/close when available.
refreshOfflineState();
setInterval(refreshOfflineState, 10_000);
function _wireBus() {
  if (!window.SeekDeepEvents || typeof window.SeekDeepEvents.on !== 'function') return false;
  window.SeekDeepEvents.on('_open',  () => markAllOffline(false));
  window.SeekDeepEvents.on('_close', () => markAllOffline(true));
  return true;
}
if (!_wireBus()) { let n=0; const iv=setInterval(()=>{if(_wireBus()||++n>30)clearInterval(iv);},250); }

// ===========================================================
// STATE
// ===========================================================
const STATE_KEY = 'seekdeep-api-explorer-v1';
let state = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
state.currentId = state.currentId || ENDPOINTS[0].id;
state.values = state.values || {};
function saveState() { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }

// ===========================================================
// REQUEST PANE RENDERER
// ===========================================================
const reqPane = document.getElementById('reqPane');
function currentEp() { return ENDPOINTS.find(e => e.id === state.currentId); }

function fieldEl(ep, f) {
  const v = (state.values[ep.id] && state.values[ep.id][f.key] != null)
    ? state.values[ep.id][f.key] : f.default;
  let control;
  if (f.type === 'textarea') {
    control = `<textarea data-key="${f.key}" placeholder="${(f.default||'').toString().replace(/"/g,'&quot;')}">${escape(v ?? '')}</textarea>`;
  } else if (f.type === 'select') {
    const opts = f.options.map(o => `<option value="${o}" ${o == v ? 'selected':''}>${o}</option>`).join('');
    control = `<select data-key="${f.key}">${opts}</select>`;
  } else if (f.type === 'number') {
    control = `<input type="number" data-key="${f.key}" value="${v ?? ''}" ${f.step?`step="${f.step}"`:''} ${f.min!=null?`min="${f.min}"`:''} ${f.max!=null?`max="${f.max}"`:''} />`;
  } else {
    control = `<input type="text" data-key="${f.key}" value="${escapeAttr(v ?? '')}" />`;
  }
  return `
    <div class="field">
      <label>
        <span>${f.label}</span>
        <span class="type">${f.type}</span>
        ${f.required ? '<span class="req-flag">REQUIRED</span>' : ''}
      </label>
      ${control}
      ${f.desc ? `<div class="desc">${f.desc}</div>` : ''}
    </div>
  `;
}

function renderRequest() {
  const ep = currentEp();
  document.querySelectorAll('.ep').forEach(el => el.classList.toggle('active', el.dataset.id === ep.id));

  const fieldsHTML = ep.fields.length
    ? ep.fields.map(f => fieldEl(ep, f)).join('')
    : '<div class="req-desc" style="color:var(--hull-3); font-family: var(--font-mono); font-size: 12px;">▸ No request body. Just <strong style="color:var(--cyan-1);">SEND</strong>.</div>';

  reqPane.innerHTML = `
    <div class="req-head">
      <h2><span class="method">${ep.method}</span>${ep.path}</h2>
      <span class="endpoint-meta">▸ ${ep.title}</span>
    </div>
    <p class="req-desc">${ep.desc}</p>
    ${fieldsHTML}
    <div class="send-row">
      <button class="btn btn-primary" id="sendBtn">▸ Send request</button>
      <button class="btn btn-ghost" id="resetBtn">Reset</button>
      <span class="latency" id="latencyLbl"></span>
    </div>
    <div class="curl-preview" id="curlPreview">
      <div class="ch"><span>CURL · <em style="font-style:normal; color:var(--cyan-1);">EQUIVALENT</em></span><button class="copy-btn" id="copyCurl">COPY</button></div>
      <pre id="curlBody"></pre>
    </div>
  `;

  // Field input listeners — persist values
  reqPane.querySelectorAll('[data-key]').forEach(el => {
    el.addEventListener('input', () => {
      state.values[ep.id] = state.values[ep.id] || {};
      state.values[ep.id][el.dataset.key] = el.value;
      saveState();
      refreshCurl();
    });
  });
  document.getElementById('sendBtn').addEventListener('click', sendRequest);
  document.getElementById('resetBtn').addEventListener('click', () => {
    delete state.values[ep.id];
    saveState();
    renderRequest();
    refreshCurl();
  });
  document.getElementById('copyCurl').addEventListener('click', (e) => {
    const txt = document.getElementById('curlBody').innerText;
    navigator.clipboard.writeText(txt).then(() => {
      const b = e.currentTarget;
      const orig = b.textContent;
      b.textContent = '✓ COPIED'; b.classList.add('copied');
      setTimeout(() => { b.textContent = orig; b.classList.remove('copied'); }, 1500);
    });
  });
  refreshCurl();
}

function buildBody() {
  const ep = currentEp();
  if (ep.method === 'GET' || ep.fields.length === 0) return null;
  const body = {};
  ep.fields.forEach(f => {
    let v = (state.values[ep.id] && state.values[ep.id][f.key] != null)
      ? state.values[ep.id][f.key] : f.default;
    if (f.type === 'number') v = (v === '' || v == null) ? null : Number(v);
    if (f.key === 'day_buckets' && typeof v === 'string') {
      try { v = JSON.parse(v); } catch {}
    }
    if (v !== '' && v != null) body[f.key] = v;
  });
  return body;
}

function buildQueryString(ep) {
  // For GET endpoints that carry fields (e.g. /route/debug), serialize them as query params.
  if (ep.method !== 'GET' || !ep.fields || !ep.fields.length) return '';
  const params = [];
  ep.fields.forEach(f => {
    let v = (state.values[ep.id] && state.values[ep.id][f.key] != null) ? state.values[ep.id][f.key] : f.default;
    if (v == null || v === '') return;
    params.push(encodeURIComponent(f.key) + '=' + encodeURIComponent(v));
  });
  return params.length ? '?' + params.join('&') : '';
}

function refreshCurl() {
  const ep = currentEp();
  const body = buildBody();
  const qs = buildQueryString(ep);
  // XSS-safe: prettyJSON returns the raw user-entered body, which can contain
  // "<script>" tokens. Build the curl preview with textContent everywhere
  // except the prompt-sign chip. Previously innerHTML interpolation here was
  // a self-XSS surface, and a same-origin XSS in the GUI can call GET /token
  // to bypass auth on every write endpoint.
  const host = document.getElementById('curlBody');
  if (!host) return;
  host.innerHTML = '';
  const prompt = document.createElement('span');
  prompt.className = 'pmt';
  prompt.textContent = '$';
  host.appendChild(prompt);
  host.appendChild(document.createTextNode(' curl -X ' + ep.method + ' ' + BASE + ep.path + qs));
  if (body) {
    host.appendChild(document.createTextNode(' \\\n      -H "Content-Type: application/json" \\\n      -d \'' + prettyJSON(body, true) + '\''));
  }
}

function escape(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/"/g,'&quot;');
}

// ===========================================================
// JSON PRETTY-PRINTER + SYNTAX HIGHLIGHTER
// ===========================================================
function prettyJSON(obj, plain = false) {
  let s = JSON.stringify(obj, null, 2);
  if (plain) return s;
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/("(?:\\.|[^"\\])*"):/g, '<span class="key">$1</span>:')
    .replace(/: "((?:\\.|[^"\\])*)"/g, ': <span class="str">"$1"</span>')
    .replace(/: (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi, ': <span class="num">$1</span>')
    .replace(/: (true|false)/g, ': <span class="bool">$1</span>')
    .replace(/: (null)/g, ': <span class="null">$1</span>');
}

// ===========================================================
// SEND REQUEST
// ===========================================================
const respPane = document.getElementById('respPane');
function setLiveMode(mode) {
  // Null-guard: `liveModePill` was a designer placeholder that never
  // got rendered. Calls to this function used to throw
  // "Cannot read properties of null (reading 'classList')" which the
  // global error surface caught and turned into a red toast — visible
  // to the user as a SEEKDEEP UNHANDLED PROMISE notification on every
  // SEND REQUEST. Now it's a no-op if the target isn't there. The
  // actual live/offline display happens via setStatus + the rail's
  // refreshOfflineState pass.
  const pill = document.getElementById('liveModePill');
  if (!pill) return;
  if (mode === 'live') {
    pill.classList.add('on'); pill.classList.remove('warn');
    pill.innerHTML = '<span class="dot"></span>LIVE · :7865';
  } else if (mode === 'mock' || mode === 'offline') {
    pill.classList.remove('on'); pill.classList.add('warn');
    pill.innerHTML = '<span class="dot"></span>OFFLINE · :7865';
  } else {
    pill.classList.remove('on'); pill.classList.remove('warn');
    pill.innerHTML = '<span class="dot"></span>STANDBY';
  }
}

async function sendRequest() {
  const ep = currentEp();
  const body = buildBody();
  const t0 = performance.now();
  document.getElementById('latencyLbl').textContent = '';
  setStatus('loading');
  respPane.querySelector('.resp-empty')?.remove();
  // try real fetch
  let response = null, ok = false, error = null;
  try {
    const opts = { method: ep.method, signal: AbortSignal.timeout(15000), cache: 'no-store' };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(BASE + ep.path + buildQueryString(ep), opts);
    const dt = Math.round(performance.now() - t0);
    const ct = r.headers.get('Content-Type') || '';
    if (ct.includes('image/')) {
      const blob = await r.blob();
      response = { __image: true, url: URL.createObjectURL(blob), size: blob.size, type: ct };
    } else {
      try { response = await r.json(); }
      catch { response = { raw: await r.text() }; }
    }
    ok = r.ok;
    renderResponse({ ep, ok, status: r.status, dt, body: response });
    setLiveMode('live');
  } catch (e) {
    const dt = Math.round(performance.now() - t0);
    error = String(e && e.message || e);
    setStatus('err');
    setLiveMode('mock');
    renderResponse({ ep, ok: false, status: 0, dt, body: mockResponse(ep, body), error });
  }
}

function setStatus(s, code) {
  const el = document.getElementById('respStatus');
  if (!el) return;
  el.className = 'resp-status ' + s;
  el.textContent = (s === 'ok' ? '200 OK' : s === 'err' ? 'OFFLINE · unreachable' : s === 'loading' ? 'SENDING…' : 'IDLE').replace('200', code || '200');
}

function renderResponse({ ep, ok, status, dt, body, error }) {
  setStatus(ok ? 'ok' : 'err', status);
  document.getElementById('latencyLbl').innerHTML = `▸ <em>${dt}</em> ms · ${ok ? status + ' OK' : (status || 'OFFLINE')}`;
  const meta = `
    <div class="resp-meta">
      <div class="resp-meta-tile"><div class="lbl">STATUS</div><div class="v">${ok ? status + ' OK' : (status || 'offline')}</div></div>
      <div class="resp-meta-tile"><div class="lbl">LATENCY</div><div class="v">${dt} ms</div></div>
      <div class="resp-meta-tile"><div class="lbl">ENDPOINT</div><div class="v">${ep.method} ${ep.path}</div></div>
    </div>
  `;

  let bodyHTML;
  if (body && body.__image) {
    bodyHTML = `<div class="resp-image"><img src="${escapeAttr(body.url)}" alt="response image" /></div>`;
  } else {
    bodyHTML = `
      <div class="resp-body">
        <div class="rh"><span>RESPONSE BODY · <em style="font-style:normal; color:var(--cyan-1);">${ok ? 'LIVE' : 'OFFLINE · canned sample below'}</em></span><button class="copy-btn" id="copyResp">COPY</button></div>
        <pre>${prettyJSON(body)}</pre>
      </div>
    `;
  }

  // Task 13 · Route Inspector — render a fallback-chain visualization above the raw JSON.
  let inspectorHTML = '';
  if (ep.id === 'route_debug' && body && body.role_resolved) {
    inspectorHTML = renderRouteInspector(body);
  }

  respPane.innerHTML = `
    <div class="resp-head">
      <h2>RESPONSE</h2>
      <span class="resp-status ${ok ? 'ok' : 'err'}" id="respStatus">${ok ? status + ' OK' : 'OFFLINE · unreachable'}</span>
    </div>
    ${error ? `<div style="color:var(--bad); font-family:var(--font-mono); font-size:12px; padding:8px 12px; background: rgba(255,107,107,0.05); border:1px solid rgba(255,107,107,0.3); border-radius: var(--r-sm); margin-bottom: 14px;">▸ FETCH ERROR · ${escape(error)} · showing canned sample response below</div>` : ''}
    ${meta}
    ${inspectorHTML}
    ${bodyHTML}
  `;
  // Wire copy button
  const cp = document.getElementById('copyResp');
  if (cp) {
    cp.addEventListener('click', e => {
      navigator.clipboard.writeText(prettyJSON(body, true)).then(() => {
        const orig = e.currentTarget.textContent;
        e.currentTarget.textContent = '✓ COPIED';
        e.currentTarget.classList.add('copied');
        setTimeout(() => { e.currentTarget.textContent = orig; e.currentTarget.classList.remove('copied'); }, 1500);
      });
    });
  }
}

// ===========================================================
// ROUTE INSPECTOR — fallback chain visualization (Task 13)
// ===========================================================
function renderRouteInspector(r) {
  const remote = r.endpoint && r.endpoint.external === true;
  const swap   = r.endpoint && r.endpoint.would_swap === true;
  const loaded = r.endpoint && r.endpoint.already_loaded === true;
  const backendTag = (b) => {
    const cls = b === 'hf' ? 'cyan' : b === 'ollama' ? '' : 'warn';
    const label = b === 'hf' ? 'HF' : b === 'ollama' ? 'OLLAMA' : '⚠ ' + (b||'').toUpperCase();
    return `<span class="pill ${cls}" style="padding:2px 8px;"><span class="dot"></span>${label}</span>`;
  };
  const stateTag = swap ? `<span class="pill warn" style="padding:2px 8px;"><span class="dot"></span>WOULD SWAP</span>`
                : loaded ? `<span class="pill cyan" style="padding:2px 8px;"><span class="dot"></span>ALREADY LOADED</span>`
                : remote ? `<span class="pill warn" style="padding:2px 8px;"><span class="dot"></span>REMOTE · PROMPTS LEAVE BOX</span>`
                         : `<span class="pill" style="padding:2px 8px;"><span class="dot"></span>CACHED</span>`;

  const fallbackHTML = (r.fallback_chain || []).length
    ? `<div class="ri-section">
         <div class="ri-section-h">FALLBACK CHAIN · ${r.auto_fallback_enabled ? 'auto' : 'manual only'}</div>
         <div class="ri-chain">
           <div class="ri-node primary">
             <div class="ri-node-h">
               <span class="ri-role">${escape(r.role_resolved)}</span>
               ${backendTag(r.backend)}
             </div>
             <div class="ri-model">${escape(r.model_id || '—')}</div>
           </div>
           ${r.fallback_chain.map(fc => `
             <div class="ri-arrow">▸</div>
             <div class="ri-node">
               <div class="ri-node-h">
                 <span class="ri-role">${fc.role}</span>
                 ${backendTag(fc.backend)}
               </div>
               <div class="ri-model">${escape(fc.model_id || '—')}</div>
             </div>
           `).join('')}
         </div>
       </div>`
    : `<div class="ri-section"><div class="ri-section-h">FALLBACK CHAIN</div><div class="ri-empty">· no fallback configured · this role is the terminal stop</div></div>`;

  const resolvedDiff = r.role_resolved !== r.role_requested
    ? `<div class="ri-note ri-warn">▸ requested role <span class="mono">${escape(r.role_requested)}</span> resolved to <span class="mono">${escape(r.role_resolved)}</span> (the requested role isn’t configured · the AI server fell through)</div>`
    : '';

  const promptPreview = r.prompt_preview
    ? `<div class="ri-section"><div class="ri-section-h">PROMPT PREVIEW · 240 char cap</div><div class="ri-pre">${escape(r.prompt_preview)}</div></div>`
    : '';

  return `
    <div class="route-inspector">
      <div class="ri-head">
        <div>
          <h3>ROUTE INSPECTOR</h3>
          <div class="ri-sub">dispatch plan for role <span class="mono" style="color:var(--cyan-1)">${escape(r.role_resolved)}</span></div>
        </div>
        ${stateTag}
      </div>
      ${resolvedDiff}
      <div class="ri-grid">
        <div class="ri-tile"><div class="ri-lbl">BACKEND</div><div class="ri-v">${(r.backend||'').toUpperCase()}</div></div>
        <div class="ri-tile"><div class="ri-lbl">MODEL ID</div><div class="ri-v mono">${escape(r.model_id || '—')}</div></div>
        <div class="ri-tile"><div class="ri-lbl">EST VRAM</div><div class="ri-v">${Number.isFinite(r.endpoint?.estimated_vram_mb) ? r.endpoint.estimated_vram_mb + ' MB' : '—'}</div></div>
      </div>
      ${fallbackHTML}
      ${promptPreview}
      ${r.note ? `<div class="ri-note"><strong>NOTE ·</strong> ${escape(r.note)}</div>` : ''}
    </div>
  `;
}

// ===========================================================
// MOCK RESPONSES (when server is offline)
// ===========================================================
function mockResponse(ep, body) {
  switch (ep.id) {
    case 'health':
      return {
        device: 'cuda:0',
        cuda_available: true,
        model: 'meta-llama/Llama-3.1-8B-Instruct',
        loaded: 'default_chat',
        keep_resident: { default_chat: false, vision: false, image: false },
        gpu: { allocated_mb: 5240, reserved_mb: 6100, free_mb: 17800, total_mb: 24576, used_mb: 6100, used_pct: 24.8, reserved_pct: 24.8 }
      };
    case 'gpu':
      return {
        allocated_mb: 5240, reserved_mb: 6100, free_mb: 17800, total_mb: 24576,
        used_mb: 6100, used_pct: 24.8, reserved_pct: 24.8,
        loaded: 'default_chat',
        keep_resident: { default_chat: false, vision: false, image: false },
        device_name: 'NVIDIA GeForce RTX 4090 Laptop GPU'
      };
    case 'chat':
      return {
        role: body?.role || 'default_chat',
        model: 'meta-llama/Llama-3.1-8B-Instruct',
        response: 'Bioluminescence is the production and emission of light by living organisms, typically through a chemical reaction involving luciferin and luciferase. It is most common in marine creatures — anglerfish, dinoflagellates, ctenophores — where it functions as defense, mate attraction, or prey lure.',
        prompt_tokens: 14,
        completion_tokens: 84,
        elapsed_ms: 1240,
        web_search_used: false
      };
    case 'image':
      return {
        seed: 8842,
        steps: body?.steps || 28,
        scheduler: 'dpmsolver++',
        width: body?.width || 1024, height: body?.height || 1024,
        elapsed_ms: 16780,
        bytes: 1287456,
        prompt: body?.prompt || ''
      };
    case 'vision':
      return {
        model: 'Qwen/Qwen2.5-VL-3B-Instruct',
        mode: body?.mode || 'describe',
        response: 'A deep-sea cephalopod, likely a colossal squid (Mesonychoteuthis hamiltoni), in low-visibility water below 8000m. Bioluminescent dapples are visible along the mantle.',
        elapsed_ms: 1840
      };
    case 'pix2pix':
      return { ok: true, elapsed_ms: 5200, image_b64: '<binary png bytes elided>', note: 'mock — server offline' };
    case 'inpaint':
      return {
        target: body?.remove || '',
        mask_area_pct: 12.4,
        elapsed_ms: 8900,
        image_b64: '<binary png bytes elided>',
        note: 'mock — server offline'
      };
    case 'upscale':
      return { ok: true, scale: body?.scale || '2', method: body?.method || 'lanczos', elapsed_ms: 220, bytes: 4400000, note: 'mock — server offline' };
    case 'chart':
      return { ok: true, elapsed_ms: 480, format: 'png', bytes: 28400, note: 'mock — server offline' };
    case 'unload':
      return { ok: true, unloaded: 'default_chat', freed_mb: 5240 };
    case 'route_debug':
      return {
        ok: true,
        prompt_preview: (body?.prompt || '').slice(0, 240),
        role_requested: body?.role || 'default_chat',
        role_resolved:  body?.role || 'default_chat',
        backend:        'hf',
        model_id:       'meta-llama/Llama-3.1-8B-Instruct',
        endpoint: {
          external: false,
          already_loaded: true,
          would_swap: false,
          currently_loaded_role: 'default_chat',
          currently_loaded_model_id: 'meta-llama/Llama-3.1-8B-Instruct',
          estimated_vram_mb: 5500,
        },
        fallback_chain: [
          { role: 'fallback_chat', backend: 'hf', model_id: 'ibm-granite/granite-3.3-8b-instruct' },
        ],
        auto_fallback_enabled: true,
        note: 'Role-selection regex heuristics live in index.js seekdeepSelectChatModelRole; this endpoint describes the dispatch plan for a pre-selected role.',
      };
    default:
      return { note: 'no mock available' };
  }
}

// ===========================================================
// SELECTION
// ===========================================================
function selectEndpoint(id) {
  state.currentId = id;
  saveState();
  renderRequest();
}
renderRequest();
