(function () {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  // ---- Task 4 · model row state from model.loaded / model.evicted ----
  function setRowState(role, label, cls) {
    const row = document.querySelector(`.model-row[data-role="${role}"]`);
    if (!row) return;
    const slot = row.querySelector('[data-role-state]');
    if (!slot) return;
    slot.innerHTML = `<span class="pill ${cls}" style="padding: 2px 6px;"><span class="dot"></span>${label}</span>`;
  }

  function applyHealth(h) {
    if (!h || !h.chat_backends) return;
    for (const [role, backend] of Object.entries(h.chat_backends)) {
      const row = document.querySelector(`.model-row[data-role="${role}"]`);
      if (!row) continue;
      row.dataset.backend = backend;
      const chip = row.querySelector('.m-backend');
      if (chip) {
        chip.className = 'm-backend ' + (backend === 'hf' ? 'hf'
                                       : backend === 'ollama' ? 'ollama'
                                       : 'remote');
        chip.textContent = backend === 'hf' ? 'HF'
                          : backend === 'ollama' ? 'OL'
                          : '⚠ ' + backend.toUpperCase();
        chip.title = backend === 'hf' ? 'Local Hugging Face'
                    : backend === 'ollama' ? 'Local Ollama daemon'
                    : 'Remote · prompts leave the local machine';
      }
    }
    // If chat_backends says a role is remote but model.loaded never fires, mark it CACHED-equivalent
    const remoteRoles = Object.entries(h.chat_backends).filter(([, b]) => b !== 'hf' && b !== 'ollama').map(([r]) => r);
    remoteRoles.forEach(r => {
      const row = document.querySelector(`.model-row[data-role="${r}"]`);
      if (row && row.querySelector('[data-role-state] .pill')?.textContent?.trim() === 'CACHED') {
        setRowState(r, 'REMOTE', 'warn');
      }
    });
  }

  function probeHealth() {
    const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
    fetch(base + '/health', { signal: AbortSignal.timeout(3000), cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(applyHealth)
      .catch(() => {});
  }
  setTimeout(probeHealth, 800);
  setInterval(probeHealth, 30_000);

  function attachModelBus() {
    if (!window.SeekDeepEvents || typeof window.SeekDeepEvents.on !== 'function') return false;
    window.SeekDeepEvents.on('model.loaded', (d) => {
      if (d.role) setRowState(d.role, 'RESIDENT', 'cyan');
    });
    window.SeekDeepEvents.on('model.evicted', (d) => {
      if (d.role) setRowState(d.role, 'CACHED', '');
    });
    // Footer sb-queue + launcher card svcQueue: track queue.depth events
    // from the AI server's in-flight middleware. Both were hardcoded "0"
    // forever even when the server was processing requests. Sum chat+
    // image+vision.
    const sbQueue = document.getElementById('sb-queue');
    const svcQueue = document.getElementById('svcQueue');
    if (sbQueue || svcQueue) {
      window.SeekDeepEvents.on('queue.depth', (d) => {
        if (!d) return;
        const n = (d.chat || 0) + (d.image || 0) + (d.vision || 0);
        const txt = String(n);
        if (sbQueue)  sbQueue.textContent = txt;
        if (svcQueue) svcQueue.textContent = txt;
      });
    }
    // ---- GPU pane: VRAM sparkline ------------------------------------
    // Buffer the last 60 vram.sample events (~10 minutes at 10s cadence)
    // and redraw an SVG sparkline. Was "— VRAM history sampler not
    // shipped" placeholder; the sampler IS shipped (server-side
    // _start_vram_sampler in local_ai_server.py emits vram.sample every
    // 10s while at least one WS subscriber is connected), the page just
    // never bound it.
    const sparkLine = document.getElementById('gpuVramSparkLine');
    const sparkFill = document.getElementById('gpuVramSparkFill');
    const sparkMeta = document.getElementById('gpuVramSparkMeta');
    if (sparkLine && sparkFill) {
      const SPARK_W = 600, SPARK_H = 80, SPARK_MAX = 60;
      const samples = [];  // [{t, used_mb, total_mb}]
      function redrawSpark() {
        if (samples.length < 2) return;
        const totalMb = samples[samples.length - 1].total_mb || 1;
        // Slice + remap to SVG viewBox coords. used_mb / total_mb → 0..1, then * SPARK_H, inverted.
        const w = SPARK_W / Math.max(1, SPARK_MAX - 1);
        const pts = samples.slice(-SPARK_MAX).map((s, i) => {
          const x = i * w;
          const pct = Math.max(0, Math.min(1, (s.used_mb || 0) / (s.total_mb || totalMb || 1)));
          const y = SPARK_H - pct * SPARK_H;
          return [x, y];
        });
        const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
        const fill = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + SPARK_H + ' L0,' + SPARK_H + ' Z';
        sparkLine.setAttribute('d', line);
        sparkFill.setAttribute('d', fill);
        if (sparkMeta) {
          const peakMb = Math.max(...samples.slice(-SPARK_MAX).map(s => s.used_mb || 0));
          const lastMb = samples[samples.length - 1].used_mb || 0;
          sparkMeta.textContent = `samples ${samples.length} · last ${(lastMb/1024).toFixed(1)} GB · peak ${(peakMb/1024).toFixed(1)} GB of ${((samples[samples.length-1].total_mb||0)/1024).toFixed(0)} GB · ${samples.length * 10}s window`;
        }
      }
      window.SeekDeepEvents.on('vram.sample', (d) => {
        if (!d || d.used_mb == null || d.total_mb == null) return;
        samples.push({ t: Date.now(), used_mb: Number(d.used_mb) || 0, total_mb: Number(d.total_mb) || 0 });
        if (samples.length > SPARK_MAX) samples.splice(0, samples.length - SPARK_MAX);
        redrawSpark();
      });
    }
    return true;
  }
  if (!attachModelBus()) {
    let n = 0; const iv = setInterval(() => { if (attachModelBus() || ++n > 30) clearInterval(iv); }, 250);
  }

  // ---- Task 5 · logs viewer ----
  const logsWrap = $('#logs-wrap');
  const pill     = $('#logsModePill');
  const pauseBtn = $('#logsPauseBtn');
  const clearBtn = $('#logsClearBtn');
  if (!logsWrap || !pill) return;

  let paused = false;
  let liveMode = false;
  let lineCount = 0;
  const MAX_LINES = 500;

  function setMode(mode) {
    liveMode = mode === 'live';
    pill.classList.remove('on', 'warn', 'cyan', 'bad');
    pill.style.cursor = ''; pill.onclick = null;
    if (mode === 'live') { pill.classList.add('cyan'); pill.innerHTML = '<span class="dot"></span>LIVE · /events'; pill.title = 'Live log streaming is on — pushing each line as it happens.'; }
    else if (mode === 'poll') {
      // Live streaming needs the log bus on (SEEKDEEP_EMIT_LOG_LINES). Make the
      // pill a one-click deep-link to that setting instead of just naming the
      // env var — no "go edit your .env" dead-end.
      pill.classList.add('warn');
      pill.innerHTML = '<span class="dot"></span>POLL · /logs/tail';
      pill.title = 'Live log streaming is off — click to turn it on in All Settings, then ↻ Restart bot. Until then, polling /logs/tail every 3s.';
      pill.style.cursor = 'pointer';
      pill.onclick = () => { location.href = 'settings.html#SEEKDEEP_EMIT_LOG_LINES'; };
    }
    else { pill.innerHTML = '<span class="dot"></span>OFFLINE'; pill.title = 'no source available'; }
  }
  setMode('poll');

  function appendLine(d) {
    if (paused) return;
    if (lineCount === 0) logsWrap.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'log-line';
    const level = (d.level || 'info').toLowerCase();
    const colorMap = { info: 'var(--cyan-1)', warn: 'var(--warn)', warning: 'var(--warn)', error: 'var(--bad)', err: 'var(--bad)', debug: 'var(--hull-3)' };
    const time = d.ts ? new Date(d.ts).toLocaleTimeString('en-US', { hour12: false }) : new Date().toLocaleTimeString('en-US', { hour12: false });
    row.style.fontFamily = 'var(--font-mono)';
    row.style.fontSize = '12px';
    row.style.padding = '5px 14px';
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '90px 60px 90px 1fr';
    row.style.gap = '12px';
    row.style.lineHeight = '1.6';
    row.style.borderBottom = '1px solid color-mix(in oklab, var(--cyan-1) 5%, transparent)';
    // Build the four columns with createElement + textContent so untrusted
    // log fields (d.src, d.msg) can never break out into markup. textContent
    // means no manual escaping is needed. Styling/colors preserved exactly.
    const timeSpan = document.createElement('span');
    timeSpan.style.color = 'var(--hull-3)';
    timeSpan.textContent = time;
    const levelSpan = document.createElement('span');
    levelSpan.style.color = colorMap[level] || 'var(--hull-2)';
    levelSpan.style.textTransform = 'uppercase';
    levelSpan.style.letterSpacing = '0.12em';
    levelSpan.style.fontSize = '10px';
    levelSpan.textContent = level;
    const srcSpan = document.createElement('span');
    srcSpan.style.color = 'var(--hull-3)';
    srcSpan.textContent = d.src || '—';
    const msgSpan = document.createElement('span');
    msgSpan.style.color = 'var(--hull-2)';
    msgSpan.textContent = d.msg || '';
    row.appendChild(timeSpan);
    row.appendChild(levelSpan);
    row.appendChild(srcSpan);
    row.appendChild(msgSpan);
    logsWrap.appendChild(row);
    lineCount++;
    while (lineCount > MAX_LINES) { logsWrap.firstChild?.remove(); lineCount--; }
    logsWrap.scrollTop = logsWrap.scrollHeight;
  }

  pauseBtn?.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });
  clearBtn?.addEventListener('click', () => {
    logsWrap.innerHTML = '<div class="log-line" style="grid-template-columns:1fr; padding:14px; color:var(--hull-3); font-style:italic;">▸ cleared · waiting for new lines</div>';
    lineCount = 0;
  });

  function attachLogBus() {
    if (!window.SeekDeepEvents || typeof window.SeekDeepEvents.on !== 'function') return false;
    let liveSeen = false;
    window.SeekDeepEvents.on('log.line', (d) => {
      if (!liveSeen) { liveSeen = true; setMode('live'); }
      appendLine(d);
    });
    window.SeekDeepEvents.on('_open',  () => { /* live status driven by first log.line */ });
    window.SeekDeepEvents.on('_close', () => setMode('offline'));
    // Probe: if we don't see a log.line in 6s, assume EMIT_LOG_LINES=off and fall back to poll mode
    setTimeout(() => { if (!liveSeen) setMode('poll'); }, 6000);
    return true;
  }
  // Fall back to /logs/tail polling when bus isn't pumping log.line.
  // Returns true on a good poll, false on a failed fetch, null when skipped
  // (live bus active, paused, or tab hidden) — the scheduler backs off only on
  // real failures.
  //
  // Dedup cursor: /logs/tail returns the last N lines on EVERY poll, so without
  // a cursor the same lines re-append every ~3s (the common idle case flooded
  // the viewer with ~100 dupes/min and pushed real history out of the 500-line
  // ring). /logs/tail is a sliding window, so on each poll it advances by `d`
  // new lines and prev.slice(d) lines up with the head of the new batch. We
  // track the WHOLE previous batch's signatures and find that alignment, then
  // append only the lines after the overlap. Matching the overlapping SEQUENCE
  // (not just the last-line signature) is what makes consecutive identical
  // lines — repeated warnings / heartbeats / idle — dedupe correctly instead of
  // silently dropping a genuinely-new repeat. (Lines may be plain strings or
  // {level,src,msg,ts} objects — ts is usually undefined, so sigs ignore it.)
  let _prevLogSigs = null;
  function logLineSig(ln) {
    if (ln && typeof ln === 'object') return `${ln.ts || ''}|${ln.level || ''}|${ln.src || ''}|${ln.msg || ''}`;
    return String(ln);
  }
  function newLinesStart(prevSigs, newSigs) {
    if (!prevSigs || !prevSigs.length) return 0;          // first poll → show all
    // Start at the smallest d whose overlap fits within newSigs — any smaller d
    // gives overlap > newSigs.length, which can't align, so we'd only skip it.
    // Largest viable overlap first; no overlap → falls through to return 0.
    for (let d = Math.max(0, prevSigs.length - newSigs.length); d < prevSigs.length; d++) {
      const overlap = prevSigs.length - d;
      let ok = true;
      for (let i = 0; i < overlap; i++) {
        if (prevSigs[d + i] !== newSigs[i]) { ok = false; break; }
      }
      if (ok) return overlap;                             // new lines begin after the aligned overlap
    }
    return 0;                                             // no overlap (big burst) → re-show window once
  }
  async function pollOnce() {
    if (liveMode || paused || (typeof document !== 'undefined' && document.hidden)) return null;
    try {
      const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
      const r = await fetch(base + '/logs/tail?n=20', { signal: AbortSignal.timeout(3000), cache: 'no-store' });
      if (!r.ok) return false;
      const data = await r.json().catch(() => null);
      const lines = Array.isArray(data?.lines) ? data.lines : [];
      const sigs = lines.map(logLineSig);
      const start = newLinesStart(_prevLogSigs, sigs);
      for (const ln of lines.slice(start)) {
        appendLine({ level: ln.level || 'info', src: ln.src || 'file', msg: ln.msg || String(ln), ts: ln.ts });
      }
      _prevLogSigs = sigs;
      return true;
    } catch (err) { window.SeekDeepDebug?.warn('/logs/tail poll', err); return false; }
  }
  if (!attachLogBus()) {
    let n = 0; const iv = setInterval(() => { if (attachLogBus() || ++n > 30) clearInterval(iv); }, 250);
  }
  // Self-rescheduling poll with failure backoff (3s → cap 30s), reset to 3s on a
  // good poll or a skip. Replaces a flat setInterval(3000) that fetched
  // /logs/tail every 3s forever even while the server was down or the tab was
  // hidden (~20 doomed requests/min).
  let _logPollDelay = 3000;
  (function scheduleLogPoll() {
    setTimeout(async () => {
      const res = await pollOnce();
      _logPollDelay = (res === false) ? Math.min(30000, Math.round(_logPollDelay * 2)) : 3000;
      scheduleLogPoll();
    }, _logPollDelay);
  })();
})();

// ===== Model picker: HF cache + Ollama tags · Bot config quick picker =====
// Fills the dropdowns in the new #sec-model-picker card from GET /models
// /available. Save buttons POST /config with the env update; the GUI then
// hits /launcher/ai-server/restart (or Tauri restart_sidecar) so the new
// model_id is picked up. + Add HF / + Pull Ollama buttons surface a modal
// that calls POST /model/install and renders progress via the model.install
// .* WS events the existing model-install.js publishes.
(function () {
  if (window.__seekdeepModelPickerLoaded) return;
  window.__seekdeepModelPickerLoaded = true;
  // BASE resolver mirrors nav.js / events.js / fix-action.js — Tauri 2 on
  // Windows serves bundled pages from http://tauri.localhost, so a bare
  // relative path or window.SEEKDEEP_BASE='' resolves to Tauri's static
  // file server (which returns index.html for unknown routes, hence the
  // "Unexpected token '<', '<!doctype'" JSON parse error users saw on the
  // Bot config → Quick Model Picker pane). SeekDeepResolveBase forces
  // 127.0.0.1:7865 under Tauri context.
  function resolveBase() {
    if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    if (window.SEEKDEEP_BASE) return window.SEEKDEEP_BASE;
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  }
  const BASE = resolveBase();
  const $ = (id) => document.getElementById(id);

  let lastScan = null;

  function fmtSize(b) {
    if (!b || b <= 0) return '';
    const gb = b / 1e9;
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return (b / 1e6).toFixed(0) + ' MB';
  }

  function populateSelect(selectEl, scan, currentValue) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    // 1. Current value first (even if not in either inventory — surfaces
    //    "ghost" entries from .env so the user sees what's actually set).
    const cur = (currentValue || '').trim();
    if (cur) {
      const o = document.createElement('option');
      o.value = cur;
      o.textContent = cur + ' · current';
      o.selected = true;
      selectEl.appendChild(o);
    } else {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '— not set · pick one below —';
      o.selected = true;
      selectEl.appendChild(o);
    }
    // 2. HF cached repos
    const hfRepos = (scan && scan.hf && scan.hf.repos) || [];
    if (hfRepos.length) {
      const group = document.createElement('optgroup');
      group.label = `HuggingFace · cached (${hfRepos.length})`;
      hfRepos.forEach(r => {
        if (r.repo_id === cur) return;
        const o = document.createElement('option');
        o.value = r.repo_id;
        o.textContent = `${r.repo_id}${r.size_bytes ? ' · ' + fmtSize(r.size_bytes) : ''}`;
        group.appendChild(o);
      });
      selectEl.appendChild(group);
    }
    // 3. Ollama tags
    const olTags = (scan && scan.ollama && scan.ollama.tags) || [];
    if (olTags.length) {
      const group = document.createElement('optgroup');
      group.label = `Ollama · local tags (${olTags.length})`;
      olTags.forEach(t => {
        const v = 'ollama:' + t.name;  // backend prefix the role-resolver understands
        if (v === cur) return;
        const o = document.createElement('option');
        o.value = v;
        o.textContent = `${t.name}${t.size_bytes ? ' · ' + fmtSize(t.size_bytes) : ''}`;
        group.appendChild(o);
      });
      selectEl.appendChild(group);
    }
    if (!hfRepos.length && !olTags.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '— nothing cached · use + Add HF / + Pull Ollama below —';
      o.disabled = true;
      selectEl.appendChild(o);
    }
  }

  async function rescan() {
    const ss = $('mpScanStatus');
    if (ss) ss.textContent = 'scanning…';
    try {
      const r = await fetch(BASE + '/models/available', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      lastScan = data;
      const hf = data.hf || { repos: [], total_size_bytes: 0 };
      const ol = data.ollama || { available: false, tags: [] };
      const cur = data.current || {};
      populateSelect($('mpChatSelect'),   data, cur.LOCAL_CHAT_MODEL_ID);
      populateSelect($('mpImageSelect'),  data, cur.LOCAL_IMAGE_MODEL_ID);
      populateSelect($('mpVisionSelect'), data, cur.LOCAL_VISION_MODEL_ID);
      if (ss) {
        const olBit = ol.available ? `· Ollama ${ol.tags.length} tags` : '· Ollama daemon offline';
        ss.textContent = `HF ${hf.repos.length} repos · ${(hf.total_size_bytes/1e9).toFixed(1)} GB ${olBit}`;
      }
      // Empty-state banner logic: surface a prominent CTA when chat isn't set.
      const empty = $('mpEmptyState');
      const hint = $('mpEmptyHint');
      if (empty) {
        const noChat = !(cur.LOCAL_CHAT_MODEL_ID || '').trim();
        const cacheEmpty = hf.repos.length === 0;
        if (noChat) {
          empty.style.display = 'block';
          if (hint) {
            if (cacheEmpty) {
              hint.textContent = `No chat model is installed yet. Pick a recommended starter — we'll download it and set it as your default in one click. Your VRAM: ${(data.vram_total_mb/1024).toFixed(0)} GB.`;
            } else {
              hint.textContent = `${hf.repos.length} model(s) are already cached but none are set as default chat. Pick one from the dropdown above and click Save, or install another from the catalog.`;
            }
          }
        } else {
          empty.style.display = 'none';
        }
      }
    } catch (err) {
      if (ss) { ss.style.color = 'var(--warn)'; ss.textContent = 'scan failed · ' + (err.message || err); }
    }
  }

  function tierColor(tier) {
    return tier === 'xl'     ? 'var(--bad)' :
           tier === 'large'  ? 'var(--warn)' :
           tier === 'medium' ? 'var(--cyan-1)' :
           tier === 'small'  ? 'var(--good)' :
                               'var(--hull-3)';
  }

  // After any model-config save, prompt the user to restart the AI server
  // so the new env var takes effect. Single source of truth so Save / Use /
  // Install all behave consistently. Tauri shell path uses restart_sidecar;
  // standalone GUI falls back to /launcher/ai-server/restart (which 409s
  // for the self-hosted server and we toast that as a known limitation).
  // Track pending env changes so the bar can summarize multi-key edits
  // (user picks chat + image + vision back-to-back, gets ONE restart bar
  // with all 3 listed instead of 3 separate prompts to dismiss).
  const _pendingChanges = new Map();  // envKey -> newValue
  function showRestartPrompt(envKey, newValue) {
    if (envKey) _pendingChanges.set(envKey, newValue);
    // Replace any existing prompt — don't stack them.
    const existing = document.getElementById('mpRestartPrompt');
    if (existing) existing.remove();
    const box = document.createElement('div');
    box.id = 'mpRestartPrompt';
    // Fixed bottom-center so it sits above any modal (catalog, install,
    // etc.). High z-index beats the catalog modal's 9999. Slide-up
    // animation makes it feel native; user dismiss = Later.
    box.style.cssText = 'position:fixed; left:50%; bottom:20px; transform:translateX(-50%); z-index:10001; min-width:480px; max-width:min(720px, 92vw); padding:14px 18px; background:var(--substrate-2); border:1px solid var(--cyan-2); border-radius:var(--r-md); display:flex; align-items:center; gap:14px; font-family:var(--font-mono); font-size:12px; color:var(--hull-1); box-shadow:0 12px 40px rgba(0,0,0,0.6), 0 0 24px rgba(45,212,255,0.15);';
    const changeRows = Array.from(_pendingChanges.entries()).map(([k, v]) => {
      const safeV = String(v || '').replace(/[<>"&]/g, '');
      return `<div style="color:var(--cyan-1); line-height:1.5;">▸ ${k} = ${safeV}</div>`;
    }).join('');
    const noun = _pendingChanges.size === 1 ? 'change saved' : `${_pendingChanges.size} changes saved`;
    box.innerHTML = `
      <div style="flex:1;">
        ${changeRows}
        <div class="tiny muted" style="font-size:10.5px; margin-top:5px;">${noun} · won't take effect until the AI server restarts.</div>
      </div>
      <button id="mpRestartGo" class="btn btn-primary" style="padding:8px 16px; font-size:12px; white-space:nowrap;">▸ Restart now</button>
      <button id="mpRestartLater" class="btn btn-ghost" style="padding:8px 14px; font-size:11px;">Later</button>
    `;
    document.body.appendChild(box);
    box.querySelector('#mpRestartLater').onclick = () => {
      box.remove();
      // Keep _pendingChanges populated so if user makes ANOTHER change
      // before restarting, the bar comes back showing all pending edits.
    };
    box.querySelector('#mpRestartGo').onclick = async () => {
      const goBtn = box.querySelector('#mpRestartGo');
      goBtn.disabled = true;
      goBtn.textContent = '⏳ restarting…';
      const sdn = window.SeekDeepNotify;
      // Set the shared restart-window flag BEFORE invoking. The sidecar:
      // status listener in launcher.js would catch RESTARTING eventually,
      // but there's a race where /logs/tail polls fail before the event
      // arrives. Explicit set wins.
      window.__seekdeepRestartingUntil = Date.now() + 12000;
      try {
        const tauri = window.__TAURI__;
        if (tauri && tauri.core) {
          // Tauri path: kills + respawns the sidecar process with fresh env.
          await tauri.core.invoke('restart_sidecar');
          if (sdn?.toast) sdn.toast({ tone: 'good', title: 'AI server restarting', body: `${envKey} change will be live in a few seconds.`, ttl: 5000 });
        } else {
          // Standalone GUI: try the HTTP route; self-hosted ai-server can't
          // restart itself so this 409s. Surface honestly.
          const r = await fetch(BASE + '/launcher/ai-server/restart', { method: 'POST' });
          if (r.ok) {
            if (sdn?.toast) sdn.toast({ tone: 'good', title: 'AI server restarting', ttl: 5000 });
          } else if (r.status === 409) {
            if (sdn?.toast) sdn.toast({ tone: 'warn', title: 'Self-restart not allowed', body: 'You\'re running the AI server standalone (not via Tauri). Stop + start it manually with seekdeep_launcher.bat option 8.', ttl: 8000 });
          } else {
            throw new Error('HTTP ' + r.status);
          }
        }
        goBtn.textContent = '✓ restarting';
        _pendingChanges.clear();
        setTimeout(() => { box.remove(); rescan(); }, 2500);
      } catch (err) {
        if (sdn?.toast) sdn.toast({ tone: 'bad', title: 'Restart failed', body: String(err.message || err), ttl: 8000 });
        goBtn.disabled = false;
        goBtn.textContent = '▸ Retry';
      }
    };
  }

  function openCatalogModal(focusRole) {
    // focusRole: 'chat' | 'vision' | 'image' | 'ollama' | undefined (= chat default)
    if (!lastScan || !lastScan.catalog) {
      (window.SeekDeepNotify?.toast || ((o) => alert(o.body ? o.title + ': ' + o.body : o.title)))({ tone: 'info', title: 'Catalog still loading', body: 'Try again in a moment.' });
      return;
    }
    const cat = lastScan.catalog;
    const hfCached = new Set((lastScan.hf?.repos || []).map(r => r.repo_id));
    const ollamaTags = new Set((lastScan.ollama?.tags || []).map(t => t.name));
    const hfTokenSet = lastScan.hf_token_set === true;
    const envOffline = lastScan.env_offline === true;
    const vramGb = (lastScan.vram_total_mb || 0) / 1024;
    const role = focusRole || 'chat';

    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:9999;display:grid;place-items:center;font-family:var(--font-grotesk);padding:24px;';
    m.innerHTML = `
      <div style="background:var(--substrate-2);border:1px solid var(--cyan-2);border-radius:var(--r-md);width:880px;max-width:96vw;max-height:90vh;display:flex;flex-direction:column;color:var(--hull-2);">
        <div style="padding:18px 22px;border-bottom:1px solid var(--stroke);display:flex;justify-content:space-between;align-items:center;">
          <div>
            <h3 style="margin:0;color:var(--cyan-1);font-family:var(--font-mono);letter-spacing:0.1em;">▸ Recommended models</h3>
            <div class="tiny muted" style="font-family:var(--font-mono);font-size:11px;margin-top:4px;">Curated · one-click install · auto-rescans when done · your VRAM: ${vramGb.toFixed(0)} GB${hfTokenSet ? '' : ' · ⚠ HF_TOKEN not set: gated models will fail'}${envOffline ? ' · ⛓ OFFLINE LOCK ACTIVE: HF installs will fail until you Unlock cache from the Launcher → Quick actions' : ''}</div>
          </div>
          <button id="cmClose" class="btn btn-ghost" style="padding:6px 14px;font-size:11px;">✕ Close</button>
        </div>
        <div style="padding:12px 22px;border-bottom:1px solid var(--stroke);display:flex;gap:8px;flex-wrap:wrap;">
          <button class="cm-tab btn btn-${role==='chat'?'primary':'ghost'}" data-role="chat" style="padding:6px 12px;font-size:11px;">Chat · ${cat.chat.length} (HF+Ollama)</button>
          <button class="cm-tab btn btn-${role==='vision'?'primary':'ghost'}" data-role="vision" style="padding:6px 12px;font-size:11px;">Vision · ${cat.vision.length}</button>
          <button class="cm-tab btn btn-${role==='image'?'primary':'ghost'}" data-role="image" style="padding:6px 12px;font-size:11px;">Image · ${cat.image.length}</button>
          <button class="cm-tab btn btn-${role==='ollama'?'primary':'ghost'}" data-role="ollama" style="padding:6px 12px;font-size:11px;">Ollama only · ${cat.ollama.length}</button>
        </div>
        <div id="cmList" style="padding:14px 22px;overflow-y:auto;flex:1;"></div>
        <div style="padding:12px 22px;border-top:1px solid var(--stroke);font-family:var(--font-mono);font-size:11px;color:var(--hull-3);">
          ✓ already cached  ·  ⚠ gated (needs HF license accept)  ·  size > VRAM = won't fit
        </div>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('#cmClose').onclick = () => m.remove();
    m.onclick = (e) => { if (e.target === m) m.remove(); };

    function renderList(activeRole) {
      const entries = cat[activeRole] || [];
      const list = m.querySelector('#cmList');
      list.innerHTML = '';
      entries.forEach(entry => {
        // Check the right inventory based on the ENTRY's backend, not the
        // tab. Future catalog entries with backend=ollama on the Chat tab
        // would otherwise be wrongly checked against the HF cache.
        const isCached = entry.backend === 'ollama'
          ? ollamaTags.has(entry.repo_id)
          : hfCached.has(entry.repo_id);
        const fits = !entry.size_gb || entry.size_gb <= vramGb;
        const gated = entry.gated === true;
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid var(--stroke);border-radius:var(--r-sm);padding:14px;margin-bottom:10px;background:rgba(2,6,15,0.4);display:grid;grid-template-columns:1fr 130px;gap:14px;align-items:center;';
        // Backend badge: shows on the Chat tab so user can tell HF vs Ollama
        // entries at a glance. Hidden on backend-specific tabs to avoid noise.
        const showBackend = (activeRole === 'chat');
        const backendBadge = showBackend
          ? (entry.backend === 'ollama'
              ? '<span class="tiny" style="padding:1px 8px;border:1px solid var(--cyan-2);border-radius:8px;font-family:var(--font-mono);color:var(--cyan-1);font-size:10px;letter-spacing:0.08em;background:rgba(45,212,255,0.08);">via OLLAMA</span>'
              : '<span class="tiny" style="padding:1px 8px;border:1px solid var(--hull-3);border-radius:8px;font-family:var(--font-mono);color:var(--hull-2);font-size:10px;letter-spacing:0.08em;">via HF</span>')
          : '';
        card.innerHTML = `
          <div>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
              <span class="mono" style="color:var(--hull-1);font-size:13px;">${entry.repo_id.replace(/[<>"&]/g, '')}</span>
              ${backendBadge}
              <span class="tiny" style="padding:1px 8px;border:1px solid var(--stroke);border-radius:8px;font-family:var(--font-mono);color:${tierColor(entry.tier)};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;">${String(entry.tier).replace(/[<>"&]/g,'')} · ${String(entry.size_gb).replace(/[<>"&]/g,'')} GB</span>
              ${gated ? '<span class="tiny" style="padding:1px 8px;border:1px solid var(--warn);border-radius:8px;font-family:var(--font-mono);color:var(--warn);font-size:10px;letter-spacing:0.08em;">⚠ gated</span>' : ''}
              ${isCached ? '<span class="tiny" style="padding:1px 8px;border:1px solid var(--good);border-radius:8px;font-family:var(--font-mono);color:var(--good);font-size:10px;letter-spacing:0.08em;">✓ cached</span>' : ''}
              ${!fits ? '<span class="tiny" style="padding:1px 8px;border:1px solid var(--bad);border-radius:8px;font-family:var(--font-mono);color:var(--bad);font-size:10px;letter-spacing:0.08em;">won\'t fit</span>' : ''}
            </div>
            <div class="tiny muted" style="font-family:var(--font-grotesk);font-size:12px;line-height:1.5;">${entry.why.replace(/[<>"&]/g, '')}</div>
          </div>
          <div style="text-align:right;display:flex;flex-direction:column;gap:6px;">
            ${isCached
              ? `<button class="btn btn-primary cm-use" data-id="${entry.repo_id.replace(/"/g,'&quot;')}" data-backend="${entry.backend}" data-role-target="${entry.role}" style="padding:8px 12px;font-size:11px;">▸ Use as ${entry.role}</button>`
              : (() => {
                  // Block HF installs while offline-lock is active; Ollama
                  // pulls go through the daemon and are unaffected.
                  const blockedByOffline = envOffline && entry.backend === 'hf';
                  const blockedByGate    = gated && !hfTokenSet;
                  const disabled = blockedByOffline || blockedByGate;
                  const label = blockedByOffline ? '⛓ Locked offline' : '▸ Install';
                  return `<button class="btn btn-${disabled ? 'ghost' : 'primary'} cm-install" data-id="${entry.repo_id.replace(/"/g,'&quot;')}" data-backend="${entry.backend}" data-role-target="${entry.role}" data-size="${entry.size_gb}" data-gated="${gated}" style="padding:8px 12px;font-size:11px;${disabled ? 'opacity:0.6;cursor:not-allowed;' : ''}" ${disabled ? 'disabled' : ''}>${label}</button>`;
                })()
            }
            <div class="cm-progress tiny muted" style="font-family:var(--font-mono);font-size:10px;text-align:right;min-height:12px;"></div>
          </div>`;
        list.appendChild(card);
      });
      // Wire install buttons
      list.querySelectorAll('.cm-install').forEach(btn => {
        btn.addEventListener('click', () => installEntry(btn));
      });
      list.querySelectorAll('.cm-use').forEach(btn => {
        btn.addEventListener('click', () => useEntry(btn));
      });
    }

    async function installEntry(btn) {
      const id = btn.dataset.id;
      const backend = btn.dataset.backend;
      const target = btn.dataset.roleTarget;
      const sizeGb = parseFloat(btn.dataset.size || '0');
      const prog = btn.parentElement.querySelector('.cm-progress');
      btn.disabled = true;
      btn.textContent = '⏳ downloading…';
      prog.style.color = 'var(--cyan-1)';
      prog.textContent = `~${sizeGb} GB · this may take several minutes`;
      try {
        const r = await fetch(BASE + '/model/install', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: id, backend, auto_pull: true }),
        });
        if (!r.ok) {
          let msg = 'HTTP ' + r.status;
          try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
          throw new Error(msg);
        }
        prog.style.color = 'var(--good)';
        prog.textContent = '✓ installed · setting as default…';
        // Auto-set as default for whichever role this catalog entry targets
        const envKey = target === 'chat'   ? 'LOCAL_CHAT_MODEL_ID' :
                       target === 'vision' ? 'LOCAL_VISION_MODEL_ID' :
                       target === 'image'  ? 'LOCAL_IMAGE_MODEL_ID' : null;
        if (envKey) {
          await fetch(BASE + '/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: { [envKey]: id } }),
          });
        }
        btn.textContent = '✓ done';
        prog.textContent = '✓ saved as default';
        if (envKey) showRestartPrompt(envKey, id);
        setTimeout(() => { rescan(); }, 500);
      } catch (err) {
        prog.style.color = 'var(--warn)';
        prog.textContent = '✗ ' + (err.message || err);
        btn.disabled = false;
        btn.textContent = '▸ Retry';
      }
    }

    async function useEntry(btn) {
      const id = btn.dataset.id;
      const target = btn.dataset.roleTarget;
      const prog = btn.parentElement.querySelector('.cm-progress');
      const envKey = target === 'chat'   ? 'LOCAL_CHAT_MODEL_ID' :
                     target === 'vision' ? 'LOCAL_VISION_MODEL_ID' :
                     target === 'image'  ? 'LOCAL_IMAGE_MODEL_ID' : null;
      if (!envKey) return;
      btn.disabled = true;
      btn.textContent = '⏳';
      try {
        const r = await fetch(BASE + '/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: { [envKey]: id } }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        btn.textContent = '✓';
        prog.style.color = 'var(--cyan-1)';
        prog.textContent = '✓ saved as default';
        showRestartPrompt(envKey, id);
        setTimeout(() => { rescan(); }, 600);
      } catch (err) {
        prog.style.color = 'var(--warn)';
        prog.textContent = '✗ ' + (err.message || err);
        btn.disabled = false;
        btn.textContent = '▸ Use';
      }
    }

    m.querySelectorAll('.cm-tab').forEach(t => {
      t.addEventListener('click', () => {
        m.querySelectorAll('.cm-tab').forEach(o => { o.classList.remove('btn-primary'); o.classList.add('btn-ghost'); });
        t.classList.remove('btn-ghost'); t.classList.add('btn-primary');
        renderList(t.dataset.role);
      });
    });
    renderList(role);
  }

  async function saveOne(envKey, selectId, btnEl) {
    const sel = $(selectId);
    const val = sel ? sel.value : '';
    if (!val) {
      $('mpStatus').style.color = 'var(--warn)';
      $('mpStatus').textContent = `pick a model for ${envKey} first`;
      return;
    }
    btnEl.disabled = true;
    const orig = btnEl.textContent;
    btnEl.textContent = '⏳';
    try {
      const r = await fetch(BASE + '/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { [envKey]: val } }),
      });
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
        throw new Error(msg);
      }
      $('mpStatus').style.color = 'var(--cyan-1)';
      $('mpStatus').textContent = `✓ ${envKey} saved`;
      btnEl.textContent = '✓';
      setTimeout(() => { btnEl.textContent = orig; }, 2000);
      showRestartPrompt(envKey, val);
    } catch (err) {
      $('mpStatus').style.color = 'var(--warn)';
      $('mpStatus').textContent = `${envKey} save failed · ${err.message || err}`;
      btnEl.textContent = orig;
    } finally {
      btnEl.disabled = false;
    }
  }

  function openInstallModal(opts) {
    // opts: { backend: 'hf' | 'ollama', placeholder, title, hint }
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:grid;place-items:center;font-family:var(--font-grotesk);';
    m.innerHTML = `
      <div style="background:var(--substrate-2);border:1px solid var(--stroke);border-radius:var(--r-md);padding:24px;width:560px;max-width:90vw;color:var(--hull-2);">
        <h3 style="margin:0 0 6px 0;color:var(--cyan-1);font-family:var(--font-mono);letter-spacing:0.1em;">${opts.title}</h3>
        <div class="tiny muted" style="font-family:var(--font-mono); font-size:11px; margin-bottom:12px;">${opts.hint}</div>
        <input id="mpModalInput" type="text" placeholder="${opts.placeholder}" style="width:100%; padding:10px 12px; background:#000; border:1px solid var(--stroke); border-radius:var(--r-sm); color:var(--hull-1); font-family:var(--font-mono); font-size:13px;" />
        <div id="mpModalStatus" class="tiny muted" style="font-family:var(--font-mono); font-size:11px; margin-top:10px; min-height:14px;"></div>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
          <button id="mpModalCancel" class="btn btn-ghost" style="padding:8px 14px;">Cancel</button>
          <button id="mpModalGo" class="btn btn-primary" style="padding:8px 14px;">▸ Install</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.querySelector('#mpModalCancel').onclick = close;
    m.onclick = (e) => { if (e.target === m) close(); };
    const input = m.querySelector('#mpModalInput');
    input.focus();
    m.querySelector('#mpModalGo').onclick = async () => {
      const val = input.value.trim();
      const st = m.querySelector('#mpModalStatus');
      if (!val) { st.style.color = 'var(--warn)'; st.textContent = '▸ enter a value first'; return; }
      st.style.color = 'var(--hull-3)';
      st.textContent = '▸ installing… (download progresses via WS · model.install.line)';
      m.querySelector('#mpModalGo').disabled = true;
      try {
        const r = await fetch(BASE + '/model/install', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: val, backend: opts.backend, auto_pull: true }),
        });
        if (!r.ok) {
          let msg = 'HTTP ' + r.status;
          try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
          throw new Error(msg);
        }
        const data = await r.json();
        st.style.color = 'var(--cyan-1)';
        st.textContent = `✓ install complete · ${val} · rescanning…`;
        setTimeout(() => { rescan(); close(); }, 1200);
      } catch (err) {
        st.style.color = 'var(--warn)';
        st.textContent = '▸ install failed · ' + (err.message || err);
        m.querySelector('#mpModalGo').disabled = false;
      }
    };
  }

  function wire() {
    if (!$('mpChatSelect')) return false;  // section not in DOM yet
    rescan();
    $('mpRescan')?.addEventListener('click', rescan);
    $('mpChatSave')?.addEventListener('click',  (e) => saveOne('LOCAL_CHAT_MODEL_ID',   'mpChatSelect',   e.target));
    $('mpImageSave')?.addEventListener('click', (e) => saveOne('LOCAL_IMAGE_MODEL_ID',  'mpImageSelect',  e.target));
    $('mpVisionSave')?.addEventListener('click',(e) => saveOne('LOCAL_VISION_MODEL_ID', 'mpVisionSelect', e.target));
    $('mpAddHF')?.addEventListener('click', () => openInstallModal({
      backend: 'hf',
      title: '+ Add HuggingFace repo',
      hint: 'Paste any HF model repo ID — we run snapshot_download into your LOCAL_MODEL_CACHE_DIR. Gated repos use your HF_TOKEN.',
      placeholder: 'e.g. meta-llama/Llama-3.1-8B-Instruct',
    }));
    $('mpAddOllama')?.addEventListener('click', () => openInstallModal({
      backend: 'ollama',
      title: '+ Pull Ollama tag',
      hint: 'Pulls a tag via the local Ollama daemon (POST /api/pull). Daemon must be running. Cloud-only setups: set OLLAMA_API_KEY first.',
      placeholder: 'e.g. llama3.1:8b-instruct-q4_K_M',
    }));
    $('mpBrowseRecommended')?.addEventListener('click', () => openCatalogModal('chat'));
    $('mpEmptyStarter')?.addEventListener('click', () => openCatalogModal('chat'));
    // Expose for tray menu / external callers. Works even when hash is
    // already set to #open-model-catalog (which would skip the hashchange).
    window.SeekDeepOpenModelCatalog = (role) => openCatalogModal(role || 'chat');
    // Hash trigger: if app.html opens with #open-model-catalog (setup-wizard
    // navigates here when chat_model firstrun check fails), wait for the
    // first scan to complete then auto-open the catalog. Strips the hash
    // so refreshes don't re-trigger.
    function maybeAutoOpenCatalog() {
      if (location.hash === '#open-model-catalog') {
        // Wait for first scan so lastScan is populated, then open.
        const wait = setInterval(() => {
          if (lastScan && lastScan.catalog) {
            clearInterval(wait);
            try { history.replaceState(null, '', location.pathname); } catch {}
            openCatalogModal('chat');
          }
        }, 200);
        setTimeout(() => clearInterval(wait), 12000);
      }
    }
    maybeAutoOpenCatalog();
    window.addEventListener('hashchange', maybeAutoOpenCatalog);
    // Auto-refresh when the user navigates into the Config pane.
    document.querySelectorAll('.sidebar a[data-mod="config"]').forEach(a =>
      a.addEventListener('click', () => setTimeout(rescan, 200))
    );
    return true;
  }

  if (!wire()) {
    let n = 0;
    const iv = setInterval(() => { if (wire() || ++n > 40) clearInterval(iv); }, 250);
  }
})();
