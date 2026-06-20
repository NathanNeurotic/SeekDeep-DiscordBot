/* SeekDeep · upscale.page.js
   Live wiring for gui/upscale.html — the Real-ESRGAN upscaler setup page.
   Self-service: check deps + cached weights → one-click download a curated
   weight → activate live + persist the feature flag to .env. Upscale falls back
   to Lanczos until a model is present, so it always works.
   Talks to the Python AI server:
     • GET  /upscale/realesrgan/status   → flag + deps + cached weights + ready/reason (open)
     • POST /upscale/realesrgan/download → fetch a weight + flip the flag live
     • POST /config                      → persist SEEKDEEP_FEATURE_UPSCALE_REALESRGAN=on
   nav.js attaches X-SeekDeep-Token to same-origin POSTs, so we never set it here.
   External + addEventListener-only (CSP-clean). Self-gates: no-op unless #esrganGrid is present. */
(function () {
  'use strict';
  if (!document.getElementById('esrganGrid')) return;
  if (window.__seekdeepUpscaleLoaded) return;
  window.__seekdeepUpscaleLoaded = true;

  const $ = (id) => document.getElementById(id);
  const sdn = () => window.SeekDeepNotify;

  // Tauri serves bundled pages from tauri.localhost, so server calls MUST target
  // the loopback API base — a relative fetch never reaches the Python server.
  // Use nav.js's shared resolver with the standard Tauri-aware fallback, exactly
  // like tts.js / api.page.js / app.page2.js.
  const BASE = (function () {
    try { if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase(); } catch (_) {}
    if (window.__TAURI__ || (window.location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    return (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
  })();

  async function getJSON(url) {
    const r = await fetch(BASE + url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
    let body = null; try { body = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error((body && (body.detail || body.error)) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return body || {};
  }
  async function postJSON(url, payload) {
    const r = await fetch(BASE + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    let body = null; try { body = await r.json(); } catch (_) {}
    if (!r.ok || (body && body.ok === false)) {
      const e = new Error((body && (body.error || body.detail)) || ('HTTP ' + r.status)); e.status = r.status; throw e;
    }
    return body || {};
  }

  function setStatus(state, label) {
    const el = $('esrganStatus');
    if (!el) return;
    el.dataset.state = state;
    el.textContent = '● Real-ESRGAN · ' + label;
  }

  let busy = false;

  function render(status) {
    const depBox = $('esrganDepsBox');
    if (depBox) depBox.style.display = status.deps_installed ? 'none' : 'flex';
    if ($('esrganDir')) $('esrganDir').textContent = status.weights_dir || '';

    if (status.ready) setStatus('ready', 'ready — upscale uses Real-ESRGAN');
    else if (!status.deps_installed) setStatus('bad', 'ML libraries not installed — using Lanczos');
    else if (!status.enabled || !(status.installed && status.installed.length)) setStatus('off', 'no model yet — using Lanczos');
    else setStatus('bad', (status.reason || 'not ready') + ' — using Lanczos');

    const grid = $('esrganGrid');
    grid.textContent = '';
    (status.catalog || []).forEach((c) => {
      const row = document.createElement('div');
      row.className = 'wt';
      const left = document.createElement('div');
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = c.label;
      const meta = document.createElement('div');
      meta.className = 'meta' + (c.downloaded ? ' got' : '');
      meta.textContent = '~' + (c.approx_mb || '?') + ' MB · native ' + (c.native_scale || '?') + '×' + (c.downloaded ? ' · downloaded' : '');
      left.appendChild(label);
      left.appendChild(meta);
      const btn = document.createElement('button');
      btn.className = c.downloaded ? 'btn' : 'btn btn-primary';
      btn.textContent = c.downloaded ? '✓ Downloaded' : '▼ Download';
      btn.disabled = !!c.downloaded;
      if (!c.downloaded) btn.addEventListener('click', () => download(c, btn));
      row.appendChild(left);
      row.appendChild(btn);
      grid.appendChild(row);
    });
  }

  async function refresh() {
    try {
      render(await getJSON('/upscale/realesrgan/status'));
    } catch (err) {
      setStatus('bad', 'status check failed: ' + (err.message || err));
      const grid = $('esrganGrid');
      if (grid) {
        grid.textContent = '';
        const d = document.createElement('div');
        d.className = 'how';
        d.textContent = 'Could not reach the AI server — is it running?';
        grid.appendChild(d);
      }
    }
  }

  async function download(c, btn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = '▼ Downloading… (~' + (c.approx_mb || 64) + ' MB)';
    setStatus('checking', 'downloading ' + c.label + '…');
    if (sdn()) sdn().toast({ tone: 'info', title: 'Downloading ' + c.label, body: '~' + (c.approx_mb || 64) + ' MB from Hugging Face — a few seconds.', ttl: 7000 });
    try {
      const res = await postJSON('/upscale/realesrgan/download', { key: c.key });
      // Server flipped the flag live; persist it so it survives a restart.
      try {
        await postJSON('/config', { updates: { SEEKDEEP_FEATURE_UPSCALE_REALESRGAN: 'on' } });
      } catch (_) {
        if (sdn()) sdn().toast({ tone: 'warn', title: 'Enabled, but not persisted', body: 'The model is active now, but writing the flag to .env failed — it may not survive a restart.', ttl: 9000 });
      }
      if (res.ready) {
        if (sdn()) sdn().toast({ tone: 'good', title: 'Real-ESRGAN ready', body: 'Upscale now uses Real-ESRGAN. Restart the bot to use it in Discord.', ttl: 9000 });
      } else {
        if (sdn()) sdn().toast({ tone: 'warn', title: 'Weight downloaded', body: (res.reason || 'Not ready yet') + ' — install the ML libraries, then it activates.', ttl: 9000 });
      }
    } catch (err) {
      if (sdn()) sdn().toast({ tone: 'bad', title: 'Download failed', body: String(err.message || err).slice(0, 200), ttl: 9000 });
    } finally {
      busy = false;
      await refresh();
    }
  }

  refresh();
})();
