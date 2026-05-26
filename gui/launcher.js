/* SeekDeep · launcher.js
   =====================
   Wires the Control Center launcher panel + Stats KPIs + cache cells.

   - Auto-loaded by nav.js's autoLoadSiblings on every page; self-gates
     to app.html (the only page with the launcher markup).
   - Polls GET /launchers/status every 5s; rewrites PID + state + uptime
     into the .launcher-card[data-svc] tiles.
   - Polls GET /stats/snapshot every 30s; rewrites the Reqs/Latency/Guilds
     launcher tile cells, the 4 Stats-pane KPIs + their 30d deltas, the
     activity bars chart (gap-filled from bot.day_buckets), the bar-axis
     labels, and the Models-pane cache-size cells + Prune button label.
   - Wires the per-card Restart / Stop buttons to POST /launcher/{svc}/{action}.
   - Wires the header Launch all / Stop all buttons.
   - Wires the GPU pane's "/unload all" button to POST /unload.
   - Wires the Quick Actions (Reload .env → restart_sidecar via Tauri,
     Flush model cache → POST /unload, Force kill all → loop stop, Smoke
     test → opens a notify.toast linking to the preflight script).
   - Wires the Models-pane "Prune cache" button to POST /cache/prune.

   Self-gates via window.__seekdeepLauncherLoaded + path check.
*/
(function () {
  'use strict';
  if (window.__seekdeepLauncherLoaded) return;
  window.__seekdeepLauncherLoaded = true;

  const here = (location.pathname.split('/').pop() || '').toLowerCase();
  if (here !== 'app.html') return;

  function getBase() {
    if (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')) return 'http://127.0.0.1:7865';
    return (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
  }
  const BASE = getBase();

  function notify() { return window.SeekDeepNotify || null; }

  function fmtUptime(s) {
    if (s == null) return '—';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) {
      const h = Math.floor(s / 3600);
      const m = Math.round((s % 3600) / 60);
      return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    }
    return Math.round(s / 86400) + 'd';
  }

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function fmtPct(p) {
    if (p == null) return null;
    const arrow = p > 0 ? '↑' : (p < 0 ? '↓' : '·');
    return arrow + ' ' + Math.abs(p).toFixed(1) + '% vs prior 30d';
  }

  function fmtCountAbbrev(n) {
    if (n == null) return '—';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1_000_000).toFixed(1) + 'M';
  }

  // --- Card status pump ---------------------------------------------------

  async function pumpStatus() {
    let data;
    try {
      const r = await fetch(BASE + '/launchers/status', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!r.ok) return;
      data = await r.json();
    } catch { return; }
    if (!data || !data.services) return;
    for (const svc of Object.keys(data.services)) {
      const s = data.services[svc];
      const card = document.querySelector('.launcher-card[data-svc="' + svc + '"]');
      if (!card) continue;

      // PID line: "PID 12345 · :7865" — preserve the port suffix if present
      const pidEl = card.querySelector('.pid');
      if (pidEl) {
        const portMatch = pidEl.textContent.match(/(·\s*[^·]+)$/);
        const port = portMatch ? portMatch[0] : '';
        if (s.pid != null) {
          pidEl.textContent = 'PID ' + s.pid + (port ? ' ' + port.trim() : '');
        } else {
          pidEl.textContent = '— ' + (port ? port.trim() : '');
        }
      }

      // Uptime / Latency / VRAM cells — these vary per card. Find any <em>
      // sibling of "Uptime:" and rewrite.
      card.querySelectorAll('.stats span').forEach((stat) => {
        const txt = stat.textContent || '';
        const em = stat.querySelector('em');
        if (!em) return;
        if (/uptime/i.test(txt)) em.textContent = fmtUptime(s.uptime_seconds);
      });

      // Health pill
      const pill = card.querySelector('.pill');
      if (pill) {
        const dot = pill.querySelector('.dot');
        const isUp = s.state === 'running';
        const isExited = s.state === 'exited' || s.state === 'not-running';
        pill.classList.toggle('on', isUp);
        pill.classList.toggle('bad', isExited);
        pill.innerHTML = '';
        if (dot) pill.appendChild(dot.cloneNode(true));
        else { const d = document.createElement('span'); d.className = 'dot'; pill.appendChild(d); }
        pill.appendChild(document.createTextNode(isUp ? 'HEALTHY' : (isExited ? 'EXITED' : 'UNKNOWN')));
      }

      card.classList.toggle('up', s.state === 'running');
    }
  }

  // --- Stats snapshot pump ------------------------------------------------
  // Single GET /stats/snapshot every 30s rewrites everything previously
  // hardcoded: per-service Reqs/Latency/Guilds cells on the launcher tiles,
  // the 4 Stats-pane KPI cards + their deltas, the 30-day activity bars
  // chart, the bar labels, and the Models-pane cache size cells.
  //
  // Soft-fail: if /stats/snapshot is unreachable (server down during boot,
  // CORS misconfig, etc.) we leave the existing DOM alone so the page still
  // renders something. The 5s status pump above handles the up/down state;
  // this pump only handles content updates.

  async function pumpStatsSnapshot() {
    let snap;
    try {
      const r = await fetch(BASE + '/stats/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      snap = await r.json();
    } catch { return; }
    if (!snap || !snap.ok) return;

    // ---- launcher tile cells (Reqs, Latency, Guilds) --------------------
    const ai = snap.ai_server || {};
    const bot = snap.bot || {};
    const fam = (ai.by_family_24h || ai.by_family_lifetime || {});
    // searxng card: "Reqs:" cell — count any path family this could plausibly
    // serve via the local-AI proxy. We don't proxy searxng through here, so
    // this is just the count attributable to the family; if we ever wire a
    // /search/ family it will show up automatically.
    setStatCell('searxng', /^reqs/i, fmtCountAbbrev((fam.search || fam.web || 0)));
    // ai-server card: existing svcQueue id is for live queue depth (not in
    // snapshot). Leave alone; backed by events.js if/when wired. But we DO
    // populate VRAM via stats.js elsewhere — no-op here.
    setStatCell('ai-server', /^reqs/i, fmtCountAbbrev(ai.total_requests));
    // bot card: Latency (p50 from ai-server, which is what the user feels
    // when they /chat) + Guilds (lifetime distinct guild count)
    setStatCell('bot', /^latency/i, (ai.latency_p50_ms != null) ? Math.round(ai.latency_p50_ms) + 'ms' : '—');
    setStatCell('bot', /^guilds/i, bot.guild_count != null ? String(bot.guild_count) : '—');

    // ---- Stats pane: 4 KPI cards ---------------------------------------
    setText('statTotalMessages', bot.total_chats);
    setText('statTotalImages',   bot.total_images);
    setText('statTotalVision',   bot.total_vision);
    // Active members: we know lifetime distinct users; "active" needs a
    // window. Use 24h-distinct-users from the bot if/when it ships; for now
    // show lifetime users, no fake "/ 42" denominator.
    setText('statTotalActive',   bot.user_count);

    // KPI deltas (Total messages / Images / Vision)
    const deltas = snap.deltas || {};
    setDeltaForCard('statTotalMessages', deltas.messages_30d_pct);
    setDeltaForCard('statTotalImages',   deltas.images_30d_pct);
    setDeltaForCard('statTotalVision',   deltas.vision_30d_pct);
    // Active members delta — no backend value; mark explicit pending so the
    // mock "↓ 3" doesn't keep lying.
    setDeltaForCard('statTotalActive', null, '— no window data yet');

    // ---- Stats pane: 30-day activity bars ------------------------------
    const buckets = Array.isArray(bot.day_buckets) ? bot.day_buckets : [];
    if (buckets.length) {
      const bars = document.getElementById('statsBars');
      if (bars) {
        const max = Math.max(1, ...buckets.map(b => (b.chats||0) + (b.images||0) + (b.vision||0)));
        bars.innerHTML = '';
        for (const b of buckets) {
          const v = (b.chats||0) + (b.images||0) + (b.vision||0);
          const col = document.createElement('div');
          col.className = 'col';
          col.style.height = Math.max(2, Math.round((v / max) * 100)) + '%';
          col.title = b.date + ' · ' + v + ' (chats ' + (b.chats||0) + ', images ' + (b.images||0) + ', vision ' + (b.vision||0) + ')';
          bars.appendChild(col);
        }
        // Bar labels: first, +7, +14, +22, last
        const labelsEl = bars.parentElement && bars.parentElement.querySelector('.bars-labels');
        if (labelsEl) {
          const pick = (i) => buckets[i] ? buckets[i].date.slice(5) : '';
          labelsEl.innerHTML = '<span>' + pick(0) + '</span>'
                             + '<span>' + pick(7) + '</span>'
                             + '<span>' + pick(14) + '</span>'
                             + '<span>' + pick(22) + '</span>'
                             + '<span>' + pick(buckets.length - 1) + '</span>';
        }
      }
    }

    // ---- Models pane: cache size cells ---------------------------------
    const cache = snap.cache || {};
    if (cache.hf_size_bytes != null) {
      // "Prune cache (4.2 GB)" button label
      document.querySelectorAll('button').forEach((btn) => {
        if (/^prune cache/i.test(btn.textContent || '')) {
          btn.textContent = 'Prune cache (' + fmtBytes(cache.hf_size_bytes) + ')';
        }
      });
      // "Cache total" mini-card — find the card whose .lbl is "Cache total"
      document.querySelectorAll('.card-mini').forEach((card) => {
        const lbl = card.querySelector('.lbl');
        if (!lbl || !/cache total/i.test(lbl.textContent || '')) return;
        const val = card.querySelector('.val');
        if (val) {
          const gb = (cache.hf_size_bytes / (1024 * 1024 * 1024));
          val.innerHTML = gb.toFixed(1) + ' <span style="font-size:16px; color:var(--hull-3);">GB</span>';
        }
        const delta = card.querySelector('.delta');
        if (delta && cache.hf_repo_count != null) {
          delta.textContent = cache.hf_repo_count + ' model' + (cache.hf_repo_count === 1 ? '' : 's') + ' pulled';
        }
      });
    }
  }

  // --- DOM helpers used by pumpStatsSnapshot ------------------------------

  function setText(id, val) {
    const el = document.getElementById(id);
    if (!el || val == null) return;
    el.textContent = (typeof val === 'number') ? val.toLocaleString() : String(val);
  }

  // Update one of the launcher-card .stats <span>'s <em> based on a label
  // regex (e.g. /^reqs/i matches "Reqs:" or "Reqs"). No-ops if the cell
  // isn't on this card — three cards each have different cell mixes.
  function setStatCell(svc, labelRe, value) {
    const card = document.querySelector('.launcher-card[data-svc="' + svc + '"]');
    if (!card) return;
    card.querySelectorAll('.stats span').forEach((span) => {
      const em = span.querySelector('em');
      if (!em) return;
      const lbl = (span.textContent || '').replace(em.textContent || '', '').trim();
      if (labelRe.test(lbl)) em.textContent = value;
    });
  }

  // Find the .delta sibling of #<id>'s parent .card-mini and rewrite it.
  // pct=null with no fallback → hide the delta entirely.
  function setDeltaForCard(valueId, pct, fallback) {
    const valEl = document.getElementById(valueId);
    if (!valEl) return;
    const card = valEl.closest('.card-mini');
    if (!card) return;
    const delta = card.querySelector('.delta');
    if (!delta) return;
    const txt = fmtPct(pct);
    if (txt != null) {
      delta.textContent = txt;
      delta.classList.toggle('bad', pct < 0);
    } else if (fallback != null) {
      delta.textContent = fallback;
      delta.classList.remove('bad');
    } else {
      delta.textContent = '';
      delta.classList.remove('bad');
    }
  }

  // --- Button wiring ------------------------------------------------------

  async function launcherCall(svc, action) {
    try {
      const r = await fetch(BASE + '/launcher/' + svc + '/' + action, { method: 'POST' });
      const sdn = notify();
      if (sdn) {
        if (r.ok) sdn.toast({ tone: 'good', title: svc + ' ' + action + ' OK', ttl: 3000 });
        else sdn.toast({ tone: 'bad', title: svc + ' ' + action + ' failed', body: 'HTTP ' + r.status, ttl: 5000 });
      }
      setTimeout(pumpStatus, 600);
    } catch (err) {
      const sdn = notify();
      if (sdn) sdn.toast({ tone: 'bad', title: 'Network error', body: String(err), ttl: 5000 });
    }
  }

  async function unloadAll() {
    try {
      const r = await fetch(BASE + '/unload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const sdn = notify();
      if (sdn) {
        if (r.ok) sdn.toast({ tone: 'good', title: 'Models unloaded · VRAM freed', ttl: 3500 });
        else sdn.toast({ tone: 'bad', title: '/unload failed · HTTP ' + r.status, ttl: 5000 });
      }
    } catch (err) {
      const sdn = notify();
      if (sdn) sdn.toast({ tone: 'bad', title: 'Network error', body: String(err), ttl: 5000 });
    }
  }

  function wireButtons() {
    // Per-card Restart / Stop
    document.querySelectorAll('.launcher-card[data-svc]').forEach((card) => {
      const svc = card.dataset.svc;
      if (!svc) return;
      card.querySelectorAll('.ctl button').forEach((btn) => {
        const label = (btn.textContent || '').toLowerCase().trim();
        if (label === 'restart') {
          btn.addEventListener('click', () => launcherCall(svc, 'restart'));
        } else if (label === 'stop') {
          btn.addEventListener('click', () => launcherCall(svc, 'stop'));
        } else if (label === 'start' || label === '▸ start') {
          btn.addEventListener('click', () => launcherCall(svc, 'start'));
        }
      });
    });

    // Header buttons — "Launch all" / "Stop all". Find by label text.
    document.querySelectorAll('section[data-pane="services"] .actions button, .head-row .actions button').forEach((btn) => {
      const label = (btn.textContent || '').toLowerCase().trim();
      if (label === '▸ launch all' || label === 'launch all') {
        btn.addEventListener('click', async () => {
          for (const svc of ['searxng', 'ai-server', 'bot']) await launcherCall(svc, 'start');
        });
      } else if (label === 'stop all') {
        btn.addEventListener('click', async () => {
          for (const svc of ['bot', 'ai-server', 'searxng']) await launcherCall(svc, 'stop');
        });
      }
    });

    // GPU pane "/unload all"
    document.querySelectorAll('button').forEach((btn) => {
      const label = (btn.textContent || '').trim();
      if (label === '/unload all') {
        btn.addEventListener('click', unloadAll);
      }
    });

    // Prune cache button (Models pane)
    document.querySelectorAll('button').forEach((btn) => {
      const label = (btn.textContent || '').toLowerCase().trim();
      if (label.startsWith('prune cache')) {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete all unreferenced HF cache revisions? This frees disk but redownloads are needed if you switch back to a deleted model rev.')) return;
          try {
            const r = await fetch(BASE + '/cache/prune', { method: 'POST' });
            const sdn = notify();
            const body = await r.json().catch(() => ({}));
            if (sdn) {
              if (r.ok) sdn.toast({ tone: 'good', title: 'Cache pruned · ' + fmtBytes(body.freed_bytes || 0) + ' freed', body: body.note || '', ttl: 5000 });
              else sdn.toast({ tone: 'bad', title: '/cache/prune failed', body: 'HTTP ' + r.status + ' · ' + (body.detail || ''), ttl: 6000 });
            }
            setTimeout(pumpStatsSnapshot, 600);
          } catch (err) {
            const sdn = notify();
            if (sdn) sdn.toast({ tone: 'bad', title: 'Network error', body: String(err), ttl: 5000 });
          }
        });
      }
    });

    // Quick Actions: Reload .env / Flush cache / Smoke test / Force kill all
    document.querySelectorAll('button').forEach((btn) => {
      const label = (btn.textContent || '').toLowerCase().trim();
      if (label === '⟳ reload .env') {
        btn.addEventListener('click', async () => {
          // .env changes only take effect on Python restart. In Tauri, ask
          // the Rust shell to kill + respawn the sidecar; outside Tauri,
          // hit /launcher/ai-server/restart (which only works for managed
          // ai-server spawns, otherwise informs the user via the toast).
          const tauri = window.__TAURI__;
          if (tauri && tauri.core) {
            try { await tauri.core.invoke('restart_sidecar'); }
            catch (err) { const sdn = notify(); if (sdn) sdn.toast({ tone: 'bad', title: 'Restart failed', body: String(err), ttl: 4000 }); }
            const sdn = notify(); if (sdn) sdn.toast({ tone: 'info', title: 'Restarting AI server with new .env…', ttl: 3500 });
          } else {
            launcherCall('ai-server', 'restart');
          }
        });
      } else if (label === '⤓ flush model cache') {
        btn.addEventListener('click', unloadAll);
      } else if (label === '↯ force kill all') {
        btn.addEventListener('click', async () => {
          if (!confirm('Force-kill bot + ai-server + searxng? Models in VRAM will drop.')) return;
          for (const svc of ['bot', 'ai-server', 'searxng']) await launcherCall(svc, 'stop');
        });
      } else if (label === '⟳ smoke test') {
        btn.addEventListener('click', () => {
          const sdn = notify();
          if (sdn) sdn.toast({ tone: 'info', title: 'Smoke test', body: 'Run <code>npm run preflight</code> from the repo to validate the full stack.', ttl: 6000 });
        });
      }
    });
  }

  // --- Boot --------------------------------------------------------------

  function init() {
    wireButtons();
    pumpStatus();
    setInterval(pumpStatus, 5000);
    // Stats snapshot pump: less frequent (30s) because it does more work
    // backend-side (HF cache scan, bot-stats file read, day-bucket sums).
    pumpStatsSnapshot();
    setInterval(pumpStatsSnapshot, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
