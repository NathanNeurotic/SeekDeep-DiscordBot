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

  // Event-driven invalidation: the backend publishes service.state.changed
  // on every transition AND on each /launchers/status request that detects
  // a change. When the WS bus delivers one, force a poll immediately so the
  // pill flips without waiting up to 5s for the regular cycle. This is the
  // half of the "stop lying about state" fix that runs in the browser; the
  // backend half is _emit_state_change_if_any in gui_endpoints.py.
  function wireStateChangeBus() {
    if (window.__seekdeepStateChangeWired) return;
    if (!window.SeekDeepEvents || typeof window.SeekDeepEvents.on !== 'function') {
      // events.js not loaded yet — re-try when DOMContentLoaded fires.
      setTimeout(wireStateChangeBus, 250);
      return;
    }
    window.__seekdeepStateChangeWired = true;
    window.SeekDeepEvents.on('service.state.changed', () => {
      // Coalesce bursts (e.g. restart fires N events) into one poll per 200ms.
      if (window.__seekdeepStateChangePending) return;
      window.__seekdeepStateChangePending = true;
      setTimeout(() => {
        window.__seekdeepStateChangePending = false;
        pumpStatus();
      }, 200);
    });
  }
  wireStateChangeBus();

  // Tracks consecutive /launchers/status failures so we can flip the cards
  // to UNKNOWN after 3 misses instead of leaving them in PROBING forever
  // (which would be a quiet lie when the AI server is genuinely down).
  let _launchStatusMisses = 0;
  async function pumpStatus() {
    let data;
    try {
      const r = await fetch(BASE + '/launchers/status', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error('http ' + r.status);
      data = await r.json();
      _launchStatusMisses = 0;
    } catch {
      // During a known restart window, suppress the UNKNOWN flip — the
      // sidecar is intentionally down for ~5-10s and the user already
      // got a "restarting" toast. Don't double-up with "OFFLINE" panic.
      if (window.__seekdeepRestartingUntil && Date.now() < window.__seekdeepRestartingUntil) {
        return;
      }
      _launchStatusMisses++;
      if (_launchStatusMisses >= 3) {
        // Mark every card UNKNOWN so the user knows the launcher backend
        // isn't reachable, instead of staring at "PROBING" indefinitely.
        document.querySelectorAll('.launcher-card[data-svc]').forEach((card) => {
          const pill = card.querySelector('.pill');
          if (!pill) return;
          pill.classList.remove('on');
          pill.classList.add('warn');
          pill.innerHTML = '<span class="dot"></span>UNKNOWN';
          card.classList.remove('up');
        });
        const sbLauncher = document.getElementById('sbLauncherBadge');
        if (sbLauncher) {
          sbLauncher.textContent = '— OFFLINE';
          sbLauncher.classList.add('bad');
        }
      }
      return;
    }
    if (!data || !data.services) return;
    // Sidebar Launcher badge: "N UP" / "N DOWN".
    let up = 0, total = 0;
    for (const s of Object.values(data.services)) {
      total++;
      if (s && s.state === 'running') up++;
    }
    const sbLauncher = document.getElementById('sbLauncherBadge');
    if (sbLauncher) {
      sbLauncher.textContent = up + ' UP';
      sbLauncher.classList.toggle('warn', up > 0 && up < total);
      sbLauncher.classList.toggle('bad',  up === 0);
    }

    // Bottom-bar STACK status — reflect aggregate launcher state instead of
    // the cLIVE pump's binary "is /health up" view. cLIVE used to stamp
    // HEALTHY whenever /health responded, which lied about the stack when
    // bot or searxng were down. Now: HEALTHY only if every service is up,
    // DEGRADED if some are up + some are down, DOWN if nothing is running.
    const stackState = document.getElementById('stackState');
    const stackDot   = document.getElementById('stackDot');
    if (stackState) {
      if (up === total && total > 0)      stackState.textContent = 'HEALTHY';
      else if (up > 0)                    stackState.textContent = 'DEGRADED';
      else                                stackState.textContent = 'DOWN';
    }
    if (stackDot) {
      // Match the badge color to the new state. Single source of truth so
      // the dot doesn't show green next to "DEGRADED" text.
      if (up === total && total > 0)      { stackDot.style.background = 'var(--good)';  stackDot.style.boxShadow = '0 0 10px var(--good)'; }
      else if (up > 0)                    { stackDot.style.background = 'var(--warn)';  stackDot.style.boxShadow = '0 0 10px var(--warn)'; }
      else                                { stackDot.style.background = 'var(--bad)';   stackDot.style.boxShadow = '0 0 10px var(--bad)';  }
    }
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

      // Health pill — honors transitioning (yellow during start/stop/restart)
      // and count (e.g. "RUNNING · 3 INSTANCES" for bot pile-ups).
      const pill = card.querySelector('.pill');
      if (pill) {
        const dot = pill.querySelector('.dot');
        const isTransitioning = s.transitioning === true || s.state === 'transitioning';
        const isUp = s.state === 'running';
        const isExited = s.state === 'exited' || s.state === 'not-running';
        pill.classList.toggle('on', isUp && !isTransitioning);
        pill.classList.toggle('bad', isExited && !isTransitioning);
        pill.classList.toggle('warn', isTransitioning);
        pill.innerHTML = '';
        if (dot) pill.appendChild(dot.cloneNode(true));
        else { const d = document.createElement('span'); d.className = 'dot'; pill.appendChild(d); }
        let label;
        if (isTransitioning) label = '… TRANSITIONING';
        else if (isUp) label = (s.count && s.count > 1)
          ? `RUNNING · ${s.count} INSTANCES`
          : 'HEALTHY';
        else if (isExited) label = 'EXITED';
        else label = 'UNKNOWN';
        pill.appendChild(document.createTextNode(label));
      }

      // Show last_error tail when the service has exited, so the user sees
      // WHY instead of just "EXITED". Idempotent: one .launcher-error div
      // per card, replaced in place on each pump.
      let errBox = card.querySelector('.launcher-error');
      if (s.state === 'exited' || s.state === 'not-running') {
        if (s.last_error) {
          if (!errBox) {
            errBox = document.createElement('div');
            errBox.className = 'launcher-error';
            errBox.style.cssText = 'grid-column: 1 / -1; margin-top: 10px; padding: 10px 12px; background: rgba(255,85,85,0.06); border: 1px solid rgba(255,85,85,0.35); border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 11px; color: var(--hull-2); line-height: 1.45;';
            card.appendChild(errBox);
          }
          const fileLine = s.last_error_log
            ? `<div style="color: var(--hull-3); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 6px;">▸ exit log · logs/${s.last_error_log}</div>`
            : '';
          const escaped = String(s.last_error).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          errBox.innerHTML = fileLine + `<pre style="margin:0; white-space:pre-wrap; word-break:break-word; color:var(--bad); font-size:10.5px;">${escaped}</pre>`;
        }
      } else if (errBox) {
        errBox.remove();
      }

      card.classList.toggle('up', s.state === 'running');
    }
  }

  // --- Sidebar GPU badge pump (lightweight /gpu probe every 10s) ----------
  // The cLIVE pump in app.html already calls /gpu but only writes to the
  // GPU pane numbers, not the sidebar badge. We want the sidebar badge to
  // update on every page even before the user clicks into the GPU pane.
  async function pumpGpuBadge() {
    const badge = document.getElementById('sbGpuBadge');
    if (!badge) return;
    try {
      const r = await fetch(BASE + '/gpu', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!r.ok) return;
      const g = await r.json();
      if (g.used_pct != null) {
        badge.textContent = Math.round(g.used_pct) + '%';
        badge.classList.toggle('warn', g.used_pct >= 75);
        badge.classList.toggle('bad',  g.used_pct >= 92);
      } else if (g.available === false) {
        badge.textContent = 'CPU';
        badge.classList.remove('warn', 'bad');
      }
    } catch { /* keep last good value */ }
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
    // searxng card: "Reqs:" cell — we don't have a count for it. SearXNG
    // runs in Docker, not through this AI server, so the AI server's
    // request-counter middleware doesn't see those hits. Leave the cell
    // as "—" (honest) rather than writing "0" which lies.
    // ai-server card has no Reqs cell in its markup, so the setStatCell
    // call below is dead — but kept for forward compat if a Reqs cell
    // gets added later.
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

    // ---- Stats pane: Persona / Image-style / Chat-model breakdowns --------
    // Live render IF the bot has bumped at least one entry. While empty
    // (fresh install, or @SeekDeep hasn't been pinged yet), the panel keeps
    // its empty-state placeholder so the page doesn't fake data.
    renderBreakdown('personaBreakdown', bot.by_persona,     'persona');
    renderBreakdown('styleBreakdown',   bot.by_image_style, 'image style');
    renderBreakdown('modelBreakdown',   bot.by_chat_model,  'chat model');

    // ---- Stats pane: Top contributors leaderboard -------------------------
    // /stats/snapshot now aggregates per-user activity across guilds and
    // returns top 10. The old wireStats() in app.html was looking for
    // data.top in server-stats.json which never existed (the file is
    // keyed guild→user), so the leaderboard never rendered. Drive it
    // from snapshot.bot.top_contributors instead.
    const lb = document.getElementById('statsLeaderboard');
    const ranked = Array.isArray(bot.top_contributors) ? bot.top_contributors : [];
    if (lb && ranked.length) {
      lb.innerHTML = '';
      const total = ranked.reduce((s, u) => s + (u.count || 0), 0) || 1;
      ranked.forEach((u, i) => {
        const pct = Math.round(((u.count || 0) / total) * 100);
        const row = document.createElement('div');
        row.className = 'lb-row';
        // XSS-safe: u.tag / u.id come from server but go via textContent.
        const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; el.textContent = text; return el; };
        const tag = String(u.tag || ('@' + (u.id || '').slice(-6) || '?'));
        row.appendChild(mk('span', 'rk', String(i + 1).padStart(2, '0')));
        row.appendChild(mk('span', 'av', tag.charAt(1) || tag.charAt(0) || '?'));
        row.appendChild(mk('span', '',   tag));
        row.appendChild(mk('span', 'count', String(u.count || 0)));
        row.appendChild(mk('span', 'pct', pct + '%'));
        row.title = `chats ${u.chats || 0} · images ${u.images || 0} · vision ${u.vision || 0}`;
        lb.appendChild(row);
      });
    }

    // ---- Sidebar Models badge --------------------------------------------
    const sbModels = document.getElementById('sbModelsBadge');
    if (sbModels && snap.cache && snap.cache.hf_repo_count != null) {
      sbModels.textContent = String(snap.cache.hf_repo_count);
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
      // "Cache total" mini-card — id-tagged spans (mmCacheTotal/mmCacheDelta)
      // first, falls back to label-match for older markup.
      const gb = (cache.hf_size_bytes / (1024 * 1024 * 1024));
      const totalEl = document.getElementById('mmCacheTotal');
      const deltaEl = document.getElementById('mmCacheDelta');
      if (totalEl) totalEl.textContent = gb.toFixed(1);
      if (deltaEl && cache.hf_repo_count != null) {
        deltaEl.textContent = cache.hf_repo_count + ' model' + (cache.hf_repo_count === 1 ? '' : 's') + ' pulled';
      }
      if (!totalEl && !deltaEl) {
        document.querySelectorAll('.card-mini').forEach((card) => {
          const lbl = card.querySelector('.lbl');
          if (!lbl || !/cache total/i.test(lbl.textContent || '')) return;
          const val = card.querySelector('.val');
          if (val) val.innerHTML = gb.toFixed(1) + ' <span style="font-size:16px; color:var(--hull-3);">GB</span>';
          const delta = card.querySelector('.delta');
          if (delta && cache.hf_repo_count != null) {
            delta.textContent = cache.hf_repo_count + ' model' + (cache.hf_repo_count === 1 ? '' : 's') + ' pulled';
          }
        });
      }
    }
  }

  // --- DOM helpers used by pumpStatsSnapshot ------------------------------

  function setText(id, val) {
    const el = document.getElementById(id);
    if (!el || val == null) return;
    el.textContent = (typeof val === 'number') ? val.toLocaleString() : String(val);
  }

  // Render a small horizontal-bar breakdown (key -> count). Sorted desc,
  // max 8 rows, total normalized to 100% across all keys for the bar widths.
  // XSS-safe: keys come from server-stats.json which is bot-controlled, but
  // we still go via textContent in case a persona/style/model label was
  // stored with a hostile substring.
  function renderBreakdown(hostId, dict, label) {
    const host = document.getElementById(hostId);
    if (!host || !dict) return;
    const entries = Object.entries(dict).filter(([_, v]) => Number(v) > 0);
    if (!entries.length) return;  // keep the empty-state placeholder
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 8);
    const total = entries.reduce((s, [, v]) => s + Number(v || 0), 0) || 1;
    host.innerHTML = '';  // clear placeholder
    host.style.fontFamily = 'var(--font-mono)';
    host.style.fontSize = '12px';
    host.style.color = 'var(--hull-2)';
    host.style.paddingTop = '6px';
    for (const [k, v] of top) {
      const pct = Math.round((Number(v) / total) * 100);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cssText = 'justify-content: space-between; padding: 6px 0;';
      const name = document.createElement('span');
      name.textContent = k;
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.cssText = 'flex: 1; margin: 0 12px;';
      const fill = document.createElement('i');
      fill.style.width = Math.max(2, pct) + '%';
      bar.appendChild(fill);
      const pctEl = document.createElement('span');
      pctEl.style.color = 'var(--cyan-1)';
      pctEl.textContent = pct + '%';
      row.appendChild(name);
      row.appendChild(bar);
      row.appendChild(pctEl);
      host.appendChild(row);
    }
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
    // ai-server is self-hosted (it's the very process serving this request),
    // so /launcher/ai-server/{start,stop,restart} always 409s. When running
    // under Tauri, route restart/stop to the Rust shell's restart_sidecar
    // command instead — that kills + respawns from outside the Python proc.
    // Outside Tauri, surface a clear toast instead of "HTTP 409".
    if (svc === 'ai-server' && (action === 'restart' || action === 'start')) {
      const tauri = window.__TAURI__;
      if (tauri && tauri.core) {
        try {
          await tauri.core.invoke('restart_sidecar');
          const sdn = notify();
          if (sdn) sdn.toast({ tone: 'info', title: 'ai-server restarting via Tauri sidecar…', ttl: 4000 });
          setTimeout(pumpStatus, 1500);
        } catch (err) {
          const sdn = notify();
          if (sdn) sdn.toast({ tone: 'bad', title: 'ai-server restart failed', body: String(err), ttl: 5000 });
        }
        return;
      }
      // Browser / non-Tauri mode: explain instead of 409
      const sdn = notify();
      if (sdn) sdn.toast({
        tone: 'info', title: 'ai-server is self-hosted',
        body: 'Restart it from the SeekDeep tray (or relaunch the .exe). The launcher endpoint refuses self-restart to avoid killing this request handler.',
        ttl: 6000,
      });
      return;
    }
    if (svc === 'ai-server' && action === 'stop') {
      const sdn = notify();
      if (sdn) sdn.toast({
        tone: 'info', title: 'ai-server can\'t stop itself',
        body: 'Quit SeekDeep from the tray to shut down the local AI server.',
        ttl: 6000,
      });
      return;
    }
    // Helper: try the POST once, return {ok, status, body} or null on network error.
    const tryOnce = async () => {
      try {
        const r = await fetch(BASE + '/launcher/' + svc + '/' + action, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, body };
      } catch (_) {
        return null;
      }
    };
    // Retry-on-network-error: TypeError: Failed to fetch was the user-visible
    // result of the WebView racing against a server restart (sidecar respawn,
    // ML deps install, etc.). One quiet retry after 400ms is enough — if the
    // server's coming back it'll be back by then; if it's not, we surface
    // the real error on the second attempt.
    // Restart action sets the global flag itself so subsequent polls + sibling
    // launcherCalls during the bounce don't surface "server unreachable" red
    // toasts. The user already saw "restarting" — we don't need 4 follow-ups.
    if (action === 'restart' || action === 'start') {
      window.__seekdeepRestartingUntil = Date.now() + 12000;
    }
    let result = await tryOnce();
    if (result === null) {
      await new Promise(r => setTimeout(r, 400));
      result = await tryOnce();
    }
    const sdn = notify();
    const inRestartWindow = window.__seekdeepRestartingUntil && Date.now() < window.__seekdeepRestartingUntil;
    if (result === null) {
      // During a known restart window, downgrade to info-tone (or skip
      // entirely) so the user isn't bombarded with 4 red toasts saying the
      // same "may be restarting" thing.
      if (sdn) {
        if (inRestartWindow) {
          // Skip — the action that started the restart already toasted.
        } else {
          sdn.toast({ tone: 'bad', title: svc + ' ' + action + ' · server unreachable', body: 'Both attempts failed. The local AI server may be restarting — try again in a few seconds.', ttl: 6000 });
        }
      }
    } else if (sdn) {
      if (result.ok) sdn.toast({ tone: 'good', title: svc + ' ' + action + ' OK', ttl: 3000 });
      else sdn.toast({ tone: 'bad', title: svc + ' ' + action + ' failed', body: 'HTTP ' + result.status + (result.body.detail ? ' · ' + result.body.detail : ''), ttl: 6000 });
    }
    setTimeout(pumpStatus, 600);
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
          if (!await (window.SeekDeepConfirm || window.confirm)('Prune HF cache?\nDeletes all unreferenced revisions. Frees disk but you\'ll have to re-download if you switch back to a removed model.')) return;
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
          // Multi-window guard: prompt before racing with another window
          // that might be doing its own restart. Was: silent fight.
          if (window.SeekDeepWindows && !window.SeekDeepWindows.confirmIfMultiple('Reload .env (restart AI server + bot)')) return;
          // .env changes only take effect on process restart. Both the AI
          // server (Python uvicorn) and the Discord bot (node index.js)
          // need to be restarted: AI-server-side keys (LOCAL_*_MODEL_ID,
          // VRAM_*, HF_HUB_OFFLINE, etc.) and bot-side keys (DISCORD_TOKEN,
          // SEEKDEEP_ADMIN_IDS, persona env defaults, feature flags) live
          // in the same .env file. Was: only restarted the AI server, so
          // bot-side changes silently didn't apply until manual restart.
          const sdn = notify();
          const tauri = window.__TAURI__;
          // 1) AI server: Tauri restart_sidecar or fallback to launcher
          if (tauri && tauri.core) {
            try { await tauri.core.invoke('restart_sidecar'); }
            catch (err) { if (sdn) sdn.toast({ tone: 'bad', title: 'AI-server restart failed', body: String(err), ttl: 4000 }); }
          } else {
            await launcherCall('ai-server', 'restart');
          }
          // 2) Bot: skip if not currently running (no point restarting an
          // exited bot — user would expect Start instead). Probe state via
          // the launcher status pump's cached data if we have it, else fire
          // and rely on launcher endpoint's own handling.
          let botShouldRestart = true;
          try {
            const r = await fetch(BASE + '/launchers/status', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
            if (r.ok) {
              const d = await r.json();
              const bot = (d && d.services && d.services.bot) || {};
              botShouldRestart = bot.state === 'running';
            }
          } catch { /* fall through and try anyway */ }
          if (botShouldRestart) {
            await launcherCall('bot', 'restart');
          }
          if (sdn) sdn.toast({
            tone: 'info',
            title: 'Reloading .env',
            body: botShouldRestart ? 'Restarting AI server + bot…' : 'Restarting AI server (bot wasn\'t running — start it manually if you need bot-side env keys)',
            ttl: 4500,
          });
        });
      } else if (label === '⤓ flush model cache') {
        btn.addEventListener('click', unloadAll);
      } else if (label === '↯ force kill all') {
        btn.addEventListener('click', async () => {
          if (window.SeekDeepWindows && !window.SeekDeepWindows.confirmIfMultiple('Force kill bot + ai-server + searxng')) return;
          if (!await (window.SeekDeepConfirm || window.confirm)('Force-kill all services?\nbot + ai-server + searxng will all be terminated. Models in VRAM drop. In-flight requests fail.')) return;
          for (const svc of ['bot', 'ai-server', 'searxng']) await launcherCall(svc, 'stop');
        });
      } else if (label === '⟳ smoke test') {
        btn.addEventListener('click', () => {
          const sdn = notify();
          if (sdn) sdn.toast({ tone: 'info', title: 'Smoke test', body: 'Run <code>npm run preflight</code> from the repo to validate the full stack.', ttl: 6000 });
        });
      }
    });

    // ---- Lock cache (offline) toggle ----------------------------------
    // Toggles HF_HUB_OFFLINE + TRANSFORMERS_OFFLINE in .env via POST /config,
    // then restarts the sidecar so the new env takes effect. The button's
    // current state is read from /health.env_offline; pumpStatus polls so the
    // label keeps up if .env is edited externally.
    const lockBtn = document.getElementById('qaLockCacheBtn');
    if (lockBtn) {
      let lockBusy = false;
      let lockState = null;  // null = unknown (will resolve on first /health)
      function paintLock() {
        if (lockBusy) {
          lockBtn.textContent = '⏳ Working…';
          lockBtn.style.color = 'var(--warn)';
          return;
        }
        if (lockState === true)  { lockBtn.textContent = '⛓ Unlock cache (online)'; lockBtn.style.color = 'var(--cyan-1)'; lockBtn.title = 'HF_HUB_OFFLINE=1 right now. Click to flip back to 0 and let the sidecar fetch new model weights again.'; }
        else if (lockState === false) { lockBtn.textContent = '⛚ Lock cache (offline)';  lockBtn.style.color = ''; lockBtn.title = 'Toggle HF_HUB_OFFLINE + TRANSFORMERS_OFFLINE. Forces HF + Transformers to local cache only. Restarts the sidecar.'; }
        else { lockBtn.textContent = '⛚ Lock cache (offline)'; lockBtn.style.color = ''; lockBtn.title = 'env_offline state unknown · /health pending'; }
      }
      async function pullLockState() {
        try {
          const r = await fetch(BASE + '/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
          if (!r.ok) return;
          const h = await r.json();
          if (typeof h.env_offline === 'boolean') {
            lockState = h.env_offline;
            paintLock();
          }
        } catch {}
      }
      pullLockState();
      setInterval(pullLockState, 15000);
      lockBtn.addEventListener('click', async () => {
        if (lockBusy) return;
        const desired = lockState === true ? '0' : '1';
        const action = lockState === true ? 'Unlock' : 'Lock';
        if (window.SeekDeepWindows && !window.SeekDeepWindows.confirmIfMultiple(`${action} HF cache (writes .env + restarts sidecar)`)) return;
        if (!await (window.SeekDeepConfirm || window.confirm)(`${action} HF cache?\nThis will:\n  1. Write HF_HUB_OFFLINE=${desired} + TRANSFORMERS_OFFLINE=${desired} to .env\n  2. Restart the AI server so it picks up the new env\n\nIn-flight requests will be dropped.`)) return;
        lockBusy = true;
        paintLock();
        const sdn = notify();
        try {
          const r = await fetch(BASE + '/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: { HF_HUB_OFFLINE: desired, TRANSFORMERS_OFFLINE: desired } }),
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) {
            const txt = await r.text().catch(() => '');
            throw new Error('HTTP ' + r.status + (txt ? ' · ' + txt.slice(0, 120) : ''));
          }
          // Now restart the sidecar so Python re-reads the env. Same pattern
          // as Reload .env above: Tauri → restart_sidecar, else → /launcher/
          // ai-server/restart (which 409s for self-hosted ai-server, in which
          // case the user has to restart manually).
          // Set the global restart-window flag so other pumps don't toast
          // "Failed to fetch" during the bounce.
          window.__seekdeepRestartingUntil = Date.now() + 12000;
          const tauri = window.__TAURI__;
          if (tauri && tauri.core) {
            try { await tauri.core.invoke('restart_sidecar'); }
            catch (err) { if (sdn) sdn.toast({ tone: 'bad', title: 'Restart failed', body: String(err), ttl: 4000 }); }
          } else {
            await launcherCall('ai-server', 'restart');
          }
          if (sdn) sdn.toast({ tone: 'good', title: `${action}ed cache`, body: `HF_HUB_OFFLINE=${desired} · sidecar restarting`, ttl: 5000 });
          // Optimistic state flip; real state confirmed on next pullLockState
          lockState = desired === '1';
          setTimeout(pullLockState, 3000);
        } catch (err) {
          if (sdn) sdn.toast({ tone: 'bad', title: `${action} failed`, body: String(err.message || err), ttl: 6000 });
        } finally {
          lockBusy = false;
          paintLock();
        }
      });
    }

    // ---- Self-update button -------------------------------------------
    // Pulls latest local_ai_server.py + gui_endpoints.py + gui/ from main
    // on GitHub via POST /system/self-update. Use when the bundled MSI is
    // stale and fixes haven't landed for this user.
    const suBtn = document.getElementById('qaSelfUpdateBtn');
    if (suBtn) {
      suBtn.addEventListener('click', async () => {
        if (!await (window.SeekDeepConfirm || window.confirm)('Self-update from GitHub?\nFetches latest local_ai_server.py + gui_endpoints.py + gui/ + scripts/ from main, writes them to the runtime dir, and marks them as user-patched so Tauri won\'t clobber them on next boot.\n\nThe AI server will auto-restart once the update completes.')) return;
        const sdn = notify();
        const orig = suBtn.textContent;
        suBtn.disabled = true;
        suBtn.textContent = '⏳ Updating…';
        try {
          const r = await fetch(BASE + '/system/self-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(60000),
          });
          if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
            throw new Error(msg);
          }
          const j = await r.json();
          const updated = (j.downloaded && j.downloaded.length) || (j.updated && j.updated.length) || 0;
          if (sdn) sdn.toast({ tone: 'good', title: 'Self-update OK', body: `Updated ${updated} file(s) · restarting AI server now…`, ttl: 5000 });
          suBtn.textContent = '⏳ restarting…';
          // Auto-restart so the patched code actually takes effect. Set the
          // global restart-window flag so /logs/tail + /launchers/status
          // polling doesn't toast errors during the ~10s sidecar bounce.
          window.__seekdeepRestartingUntil = Date.now() + 12000;
          try {
            const tauri = window.__TAURI__;
            if (tauri && tauri.core) {
              await tauri.core.invoke('restart_sidecar');
            } else {
              await fetch(BASE + '/launcher/ai-server/restart', { method: 'POST' });
            }
            suBtn.textContent = '✓ updated + restarted';
            setTimeout(() => { suBtn.textContent = orig; }, 4000);
          } catch (re) {
            if (sdn) sdn.toast({ tone: 'warn', title: 'Restart failed', body: 'Update applied but restart didn\'t fire — restart manually. ' + (re.message || re), ttl: 8000 });
            suBtn.textContent = '✓ updated · please restart manually';
          }
        } catch (err) {
          if (sdn) sdn.toast({ tone: 'bad', title: 'Self-update failed', body: String(err.message || err), ttl: 8000 });
          suBtn.textContent = orig;
        } finally {
          suBtn.disabled = false;
        }
      });
    }

    // ---- Bot CWD field -----------------------------------------------
    // Lets the user point `node index.js` at their actual repo dir when
    // running under Tauri (where cwd defaults to %APPDATA%/SeekDeep/app/).
    // Saved to .env as SEEKDEEP_BOT_CWD via POST /config; blank = auto-detect.
    const cwdInput = document.getElementById('qaBotCwd');
    const cwdSave = document.getElementById('qaBotCwdSave');
    const cwdStatus = document.getElementById('qaBotCwdStatus');
    if (cwdInput && cwdSave) {
      // Prefill from /config (server returns redacted env keys; SEEKDEEP_BOT_CWD is not secret).
      (async () => {
        try {
          const r = await fetch(BASE + '/config', { cache: 'no-store' });
          if (!r.ok) return;
          const j = await r.json();
          const val = (j.env && j.env.SEEKDEEP_BOT_CWD) || (j.SEEKDEEP_BOT_CWD) || '';
          if (val && cwdInput.value === '') cwdInput.value = String(val);
        } catch {}
      })();
      cwdSave.addEventListener('click', async () => {
        const val = (cwdInput.value || '').trim();
        cwdSave.disabled = true;
        cwdStatus.style.color = 'var(--hull-3)';
        cwdStatus.textContent = '▸ saving…';
        try {
          const r = await fetch(BASE + '/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: { SEEKDEEP_BOT_CWD: val } }),
          });
          if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
            throw new Error(msg);
          }
          cwdStatus.style.color = 'var(--cyan-1)';
          cwdStatus.textContent = val ? `▸ saved · restart bot to use ${val}` : '▸ cleared · will auto-detect on next start';
        } catch (err) {
          cwdStatus.style.color = 'var(--warn)';
          cwdStatus.textContent = '▸ save failed · ' + (err.message || err);
        } finally {
          cwdSave.disabled = false;
        }
      });
    }
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
    // GPU sidebar badge pump (10s; cheap /gpu probe).
    pumpGpuBadge();
    setInterval(pumpGpuBadge, 10000);
  }

  // Tauri sidecar restart listener: any code path that bounces the Python
  // server (tray menu, splash recovery, lib.rs restart_sidecar command) emits
  // a sidecar:status event with code=RESTARTING / SPAWNING. Set the global
  // restart-window flag so launcherCall + nav.js error surfacing both stay
  // quiet during the bounce.
  (function wireSidecarRestartFlag() {
    const tauri = window.__TAURI__;
    if (!tauri || !tauri.event || typeof tauri.event.listen !== 'function') return;
    tauri.event.listen('sidecar:status', (e) => {
      const code = e?.payload?.code || '';
      if (code === 'RESTARTING' || code === 'SPAWNING' || code === 'DEPS_INSTALLING') {
        window.__seekdeepRestartingUntil = Date.now() + 15000;
      } else if (code === 'READY' || code === 'HEALTHY') {
        // Sidecar is back up — clear the suppression immediately so real
        // errors after this point aren't swallowed.
        window.__seekdeepRestartingUntil = 0;
      }
    }).catch(() => { /* event plugin not loaded — fall back to per-button flag */ });
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
