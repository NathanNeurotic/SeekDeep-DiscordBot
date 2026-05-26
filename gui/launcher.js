/* SeekDeep · launcher.js
   =====================
   Wires the Control Center launcher panel + GPU pane.

   - Auto-loaded by nav.js's autoLoadSiblings on every page; self-gates
     to app.html (the only page with the launcher markup).
   - Polls GET /launchers/status every 5s; rewrites PID + state + uptime
     into the .launcher-card[data-svc] tiles.
   - Wires the per-card Restart / Stop buttons to POST /launcher/{svc}/{action}.
   - Wires the header Launch all / Stop all buttons.
   - Wires the GPU pane's "/unload all" button to POST /unload.
   - Wires the Quick Actions (Reload .env → restart_sidecar via Tauri,
     Flush model cache → POST /unload, Force kill all → loop stop, Smoke
     test → opens a notify.toast linking to the preflight script).
   - Drops a notify.banner ("Some launcher controls are unwired mocks")
     on the page once the page proves its panel is rendered, so users
     know which bits are decorative vs functional.

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

  // --- One-shot "some controls are decorative" disclosure -----------------
  // The Control Center has historical mock buttons (paginated transcripts,
  // "↑ 18% vs last 30d" deltas, "History (184)" counters). Wiring them all
  // would mean shipping new endpoints we don't have. Flag the situation
  // honestly via a one-time notify.banner so the user knows which controls
  // do something vs which are placeholders.

  const DISCLOSURE_KEY = 'sd-launcher-mocks-acknowledged';

  function maybeShowDisclosure() {
    const sdn = notify();
    if (!sdn) return;
    try { if (localStorage.getItem(DISCLOSURE_KEY) === '1') return; } catch {}
    sdn.banner({
      id: 'sd-launcher-mocks',
      tone: 'neutral',
      title: 'Some Control Center widgets are still mocks',
      body: 'Launch / Stop / Restart / /unload / Reload .env / Flush cache / Force kill are wired. Pagination, transcript history, "↑ 18% vs last 30d" deltas, and "Reqs: 184" counters are placeholders pending backend telemetry.',
      primary: { label: 'Got it', onClick: ({ close }) => { try { localStorage.setItem(DISCLOSURE_KEY, '1'); } catch {} close(); } },
      dismissible: true,
    });
  }

  // --- Boot --------------------------------------------------------------

  function init() {
    wireButtons();
    pumpStatus();
    setInterval(pumpStatus, 5000);
    // Give the page a beat to settle before surfacing the disclosure banner.
    setTimeout(maybeShowDisclosure, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
