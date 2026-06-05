  /* TSF / spellcheck warm-up — fires ONCE here on the loading page so
     Webview2 cold-starts its Windows text-input subsystem before the user
     ever reaches an interactive page. sessionStorage prevents the warm-up
     from re-firing on every subsequent navigation (which is what
     produced the "delay + flash when opening the chat tab" symptom: the
     warm-up was effectively running again on chat.html). */
  (function warmTextInputDuringLoad() {
    try {
      if (sessionStorage.getItem('__sdTextWarmed') === '1') return;
      const t = document.createElement('textarea');
      t.setAttribute('aria-hidden', 'true');
      t.setAttribute('tabindex', '-1');
      t.setAttribute('spellcheck', 'true');
      t.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.001;pointer-events:none;z-index:-1;background:transparent;color:transparent;border:none;outline:none;';
      document.body.appendChild(t);
      t.focus();
      t.value = 'a';
      try { t.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'a', inputType: 'insertText' })); } catch {}
      try { t.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true })); } catch {}
      try { t.dispatchEvent(new KeyboardEvent('keyup',   { key: 'a', code: 'KeyA', bubbles: true })); } catch {}
      t.value = '';
      t.blur();
      t.remove();
      try { sessionStorage.setItem('__sdTextWarmed', '1'); } catch {}
    } catch {}
  })();

  /* Boot poller — runs entirely standalone (no nav.js / events.js needed).
     Drives the phase ladder + status line + progress bar based on which
     endpoints the local server can answer.

     Once all four phases are green, redirects to chat.html (or whatever
     ?next= param is set). */
  (function () {
    // Tauri 2 on Windows serves the bundled splash from http://tauri.localhost.
    // location.origin would be that — pointing /health probes at the WebView
    // itself instead of the local AI server. Force 127.0.0.1:7865 in Tauri
    // context. The loading overlay runs BEFORE nav.js so we can't rely on
    // window.SeekDeepResolveBase here; inline the detection.
    const BASE = (function () {
      if (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') {
        return 'http://127.0.0.1:7865';
      }
      return (location.protocol === 'http:' || location.protocol === 'https:')
        ? location.origin : 'http://127.0.0.1:7865';
    })();
    const params = new URLSearchParams(location.search);
    const NEXT = params.get('next') || 'chat.html';

    const $status  = document.getElementById('splashStatus');
    const $label   = document.getElementById('splashLabel');
    const $stage   = document.getElementById('splashStage');
    const $bar     = document.getElementById('splashBar');
    const phases   = ['server', 'deps', 'models', 'ws'];
    const state    = { server: false, deps: false, models: false, ws: false };
    let failures = 0;

    function phaseEl(name) { return document.querySelector(`.splash-phase[data-phase="${name}"]`); }
    function setActive(name) {
      phases.forEach(p => phaseEl(p).classList.toggle('active', p === name));
    }
    function setDone(name) {
      const el = phaseEl(name);
      el.classList.remove('active');
      el.classList.add('done');
      el.querySelector('.mark').textContent = '✓';
      state[name] = true;
    }
    function pct() {
      const done = phases.filter(p => state[p]).length;
      return Math.round((done / phases.length) * 100);
    }
    function refreshBar() {
      $bar.classList.add('determinate');
      $bar.style.setProperty('--pct', pct() + '%');
    }
    function setStage(text) { $stage.textContent = text; }

    async function check(path, opts) {
      try {
        const r = await fetch(BASE + path, {
          signal: AbortSignal.timeout((opts && opts.timeoutMs) || 2500),
          cache: 'no-store',
        });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    }

    async function pollServer() {
      setActive('server');
      setStage('starting local AI server…');
      const h = await check('/health');
      if (!h) return false;
      setDone('server'); refreshBar();
      return h;
    }
    async function pollDeps() {
      setActive('deps');
      setStage('checking Python packages…');
      const d = await check('/ml_deps');
      // Treat "endpoint missing" or "no required missing" as success.
      const ok = !d || !(d.missing || []).filter(m => !m.optional).length;
      if (ok) setDone('deps'); refreshBar();
      return ok;
    }
    async function pollModels() {
      setActive('models');
      setStage('listing installed models…');
      const m = await check('/models/installed');
      // First-boot users will have zero installed; let model-install.js
      // surface the picker once we hand off to chat.html.
      setDone('models'); refreshBar();
      return m;
    }
    async function pollBus() {
      setActive('ws');
      setStage('opening event bus…');
      // Don't actually open the WS here (we'd just close it immediately on
      // redirect); a /health.ws probe is enough.
      const h = await check('/health');
      const ready = h && (h.events_ws_open === true || h.events_ws !== false);
      setDone('ws'); refreshBar();
      return ready;
    }

    // Patience tuning: Python 3.14 + cold uvicorn + fastapi imports can take
    // 15-30s on first launch. We poll forever; the FAILURE_THRESHOLD just
    // controls when we show the visual "waiting" state. The moment /health
    // returns 200 we redirect — NO dependency on /ml_deps / /models/installed
    // / WS probes, because any of those hanging would block us indefinitely
    // even when the server is clearly responding (real user case: 15 200 OK
    // /health responses in the log while the page sat on BOOTING forever
    // because something downstream caught the chain).
    const FAILURE_THRESHOLD = 20;
    const POLL_INTERVAL_MS  = 1500;
    let offlineShown = false;

    async function attemptBoot() {
      // No re-entrance guard: Retry / Install Python deps handlers call
      // run() to kick a fresh probe loop, and any old loop becomes
      // garbage when location.href fires. Parallel loops racing to a
      // successful navigate is fine — first to win, others get GC'd.
      setActive('server');
      setStage('starting local AI server…');

      while (true) {
        let h = null;
        try {
          const r = await fetch(BASE + '/health', {
            signal: AbortSignal.timeout(2500),
            cache: 'no-store',
          });
          if (r.ok) {
            try { h = await r.json(); }
            catch (jsonErr) {
              // 200 but body isn't JSON — server is alive, that's enough.
              console.warn('[seekdeep-loading] /health body not JSON', jsonErr);
              h = { ok: true, version: null };
            }
          }
        } catch (err) {
          console.warn('[seekdeep-loading] /health probe failed:', err);
        }

        if (h) {
          // First success: clear error UI, tick all phases visually for
          // continuity, mirror the version, then redirect. The phase ticks
          // are pure visual flourish — no probes — so they can't hang.
          if (offlineShown) {
            $status.classList.remove('is-error');
            $label.textContent = 'BOOTING';
            offlineShown = false;
          }
          if (h.version) {
            document.querySelectorAll('[data-version]').forEach(el => {
              el.textContent = String(h.version);
            });
          }
          setDone('server'); refreshBar();
          setActive('deps');  setDone('deps');  refreshBar();
          setActive('models');setDone('models');refreshBar();
          setActive('ws');    setDone('ws');    refreshBar();
          $status.classList.add('is-ready');
          $label.textContent = 'READY';
          // Probe firstrun. If anything is missing AND the user hasn't
          // explicitly dismissed the wizard this session, route to the
          // setup wizard instead of straight into chat.html — that's
          // the zero-terminal flow. The wizard's "Open SeekDeep" button
          // sets the same flag so a second probe doesn't loop.
          let nextHref = NEXT;
          const wizardDismissed = sessionStorage.getItem('seekdeep:firstrun:wizard-completed') === '1' ||
                                  sessionStorage.getItem('seekdeep:firstrun:wizard-skipped') === '1';
          if (!wizardDismissed && new URLSearchParams(location.search).get('next') == null) {
            try {
              const fr = await fetch(BASE + '/system/firstrun', {
                signal: AbortSignal.timeout(3000), cache: 'no-store',
              });
              if (fr.ok) {
                const fd = await fr.json();
                const failing = (fd.checks || []).filter(c => !c.ok);
                if (failing.length) nextHref = 'setup-wizard.html';
              }
            } catch { /* if firstrun probe fails, fall through to NEXT */ }
          }
          setStage('opening ' + nextHref + '…');
          setTimeout(() => { location.href = nextHref; }, 300);
          return;
        }

        // Probe failed. Bump counter, show OFFLINE after threshold, retry.
        failures++;
        if (failures >= FAILURE_THRESHOLD && !offlineShown) {
          $status.classList.add('is-error');
          $label.textContent = 'WAITING';
          setStage('still waiting for ' + BASE + '/health … (will keep trying)');
          offlineShown = true;
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }

    // Keep the legacy `run()` name so the existing Retry / install-deps
    // handlers below still work without touching them.
    const run = attemptBoot;

    document.getElementById('splashRetry').addEventListener('click', async () => {
      failures = 0;
      $status.classList.remove('is-error');
      $label.textContent = 'BOOTING';
      phases.forEach(p => {
        const el = phaseEl(p);
        el.classList.remove('done', 'active');
        el.querySelector('.mark').textContent = '·';
        state[p] = false;
      });
      $bar.classList.remove('determinate');
      // Ask the Rust shell to re-run the boot sequence (probe :7865 + find
      // python + spawn server). No-op in plain-browser contexts where Tauri
      // isn't available — the poller's own retry below still runs.
      const tauri = window.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
        try { await tauri.core.invoke('retry_spawn'); } catch (_) {}
      }
      run();
    });

    // ===== Tauri command wiring =============================================
    // The three Tauri commands surfaced via buttons:
    //   install_python_deps   — runs `python -m pip install --user -r
    //                            requirements-local.txt` inside the Rust
    //                            shell. No terminal, no setup_local.ps1.
    //   open_external         — opens an URL in the system browser via
    //                            tauri-plugin-opener. Used for python.org.
    //   retry_spawn           — re-runs the Rust shell's boot_sequence
    //                            (probe :7865, find python, spawn server).
    //                            Bound to Retry above.
    // sidecar:status event listener: the Rust shell emits one-word reason
    // codes (PYTHON_NOT_FOUND / DEPS_MISSING / EXTRACT_FAILED / SPAWN_FAILED
    // / EXTERNAL_SERVER_RUNNING / SPAWNING / RESTARTING) so the user
    // understands WHY the server is stuck.
    const tauri = (typeof window !== 'undefined' && window.__TAURI__) || null;

    function setStatusLabel(label, kind) {
      $status.classList.remove('is-error', 'is-ready');
      if (kind === 'error') $status.classList.add('is-error');
      if (kind === 'ready') $status.classList.add('is-ready');
      $label.textContent = label;
    }

    document.getElementById('splashInstallDeps').addEventListener('click', async () => {
      if (!tauri) {
        setStage('Tauri shell required — open from the SeekDeep app.');
        return;
      }
      setStatusLabel('INSTALLING', null);
      setStage('pip install -r requirements-local.txt … (~30s)');
      try {
        await tauri.core.invoke('install_python_deps');
        setStage('deps installed · retrying boot…');
        try { await tauri.core.invoke('retry_spawn'); } catch (_) {}
        // Reset failure counter and re-enter the polling loop so the
        // 4-phase ladder ticks through again with the freshly-bound server.
        failures = 0;
        $status.classList.remove('is-error');
        $label.textContent = 'BOOTING';
        phases.forEach(p => {
          const el = phaseEl(p);
          el.classList.remove('done', 'active');
          el.querySelector('.mark').textContent = '·';
          state[p] = false;
        });
        $bar.classList.remove('determinate');
        run();
      } catch (err) {
        setStatusLabel('PIP FAILED', 'error');
        // Show full pip stdout/stderr in a scrollable region instead of
        // truncating to 80 chars. The error string from Rust is the
        // combined stdout + stderr with a leading invoked-command line.
        setStage('pip exit ≠ 0 — full log below + saved to logs/pip.log');
        let pre = document.getElementById('pipFullLog');
        if (!pre) {
          pre = document.createElement('pre');
          pre.id = 'pipFullLog';
          pre.style.cssText = 'margin: 14px auto 0; max-width: 540px; max-height: 280px; overflow:auto; background: rgba(0,0,0,0.45); border: 1px solid color-mix(in oklab, var(--bad) 35%, transparent); border-radius: var(--r-md); padding: 12px; text-align: left; font-family: var(--font-mono); font-size: 10.5px; color: var(--hull-2); white-space: pre-wrap; word-break: break-all; line-height: 1.5;';
          // Insert above the phase ladder
          const phases = document.getElementById('splashPhases');
          if (phases && phases.parentNode) phases.parentNode.insertBefore(pre, phases);
          else document.querySelector('.splash').appendChild(pre);
        }
        pre.textContent = String(err);
      }
    });

    document.getElementById('splashGetPython').addEventListener('click', async () => {
      const url = 'https://www.python.org/downloads/';
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
        try { await tauri.core.invoke('open_external', { url }); return; }
        catch (_) { /* fall through */ }
      }
      window.open(url, '_blank');
    });

    document.getElementById('splashViewLogs').addEventListener('click', async () => {
      if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
        setStage('View log requires the Tauri shell — log lives at %APPDATA%\\SeekDeep\\logs\\');
        return;
      }
      try { await tauri.core.invoke('view_logs'); }
      catch (err) { setStage('view_logs failed: ' + String(err).slice(0, 100)); }
    });

    // Listen for Rust-side status pushes so the reason code reflects
    // what's actually happening even before /health responds.
    const REASON_LABELS = {
      EXTERNAL_SERVER_RUNNING: 'external server detected',
      EXTRACT_FAILED:          'failed to extract bundled resources',
      RUNTIME_DIR_UNAVAILABLE: 'app data dir unavailable',
      PYTHON_NOT_FOUND:        'Python 3.11+ not found on PATH',
      DEPS_MISSING:            'boot deps not installed yet',
      SPAWNING:                'spawning local_ai_server.py',
      SPAWN_FAILED:            'spawn failed (see logs)',
      RESTARTING:              'restarting AI server',
    };
    if (tauri && tauri.event && typeof tauri.event.listen === 'function') {
      tauri.event.listen('sidecar:status', (ev) => {
        const code = ev && ev.payload && ev.payload.code;
        if (!code) return;
        const codeEl = document.getElementById('reasonCode');
        if (codeEl) codeEl.textContent = code + (REASON_LABELS[code] ? ' · ' + REASON_LABELS[code] : '');
        if (code === 'PYTHON_NOT_FOUND' || code === 'DEPS_MISSING' || code === 'SPAWN_FAILED' || code === 'EXTRACT_FAILED') {
          // Surface the failure state immediately rather than waiting for
          // 3× failed /health probes. The user has actionable buttons.
          $status.classList.add('is-error');
          $label.textContent = code === 'PYTHON_NOT_FOUND' ? 'PYTHON MISSING' : (code === 'DEPS_MISSING' ? 'DEPS MISSING' : 'OFFLINE');
        }
      });
    }

    run();
  })();

/* Splash-mark image fallback — replaces the inline `onerror=` (CSP). This
   deferred script may run AFTER the webp has already failed, so handle the
   already-errored state as well as a future error event. */
(function () {
  var img = document.querySelector('img.splash-mark');
  if (!img) return;
  function fallback() { img.src = 'assets/seekdeep-mark.png'; }
  if (img.complete && img.naturalWidth === 0) fallback();
  else img.addEventListener('error', fallback, { once: true });
})();
