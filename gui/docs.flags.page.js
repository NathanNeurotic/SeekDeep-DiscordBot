  // ---- Docs as a control surface: live feature toggles -------------------
  // Each command with a `flag` renders an on/off switch wired to the REAL .env
  // via /config — the same catalog key the bot reads, so it actually takes
  // effect (restart the bot to apply). Gated on DOMContentLoaded, which fires
  // AFTER deferred scripts (nav.js) have run — so window.fetch is token-patched
  // (POST /config is token-gated) and SeekDeepResolveBase exists. This matters:
  // an inline <script defer> IGNORES `defer` and would otherwise execute mid-
  // parse, before nav.js. Read endpoint (/config/features) is open; write gated.
  function wireDocsFeatureToggles() {
    function base() {
      if (window.SeekDeepResolveBase) return window.SeekDeepResolveBase();
      if (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
      return (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
    }
    const cells = [...document.querySelectorAll('.cmd-flag[data-flag-key]')];
    if (!cells.length) return;
    function paint(cell, on) {
      cell.dataset.on = on ? '1' : '0';
      const btn = cell.querySelector('.ff-toggle');
      if (btn) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.textContent = on ? 'ENABLED' : 'DISABLED'; }
    }
    async function load() {
      try {
        const r = await fetch(base() + '/config/features', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (!r.ok) return;
        const f = ((await r.json()) || {}).features || {};
        cells.forEach(cell => paint(cell, !!f[cell.dataset.flagKey]));
      } catch (_) { /* server not up yet — leave toggles in the '···' state */ }
    }
    // In-place "apply" affordance: a feature flag is an .env change, so it
    // needs a bot restart — but the user shouldn't be told to go do it. After
    // any toggle we surface a one-click Restart bar (same /launcher/bot/restart
    // the All Settings page uses); rapid toggles reuse the one bar.
    let _restartBar = null;
    function showRestartBar() {
      if (_restartBar) { _restartBar.style.display = 'flex'; return; }
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9999;display:flex;gap:10px;align-items:center;background:var(--hull-1,#11151c);border:1px solid var(--good,#3ba55d);border-radius:8px;padding:8px 12px;box-shadow:0 4px 16px rgba(0,0,0,.45);font-size:12px;';
      const label = document.createElement('span');
      label.textContent = 'Feature change saved.';
      const btn = document.createElement('button');
      btn.className = 'btn'; btn.textContent = '↻ Restart bot to apply';
      btn.style.cssText = 'padding:6px 12px;font-size:12px;cursor:pointer;';
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '↻ Restarting…';
        try {
          const r = await fetch(base() + '/launcher/bot/restart', { method: 'POST', signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          window.SeekDeepNotify?.toast?.({ tone: 'good', title: 'Bot restarting…', body: 'Your changes are being applied (~15s).', ttl: 6000 });
          bar.style.display = 'none';
        } catch (e) {
          window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Restart request failed', body: String((e && e.message) || e) + '. Try again.', ttl: 6000 });
          btn.disabled = false; btn.textContent = '↻ Restart bot to apply';
        }
      });
      bar.appendChild(label); bar.appendChild(btn);
      document.body.appendChild(bar);
      _restartBar = bar;
    }
    async function toggle(cell) {
      const key = cell.dataset.flagKey;
      const next = cell.dataset.on === '1' ? 'off' : 'on';
      const prev = cell.dataset.on === '1';
      const btn = cell.querySelector('.ff-toggle');
      if (btn) { btn.disabled = true; btn.textContent = '···'; }
      try {
        const r = await fetch(base() + '/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: { [key]: next } }), signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        paint(cell, next === 'on');
        window.SeekDeepNotify?.toast?.({ tone: next === 'on' ? 'good' : 'info', title: key, body: (next === 'on' ? 'enabled' : 'disabled') + ' · click Restart to apply', ttl: 4000 });
        showRestartBar();
      } catch (e) {
        paint(cell, prev);
        window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Toggle failed', body: String((e && e.message) || e), ttl: 6000 });
      } finally {
        if (btn) btn.disabled = false;
      }
    }
    cells.forEach(cell => cell.querySelector('.ff-toggle')?.addEventListener('click', () => toggle(cell)));
    load();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireDocsFeatureToggles, { once: true });
  } else {
    wireDocsFeatureToggles();
  }
