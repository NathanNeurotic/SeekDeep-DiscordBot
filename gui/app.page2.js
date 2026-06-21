  const labelMap = {
    launcher: "LAUNCHER", gpu: "GPU / VRAM", models: "MODEL MANAGER",
    config: "BOT CONFIG", logs: "LOGS VIEWER", chat: "CHAT PLAYGROUND",
    image: "IMAGE PLAYGROUND", archive: "ARCHIVE BROWSER",
    reacts: "AUTO-REACT RULES", stats: "SERVER STATS"
  };
  function activate(mod) {
    document.querySelectorAll('.sidebar a').forEach(a => a.classList.toggle('active', a.dataset.mod === mod));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === mod));
    const lbl = document.getElementById('active-mod-label');
    if (lbl) lbl.textContent = labelMap[mod] || mod.toUpperCase();
    document.querySelector('.main').scrollTop = 0;
  }
  document.querySelectorAll('.sidebar a[data-mod]').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      // Dirty-guard: if the user is leaving the Bot config pane with
      // unsaved DIRTY rows, prompt before letting them switch. Was:
      // silent loss every time the user clicked a different sidebar
      // entry. The DOM state survives across panes (rows aren't
      // re-rendered), so cancelling the nav recovers fully.
      const currentPane = document.querySelector('.pane.active');
      if (currentPane && currentPane.dataset.pane === 'config') {
        const dirtyCount = [...document.querySelectorAll('.config-row .save')]
          .filter(s => s.textContent.includes('DIRTY')).length;
        if (dirtyCount > 0) {
          if (!await (window.SeekDeepConfirm || window.confirm)(`You have ${dirtyCount} unsaved config change${dirtyCount === 1 ? '' : 's'}. Switch panes anyway?\n(Values stay in the form until you reload the page — Save them first, or hit Cancel here to stay on Bot config.)`)) {
            return;
          }
        }
      }
      activate(a.dataset.mod);
    });
  });

  // toggle helpers (sidebar chips). data-disabled chips short-circuit so
  // the user can't "activate" something the page can't fulfill (e.g. img2img
  // in the txt2img-only playground).
  document.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      if (c.dataset.disabled === '1') return;
      const siblings = c.parentElement.querySelectorAll('.chip');
      const isExclusiveGroup = c.parentElement.classList.contains('mode-tabs') ||
                              c.parentElement.classList.contains('log-filters') ||
                              c.parentElement.classList.contains('arch-tabs');
      if (isExclusiveGroup) siblings.forEach(s => s.classList.remove('active'));
      c.classList.toggle('active');
    });
  });

  // clock
  setInterval(() => {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }, 1000);

  // Smart BASE — picks the right host for our fetches.
//   1. nav.js's shared resolver (Tauri-aware: detects __TAURI__ /
//      tauri.localhost and forces 127.0.0.1:7865 instead of the
//      bundled-WebView host).
//   2. Same-origin when served from local_ai_server.py via /gui mount.
//   3. file:// or other origins fall back to :7865.
//
// The previous version returned window.location.origin unconditionally
// in any http:// context — which in Tauri 2 on Windows resolves to
// http://tauri.localhost. Every fetch using SEEKDEEP_BASE then hit the
// WebView's bundled-resources host instead of the AI server, producing
// the now-classic "Unexpected token '<', '<!DOCTYPE ...' is not valid
// JSON" error (the WebView served its 404 HTML page as the response).
// The image playground, chat composer, persona pill, config save, GPU
// stats, archive snapshot, server stats, persona load — all silently
// broken under Tauri until this fix.
const SEEKDEEP_BASE = (function() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:7865';
  if (typeof window.SeekDeepResolveBase === 'function') {
    try { return window.SeekDeepResolveBase(); } catch (_) {}
  }
  if (window.__TAURI__ || (window.location.hostname || '') === 'tauri.localhost') {
    return 'http://127.0.0.1:7865';
  }
  const sameOrigin = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  if (sameOrigin && window.location.host) {
    return window.location.origin;
  }
  return 'http://127.0.0.1:7865';
})();

  // Resilient GET for status polls (audit §5). Rides out a transient blip
  // within one tick instead of leaving stale state on screen. Falls back to
  // native fetch if fetch.js hasn't auto-loaded yet. ONLY for idempotent
  // GETs — never wrap a side-effecting POST.
  function sdPollFetch(url, { timeout = 4000, attempts = 2 } = {}) {
    if (window.SeekDeepFetch && typeof window.SeekDeepFetch.retry === 'function') {
      return window.SeekDeepFetch.retry(url, {
        cache: 'no-store', attemptTimeoutMs: timeout,
        maxAttempts: attempts, baseDelayMs: 400, maxDelayMs: 2000,
      });
    }
    return fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
  }

  // ===== LIVE BACKEND PROBE — fetches /health + /gpu every 5s =====
  // When the local AI server at :7865 is reachable, this swaps PROBING
  // placeholders with real GPU/model data and flips the LIVE pill on.
  const LIVE = {
    timer: null,
    failures: 0,
    isLive: false,
    async probe() {
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch(SEEKDEEP_BASE + '/health', { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(tm);
        if (!r.ok) throw new Error('http ' + r.status);
        const h = await r.json();
        this.failures = 0;
        this.everSucceeded = true;
        if (!this.isLive) this.setMode('live');
        this.applyHealth(h);
        // Also pull /gpu for the richer GPU pane numbers
        try {
          const gr = await sdPollFetch(SEEKDEEP_BASE + '/gpu', { timeout: 4000, attempts: 2 });
          if (gr.ok) this.applyGpu(await gr.json());
        } catch (err) { window.SeekDeepDebug?.warn('/gpu probe', err); }
      } catch (e) {
        this.failures++;
        // Stay in PROBING for transient hiccups. Flip to OFFLINE after 3
        // consecutive misses (so a brief stall doesn't change the UI).
        if (this.isLive && this.failures >= 3) this.setMode('offline');
        else if (!this.everSucceeded && this.failures >= 5) this.setMode('offline');
      }
    },
    setMode(mode) {
      this.isLive = (mode === 'live');
      const pill = document.getElementById('liveModePill');
      // stackDot + stackState are owned by launcher.js's pumpStatus now —
      // it knows whether bot/searxng are also running, not just whether
      // /health responded. cLIVE only owns its own .pill here. (Previously
      // cLIVE stamped STACK HEALTHY whenever /health 200'd, lying about
      // the stack when bot or searxng were exited.)
      // Null-guard: app.html doesn't ship a #liveModePill in markup; the
      // sd-live-pill nav.js injects into the topnav reflects /events bus
      // state instead. Without the guard, setMode would throw on the first
      // probe success/failure and break the rest of LIVE.probe().
      if (!pill) return;
      if (mode === 'live') {
        pill.classList.add('on'); pill.classList.remove('warn');
        pill.innerHTML = '<span class="dot"></span>LIVE · :7865';
      } else {
        pill.classList.remove('on'); pill.classList.add('warn');
        pill.innerHTML = '<span class="dot"></span>OFFLINE · :7865';
      }
    },
    applyHealth(h) {
      // /health shape (per local_ai_server.py): { device, cuda_available, model, loaded, keep_resident, gpu: {...} }
      const g = h.gpu || {};
      const usedGB  = g.used_mb ? (g.used_mb / 1024) : null;
      const totalGB = g.total_mb ? (g.total_mb / 1024) : null;
      if (usedGB != null && totalGB != null) {
        const txt = `${usedGB.toFixed(1)} / ${totalGB.toFixed(0)} GB`;
        this.setText('sb-vram', txt);
        this.setText('svcVram', txt);  // launcher card ai-server VRAM cell
        this.setText('gpuVramUsed', usedGB.toFixed(1));
        this.setText('gpuVramTotal', totalGB.toFixed(1));
        const bar = document.getElementById('gpuVramBar');
        if (bar) bar.style.width = Math.round((usedGB / totalGB) * 100) + '%';
      } else if (g.available === false) {
        // No CUDA / torch missing. Don't leave "— / —" hanging; tell the
        // user the truth ("CPU mode") so they don't stare at empty fields.
        this.setText('sb-vram', 'CPU');
        this.setText('svcVram', 'CPU');
      }
      // Models pane — mark loaded + pinned roles.
      // /health returns loaded_chat_role (not "loaded") + a gpu.loaded
      // object {chat_model, vision_model, image_pipe} of booleans. The
      // old code checked `h.loaded` which doesn't exist as a field, so
      // NOTHING ever matched "RESIDENT" and every chat role fell through
      // to a misleading "CACHED" badge even on installs that hadn't
      // downloaded any models.
      const loadedChatRole = h.loaded_chat_role || null;
      const pinned = h.keep_resident || {};
      const gpuLoaded = (h.gpu && h.gpu.loaded) || {};
      const visionLoaded = !!gpuLoaded.vision_model;
      const imageLoaded  = !!gpuLoaded.image_pipe;
      document.querySelectorAll('.model-row[data-role]').forEach(row => {
        const role = row.dataset.role;
        const cell = row.querySelector('[data-role-state]');
        if (!cell) return;
        const isResident =
          (role === loadedChatRole) ||
          (role === 'vision' && visionLoaded) ||
          (role === 'image'  && imageLoaded);
        if (isResident) {
          cell.innerHTML = '<span class="pill cyan" style="padding: 2px 6px;"><span class="dot"></span>RESIDENT</span>';
        } else if (pinned[role]) {
          cell.innerHTML = '<span class="pill cyan" style="padding: 2px 6px;"><span class="dot"></span>PINNED</span>';
        } else {
          // Honest "not loaded right now" instead of fake CACHED/EVICTABLE.
          // We can't tell from /health whether the weights are downloaded
          // — that requires an HF cache scan (cache.hf_repo_count from
          //   /stats/snapshot tells you how many; individual presence is
          //   not exposed). So just say UNLOADED.
          cell.innerHTML = '<span class="pill" style="padding: 2px 6px;"><span class="dot"></span>UNLOADED</span>';
        }
      });

      // Resident models list in the GPU pane — populate from the same
      // gpu.loaded booleans + the loaded_chat_role. Empty list = honest
      // "no models resident right now" instead of the previously-hardcoded
      // squid-art mock data.
      const residentHost = document.getElementById('residentModelsList');
      if (residentHost) {
        const items = [];
        if (loadedChatRole) items.push({ role: loadedChatRole, kind: 'chat',   id: h.loaded_chat_model_id || (h.models && h.models.chat) || loadedChatRole });
        if (visionLoaded)   items.push({ role: 'vision',       kind: 'vision', id: (h.models && h.models.vision) || 'vision' });
        if (imageLoaded)    items.push({ role: 'image',        kind: 'image',  id: (h.models && h.models.image) || 'image' });
        if (!items.length) {
          residentHost.className = 'tiny muted';
          residentHost.style.fontFamily = 'var(--font-mono)';
          residentHost.textContent = '— no models resident right now · load via Warm buttons in Model manager, or run a /chat / /image / /vision request to trigger task-LRU load';
        } else {
          residentHost.className = '';
          residentHost.style.fontFamily = '';
          residentHost.innerHTML = '';
          // XSS-safe row builder: every model id / role string goes via
          // textContent. it.role + it.id come from /health response which
          // is server-controlled, but escape anyway for defense in depth.
          for (const it of items) {
            const row = document.createElement('div');
            row.style.cssText = 'display: grid; grid-template-columns: 200px 1fr 100px; gap: 14px; padding: 10px 0; align-items: center; font-family: var(--font-mono); font-size: 12px; border-bottom: 1px solid var(--stroke);';
            const lblWrap = document.createElement('div');
            const lblRole = document.createElement('div');
            lblRole.style.color = 'var(--cyan-1)';
            lblRole.textContent = String(it.role);
            const lblId = document.createElement('div');
            lblId.style.cssText = 'font-size: 10px; color: var(--hull-3);';
            lblId.textContent = String(it.id).split('/').pop();
            lblWrap.appendChild(lblRole); lblWrap.appendChild(lblId);
            const kind = document.createElement('div');
            kind.style.cssText = 'color: var(--hull-3); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;';
            kind.textContent = it.kind;
            const state = document.createElement('div');
            state.innerHTML = '<span class="pill cyan" style="padding: 2px 6px;"><span class="dot"></span>RES</span>';
            row.appendChild(lblWrap); row.appendChild(kind); row.appendChild(state);
            residentHost.appendChild(row);
          }
        }
      }

      if (h.model) {
        document.title = 'SeekDeep — ' + h.model;
      }

      // Model manager "Currently resident" mini-card — count distinct
      // resident roles from /health.gpu.loaded + loaded_chat_role. No
      // hardcoded 3.
      const residentRoles = [];
      if (loadedChatRole) residentRoles.push('chat');
      if (visionLoaded)   residentRoles.push('vision');
      if (imageLoaded)    residentRoles.push('image');
      const mmrCount = document.getElementById('mmResidentCount');
      const mmrDelta = document.getElementById('mmResidentDelta');
      if (mmrCount) mmrCount.textContent = String(residentRoles.length);
      if (mmrDelta) mmrDelta.textContent = residentRoles.length
        ? residentRoles.join(' · ')
        : '— no models resident · /chat /image /vision will warm one';

      // Model manager "Offline lock" mini-card — reads h.env_offline if
      // /health exposes it (true if HF_HUB_OFFLINE=1 or TRANSFORMERS_OFFLINE=1).
      // Falls back to "unknown" when the field is missing so we don't lie.
      const mmOff = document.getElementById('mmOfflineLock');
      const mmOffDelta = document.getElementById('mmOfflineLockDelta');
      if (mmOff) {
        if (h.env_offline === true) {
          mmOff.textContent = 'ON';
          mmOff.style.color = 'var(--good)';
          if (mmOffDelta) {
            mmOffDelta.textContent = 'HF_HUB_OFFLINE=1';
            mmOffDelta.className = 'delta good';
          }
        } else if (h.env_offline === false) {
          mmOff.textContent = 'OFF';
          mmOff.style.color = '';
          if (mmOffDelta) {
            mmOffDelta.textContent = 'HF_HUB_OFFLINE=0';
            mmOffDelta.className = 'delta';
          }
        } else {
          mmOff.textContent = '—';
          mmOff.style.color = '';
          if (mmOffDelta) {
            mmOffDelta.textContent = '— /health.env_offline not exposed yet';
            mmOffDelta.className = 'delta muted';
          }
        }
      }
    },
    applyGpu(g) {
      // /gpu (per local_ai_server.py): { allocated_mb, reserved_mb, free_mb,
      // total_mb, used_mb, used_pct, reserved_pct, loaded, keep_resident,
      // device_name, nvidia_smi:{util_pct, temp_c, power_w, fan_pct, ...} }
      const smi = g.nvidia_smi || {};
      // Prefer nvidia-smi util (real GPU utilization) over the
      // reserved_pct proxy. Falls back when smi isn't reporting.
      if (smi.util_pct != null) {
        this.setText('gpuUtil', Math.round(smi.util_pct));
      } else if (g.used_pct != null) {
        this.setText('gpuUtil', Math.round(g.used_pct));
      }
      const usedGB  = g.used_mb  ? (g.used_mb / 1024)  : null;
      const totalGB = g.total_mb ? (g.total_mb / 1024) : null;
      if (usedGB != null && totalGB != null) {
        this.setText('gpuVramUsed', usedGB.toFixed(1));
        this.setText('gpuVramTotal', totalGB.toFixed(1));
        const bar = document.getElementById('gpuVramBar');
        if (bar) bar.style.width = Math.round((usedGB / totalGB) * 100) + '%';
        this.setText('sb-vram', `${usedGB.toFixed(1)} / ${totalGB.toFixed(0)} GB`);
      }
      if (g.device_name) {
        this.setText('gpuUtilNote', g.device_name);
      }
      // ---- Temperature / Power / Fan from nvidia-smi --------------------
      // Were dead "— nvidia-smi pending" placeholders. /gpu now bundles
      // smi readings as g.nvidia_smi.{temp_c, power_w, power_limit_w, fan_pct}
      // so we can render them honestly. If smi isn't available (CPU box
      // or driver hung), leave the dash and surface the smi error in the
      // note row.
      if (smi.temp_c != null) {
        this.setText('gpuTemp', Math.round(smi.temp_c));
        const note = document.getElementById('gpuTempNote');
        if (note) {
          // Heat tiers cribbed from RTX laptop GPU spec sheets — 75 C is
          // hot but fine, 85 C is throttling-imminent.
          const t = smi.temp_c;
          const tier = t < 60 ? 'cool' : t < 75 ? 'normal' : t < 85 ? 'hot' : 'throttling-soon';
          note.textContent = tier;
          note.style.color = t < 75 ? '' : (t < 85 ? 'var(--warn)' : 'var(--bad)');
        }
      } else {
        const note = document.getElementById('gpuTempNote');
        if (note) note.textContent = smi.error ? ('— ' + smi.error.slice(0, 80)) : '— nvidia-smi unavailable';
      }
      if (smi.power_w != null) {
        this.setText('gpuPower', Math.round(smi.power_w));
        const note = document.getElementById('gpuPowerNote');
        if (note) {
          const limit = smi.power_limit_w;
          if (limit) note.textContent = `${Math.round(smi.power_w)}W of ${Math.round(limit)}W limit`;
          else note.textContent = `live draw`;
        }
      } else {
        const note = document.getElementById('gpuPowerNote');
        if (note) note.textContent = smi.error ? ('— ' + smi.error.slice(0, 80)) : '— nvidia-smi unavailable';
      }
      // Fan slot doesn't exist as a mini-card but surface in the temp note
      // when temp is also available — useful diagnostic for "why isn't it cooling".
      if (smi.fan_pct != null && smi.temp_c != null) {
        const note = document.getElementById('gpuTempNote');
        if (note) note.textContent = note.textContent + ' · fan ' + Math.round(smi.fan_pct) + '%';
      }
    },
    setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    },
    start() {
      this.probe();
      // Live-event path: subscribe to gpu.tick / health.tick / route.changed
      // on the WS event bus. The setInterval below stays as a 30s safety
      // net for when the WS is down (sidecar restarting, etc).
      const ev = window.SeekDeepEvents;
      if (ev && typeof ev.on === 'function') {
        ev.on('gpu.tick',     (data) => { if (data) this.applyGpu(data); });
        ev.on('health.tick',  (data) => { if (data) this.applyHealth(data); });
        ev.on('route.changed', () => this.probe());
        ev.on('_open',         () => this.probe());
        this.timer = setInterval(() => this.probe(), 30000);
      } else {
        this.timer = setInterval(() => this.probe(), 5000);
      }
    }
  };
  LIVE.start();

  // ===== Persona-grid click → POST /persona (global scope) =====
  // Cards had .active styling toggled by the Tweaks UI but no click handler,
  // so clicking them did nothing. Wire a delegated handler that posts the
  // selected slug to /persona scope=global and updates active styling.
  (function wirePersonaGridClicks() {
    const grid = document.getElementById('persona-grid');
    if (!grid) return;
    grid.addEventListener('click', async (e) => {
      const card = e.target.closest('.persona-card[data-persona]');
      if (!card) return;
      const slug = card.dataset.persona;
      if (!slug) return;
      // Optimistic active toggle so the click feels immediate
      grid.querySelectorAll('.persona-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      try {
        const r = await fetch(SEEKDEEP_BASE + '/persona', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'global', persona: slug }),
          signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // Update footer pill to match
        const sb = document.getElementById('sb-persona');
        if (sb) sb.textContent = slug.toUpperCase();
      } catch (err) {
        // Revert active state and toast the failure
        card.classList.remove('active');
        if (window.SeekDeepNotify?.toast) {
          window.SeekDeepNotify.toast({ tone: 'bad', title: 'Persona update failed', body: String(err && err.message || err), ttl: 4000 });
        }
      }
    });
  })();

  // ===== Persona-grid hydration — append custom personas from /persona =====
  // The four built-in cards (clinical/neurotic/unsettling/chaotic) are
  // baked into the markup with their tone descriptions. Custom personas
  // defined via @SeekDeep persona create get a generic "(custom)" card
  // here so the user can click-to-select them in the Tweaks panel.
  (async function hydratePersonaGrid() {
    const grid = document.getElementById('persona-grid');
    if (!grid) return;
    try {
      const r = await sdPollFetch(SEEKDEEP_BASE + '/persona', { timeout: 3000, attempts: 2 });
      if (!r.ok) return;
      const d = await r.json();
      if (!Array.isArray(d.valid_personas)) return;
      const builtIn = new Set(['clinical','neurotic','unsettling','chaotic']);
      const existing = new Set([...grid.querySelectorAll('.persona-card')].map(c => c.dataset.persona));
      for (const slug of d.valid_personas) {
        const s = String(slug).toLowerCase();
        if (builtIn.has(s) || existing.has(s)) continue;
        const card = document.createElement('div');
        card.className = 'persona-card';
        card.setAttribute('data-persona', s);
        const h4 = document.createElement('h4');
        h4.textContent = s.charAt(0).toUpperCase() + s.slice(1);
        const p = document.createElement('p');
        p.textContent = 'custom persona · defined via @SeekDeep persona create. Click to set globally.';
        card.appendChild(h4); card.appendChild(p);
        grid.appendChild(card);
      }
    } catch { /* leave the 4 built-in cards as-is */ }
  })();

  // ===== Footer status bar pumps (persona / web / queue) =====
  // sb-persona was hardcoded "CLINICAL" forever; sb-web was hardcoded
  // "SEARXNG · :8080" even when searxng was unreachable. Now they reflect
  // real /persona + searxng-probe state.
  (function pumpFooter() {
    const personaEl = document.getElementById('sb-persona');
    const webEl     = document.getElementById('sb-web');
    if (!personaEl && !webEl) return;
    async function pull() {
      // Persona — /persona returns effective_global / global / env_default
      if (personaEl) {
        try {
          const r = await sdPollFetch(SEEKDEEP_BASE + '/persona', { timeout: 3000, attempts: 2 });
          if (r.ok) {
            const d = await r.json();
            const slug = String(d.effective_global || d.global || d.env_default || '').trim();
            if (slug) personaEl.textContent = slug.toUpperCase();
            else personaEl.textContent = '—';
          }
        } catch { /* leave the dash */ }
      }
      // Web search backend — /launchers/status reports searxng state.
      if (webEl) {
        try {
          const r = await sdPollFetch(SEEKDEEP_BASE + '/launchers/status', { timeout: 3000, attempts: 2 });
          if (r.ok) {
            const d = await r.json();
            const sx = (d && d.services && d.services.searxng) || {};
            if (sx.state === 'running') webEl.textContent = 'SEARXNG · :8080';
            else if (sx.state === 'exited' || sx.state === 'not-running') webEl.textContent = 'SEARXNG · OFF';
            else webEl.textContent = '—';
          }
        } catch { /* leave the dash */ }
      }
    }
    pull();
    setInterval(pull, 15000);
  })();

  // ===== Clock — kick-start before the existing setInterval ticks =====
  (function tickClockNow() {
    const clk = document.getElementById('clock');
    if (!clk) return;
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    clk.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  })();

  // ===== Config: collapse / expand all =====
  document.getElementById('cfg-collapse-all')?.addEventListener('click', () => {
    document.querySelectorAll('.cfg-section').forEach(s => s.open = false);
  });
  document.getElementById('cfg-expand-all')?.addEventListener('click', () => {
    document.querySelectorAll('.cfg-section').forEach(s => s.open = true);
  });

  // Quickjump: opens AND scrolls
  document.querySelectorAll('.cfg-quickjump a.qj').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const tgt = document.querySelector(a.getAttribute('href'));
      if (tgt) {
        tgt.open = true;
        document.querySelector('.main').scrollTo({ top: tgt.offsetTop - 40, behavior: 'smooth' });
      }
    });
  });

  // ===== Config: dirty tracking =====
  // Audit §1: include .cfg-feature[data-key] cards alongside .config-row.
  // Same dirty marker, same save badge, same /config POST path — just a
  // different DOM shape so the existing dirty/save code can find them.
  const CFG_ROW_SELECTOR = '.config-row, .cfg-feature[data-key]';
  const CFG_SAVE_SELECTOR = '.config-row .save, .cfg-feature[data-key] .save';
  window.markDirty = function(el) {
    const row = el.closest(CFG_ROW_SELECTOR);
    if (row) {
      const save = row.querySelector('.save');
      if (save) { save.textContent = 'DIRTY'; save.style.color = 'var(--warn)'; }
    }
    recountDirty();
  };
  function recountDirty() {
    const allSaves = document.querySelectorAll('.cfg-section ' + CFG_SAVE_SELECTOR);
    const dirtyCount = [...allSaves].filter(s => s.textContent.includes('DIRTY')).length;
    const counter = document.getElementById('cfg-dirty-count');
    if (counter) counter.textContent = dirtyCount;
    document.querySelectorAll('details.cfg-section').forEach(sec => {
      const tag = sec.querySelector('summary > .sec-dirty');
      if (!tag) return;
      const sectionSaves = sec.querySelectorAll(CFG_SAVE_SELECTOR);
      const n = sectionSaves
        ? [...sectionSaves].filter(s => s.textContent.includes('DIRTY')).length
        : 0;
      tag.textContent = n > 0 ? (n + ' dirty') : '';
    });
  }
  // dirty-flag tracking for native inputs/selects. Was an explicit
  // per-section selector list that missed sec-paths / sec-remote /
  // sec-features / sec-personas — so changes in those sections never
  // marked the row DIRTY, never showed up in the per-section dirty
  // count, and didn't get POSTed by Save. Cover every cfg-section row.
  document.querySelectorAll('.cfg-section .config-row input, .cfg-section .config-row select').forEach(el => {
    el.addEventListener('change', () => { markDirty(el); validateField(el); });
    el.addEventListener('input',  () => { markDirty(el); validateField(el); });
  });

  // ===== Client-side validation =====================================
  // Rules table keyed by ENV var name. Validators return null on pass,
  // a short error string on fail. Inline error message gets attached
  // to the row; Save button gates on no validation errors anywhere.
  const CFG_VALIDATORS = {
    DISCORD_TOKEN:           v => !v || v.length >= 50 ? null : 'Token too short (Discord bot tokens are 70+ chars)',
    DISCORD_CLIENT_ID:       v => !v || /^\d{15,25}$/.test(v) ? null : 'Should be a numeric snowflake (15-25 digits)',
    SEEKDEEP_ALLOWED_CHANNELS: v => !v || /^[\d,\s]+$/.test(v) ? null : 'Comma-separated numeric channel IDs',
    SEEKDEEP_BLOCKED_CHANNELS: v => !v || /^[\d,\s]+$/.test(v) ? null : 'Comma-separated numeric channel IDs',
    SEEKDEEP_ADMIN_IDS:      v => !v || /^[\d,\s]+$/.test(v) ? null : 'Comma-separated numeric user IDs',
    MAX_DISCORD_CHARS:       v => !v || (/^\d+$/.test(v) && +v >= 500 && +v <= 2000) ? null : 'Integer 500-2000 (Discord hard cap is 2000)',
    HF_TOKEN:                v => !v || /^hf_[A-Za-z0-9]+$/.test(v) ? null : 'HF tokens start with "hf_"',
  };
  function validateField(el) {
    const row = el.closest('.config-row');
    if (!row) return;
    const keyEl = row.querySelector('.key');
    if (!keyEl) return;
    const key = keyEl.textContent.trim();
    const rule = CFG_VALIDATORS[key];
    if (!rule) return;
    const msg = rule(String(el.value || '').trim());
    // Attach / replace an inline error span (".cfg-err") just inside the row
    let errEl = row.querySelector('.cfg-err');
    if (msg) {
      if (!errEl) {
        errEl = document.createElement('div');
        errEl.className = 'cfg-err';
        errEl.style.cssText = 'grid-column: 1/-1; padding: 4px 0 0 0; font-family: var(--font-mono); font-size: 10px; color: var(--bad); letter-spacing: 0.06em;';
        row.appendChild(errEl);
      }
      errEl.textContent = '✕ ' + msg;
      el.style.borderColor = 'var(--bad)';
    } else {
      if (errEl) errEl.remove();
      el.style.borderColor = '';
    }
  }
  // Run an initial pass so Reload-from-disk-populated values get a fresh badge
  function validateAll() {
    document.querySelectorAll('.cfg-section .config-row input, .cfg-section .config-row select').forEach(validateField);
  }

  // ===== beforeunload warning on dirty config ========================
  // Browser shows "Leave site? Changes you made may not be saved." when
  // the user navigates away with unsaved edits. Was: silent loss every
  // time you switched panes via the sidebar (which navigates within the
  // SPA but not via a real beforeunload — so this guards the page-reload
  // / window-close / external-link case). Sidebar nav doesn't fire
  // beforeunload, so dirty state survives across panes already.
  //
  // Critical scoping: ONLY warn when the user is currently looking at the
  // Bot config pane AND it has DIRTY save buttons. Earlier this fired
  // from any pane (Image playground, Chat playground, Archive) because
  // it queried the whole document — and a lingering "DIRTY" from an
  // earlier session would prompt on every page-nav out of app.html.
  window.addEventListener('beforeunload', (e) => {
    const activeConfigPane = document.querySelector('.pane.active[data-pane="config"]');
    if (!activeConfigPane) return undefined;  // not on config pane → no risk
    const saves = activeConfigPane.querySelectorAll('.config-row .save');
    const dirty = [...saves].some(s => s.textContent.includes('DIRTY'));
    if (!dirty) return undefined;
    e.preventDefault();
    e.returnValue = 'You have unsaved config changes. Save them before reloading.';
    return e.returnValue;
  });

  // "Reload from disk" button — GET /config and populate every .config-row
  // whose .key textContent matches a returned env key. Secrets come back
  // redacted as "*****" so we just clear the input (browser shows placeholder
  // "set in .env · redacted by /config" instead of fake dots).
  (function wireConfigReload() {
    const btn = [...document.querySelectorAll('.head-row .actions button')].find(b =>
      (b.textContent || '').toLowerCase().trim() === 'reload from disk');
    if (!btn) return;
    // Extracted so we can also call it on first Config-pane activation,
    // not only on button click. Previously the page loaded with every
    // .save badge hardcoded "SAVED" and no actual /config fetch — the
    // badges lied about persisted state until the user clicked Reload.
    async function loadFromDisk(silent) {
      const orig = btn.textContent;
      if (!silent) { btn.disabled = true; btn.textContent = 'Loading…'; }
      try {
        const r = await sdPollFetch(SEEKDEEP_BASE + '/config', { timeout: 5000, attempts: 3 });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const env = (data && data.env) || {};
        let populated = 0, redacted = 0;
        // Helper: pull the env-var key for a row, whether it's an
        // input-style .config-row (with a <span class="key">) or a
        // .cfg-feature card (data-key="..."). Audit §1 fix.
        function rowKey(row) {
          if (row.dataset && row.dataset.key) return row.dataset.key.trim();
          const k = row.querySelector('.key');
          return k ? k.textContent.trim() : null;
        }
        document.querySelectorAll('.config-row, .cfg-feature[data-key]').forEach(row => {
          const key = rowKey(row);
          if (!key) return;
          const present = (key in env);
          const v = present ? env[key] : '';
          // Shared-renderer rows (config-render.js) hydrate themselves — value
          // + toggle label — via the hook the reconcile attached. No-op for
          // rows still on the hand-coded path.
          if (typeof row._sdHydrate === 'function') {
            if (present) row._sdHydrate(v === '*****' ? '' : v);
            const sv = row.querySelector('.save');
            if (sv) { sv.textContent = 'SAVED'; sv.style.color = ''; }
            if (present && v === '*****') redacted++; else populated++;
            return;
          }
          // Toggle rows (feature flags + any future on/off card): set
          // .toggle.on based on /env value. "on"/"true"/"1"/"yes" → on.
          // A feature flag ABSENT from .env is not "unknown" — the bot/server
          // treat an unset SEEKDEEP_FEATURE_* as off. So hydrate absent
          // toggles to off + badge SAVED instead of leaving them stuck on
          // UNKNOWN forever (audit §1 follow-up surfaced by the e2e suite).
          const tgl = row.querySelector('.toggle');
          if (tgl && !row.querySelector('input, select')) {
            const onish = present && ['1','true','yes','on'].includes(String(v || '').toLowerCase());
            tgl.classList.toggle('on', onish);
            const save = row.querySelector('.save');
            if (save) { save.textContent = 'SAVED'; save.style.color = ''; }
            populated++;
            return;
          }
          // Input/select rows: only populate when the key is actually present
          // (absent input keys keep their placeholder — empty is meaningful).
          if (!present) return;
          const input = row.querySelector('input, select');
          if (!input) return;
          if (v === '*****') {
            input.value = '';
            redacted++;
          } else {
            input.value = String(v || '');
            populated++;
          }
          const save = row.querySelector('.save');
          if (save) { save.textContent = 'SAVED'; save.style.color = ''; }
        });
        if (typeof recountDirty === 'function') recountDirty();
        if (typeof validateAll === 'function') validateAll();
        if (!silent) {
          btn.textContent = `Loaded ${populated} · ${redacted} redacted`;
          setTimeout(() => { btn.textContent = orig; }, 2400);
        }
      } catch (err) {
        if (!silent) {
          btn.textContent = 'Offline · /config unreachable';
          btn.style.color = 'var(--warn)';
          setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 3000);
        }
        // Silent path: if /config is unreachable on first mount, mark
        // every .save badge as UNKNOWN so the user knows we never read
        // the actual .env. Otherwise the hardcoded "SAVED" badges lie.
        if (silent) {
          document.querySelectorAll('.config-row .save').forEach(s => {
            s.textContent = 'UNKNOWN';
            s.style.color = 'var(--warn)';
            s.title = 'Server unreachable — could not read .env. Click "Reload from disk" once it\'s back.';
          });
        }
      } finally {
        if (!silent) btn.disabled = false;
      }
    }
    btn.addEventListener('click', () => loadFromDisk(false));

    // Route hand-coded config controls through the shared renderer (config-
    // render.js) so they can't drift from All Settings. SELECT rows get their
    // options from the schema (2c — e.g. CHAT_PROVIDER's list was missing
    // 'ollama'); TOGGLE rows get the schema's boolean vocabulary + a value label
    // (2d — bespoke toggles saved a fixed on/off, so a true/false key like
    // MODEL_AUTO_FALLBACK wrote KEY=on instead of KEY=true). Strict kind-match:
    // a row is converted only when its existing control matches the schema kind,
    // so curated controls survive (offline flags are schema kind 'toggle' but a
    // labeled <select>; inputs keep their hand-written placeholders). Save
    // (_sdRead) + hydrate (_sdHydrate) hooks landed in 2a/2b.
    async function reconcileConfigControlsFromSchema() {
      const R = window.SeekDeepConfigRender;
      if (!R || typeof R.makeControl !== 'function') return;
      let schema;
      try {
        // sdPollFetch retries across the window where nav.js hasn't yet patched
        // fetch with the GUI token — a one-shot fetch here 401s and silently
        // skips the conversion (same token-interceptor race loadFromDisk rides).
        const r = await sdPollFetch(SEEKDEEP_BASE + '/config/schema', { timeout: 5000, attempts: 4 });
        schema = await r.json();
      } catch (_) { return; }   // schema unreachable → keep hand-coded controls
      if (!schema || !schema.ok || !Array.isArray(schema.sections)) return;
      const fields = {};
      for (const sec of schema.sections) for (const f of (sec.keys || [])) fields[f.key] = f;
      document.querySelectorAll('.cfg-section .config-row').forEach(row => {
        if (row._sdRead) return;                          // already converted
        const key = row.querySelector('.key')?.textContent.trim();
        if (!key) return;
        const field = fields[key];
        if (!field) return;
        // Kind-match: only convert a row whose EXISTING control matches the
        // schema kind, so curated controls survive untouched — e.g. the offline
        // flags are schema kind 'toggle' but rendered as a labeled <select>
        // (no .toggle), so they're skipped here. Inputs stay bespoke too: their
        // hand-written placeholders ("(empty · comma-separated)") beat generic.
        let existing, keepClass = '', flexWrap = null, baseline = '';
        if (field.kind === 'select') {
          existing = row.querySelector('select');
          if (!existing) return;
          keepClass = existing.className;                 // keep .mono styling
          baseline = existing.value;
        } else if (field.kind === 'toggle') {
          existing = row.querySelector('.toggle');
          if (!existing) return;                          // curated <select> → skip
          flexWrap = existing.parentElement;              // grid cell → flex (label + toggle)
          baseline = existing.classList.contains('on') ? '1' : '';
        } else {
          return;                                         // inputs/secrets: left bespoke
        }
        const c = R.makeControl(field, { baseline: baseline, onChange: () => markDirty(row) });
        if (keepClass && c.nodes[0]) c.nodes[0].className = keepClass;
        existing.replaceWith(...c.nodes);
        if (flexWrap) flexWrap.classList.add('cfg-ctrl-flex');
        row._sdRead = c.read;
        row._sdHydrate = c.hydrate;
      });
    }

    // Auto-load when the Config pane becomes active for the first time.
    // Sentinel on window so we don't refetch on every sidebar click.
    const autoload = () => {
      const pane = document.querySelector('[data-pane="config"]');
      if (!pane || !pane.classList.contains('active')) return;
      if (window.__seekdeepConfigAutoLoaded) return;
      window.__seekdeepConfigAutoLoaded = true;
      // Reconcile control rendering from the schema FIRST, then hydrate values
      // (loadFromDisk's _sdHydrate path fills the converted controls).
      reconcileConfigControlsFromSchema().finally(() => loadFromDisk(true));
    };
    document.querySelectorAll('.sidebar a[data-mod="config"]').forEach(a =>
      a.addEventListener('click', () => setTimeout(autoload, 60))
    );
    // Run once deferred scripts (config-render.js) have loaded, so the
    // reconcile can see window.SeekDeepConfigRender.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoload, { once: true });
    else autoload();
  })();

  // Member-log "Test post" button (audit §10b). A real Discord post can
  // only come from the bot (the AI server can't post; the bot has no HTTP
  // listener), so this validates the preconditions and tells the user what
  // to expect rather than faking an event. Uses operation() for a clean
  // start→result toast pair.
  (function wireMemberLogTest() {
    const btn = document.getElementById('memberLogTestBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const sdn = window.SeekDeepNotify;
      if (!sdn || typeof sdn.operation !== 'function') return;
      sdn.operation({
        label: 'Member-log preflight',
        successTitle: 'Member log is ready',
        errorTitle: 'Member log not ready',
        run: async () => {
          const chan = (document.getElementById('memberLogChannel')?.value || '').trim();
          if (!/^\d{17,20}$/.test(chan)) {
            throw new Error('Set a valid channel ID (17–20 digits) and Save first.');
          }
          // Read the canonical status file (§8) to confirm the bot is online.
          const getJson = (window.SeekDeepFetch && window.SeekDeepFetch.json)
            ? (u) => window.SeekDeepFetch.json(u, { attemptTimeoutMs: 4000, maxAttempts: 3 })
            : async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
          let state;
          try { state = await getJson(SEEKDEEP_BASE + '/data/system-state.json'); } catch (_) { state = null; }
          const bot = state && state.data && state.data.bot;
          if (!bot || !bot.ready) {
            throw new Error('Bot is not connected to Discord yet — start it and wait for READY, then test.');
          }
          return 'Config looks good. Have an alt account join/leave the channel\'s server to confirm the embed posts. (A real post can only be triggered by an actual Discord join/leave event.)';
        },
      }).catch(() => {});
    });
  })();

  // Save button — POST /config with dirty values, fall back to local-only "saved" on offline
  document.getElementById('cfg-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    // Multi-window guard: another window saving simultaneously means
    // last-writer-wins and earlier user thinks their save took effect.
    if (window.SeekDeepWindows && !(await window.SeekDeepWindows.confirmIfMultiple('Save config to .env'))) return;
    // Validation gate — refuse to save if any field has a CFG_VALIDATORS
    // error active. Was: silently sent garbage and let the server 422.
    validateAll();
    const errs = document.querySelectorAll('.config-row .cfg-err');
    if (errs.length) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<span id="cfg-dirty-count">' + errs.length + '</span> validation error' + (errs.length === 1 ? '' : 's') + ' · fix before save';
      btn.style.color = 'var(--bad)';
      // Scroll to first error so the user can see what's wrong
      errs[0].closest('.config-row')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Also expand the section containing it so it's actually visible
      errs[0].closest('details.cfg-section')?.setAttribute('open', '');
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 4000);
      return;
    }
    // Audit §1: include .cfg-feature[data-key] cards in the dirty sweep.
    const dirtyRows = [...document.querySelectorAll('.config-row .save, .cfg-feature[data-key] .save')]
      .filter(s => s.textContent.includes('DIRTY'))
      .map(s => s.closest('.config-row, .cfg-feature[data-key]'));

    // Collect updates: { ENV_KEY: value }
    const updates = {};
    dirtyRows.forEach(row => {
      // Dual key source: data-key attribute (feature cards) or
      // <span class="key"> text (config rows). Either is fine.
      const key = (row.dataset && row.dataset.key)
        ? row.dataset.key.trim()
        : (row.querySelector('.key')?.textContent.trim());
      if (!key) return;
      let val;
      // Shared-renderer rows (config-render.js makeControl) attach a vocab-aware
      // read() to the row as _sdRead — use it so a shared toggle saves the key's
      // real value (e.g. "1"/"0" for HF offline flags) instead of a blind
      // "on"/"off". Rows not yet on the shared renderer keep the original read
      // path unchanged, so this is a no-op until a row opts in.
      if (typeof row._sdRead === 'function') {
        val = row._sdRead();
      } else {
        const input = row.querySelector('input, select');
        if (input) {
          val = input.value;
        } else {
          const tgl = row.querySelector('.toggle');
          if (tgl) val = tgl.classList.contains('on') ? 'on' : 'off';
        }
      }
      if (val !== undefined) updates[key] = val;
    });

    btn.disabled = true;
    btn.innerHTML = '<span id="cfg-dirty-count">' + Object.keys(updates).length + '</span> saving…';

    let liveOk = false, errMsg = '';
    if (Object.keys(updates).length > 0) {
      try {
        const r = await fetch(SEEKDEEP_BASE + '/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          liveOk = data.ok !== false;
        } else if (r.status === 404) {
          errMsg = '/config endpoint missing — add it per INTEGRATION.md';
        } else {
          errMsg = 'server returned ' + r.status;
        }
      } catch (e) {
        errMsg = 'server unreachable — saved locally only';
      }
    } else {
      liveOk = true;
    }

    btn.disabled = false;
    // Only flip row markers to SAVED when the POST actually succeeded.
    // On failure, keep dirty markers so the user knows nothing was written.
    if (liveOk) {
      // Audit §1: include .cfg-feature[data-key] saves in the SAVED sweep.
      document.querySelectorAll('.config-row .save, .cfg-feature[data-key] .save').forEach(s => {
        s.textContent = 'SAVED';
        s.style.color = '';
      });
    } else {
      btn.style.color = 'var(--warn)';
      if (window.SeekDeepNotify?.toast) {
        window.SeekDeepNotify.toast({
          tone: 'bad', title: 'Save failed · changes NOT written',
          body: errMsg, ttl: 6000,
        });
      }
    }

    if (liveOk) {
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-ghost');
      btn.innerHTML = '<span id="cfg-dirty-count">0</span> saved to .env · click Reload .env to apply';
      // Toast a reminder that the running processes still have the old
      // env values until restart. Was silent — user clicked Save, saw a
      // green checkmark, then their changes silently didn't apply
      // because they hadn't hit Reload .env.
      if (Object.keys(updates).length > 0 && window.SeekDeepNotify?.toast) {
        window.SeekDeepNotify.toast({
          tone: 'info',
          title: `Saved ${Object.keys(updates).length} value${Object.keys(updates).length === 1 ? '' : 's'} to .env`,
          body: 'Click <strong>⟳ Reload .env</strong> in the Launcher panel to restart the AI server + bot so they pick up the new values.',
          html: true,
          ttl: 8000,
        });
      }
    } else {
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-ghost');
      btn.innerHTML = '<span id="cfg-dirty-count">0</span> ' + (errMsg || 'server reported failure');
      btn.style.color = 'var(--warn)';
    }

    setTimeout(() => {
      btn.classList.remove('btn-ghost');
      btn.classList.add('btn-primary');
      btn.style.color = '';
      btn.innerHTML = '<span id="cfg-dirty-count">0</span> pending · save';
    }, 5000);  // longer so the user has time to read "click Reload .env"
  });

  // Section-count refresher. Both the quick-jump sidebar (.qj .ct) and the
  // collapsible section headers (.sec-count) had HARDCODED counts ("9",
  // "8", "7"...) that never changed. So:
  //   - Filtering for "TOKEN" hid 60 rows but the sidebar still showed
  //     "Discord & routing 9"
  //   - Adding/removing rows in HTML without bumping the literals shows
  //     a stale total
  // recountConfigSections() rederives counts from the live DOM. Run once
  // on Config-pane mount and again on every cfg-filter input event so
  // the user always sees how many rows actually match.
  function recountConfigSections() {
    document.querySelectorAll('.cfg-section').forEach(sec => {
      const visible = [...sec.querySelectorAll('.config-row, .card-mini')]
        .filter(r => r.style.display !== 'none').length;
      const total = sec.querySelectorAll('.config-row, .card-mini').length;
      const txt = visible === total ? String(total) : `${visible}/${total}`;
      const badge = sec.querySelector('summary .sec-count');
      if (badge) badge.textContent = txt;
      // Match the section to its quick-jump entry via the section's id
      // (e.g. id="sec-discord" -> a.qj[href="#sec-discord"]).
      const id = sec.id || sec.getAttribute('id');
      if (id) {
        const qj = document.querySelector(`a.qj[href="#${id}"] .ct`);
        if (qj) qj.textContent = txt;
      }
    });
  }
  recountConfigSections();

  // Config filter
  document.getElementById('cfg-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.cfg-section .config-row, .cfg-section .card-mini').forEach(row => {
      const txt = row.textContent.toLowerCase();
      row.style.display = (!q || txt.includes(q)) ? '' : 'none';
    });
    // open any section that has visible rows
    if (q) {
      document.querySelectorAll('.cfg-section').forEach(sec => {
        const anyVisible = [...sec.querySelectorAll('.config-row, .card-mini')]
          .some(r => r.style.display !== 'none');
        sec.open = anyVisible;
      });
    }
    recountConfigSections();
  });

  // ===== Persona cards (sync with Tweaks panel) =====
  document.querySelectorAll('#persona-grid .persona-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#persona-grid .persona-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      window.dispatchEvent(new CustomEvent('seekdeep:setPersona', { detail: card.dataset.persona }));
    });
  });

  // ===== Launcher: live wiring (POST /launcher/{svc}/{action}) =====
  document.querySelectorAll('.launcher-card[data-svc]').forEach(card => {
    const svc = card.dataset.svc;
    const btns = card.querySelectorAll('.ctl button');
    const pill = card.querySelector('.pill');
    const restartBtn = btns[0];
    const stopBtn    = btns[1];

    function setPill(state) {
      if (!pill) return;
      pill.classList.remove('on', 'bad', 'warn');
      if (state === 'running')      { pill.classList.add('on');   pill.innerHTML = '<span class="dot"></span>HEALTHY'; }
      else if (state === 'starting'){ pill.classList.add('warn'); pill.innerHTML = '<span class="dot"></span>STARTING'; }
      else if (state === 'stopped' || state === 'not-running' || state === 'exited') {
        pill.classList.add('bad'); pill.innerHTML = '<span class="dot"></span>STOPPED';
      } else { pill.innerHTML = '<span class="dot"></span>' + (state || '').toUpperCase(); }
    }
    function setCardUp(up) {
      card.classList.toggle('up', up);
      card.classList.toggle('down', !up);
      if (stopBtn) {
        stopBtn.textContent = up ? 'Stop' : 'Start';
        stopBtn.style.color = up ? 'var(--bad)' : 'var(--good)';
      }
    }
    async function action(act) {
      try {
        const r = await fetch(SEEKDEEP_BASE + '/launcher/' + svc + '/' + act, {
          method: 'POST', signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const state = data.state || 'unknown';
        setPill(state);
        setCardUp(state === 'running' || state === 'starting' || state === 'already-running');
      } catch (e) {
        // Local fallback when server is unreachable
        setPill('OFFLINE');
        setCardUp(act === 'start' || act === 'restart');
      }
    }

    if (restartBtn) restartBtn.addEventListener('click', () => action('restart'));
    if (stopBtn) stopBtn.addEventListener('click', () => {
      const up = card.classList.contains('up');
      action(up ? 'stop' : 'start');
    });
  });

  // Initial status sweep so the cards reflect reality on load
  (async () => {
    for (const card of document.querySelectorAll('.launcher-card[data-svc]')) {
      const svc = card.dataset.svc;
      try {
        const r = await fetch(SEEKDEEP_BASE + '/launcher/' + svc + '/status', {
          method: 'POST', signal: AbortSignal.timeout(2000),
        });
        if (r.ok) {
          const data = await r.json();
          const pill = card.querySelector('.pill');
          const stopBtn = card.querySelectorAll('.ctl button')[1];
          if (data.state === 'running') {
            pill.classList.remove('bad'); pill.classList.add('on');
            pill.innerHTML = '<span class="dot"></span>HEALTHY';
            card.classList.remove('down'); card.classList.add('up');
            if (stopBtn) { stopBtn.textContent = 'Stop'; stopBtn.style.color = 'var(--bad)'; }
          } else if (data.state === 'not-running' || data.state === 'exited') {
            pill.classList.remove('on'); pill.classList.add('bad');
            pill.innerHTML = '<span class="dot"></span>STOPPED';
            card.classList.remove('up'); card.classList.add('down');
            if (stopBtn) { stopBtn.textContent = 'Start'; stopBtn.style.color = 'var(--good)'; }
          }
        }
      } catch (err) { window.SeekDeepDebug?.warn('launcher-card status', err); }  // offline → leave the visual default
    }
  })();

  // Launch all / Stop all
  const launcherPane = document.querySelector('[data-pane="launcher"]');
  if (launcherPane) {
    const actBtns = launcherPane.querySelectorAll('.head-row .actions .btn');
    if (actBtns[0]) actBtns[0].addEventListener('click', () => {
      launcherPane.querySelectorAll('.launcher-card .ctl button:last-child').forEach(b => b.click());
    });
    if (actBtns[1]) actBtns[1].addEventListener('click', () => {
      launcherPane.querySelectorAll('.launcher-card .ctl button:first-child').forEach(b => b.click());
    });
    // First-run orientation hint — dismissible, remembered per browser so it
    // only nudges genuinely-new users and never nags after the first dismiss.
    const frHint = document.getElementById('firstRunHint');
    if (frHint) {
      try { if (localStorage.getItem('sd-firstrun-hint-dismissed') === '1') frHint.style.display = 'none'; } catch (_) {}
      const frClose = document.getElementById('firstRunHintClose');
      if (frClose) frClose.addEventListener('click', () => {
        frHint.style.display = 'none';
        try { localStorage.setItem('sd-firstrun-hint-dismissed', '1'); } catch (_) {}
      });
    }
  }

  // ===== Image playground · live wiring (POST /image|/img2img|/instruct-pix2pix|/inpaint|/upscale) =====
  // Mode-aware. Each mode shows/hides the controls it needs and posts to the
  // right endpoint with the right body shape:
  //   txt2img → /image            prompt + dims + guidance + steps + seed
  //   img2img → /img2img          prompt + source + strength + dims + guidance + steps + seed
  //   pix2pix → /instruct-pix2pix instruction (=prompt) + source + guidance + image_guidance + steps + seed
  //   inpaint → /inpaint          prompt + remove_target + source + strength + dims + guidance + steps + seed
  //   upscale → /upscale          source + scale + method  (no prompt)
  (function wireImagePlayground() {
    const genBtn = document.getElementById('ipGenBtn');
    const regenBtn = document.getElementById('ipRegenBtn');
    const canvas = document.getElementById('ipCanvas');
    if (!genBtn || !canvas) return;

    const refs = {
      prompt:  document.getElementById('ipPrompt'),
      promptLabel: document.getElementById('ipPromptLabel'),
      neg:     document.getElementById('ipNeg'),
      negField:document.getElementById('ipNegField'),
      w:       document.getElementById('ipW'),
      h:       document.getElementById('ipH'),
      seed:    document.getElementById('ipSeed'),
      guid:    document.getElementById('ipGuid'),
      guidLabel: document.getElementById('ipGuidLabel'),
      steps:   document.getElementById('ipSteps'),
      quality: document.getElementById('ipQuality'),
      style:   document.getElementById('ipStyle'),
      qualityField: document.getElementById('ipQualityField'),
      dimField:document.getElementById('ipDimField'),
      guidField:document.getElementById('ipGuidField'),
      refineField:document.getElementById('ipRefineField'),
      strengthField:document.getElementById('ipStrengthField'),
      strength:document.getElementById('ipStrength'),
      strengthVal:document.getElementById('ipStrengthVal'),
      upscaleField:document.getElementById('ipUpscaleField'),
      upscaleScale:document.getElementById('ipUpscaleScale'),
      upscaleMethod:document.getElementById('ipUpscaleMethod'),
      removeField:document.getElementById('ipRemoveField'),
      removeTarget:document.getElementById('ipRemoveTarget'),
      srcField:document.getElementById('ipSrcField'),
      srcDrop: document.getElementById('ipSrcDrop'),
      srcEmpty:document.getElementById('ipSrcEmpty'),
      srcPreview:document.getElementById('ipSrcPreview'),
      srcImg:  document.getElementById('ipSrcImg'),
      srcMeta: document.getElementById('ipSrcMeta'),
      srcClear:document.getElementById('ipSrcClear'),
      srcFile: document.getElementById('ipSrcFile'),
      placeholder: document.getElementById('ipPlaceholder'),
      image:   document.getElementById('ipImage'),
      status:  document.getElementById('ipStatus'),
      history: document.getElementById('ipHistory'),
      download:document.getElementById('ipDownload'),
      modeHint:document.getElementById('ipModeHint'),
    };

    // ---- Mode state ----
    // Active mode comes from .mode-tabs .chip[data-mode].active (default txt2img).
    function activeMode() {
      const c = document.querySelector('.mode-tabs .chip.active[data-mode]');
      return (c && c.dataset.mode) || 'txt2img';
    }

    // Per-mode field visibility + button label + hint text. Driven by a single
    // table so adding a mode is one entry instead of N if-branches.
    const MODE_UI = {
      txt2img: {
        src:false, prompt:true,  remove:false, neg:true,  strength:false, upscale:false,
        refine:true, quality:true, dim:true,  guid:true,
        promptLabel:'Prompt', guidLabel:'Guidance / steps', btn:'▸ Generate',
        hint:'▸ SDXL txt2img · prompt only',
      },
      img2img: {
        src:true,  prompt:true,  remove:false, neg:true,  strength:true,  upscale:false,
        refine:false, quality:false, dim:true,  guid:true,
        promptLabel:'Prompt', guidLabel:'Guidance / steps', btn:'▸ Img2img',
        hint:'▸ SDXL img2img · source + prompt · strength controls how far it drifts',
      },
      pix2pix: {
        src:true,  prompt:true,  remove:false, neg:true,  strength:false, upscale:false,
        refine:false, quality:false, dim:false, guid:true,
        promptLabel:'Instruction', guidLabel:'Guidance / steps · image_guidance is hidden (defaults to 1.5)', btn:'▸ Pix2pix',
        hint:'▸ InstructPix2Pix · "make it neon" · "remove the watermark"',
      },
      inpaint: {
        src:true,  prompt:true,  remove:true,  neg:true,  strength:true,  upscale:false,
        refine:false, quality:false, dim:true,  guid:true,
        promptLabel:'Scene prompt · what fills the hole', guidLabel:'Guidance / steps', btn:'▸ Inpaint',
        hint:'▸ CLIPSeg mask + SDXL inpainting · target = what to remove',
      },
      upscale: {
        src:true,  prompt:false, remove:false, neg:false, strength:false, upscale:true,
        refine:false, quality:false, dim:false, guid:false,
        promptLabel:'Prompt', guidLabel:'Guidance / steps', btn:'▸ Upscale',
        hint:'▸ Lanczos (fast) or Real-ESRGAN (model · slow but sharper)',
      },
    };

    function show(el, on) {
      if (!el) return;
      el.style.display = on ? '' : 'none';
    }
    function applyModeUI() {
      const m = activeMode();
      const u = MODE_UI[m] || MODE_UI.txt2img;
      show(refs.srcField,      u.src);
      show(refs.promptLabel?.closest('.ip-field'), u.prompt);
      show(refs.removeField,   u.remove);
      show(refs.negField,      u.neg);
      show(refs.strengthField, u.strength);
      show(refs.upscaleField,  u.upscale);
      show(refs.refineField,   u.refine);
      show(refs.qualityField,  u.quality);
      show(refs.dimField,      u.dim);
      show(refs.guidField,     u.guid);
      if (refs.promptLabel) refs.promptLabel.textContent = u.promptLabel;
      if (refs.guidLabel)   refs.guidLabel.textContent   = u.guidLabel;
      if (refs.modeHint)    refs.modeHint.textContent    = u.hint;
      genBtn.textContent = u.btn;
    }

    // Mode tab click — single-select, then re-apply UI
    document.querySelectorAll('.mode-tabs .chip[data-mode]').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('.mode-tabs .chip[data-mode]').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
        applyModeUI();
      });
    });
    applyModeUI();

    // Strength slider readout
    refs.strength?.addEventListener('input', () => {
      if (refs.strengthVal) refs.strengthVal.textContent = parseFloat(refs.strength.value).toFixed(2);
    });

    // Quality select drives the steps field
    refs.quality?.addEventListener('change', e => { refs.steps.value = e.target.value; });

    // Refinement chips (only relevant for txt2img display, but the click
    // handler is harmless when the field is hidden)
    document.querySelectorAll('#ipRefine .chip').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('#ipRefine .chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
      });
    });

    function setStatus(text, cls) {
      refs.status.className = 'pill ' + (cls || '') + ' ';
      refs.status.style.padding = '3px 10px';
      // CodeQL js/xss-through-dom: image-error callers pass server-supplied text in
      // here; render it as a text node (dot stays markup) so a hostile AI-server
      // error string can't inject HTML.
      refs.status.innerHTML = '<span class="dot"></span>';
      refs.status.appendChild(document.createTextNode(text == null ? '' : String(text)));
    }

    // ---- Source image handling (drop / paste / click) ----
    // Bytes capped at 24 MB to mirror LOCAL_AI_MAX_IMAGE_BYTES on the server.
    // We store the base64 once on accept so generate() is a sync read.
    const MAX_SRC_BYTES = 24 * 1024 * 1024;
    let srcB64 = null;
    let srcType = null;
    let srcBytes = 0;

    function clearSrc() {
      srcB64 = null; srcType = null; srcBytes = 0;
      if (refs.srcImg) refs.srcImg.removeAttribute('src');
      if (refs.srcEmpty) refs.srcEmpty.style.display = '';
      if (refs.srcPreview) refs.srcPreview.style.display = 'none';
      if (refs.srcFile) refs.srcFile.value = '';
    }
    function _fmtKb(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
      return (n/(1024*1024)).toFixed(2) + ' MB';
    }
    async function acceptFile(file) {
      if (!file) return;
      if (!/^image\//.test(file.type || '')) {
        setStatus('REJECTED · not an image', 'bad');
        return;
      }
      if (file.size > MAX_SRC_BYTES) {
        setStatus(`REJECTED · ${_fmtKb(file.size)} > 24 MB cap`, 'bad');
        return;
      }
      const buf = await file.arrayBuffer();
      // btoa wants a binary string; build it in 64KB chunks to avoid
      // call-stack blowup on big images.
      let bin = '';
      const u8 = new Uint8Array(buf);
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + CHUNK)));
      }
      srcB64 = btoa(bin);
      srcType = file.type;
      srcBytes = file.size;
      if (refs.srcImg) refs.srcImg.src = 'data:' + srcType + ';base64,' + srcB64;
      if (refs.srcEmpty) refs.srcEmpty.style.display = 'none';
      if (refs.srcPreview) refs.srcPreview.style.display = '';
      if (refs.srcMeta) refs.srcMeta.textContent = file.name + ' · ' + _fmtKb(file.size) + ' · ' + srcType;
    }

    refs.srcDrop?.addEventListener('click', () => refs.srcFile?.click());
    refs.srcFile?.addEventListener('change', e => { acceptFile(e.target.files && e.target.files[0]); });
    refs.srcClear?.addEventListener('click', e => { e.stopPropagation(); clearSrc(); });
    refs.srcDrop?.addEventListener('dragover', e => {
      e.preventDefault();
      refs.srcDrop.style.borderColor = 'var(--cyan-1)';
      refs.srcDrop.style.background = 'rgba(45,212,255,0.04)';
    });
    refs.srcDrop?.addEventListener('dragleave', () => {
      refs.srcDrop.style.borderColor = '';
      refs.srcDrop.style.background = '';
    });
    refs.srcDrop?.addEventListener('drop', e => {
      e.preventDefault();
      refs.srcDrop.style.borderColor = '';
      refs.srcDrop.style.background = '';
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) acceptFile(f);
    });
    // Paste from clipboard (Ctrl+V anywhere on the image pane).
    document.addEventListener('paste', e => {
      const pane = document.querySelector('[data-pane="image"]');
      if (!pane || !pane.classList.contains('active')) return;
      if (activeMode() === 'txt2img') return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          acceptFile(it.getAsFile());
          e.preventDefault();
          return;
        }
      }
    });

    let lastSeed = null, lastImageUrl = null;
    let inflightCtl = null;   // AbortController for the in-flight /image POST
    let inflightMode = null;  // mode of the in-flight request (for status text)

    function setGenButtonMode(state, mode) {
      // state: 'idle' | 'busy' | 'cancelling'
      // Replaces the lazy `genBtn.disabled = true` pattern. The button now
      // doubles as a Cancel button while a request is in flight: same
      // visual position, label flips, click signals AbortController.abort().
      const u = MODE_UI[mode || activeMode()] || MODE_UI.txt2img;
      if (state === 'busy') {
        genBtn.textContent = '✕ Cancel ' + (mode || activeMode());
        genBtn.classList.remove('btn-primary');
        genBtn.classList.add('btn-ghost');
        genBtn.style.color = 'var(--warn)';
        regenBtn.disabled = true;
      } else if (state === 'cancelling') {
        genBtn.textContent = '⋯ cancelling…';
        genBtn.style.color = 'var(--bad)';
      } else {
        genBtn.textContent = u.btn;
        genBtn.classList.remove('btn-ghost');
        genBtn.classList.add('btn-primary');
        genBtn.style.color = '';
        regenBtn.disabled = false;
      }
    }

    async function generate(useLastSeed) {
      // If a request is already in flight, treat this click as a Cancel:
      // abort the AbortController and let the existing generate() unwind
      // through its catch block. Was: silently ignored — user clicked
      // Generate, nothing happened, clicked again, still nothing.
      if (inflightCtl) {
        setGenButtonMode('cancelling', inflightMode);
        try { inflightCtl.abort(); } catch {}
        return;
      }
      const mode = activeMode();
      const u = MODE_UI[mode] || MODE_UI.txt2img;

      // Source-image requirement (everything except txt2img)
      if (u.src && !srcB64) {
        setStatus('NEEDS SOURCE · drop an image first', 'bad');
        return;
      }

      // Prompt requirement (everything except upscale)
      const prompt = (refs.prompt?.value || '').trim();
      if (u.prompt && !prompt && mode !== 'upscale') {
        setStatus('NEEDS PROMPT', 'bad');
        return;
      }

      // Seed pick — txt2img/img2img/inpaint/pix2pix all accept it. Upscale ignores.
      const seedInput = parseInt(refs.seed?.value, 10);
      const seed = useLastSeed && lastSeed != null
        ? lastSeed
        : (isNaN(seedInput) || seedInput < 0 ? Math.floor(Math.random() * 1_000_000) : seedInput);

      // ---- Refinement step (txt2img only) -------------------------------
      // When "refined" or "both" is active, run the user's prompt through
      // /chat first with a system prompt asking for an SDXL-friendly
      // rewrite. The bot does this server-side for Discord /image flows;
      // the playground replicates it client-side so the refinement chips
      // are honest. "raw" skips the chat round-trip.
      let workingPrompt = prompt;
      let refineMeta = null;
      if (mode === 'txt2img') {
        const refineChip = document.querySelector('#ipRefine .chip.active');
        const refineMode = refineChip?.dataset.refine || 'raw';
        if (refineMode === 'refined' || refineMode === 'both') {
          setStatus(`REFINING · /chat → SDXL`, 'warn');
          refs.placeholder.style.display = 'grid';
          refs.placeholder.textContent = `[REFINING · chat model rewriting your prompt for SDXL…]`;
          try {
            const sys = 'You are a prompt refiner for Stable Diffusion XL. Rewrite the user\'s prompt to be vivid, concrete, and image-friendly. Output ONLY the rewritten prompt — no preamble, no explanation, no quotation marks. Keep proper nouns. Add 2-4 visual descriptors (lighting, composition, style) only if missing. Max 350 chars.';
            const rr = await fetch(SEEKDEEP_BASE + '/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt, role: 'default_chat', temperature: 0.5,
                system_prompt: sys, max_new_tokens: 256,
              }),
              signal: AbortSignal.timeout(45000),
            });
            if (rr.ok) {
              const rd = await rr.json();
              const refined = (rd.response || rd.text || rd.content || '').trim().replace(/^["']|["']$/g, '').slice(0, 700);
              if (refined && refined.length > 8) {
                refineMeta = { original: prompt, refined, mode: refineMode };
                workingPrompt = refined;
              }
            }
          } catch { /* refinement fail → fall back to raw prompt */ }
        }
      }

      // Build endpoint + body per mode
      let endpoint, body;
      if (mode === 'txt2img') {
        const style = refs.style?.value || '';
        endpoint = '/image';
        body = {
          prompt: style ? `${workingPrompt}, ${style}` : workingPrompt,
          negative_prompt: refs.neg?.value || '',
          width:  parseInt(refs.w.value, 10)  || 1024,
          height: parseInt(refs.h.value, 10)  || 1024,
          steps:  parseInt(refs.steps.value, 10) || 28,
          guidance_scale: parseFloat(refs.guid.value) || 7.0,
          seed,
        };
      } else if (mode === 'img2img') {
        endpoint = '/img2img';
        body = {
          prompt,
          negative_prompt: refs.neg?.value || '',
          image_b64: srcB64,
          strength: parseFloat(refs.strength.value) || 0.6,
          width:  parseInt(refs.w.value, 10)  || 1024,
          height: parseInt(refs.h.value, 10)  || 1024,
          steps:  parseInt(refs.steps.value, 10) || 28,
          guidance_scale: parseFloat(refs.guid.value) || 5.0,
          seed,
        };
      } else if (mode === 'pix2pix') {
        endpoint = '/instruct-pix2pix';
        body = {
          instruction: prompt,
          image_b64: srcB64,
          steps:  parseInt(refs.steps.value, 10) || 30,
          guidance_scale: parseFloat(refs.guid.value) || 9.0,
          image_guidance_scale: 1.5,
          seed,
          negative_prompt: refs.neg?.value || '',
        };
      } else if (mode === 'inpaint') {
        endpoint = '/inpaint';
        body = {
          prompt,
          remove_target: (refs.removeTarget?.value || '').trim(),
          image_b64: srcB64,
          strength: parseFloat(refs.strength.value) || 0.85,
          width:  parseInt(refs.w.value, 10)  || 1024,
          height: parseInt(refs.h.value, 10)  || 1024,
          steps:  parseInt(refs.steps.value, 10) || 28,
          guidance_scale: parseFloat(refs.guid.value) || 5.0,
          seed,
          negative_prompt: refs.neg?.value || '',
        };
      } else if (mode === 'upscale') {
        endpoint = '/upscale';
        body = {
          image_b64: srcB64,
          scale: parseInt(refs.upscaleScale.value, 10) || 2,
          method: refs.upscaleMethod.value || 'lanczos',
        };
      } else {
        setStatus('UNKNOWN MODE · ' + mode, 'bad');
        return;
      }

      // Set up cancellable in-flight state. Button flips to "✕ Cancel
      // <mode>" — second click on the same button triggers abort().
      inflightCtl = new AbortController();
      inflightMode = mode;
      setGenButtonMode('busy', mode);
      // 3 min hard cap on top of user-cancellable abort. SDXL on a 4090
      // takes 5-30s normally, 60-90s on first cold load with steps=40+.
      const cancelOnTimeout = setTimeout(() => { try { inflightCtl?.abort(); } catch {} }, 180000);
      const label = u.btn.replace('▸ ', '').toUpperCase();
      setStatus(`${label}ING · SEED ${seed} · click button to cancel`, 'warn');
      refs.placeholder.style.display = 'grid';
      const dim = (body.width && body.height) ? `${body.width}×${body.height} · ` : '';
      refs.placeholder.textContent = `[${label}ING · ${dim}${body.steps ? body.steps + ' steps · ' : ''}seed ${seed}]`;
      refs.image.style.display = 'none';
      const t0 = performance.now();

      try {
        const r = await fetch(SEEKDEEP_BASE + endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: inflightCtl.signal,
        });
        if (!r.ok) {
          // Try to parse the response body as JSON first — /image and friends
          // return {error, reason, detail} on 503/500 just like /chat does.
          // Without this the user sees a generic "HTTP 503" instead of the
          // real cause (gated repo, OOM, missing diffusers cache, etc.).
          let payload = null;
          const raw = await r.text().catch(() => '');
          try { payload = raw ? JSON.parse(raw) : null; } catch {}
          const err = new Error('HTTP ' + r.status);
          err.httpStatus = r.status;
          err.body = payload || {};
          err.bodyText = raw;
          throw err;
        }
        const ct = r.headers.get('Content-Type') || '';
        let url;
        if (ct.startsWith('image/')) {
          const blob = await r.blob();
          url = URL.createObjectURL(blob);
          lastSeed = seed;  // binary response carries no seed; use the requested one
        } else {
          const data = await r.json();
          if (data.image_b64) url = `data:image/png;base64,${data.image_b64}`;
          else if (data.url)  url = data.url;
          else throw new Error('no image payload');
          // Prefer the seed the SERVER actually used — it may pick/clamp its own
          // when the client sends a random/blank seed — so Copy-seed and Regen-
          // same-seed reproduce THIS image. (The old unconditional `lastSeed =
          // seed` discarded it.) Falls back to the requested seed.
          lastSeed = (data.seed != null) ? data.seed : seed;
        }
        lastImageUrl = url;
        refs.image.src = url;
        refs.image.style.display = 'block';
        refs.placeholder.style.display = 'none';
        const ms = Math.round(performance.now() - t0);
        setStatus(`DONE · ${label} · ${(ms/1000).toFixed(1)}s · SEED ${lastSeed}`, 'on');

        // Append to history (tooltip shows refinement provenance when applicable)
        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        thumb.style.backgroundImage = `url(${url})`;
        thumb.style.backgroundSize = 'cover';
        thumb.style.backgroundPosition = 'center';
        let thumbTitle = `${label} · seed ${lastSeed}${body.steps ? ' · ' + body.steps + ' steps' : ''}`;
        if (refineMeta) thumbTitle += `\nrefined: ${refineMeta.refined.slice(0, 200)}`;
        thumb.title = thumbTitle;
        // Track blob: URLs on their thumb so we can revoke them on eviction —
        // otherwise each generated PNG's object URL is pinned forever by the
        // thumbnail's background-image and the WebView leaks unbounded memory
        // across a session. (data:/http thumbs have no blobUrl → skipped.)
        if (typeof url === 'string' && url.startsWith('blob:')) thumb.dataset.blobUrl = url;
        refs.history.prepend(thumb);
        if (refs.history.children.length > 6) {
          const evicted = refs.history.lastChild;
          // By the time a thumb is the oldest of 7, the main preview and
          // lastImageUrl point at a newer image, so nothing else references this
          // blob — safe to revoke.
          if (evicted && evicted.dataset && evicted.dataset.blobUrl) {
            try { URL.revokeObjectURL(evicted.dataset.blobUrl); } catch {}
          }
          if (evicted) evicted.remove();
        }
        // "both" mode: kick off a second pass with the RAW prompt (no
        // refinement) so the user can A/B compare. Skip the recursion
        // guard by passing useLastSeed=true so both pieces share a seed.
        if (refineMeta && refineMeta.mode === 'both') {
          // Temporarily flip the active chip to "raw" so the recursive
          // generate() call skips refinement, then restore.
          const allChips = document.querySelectorAll('#ipRefine .chip');
          const wasActive = document.querySelector('#ipRefine .chip.active');
          allChips.forEach(c => c.classList.remove('active'));
          const rawChip = document.querySelector('#ipRefine .chip[data-refine="raw"]');
          if (rawChip) rawChip.classList.add('active');
          // Use the SAME seed so the only variable is prompt-refinement effect.
          await generate(true);
          // Restore the "both" chip
          allChips.forEach(c => c.classList.remove('active'));
          if (wasActive) wasActive.classList.add('active');
        }
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        const aborted = (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || e))));
        if (aborted) {
          setStatus(`CANCELLED · ${(ms/1000).toFixed(1)}s · ${endpoint}`, 'warn');
          refs.placeholder.style.display = 'grid';
          refs.placeholder.textContent = `[CANCELLED — ${endpoint}]`;
          refs.placeholder.style.whiteSpace = '';
          refs.placeholder.style.textAlign = '';
          refs.placeholder.style.fontSize = '';
        } else if (e && e.httpStatus && e.body && (e.body.error || e.body.detail || e.body.message)) {
          // Server gave us a structured error (503 model-load-failure, 500
          // diffusers crash, etc.). Render the real cause + detail so the
          // user doesn't have to dig through server.log.
          const body = e.body || {};
          const errMsg = String(body.error || body.message || ('HTTP ' + e.httpStatus));
          const reason = body.reason ? `${body.reason.toUpperCase()} · ` : '';
          const detail = body.detail ? `\n\n${String(body.detail).slice(0, 600)}` : '';
          setStatus(`HTTP ${e.httpStatus} · ${(ms/1000).toFixed(1)}s · ${endpoint} · ${reason}${String(body.reason || errMsg).slice(0, 40)}`, 'bad');
          refs.placeholder.style.display = 'grid';
          refs.placeholder.textContent = `[ERROR — HTTP ${e.httpStatus} ${endpoint}\n${errMsg}${detail}]`;
          refs.placeholder.style.whiteSpace = 'pre-line';
          refs.placeholder.style.textAlign = 'left';
          refs.placeholder.style.fontSize = '11px';
        } else {
          const msg = String(e && e.message || e);
          const extra = e && e.bodyText ? '\n' + e.bodyText.slice(0, 300) : '';
          setStatus(`OFFLINE · ${(ms/1000).toFixed(1)}s · ${endpoint} · ${msg.slice(0, 60)}`, 'bad');
          refs.placeholder.style.display = 'grid';
          refs.placeholder.textContent = `[ERROR — ${SEEKDEEP_BASE}${endpoint}\n${msg}${extra}]`;
          refs.placeholder.style.whiteSpace = 'pre-line';
          refs.placeholder.style.textAlign = 'center';
          refs.placeholder.style.fontSize = '11px';
        }
      } finally {
        clearTimeout(cancelOnTimeout);
        inflightCtl = null;
        inflightMode = null;
        setGenButtonMode('idle');
      }
    }

    genBtn.addEventListener('click', () => generate(false));
    regenBtn.addEventListener('click', () => generate(true));
    refs.download?.addEventListener('click', async () => {
      if (!lastImageUrl) return;
      const fname = `seekdeep-${activeMode()}-${lastSeed || 'x'}.png`;
      // <a download> is silently dropped by the Tauri WebView2 — save through the
      // loopback server (writes to Downloads, returns the path), fall back to the
      // anchor only in a plain browser where it works.
      if (window.SeekDeepSaveFile) {
        try {
          const path = await window.SeekDeepSaveFile(fname, lastImageUrl);
          window.SeekDeepNotify?.toast?.({ tone: 'good', title: '✓ Saved', body: '→ ' + path });
        } catch (err) {
          window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Save failed', body: String(err && err.message || err) });
        }
        return;
      }
      const a = document.createElement('a');
      a.href = lastImageUrl;
      a.download = fname;
      a.click();
    });

    // ⎘ Seed — copy the last seed to the clipboard so the user can paste it
    // back into the seed input for a reproducible run. Was an unwired
    // "📂 Archive" button that did nothing in the playground context.
    document.getElementById('ipCopySeed')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const orig = btn.textContent;
      if (lastSeed == null) {
        btn.textContent = '— no seed yet';
        setTimeout(() => { btn.textContent = orig; }, 1400);
        return;
      }
      try {
        await navigator.clipboard.writeText(String(lastSeed));
        btn.textContent = '✓ ' + lastSeed;
      } catch {
        btn.textContent = String(lastSeed);  // at least surface it
      }
      setTimeout(() => { btn.textContent = orig; }, 1800);
    });

    // ↻ Use as source — pipe the last generated image into the source-image
    // slot. Lets the user txt2img → img2img → inpaint chain without
    // manually saving + uploading. Mode auto-switches to img2img unless the
    // user is already on a non-txt2img mode.
    document.getElementById('ipSendToSource')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const orig = btn.textContent;
      if (!lastImageUrl) {
        btn.textContent = '— generate one first';
        setTimeout(() => { btn.textContent = orig; }, 1600);
        return;
      }
      try {
        // Fetch the blob from the data URL or object URL we already have
        const r = await fetch(lastImageUrl);
        const blob = await r.blob();
        const file = new File([blob], `seekdeep-source-${lastSeed || 'x'}.png`, { type: blob.type || 'image/png' });
        await acceptFile(file);
        if (activeMode() === 'txt2img') {
          // Auto-switch to img2img since that's the most common downstream
          const chip = document.querySelector('.mode-tabs .chip[data-mode="img2img"]');
          if (chip) chip.click();
        }
        btn.textContent = '✓ loaded';
      } catch (err) {
        btn.textContent = '✕ failed';
      }
      setTimeout(() => { btn.textContent = orig; }, 1800);
    });
  })();

  // ===== Logs viewer: live wiring (GET /logs/tail + /logs/stream SSE) =====
  (function wireLogsViewer() {
    const wrap = document.getElementById('logs-wrap');
    if (!wrap) return;

    // File-logger format (most common today): [YYYY-MM-DDTHH:MM:SS(.fff)?] [LEVEL] msg
    // Legacy / SSE format: HH:MM:SS [LEVEL] [src] msg
    // The old single regex only handled HH:MM:SS and treated the ISO date as
    // a "source" — so the timestamp column showed "2026-05-27T05" and the
    // level was lost. Split into two patterns + fall back to plain text.
    const FILE_LOG_RE   = /^\s*\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]\s*\[(INFO|WARN|ERR|ERROR|DBG|DEBUG)\]\s*(.*)$/i;
    const LEGACY_LOG_RE = /^(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)?\s*\[?(INFO|WARN|ERR|ERROR|DBG|DEBUG)?\]?\s*\[?([A-Za-z][\w-]*)?\]?\s*[:|]?\s*(.*)$/i;

    function renderLine(raw) {
      let ts = '', lvl = '', src = '', msg = raw;
      const fm = FILE_LOG_RE.exec(raw);
      if (fm) {
        ts  = fm[1] || '';
        lvl = (fm[2] || '').toLowerCase();
        msg = fm[3] || '';
        src = 'file';
      } else {
        const sm = LEGACY_LOG_RE.exec(raw) || [null,'','','',raw];
        ts  = sm[1] || '';
        lvl = (sm[2] || '').toLowerCase();
        src = sm[3] || '';
        msg = sm[4] || raw;
      }
      // Auto-correct stale-bundle mis-tags: an older Tee tagged uvicorn's
      // `INFO: Started server process` as [ERR] because stderr defaulted to
      // ERR. The current Tee fixes this at the source (commit 3ef9fae), but
      // until the user rebuilds the installer they're stuck with the old
      // server. Re-detect level from message content so the viewer at least
      // displays it correctly.
      if ((lvl === 'err' || lvl === 'error') && /^\s*INFO[:\s]/i.test(msg)) {
        lvl = 'info';
      }
      lvl = lvl.replace('error','err').replace('debug','dbg');
      const lvlCls = ['info','warn','err','dbg'].includes(lvl) ? lvl : 'info';
      const safeMsg = msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const el = document.createElement('div');
      el.className = 'log-line';
      el.innerHTML = `<span class="ts">${ts}</span><span class="lvl ${lvlCls}">${(lvl||'log').toUpperCase()}</span><span class="src">${src}</span><span class="msg">${safeMsg}</span>`;
      return el;
    }
    function clear() { wrap.innerHTML = ''; }
    function append(line) {
      wrap.appendChild(renderLine(line));
      while (wrap.children.length > 1500) wrap.removeChild(wrap.firstChild);
      wrap.scrollTop = wrap.scrollHeight;
    }
    function fail(msg) {
      clear();
      const el = document.createElement('div');
      el.className = 'log-line';
      el.style.gridTemplateColumns = '1fr';
      el.style.padding = '14px';
      el.style.color = 'var(--warn)';
      el.style.fontStyle = 'italic';
      el.textContent = '▸ ' + msg;
      wrap.appendChild(el);
    }

    let sse = null;
    let loaded = false;
    function _fmtBytes(n) {
      if (n == null) return '—';
      if (n < 1024) return n + ' B';
      if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
      if (n < 1024*1024*1024) return (n/(1024*1024)).toFixed(1) + ' MB';
      return (n/(1024*1024*1024)).toFixed(2) + ' GB';
    }
    async function loadInitial() {
      if (loaded) return;
      loaded = true;
      try {
        const r = await fetch(SEEKDEEP_BASE + '/logs/tail?lines=200', {
          signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        if (!data.ok && !Array.isArray(data.lines)) throw new Error(data.error || 'no lines');
        clear();
        const lineArr = data.lines || [];
        lineArr.forEach(append);
        // Truth-up the header subtitle: real filename + actual returned line
        // count + file size. Was hardcoded "./logs/seekdeep-2026-05-23.log
        // · 14,224 lines" which lied as soon as the date rolled over (or on
        // any install that hadn't accumulated 14k lines yet).
        const fileEl = document.getElementById('logsFilePath');
        const cntEl  = document.getElementById('logsLineCount');
        const sizeEl = document.getElementById('logsFileSize');
        if (fileEl && data.file) fileEl.textContent = 'logs/' + data.file;
        if (cntEl)  cntEl.textContent = lineArr.length.toLocaleString();
        if (sizeEl) sizeEl.textContent = _fmtBytes(data.size_bytes);
        startStream();
      } catch (e) {
        loaded = false;
        const msg = String(e.message || e);
        if (msg.includes('404')) fail('/logs/tail endpoint missing — add gui_endpoints.py per INTEGRATION.md');
        else fail('logs unavailable · ' + msg);
      }
    }
    async function startStream() {
      try {
        // EventSource can't set request headers, so append the GUI token
        // via ?token= — server accepts either form (see /logs/stream in
        // gui_endpoints.py). Without this, the SSE connect 401s.
        let url = SEEKDEEP_BASE + '/logs/stream';
        if (window.SeekDeepAuth && typeof window.SeekDeepAuth.get === 'function') {
          try {
            const tok = await window.SeekDeepAuth.get();
            if (tok) url += '?token=' + encodeURIComponent(tok);
          } catch {}
        }
        sse = new EventSource(url);
        sse.onmessage = (e) => {
          try { const line = JSON.parse(e.data); if (typeof line === 'string') append(line); }
          catch (err) { window.SeekDeepDebug?.warn('SSE log.line parse', err); }
        };
        sse.onerror = () => { sse?.close(); sse = null; };
      } catch (err) { window.SeekDeepDebug?.warn('EventSource /logs/stream', err); }
    }

    function onLogsActive() {
      const pane = document.querySelector('[data-pane="logs"]');
      if (pane && pane.classList.contains('active')) loadInitial();
    }
    document.querySelectorAll('.sidebar a[data-mod="logs"]').forEach(a => {
      a.addEventListener('click', () => setTimeout(onLogsActive, 50));
    });
    onLogsActive();

    // ---- Filter wiring: search input + level chips + source chips -------
    // Visibility = matches search AND (level chip is ALL or matches) AND
    // (source chip is unselected OR matches). Re-runs on any chip click or
    // search keystroke. Hides .log-line nodes that don't match.
    const logFilters = document.querySelector('.log-filters');
    const searchInput = logFilters?.querySelector('input[placeholder*="Search"]');
    let searchQ = '';
    let activeLevel = 'all';        // 'all' / 'info' / 'warn' / 'err' / 'dbg'
    let activeSources = new Set();  // 'bot' / 'ai-server' / 'searxng' / 'image' / 'vision'
    function applyFilters() {
      const q = searchQ.toLowerCase();
      wrap.querySelectorAll('.log-line').forEach(line => {
        const lvl = (line.querySelector('.lvl')?.textContent || '').toLowerCase();
        const src = (line.querySelector('.src')?.textContent || '').toLowerCase();
        const txt = (line.textContent || '').toLowerCase();
        const okQ = !q || txt.includes(q);
        const okLvl = activeLevel === 'all' || lvl === activeLevel;
        // The 'file' source is the common file-log format (renderLine hardcodes
        // src='file' for it), which carries no real bot/ai-server/searxng/image/
        // vision token. Without this exemption, selecting ANY source chip set
        // okSrc=false for every file-format line and the viewer went blank.
        const okSrc = !activeSources.size || src === 'file' || [...activeSources].some(s => src.includes(s));
        line.style.display = (okQ && okLvl && okSrc) ? '' : 'none';
      });
    }
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQ = (e.target.value || '').trim();
        applyFilters();
      });
    }
    if (logFilters) {
      const allChips = logFilters.querySelectorAll('.chip');
      // First 5 chips are levels: ALL / INFO / WARN / ERROR / DEBUG.
      // The rest are sources: bot / ai-server / searxng / image / vision.
      // Multi-select on sources, single-select on levels.
      const levelChips = [...allChips].slice(0, 5);
      const sourceChips = [...allChips].slice(5);
      levelChips.forEach(c => {
        c.addEventListener('click', () => {
          levelChips.forEach(x => x.classList.remove('active'));
          c.classList.add('active');
          const t = (c.textContent || '').trim().toLowerCase();
          activeLevel = (t === 'all' ? 'all'
                       : t === 'info' ? 'info'
                       : t === 'warn' ? 'warn'
                       : t === 'error' ? 'err'
                       : t === 'debug' ? 'dbg' : 'all');
          applyFilters();
        });
      });
      sourceChips.forEach(c => {
        c.addEventListener('click', () => {
          const src = (c.textContent || '').trim().toLowerCase();
          if (activeSources.has(src)) { activeSources.delete(src); c.classList.remove('active'); }
          else { activeSources.add(src); c.classList.add('active'); }
          applyFilters();
        });
      });
    }
    // Pause / Clear buttons (Clear was already only visually firing — wire
    // it to actually drop everything; Pause swallows new SSE pushes by
    // closing the EventSource without losing the loaded backlog).
    const pauseBtn = document.getElementById('logsPauseBtn');
    const clearBtn = document.getElementById('logsClearBtn');
    if (pauseBtn) {
      let paused = false;
      pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        if (paused) { sse?.close(); sse = null; }
        else        { startStream(); }
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => clear());
    }
  })();

  // ===== First-run setup checklist · GET /system/firstrun =================
  // Probes for the common "fresh install" gotchas (missing DISCORD_TOKEN,
  // ML deps not installed, SearXNG not running, no chat model in cache,
  // etc.) and renders a top-of-page banner listing what still needs to
  // happen. Auto-hides when every blocking check passes. Was: empty panes
  // with no hint why nothing worked.
  (function wireFirstRunBanner() {
    const banner = document.getElementById('firstRunBanner');
    if (!banner) return;
    // Per-session dismiss — sessionStorage so it comes back next time
    // the user opens the app (don't permanently hide setup issues).
    if (sessionStorage.getItem('seekdeep:firstrun:dismissed') === '1') return;
    document.getElementById('firstRunDismiss')?.addEventListener('click', () => {
      banner.style.display = 'none';
      sessionStorage.setItem('seekdeep:firstrun:dismissed', '1');
    });

    async function load() {
      try {
        const r = await sdPollFetch(SEEKDEEP_BASE + '/system/firstrun', { timeout: 4000, attempts: 2 });
        if (!r.ok) return;
        const data = await r.json();
        const checks = Array.isArray(data.checks) ? data.checks : [];
        const failed = checks.filter(c => !c.ok);
        if (!failed.length) {
          // Everything passes — keep banner hidden (or fade it out if it
          // was previously shown).
          banner.style.display = 'none';
          return;
        }
        // Render. Banner stays the same color regardless — let per-row
        // markers (✕ blocking, ⚠ warning, ✓ ok) tell the severity story.
        banner.style.display = 'block';
        const blocking = failed.filter(c => c.blocking);
        const summary = document.getElementById('firstRunSummary');
        if (summary) {
          if (blocking.length) {
            summary.innerHTML = `<strong>${blocking.length} blocking issue${blocking.length === 1 ? '' : 's'}</strong> · the bot can't start until these are fixed. ${failed.length - blocking.length > 0 ? failed.length - blocking.length + ' optional warning' + (failed.length - blocking.length === 1 ? '' : 's') + ' below.' : ''}`;
          } else {
            summary.innerHTML = `Bot can run, but <strong>${failed.length} optional feature${failed.length === 1 ? '' : 's'}</strong> won't work until fixed. Each is independent — fix whatever you need.`;
          }
        }
        const list = document.getElementById('firstRunChecks');
        if (list) {
          list.innerHTML = '';
          for (const c of checks) {
            const li = document.createElement('li');
            li.style.cssText = 'padding: 6px 0; display: grid; grid-template-columns: 22px 1fr; gap: 8px; align-items: start;';
            const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
            const marker = mk('span', '', '');
            if (c.ok) { marker.textContent = '✓'; marker.style.color = 'var(--good)'; }
            else if (c.blocking) { marker.textContent = '✕'; marker.style.color = 'var(--bad)'; }
            else { marker.textContent = '⚠'; marker.style.color = 'var(--warn)'; }
            li.appendChild(marker);
            const right = document.createElement('div');
            const lbl = mk('div', '', String(c.label || c.id || ''));
            lbl.style.color = c.ok ? 'var(--hull-3)' : 'var(--hull)';
            right.appendChild(lbl);
            if (!c.ok && c.fix) {
              const fix = mk('div', '', String(c.fix));
              fix.style.cssText = 'font-size: 10.5px; color: var(--hull-3); margin-top: 2px; line-height: 1.45;';
              right.appendChild(fix);
            }
            // Inline FIX button — if the server attached a fix_action,
            // render a one-click button that hits the endpoint and
            // re-polls firstrun on completion. Zero-terminal flow:
            // user sees "⚠ SearXNG container running" with a [▸ FIX]
            // button next to it; one click and it's started.
            if (!c.ok && c.fix_action) {
              const fa = c.fix_action;
              const btn = mk('button', 'btn btn-primary', fa.label || '▸ FIX');
              btn.style.cssText = 'margin-top: 6px; padding: 5px 12px; font-size: 11px; letter-spacing: 0.1em;';
              btn.addEventListener('click', async () => {
                // Prompts (DISCORD_TOKEN, CLIENT_ID, ADMIN_IDS) need an
                // input field that doesn't fit cleanly into a 1-line
                // banner row — route those to the full-screen wizard
                // which has the input UI. Navigate actions
                // (chat_model -> add-model.html) likewise just route.
                if (Array.isArray(fa.prompt_for) && fa.prompt_for.length) {
                  location.href = 'setup-wizard.html';
                  return;
                }
                if (typeof fa.navigate === 'string') {
                  location.href = fa.navigate;
                  return;
                }
                const origLbl = btn.textContent;
                btn.disabled = true;
                btn.textContent = '… running';
                const sdn = window.SeekDeepNotify;
                // Single source of truth for retry/watch_events/hint via
                // gui/fix-action.js. UI hooks below adapt the result to the
                // launcher card pill + toast presentation.
                if (!window.SeekDeepFixAction) {
                  // fix-action.js not loaded yet (unlikely — nav.js auto-loads
                  // it). Surface a clear error instead of silently failing.
                  btn.textContent = '✕ ERROR';
                  btn.style.background = 'var(--bad)';
                  if (sdn?.toast) sdn.toast({ tone: 'bad', title: c.label, body: 'fix-action.js failed to load', ttl: 8000 });
                  setTimeout(() => { btn.textContent = origLbl; btn.style.background = ''; btn.disabled = false; }, 4000);
                  return;
                }
                if (Array.isArray(fa.watch_events) && fa.watch_events.length) {
                  btn.textContent = '⏳ running…';
                  if (sdn?.toast) sdn.toast({ tone: 'info', title: c.label, body: 'Background work started · waiting for completion event…', ttl: 5000 });
                }
                const result = await window.SeekDeepFixAction.run({
                  endpoint:    fa.endpoint,
                  method:      fa.method,
                  body:        fa.body,
                  watchEvents: fa.watch_events,
                  longRunning: !!fa.long_running,
                });
                if (result.ok) {
                  btn.textContent = '✓ DONE';
                  btn.style.background = 'var(--good)';
                  if (sdn?.toast) sdn.toast({ tone: 'good', title: c.label + ' · complete', body: result.payload?.note || 'Fix applied · re-checking…', ttl: 5000 });
                  setTimeout(load, result.settled_via === 'watch-event' ? 1500 : (fa.long_running ? 4000 : 2000));
                } else {
                  const isTimeout = result.settled_via === 'event-timeout';
                  btn.textContent = isTimeout ? '⚠ TIMED OUT' : '✕ FAILED';
                  btn.style.background = isTimeout ? 'var(--warn)' : 'var(--bad)';
                  const errBody = (result.hint || result.error || '').toString().slice(0, 240);
                  if (sdn?.toast) sdn.toast({
                    tone: isTimeout ? 'warn' : 'bad',
                    title: c.label + (isTimeout ? ' · timeout' : ' · fix failed'),
                    body: errBody,
                    ttl: 8000,
                  });
                  setTimeout(() => { btn.textContent = origLbl; btn.style.background = ''; btn.disabled = false; }, 4000);
                }
              });
              right.appendChild(btn);
            }
            li.appendChild(right);
            list.appendChild(li);
          }
        }
      } catch { /* server unreachable — keep banner hidden */ }
    }
    load();
    // Re-check every 60s so resolved issues drop off without a manual reload.
    setInterval(load, 60000);
  })();

  // ===== Boot sequence panel (launcher pane) · last startup-related lines ====
  // Uses /logs/tail to scrape the last ~200 lines and filter for boot-like
  // markers (uvicorn / Application startup / clientReady / Discord ready /
  // models loaded / SeekDeep boot / archive snapshot scheduled / etc.).
  // Replaces the static "no boot.* events yet" empty-state with a real
  // last-10-startup-lines view that refreshes when the launcher pane
  // becomes active OR every 30s otherwise.
  (function wireBootSequencePanel() {
    const wrap = document.getElementById('bootSeqLog');
    if (!wrap) return;

    const BOOT_RE = /uvicorn|application startup|application shutdown|clientReady|client ?ready|discord ?ready|registered.*commands|loaded.*model|warmed|spawned|SeekDeep boot|archive snapshot|status rotation|fastapi|reloading|environment|listening on|started server|model_loaded|sidecar/i;

    async function load() {
      try {
        // §5b (missed in the first sweep): retry instead of one-shot. This
        // panel fetches the TOKEN-GATED /logs/tail; on initial paint nav.js's
        // token interceptor may not be installed yet, so the first call 401s.
        // A one-shot then froze on "unreachable — start the AI server" — a
        // flat contradiction of the HEALTHY cards next to it. Retry rides out
        // the token-interceptor + boot window.
        const r = await sdPollFetch(SEEKDEEP_BASE + '/logs/tail?lines=200', { timeout: 3500, attempts: 4 });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const lines = Array.isArray(data.lines) ? data.lines : [];
        const boot = lines.filter(l => BOOT_RE.test(l)).slice(-12);
        if (!boot.length) {
          wrap.innerHTML = '<div class="log-line" style="grid-template-columns:1fr; padding:14px; color:var(--hull-3); font-style:italic;">▸ no boot.* events in the last 200 log lines — services may have been up a while. See the Logs pane for the full tail.</div>';
          return;
        }
        wrap.innerHTML = '';
        boot.forEach(raw => {
          const m = raw.match(/^(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)?\s*\[?(INFO|WARN|ERR|ERROR|DBG|DEBUG)?\]?\s*\[?(\w+[-\w]*)?\]?\s*[:|]?\s*(.*)$/i);
          const ts = (m && m[1]) || '';
          const lvl = ((m && m[2]) || 'INFO').toLowerCase().replace('error','err').replace('debug','dbg');
          const lvlCls = ['info','warn','err','dbg'].includes(lvl) ? lvl : 'info';
          const src = (m && m[3]) || '';
          const msg = ((m && m[4]) || raw).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const el = document.createElement('div');
          el.className = 'log-line';
          el.innerHTML = `<span class="ts">${ts}</span><span class="lvl ${lvlCls}">${lvl.toUpperCase()}</span><span class="src">${src}</span><span class="msg">${msg}</span>`;
          wrap.appendChild(el);
        });
      } catch (err) {
        // Honest message: don't tell the user to "start the AI server" — the
        // service cards next to this panel already prove whether it's up.
        // A failure here is almost always a transient log-tail read (token
        // not ready, log briefly locked); the 30s refresh + retry recovers it.
        const status = String(err && err.message || '').match(/HTTP (\d+)/);
        const detail = status && status[1] === '401'
          ? 'log tail needs the GUI token (still loading) — refreshing automatically'
          : 'log tail unavailable (server warming up or log locked) — refreshing automatically';
        wrap.innerHTML = `<div class="log-line" style="grid-template-columns:1fr; padding:14px; color:var(--hull-3); font-style:italic;">▸ ${detail}. See the Logs pane for the full tail.</div>`;
      }
    }
    // Refresh whenever the launcher pane becomes active + every 30s.
    function onActive() {
      const pane = document.querySelector('[data-pane="launcher"]');
      if (pane && pane.classList.contains('active')) load();
    }
    document.querySelectorAll('.sidebar a[data-mod="launcher"]').forEach(a =>
      a.addEventListener('click', () => setTimeout(onActive, 50))
    );
    onActive();  // initial
    setInterval(onActive, 30000);
  })();

  // ===== Chat playground · live wiring (POST /chat) =====
  // Send button hits SEEKDEEP_BASE + '/chat' with the active role / persona /
  // web mode / temperature. On failure (server offline, timeout, HTTP error)
  // the assistant bubble shows an honest "OFFLINE" error message — no mock
  // replies, no canned text.
  (function wireChatPlayground() {
    const conv  = document.getElementById('cpConv');
    const input = document.getElementById('cpInput');
    const send  = document.getElementById('cpSendBtn');
    if (!conv || !input || !send) return;

    function appendMsg(role, html, meta) {
      const el = document.createElement('div');
      el.className = 'cp-msg ' + (role === 'user' ? 'u' : 'b');
      if (meta) el.innerHTML = `<span class="meta">${meta}</span>${html}`;
      else el.textContent = html;
      conv.appendChild(el);
      conv.scrollTop = conv.scrollHeight;
      return el;
    }

    // Seed with a system message so the playground isn't empty
    appendMsg('bot',
      'You are SeekDeep. Answer in numbered, terse facts. Cite sources when web-routed. No filler.',
      'SYSTEM · CLINICAL');

    function getRole() {
      const r = document.querySelector('#cpRoles input[name="role"]:checked');
      return r ? r.value : 'default_chat';
    }
    function getWeb() {
      const a = document.querySelector('#cpWeb .chip.active');
      return a ? a.dataset.web : 'auto';
    }
    function getPersona() {
      return (document.getElementById('cpPersona')?.value || 'clinical').replace(/ · default$/, '');
    }
    function getTemp() {
      const v = parseFloat(document.getElementById('cpTemp')?.value || '7');
      return Math.max(0, Math.min(1, v / 10));
    }

    // Live temperature readout — slider has no inherent text feedback so
    // users couldn't tell what 0.7 vs 0.3 felt like.
    const tempInput = document.getElementById('cpTemp');
    const tempReadout = document.getElementById('cpTempReadout');
    if (tempInput && tempReadout) {
      const paintTemp = () => { tempReadout.textContent = (parseFloat(tempInput.value || '7') / 10).toFixed(2); };
      tempInput.addEventListener('input', paintTemp);
      paintTemp();
    }

    // Active styling for role radios
    document.querySelectorAll('#cpRoles label').forEach(lb => {
      lb.addEventListener('click', () => {
        document.querySelectorAll('#cpRoles label').forEach(x => {
          x.style.background = ''; x.style.color = ''; x.style.border = '1px solid transparent';
        });
        lb.style.background = 'rgba(45,212,255,0.1)';
        lb.style.color = 'var(--cyan-1)';
        lb.style.border = '1px solid var(--cyan-1)';
      });
    });
    // Web mode chips
    document.querySelectorAll('#cpWeb .chip').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('#cpWeb .chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
      });
    });

    // Custom personas from /persona — same idea as chat.html's popover.
    // Hydrates the cpPersona <select> with anything in data/custom-
    // personas.json so the user can route the playground through their
    // own personas, not just the 4 built-ins.
    (async function loadCustomPersonas() {
      try {
        const r = await sdPollFetch(SEEKDEEP_BASE + '/persona', { timeout: 3000, attempts: 2 });
        if (!r.ok) return;
        const d = await r.json();
        const sel = document.getElementById('cpPersona');
        if (!sel || !Array.isArray(d.valid_personas)) return;
        const existing = new Set([...sel.options].map(o => o.value.replace(/ · default$/, '').toLowerCase()));
        const resetIdx = [...sel.options].findIndex(o => /reset/i.test(o.value));
        for (const slug of d.valid_personas) {
          const s = String(slug).toLowerCase();
          if (existing.has(s)) continue;
          const opt = document.createElement('option');
          opt.value = s;
          opt.textContent = s.charAt(0).toUpperCase() + s.slice(1) + ' · custom';
          if (resetIdx >= 0) sel.insertBefore(opt, sel.options[resetIdx]);
          else sel.appendChild(opt);
        }
      } catch (err) { window.SeekDeepDebug?.warn('cpPersona /persona hydrate', err); }
    })();

    let sendCtl = null;  // AbortController for in-flight /chat
    async function doSend() {
      // Re-click while a request is in flight cancels it. Mirrors the
      // image playground UX so concurrency behavior is consistent across
      // the two playgrounds. Was: silently ignored second click; user
      // had to wait the full 60s timeout.
      if (sendCtl) {
        try { sendCtl.abort(); } catch {}
        return;
      }
      const text = (input.value || '').trim();
      if (!text) return;
      input.value = '';
      const role    = getRole();
      const web     = getWeb();
      const persona = getPersona();
      const temp    = getTemp();

      appendMsg('user', text);
      const pending = appendMsg('bot', '<span style="opacity:0.6;">…</span>',
        `${role.toUpperCase()} · WEB ${web.toUpperCase()} · SENDING… · click Send to cancel`);
      // Send button flips to cancel mode
      const origSendLabel = send.textContent;
      send.textContent = '✕ Cancel';
      send.style.color = 'var(--warn)';

      sendCtl = new AbortController();
      const t0 = performance.now();
      try {
        const r = await fetch(SEEKDEEP_BASE + '/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: text, role, temperature: temp,
            web_search_mode: web, persona,
            system_prompt: `You are SeekDeep. Persona: ${persona}.`,
            max_new_tokens: 1024,
          }),
          signal: sendCtl.signal,
        });
        // For HTTP errors (e.g. 503 chat-load-failure), the body holds
        // {error, reason, detail} — pull it out before throwing so the UI
        // can render the real cause instead of "OFFLINE".
        if (!r.ok) {
          let payload = null;
          try { payload = await r.json(); } catch {}
          const err = new Error('HTTP ' + r.status);
          err.httpStatus = r.status;
          err.body = payload || {};
          throw err;
        }
        const data = await r.json();
        const ms = Math.round(performance.now() - t0);
        const reply = data.response || data.text || data.content || JSON.stringify(data);
        pending.innerHTML = `<span class="meta">${role.toUpperCase()} · WEB ${web.toUpperCase()} · ${ms}MS · LIVE</span>${escapeHtml(reply).replace(/\n/g, '<br/>')}`;

        // Diagnostics panel — was a row of "—" forever even after dozens of
        // successful sends. Fill in from /chat response now. tok/s derives
        // from completion_tokens / elapsed seconds when both are present.
        const setDiag = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v == null || v === '') ? '—' : String(v); };
        const elapsedSec = (data.elapsed_ms || ms) / 1000;
        const compTok = data.completion_tokens;
        setDiag('cpLastLatency', ms + ' ms');
        setDiag('cpTokRate', (compTok && elapsedSec > 0) ? (compTok / elapsedSec).toFixed(1) : '—');
        setDiag('cpPromptTokens', data.prompt_tokens);
        setDiag('cpCompletionTokens', compTok);
        setDiag('cpWebTrace', data.web_search_used ? (data.web_search_engine || 'used') : 'off');
        setDiag('cpMemTrace', data.memory_used ? 'hit' : 'miss');
        setDiag('cpVramResident', data.loaded_chat_role || data.role || role);

        // Routing trace — show model_id + backend + (if web-routed) sources
        const trace = document.getElementById('cpRouteTrace');
        if (trace) {
          const bits = [];
          if (data.model_id || data.model) bits.push(`<div><span class="muted">model</span> · <span style="color:var(--cyan-1);">${escapeHtml(String(data.model_id || data.model))}</span></div>`);
          if (data.backend) bits.push(`<div><span class="muted">backend</span> · ${escapeHtml(String(data.backend))}</div>`);
          if (Array.isArray(data.web_sources) && data.web_sources.length) {
            bits.push('<div><span class="muted">sources</span></div>');
            data.web_sources.slice(0, 5).forEach(s => {
              const url = typeof s === 'string' ? s : (s.url || s.link || '');
              if (url) bits.push(`<div style="margin-left:10px; color:var(--cyan-1); word-break:break-all;">${escapeHtml(url)}</div>`);
            });
          }
          trace.innerHTML = bits.length ? bits.join('') : '<div class="tiny muted">— response had no routing metadata</div>';
        }
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        const aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || e)));
        if (aborted) {
          pending.innerHTML = `<span class="meta" style="color:var(--warn);">${role.toUpperCase()} · CANCELLED · ${ms}MS</span>▸ User cancelled the request.`;
          const el = document.getElementById('cpLastLatency');
          if (el) { el.textContent = 'cancelled · ' + ms + ' ms'; el.style.color = 'var(--warn)'; }
        } else if (e && e.httpStatus && e.body && (e.body.error || e.body.detail)) {
          // Server responded with a structured error (503 chat-load-failure etc.).
          // Show error + reason + collapsible detail so the user sees the real cause.
          const body = e.body || {};
          const msg = escapeHtml(String(body.error || ('HTTP ' + e.httpStatus)));
          const reason = body.reason ? `<span class="meta" style="color:var(--warn);">REASON · ${escapeHtml(String(body.reason).toUpperCase())}</span>` : '';
          const detail = body.detail
            ? `<details style="margin-top:8px;"><summary style="cursor:pointer; color:var(--hull-3);">show underlying error</summary><pre class="mono" style="white-space:pre-wrap; word-break:break-word; color:var(--hull-2); margin:6px 0 0;">${escapeHtml(String(body.detail))}</pre></details>`
            : '';
          pending.innerHTML = `<span class="meta" style="color:var(--warn);">${role.toUpperCase()} · HTTP ${e.httpStatus} · ${ms}MS</span>${reason}▸ ${msg}${detail}`;
          const el = document.getElementById('cpLastLatency');
          if (el) { el.textContent = 'http ' + e.httpStatus + ' · ' + ms + ' ms'; el.style.color = 'var(--warn)'; }
        } else {
          pending.innerHTML = `<span class="meta" style="color:var(--warn);">${role.toUpperCase()} · OFFLINE · ${ms}MS</span>▸ Local AI server unreachable at <span class="mono" style="color:var(--cyan-1);">${SEEKDEEP_BASE}/chat</span>. ${e && e.message ? '<br/>Error: ' + escapeHtml(e.message) : 'Start the stack via the SeekDeep tray icon or <span class="mono" style="color:var(--cyan-1);">seekdeep_launcher.bat</span> option 8, then resend.'}`;
          // Diagnostics — show the error in the latency slot so the panel
          // doesn't stay frozen on a stale successful send.
          const el = document.getElementById('cpLastLatency');
          if (el) { el.textContent = 'offline · ' + ms + ' ms'; el.style.color = 'var(--warn)'; }
        }
      } finally {
        sendCtl = null;
        send.textContent = origSendLabel;
        send.style.color = '';
      }
    }
    function escapeHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    send.addEventListener('click', doSend);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
  })();
  document.querySelectorAll('.btn, .btn-mini, .att-btn').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.addEventListener('click', () => {
      btn.style.transition = 'box-shadow 0.15s';
      const orig = btn.style.boxShadow;
      btn.style.boxShadow = '0 0 0 2px var(--cyan-1), 0 0 18px rgba(45,212,255,0.5)';
      setTimeout(() => { btn.style.boxShadow = orig; }, 220);
    });
  });
