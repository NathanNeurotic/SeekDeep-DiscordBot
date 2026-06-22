/* SeekDeep · ml-deps.js
   ====================
   First-use ML dependency downloader. Auto-loaded by nav.js's autoLoadSiblings
   AFTER notify.js (whose SeekDeepNotify banner / modal primitive this file
   consumes for the visible UX).

   Flow:
     1. On load, probe GET /ml_deps. If available=true, do nothing.
     2. If available=false, show a notify.banner (warn tone) naming the
        missing modules. Primary action opens the install modal.
     3. Modal POSTs /deps/install — pip runs in a background thread on
        the server; deps.install.* events stream to the modal via the
        existing SeekDeepEvents WebSocket bus.
     4. On deps.install.complete, if running inside Tauri shell, call
        the restart_sidecar command (torch can't be hot-loaded into a
        running Python process) and reload the page once /health is
        back. Outside Tauri, leave the manual-restart hint visible.

   Self-gates against double-loads via window.__seekdeepMlDepsLoaded.
*/
(function () {
  'use strict';
  if (window.__seekdeepMlDepsLoaded) return;
  window.__seekdeepMlDepsLoaded = true;

  const BASE = (function () {
    // Tauri 2 on Windows serves bundled pages from http://tauri.localhost.
    // Force 127.0.0.1:7865 when running inside Tauri; nav.js stashes a
    // shared resolver we prefer if available.
    if (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') {
      return window.SeekDeepResolveBase();
    }
    if (typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')) {
      return 'http://127.0.0.1:7865';
    }
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  })();

  // SeekDeepNotify is the shared banner/modal primitive (designer zip 43,
  // gui/notify.js). nav.js loads it before us via the autoLoadSiblings
  // globalKey gate; we still test for it so we degrade gracefully if a page
  // pulls this file standalone.
  function notify() { return window.SeekDeepNotify || null; }

  // --- Banner --------------------------------------------------------------

  const BANNER_ID = 'sd-ml-deps-banner';

  // Persistent dismiss — survives reload. Keyed by the missing-set hash so
  // dismissing "torch, diffusers" doesn't suppress a future "transformers"
  // banner. localStorage lives as long as the WebView's profile dir.
  const DISMISS_KEY = 'sd-ml-deps-dismiss';
  function missingHash(missing) {
    return [...missing].sort().join('|');
  }
  function isDismissed(missing) {
    try { return localStorage.getItem(DISMISS_KEY) === missingHash(missing); }
    catch { return false; }
  }
  function markDismissed(missing) {
    try { localStorage.setItem(DISMISS_KEY, missingHash(missing)); } catch {}
  }

  function showBanner(missing) {
    if (isDismissed(missing)) return; // user said "stop nagging me about these"
    const sdn = notify();
    if (!sdn) {
      console.warn('[SeekDeep ml-deps] notify.js not loaded; missing:', missing);
      return;
    }
    sdn.banner({
      id: BANNER_ID,
      tone: 'warn',
      title: 'ML libraries not installed',
      body: 'Local /chat, /image, and /vision will return errors until installed. Missing: <code>' + missing.map((m) => String(m).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))).join(', ') + '</code>',
      html: true,
      primary: { label: 'Install (~2 GB)', onClick: ({ close }) => { openInstallModal(); /* leave banner up until install completes */ } },
      secondary: { label: 'Dismiss', onClick: ({ close }) => { markDismissed(missing); close(); } },
      dismissible: false,
      sticky: true,
    });
  }

  function clearBanner() {
    const sdn = notify();
    if (sdn) sdn.dismiss(BANNER_ID);
  }

  // --- Install modal -------------------------------------------------------
  //
  // Built via notify.modal({ render }) — the render callback gets a body
  // <div> to populate. We hold refs to the status + log nodes so the WS
  // event subscriptions below can update them in place.

  let modalRefs = null; // { statusEl, logEl, closeFn }
  let modalBusy = false;

  function appendLogLine(line) {
    if (!modalRefs || !modalRefs.logEl) return;
    modalRefs.logEl.textContent += line + '\n';
    modalRefs.logEl.scrollTop = modalRefs.logEl.scrollHeight;
  }

  function openInstallModal() {
    if (modalBusy) return;
    const sdn = notify();
    if (!sdn) {
      // Without notify.js we can still fire the install. Pip runs server-
      // side and the user sees the result via the normal /ml_deps probe.
      triggerInstall();
      return;
    }
    modalBusy = true;
    sdn.modal({
      tone: 'info',
      label: '◐ INSTALL ML LIBRARIES',
      title: 'Installing ML libraries',
      dismissible: true,
      render: (bodyEl) => {
        const status = document.createElement('div');
        status.style.cssText = 'font-family: var(--font-mono, monospace); font-size: 11px; color: var(--cyan-1, #2dd4ff); letter-spacing: 0.08em; margin-bottom: 12px;';
        status.textContent = 'Starting…';

        const log = document.createElement('pre');
        log.style.cssText = 'flex:1; overflow:auto; background: rgba(2,6,15,0.9); border:1px solid rgba(45,212,255,0.18); border-radius:6px; padding:12px; font-family: var(--font-mono, monospace); font-size:11px; color: var(--hull-2, #b6c4d4); line-height:1.5; margin:0; white-space:pre-wrap; max-height:50vh; min-height:180px;';

        bodyEl.style.display = 'flex';
        bodyEl.style.flexDirection = 'column';
        bodyEl.appendChild(status);
        bodyEl.appendChild(log);

        modalRefs = { statusEl: status, logEl: log };
      },
      primary: { label: 'Close', onClick: () => { /* falls through to close */ } },
    }).then(() => {
      modalRefs = null;
      modalBusy = false;
    });

    // Hook up subscriptions + fire the install — the modal stays open while
    // pip runs in the background.
    triggerInstall();
  }

  // --- WS subscriptions + install kick-off --------------------------------

  let busWired = false;

  function ensureSubscriptions() {
    if (busWired) return;
    const bus = window.SeekDeepEvents;
    if (!bus) return;
    busWired = true;

    bus.on('deps.install.started', (data) => {
      if (modalRefs && modalRefs.statusEl) {
        modalRefs.statusEl.textContent = 'PIP INSTALL STARTED · ' + (data.requirements_file || 'requirements-ml.txt');
      }
    });
    bus.on('deps.install.line', (data) => {
      appendLogLine(data.line || '');
    });
    bus.on('deps.install.complete', async (data) => {
      if (modalRefs && modalRefs.statusEl) {
        modalRefs.statusEl.textContent = '✓ INSTALL COMPLETE · restarting the AI server';
        modalRefs.statusEl.style.color = 'var(--good, #58e6a1)';
      }
      appendLogLine('');
      appendLogLine('--- Install finished. Restarting AI server to load torch/transformers/diffusers ---');

      // If we're inside the Tauri shell, ask Rust to kill + respawn the
      // Python sidecar so the new libraries take effect. Without Tauri
      // (pure browser), the user has to restart manually.
      const tauri = window.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
        try {
          await tauri.core.invoke('restart_sidecar');
          appendLogLine('--- Server restart requested. Reloading the page in ~5 seconds. ---');
          // Clear the banner now — the next /ml_deps probe should report
          // available:true and we want the banner gone before reload.
          clearBanner();
          setTimeout(() => { location.reload(); }, 5000);
        } catch (err) {
          appendLogLine('--- Restart request failed: ' + err + ' ---');
          appendLogLine('--- Close + reopen SeekDeep manually to finish loading the libraries. ---');
        }
      } else {
        appendLogLine('--- (No Tauri shell detected — restart the AI server manually.) ---');
      }
    });
    bus.on('deps.install.failed', (data) => {
      if (modalRefs && modalRefs.statusEl) {
        modalRefs.statusEl.textContent = '⚠ INSTALL FAILED · exit code ' + (data.exit_code != null ? data.exit_code : '?');
        modalRefs.statusEl.style.color = 'var(--bad, #ff6b6b)';
      }
      appendLogLine('');
      appendLogLine('--- Install failed. See output above. ---');
      if (data.error) appendLogLine('Error: ' + data.error);
    });
  }

  async function triggerInstall() {
    ensureSubscriptions();

    // Prefer the Tauri install_ml_deps command when available — it kills
    // the sidecar before running pip so torch/transformers/diffusers can
    // be overwritten without WinError 32 (Windows file-locks .pyd files
    // that the running Python process has imported). The plain
    // POST /deps/install path stays as a fallback for plain-browser usage
    // (no Tauri shell) and for in-place upgrade attempts.
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      if (modalRefs && modalRefs.statusEl) {
        modalRefs.statusEl.textContent = 'STOPPING SERVER · then installing torch/transformers/diffusers';
      }
      appendLogLine('Stopping local AI server so pip can overwrite torch/diffusers without WinError 32 …');
      // Subscribe to ml-install:line events that the Rust side now
      // emits per pip stdout line. Previous version awaited the
      // entire install_ml_deps invoke for 5-10 minutes with no
      // intermediate UI updates — the modal looked frozen and Windows
      // painted "Not Responding" on the title bar. Now each line
      // arrives within ~50ms of pip writing it.
      let bytesShown = 0;
      let unlistenLine = null, unlistenDone = null;
      if (tauri.event && typeof tauri.event.listen === 'function') {
        try {
          unlistenLine = await tauri.event.listen('ml-install:line', (e) => {
            const payload = (e && e.payload) || {};
            const line = String(payload.line || '');
            if (line) {
              appendLogLine(line);
              bytesShown += line.length;
              if (modalRefs && modalRefs.statusEl && /^(Downloading|Collecting|Installing|Successfully)/i.test(line)) {
                // Surface the most recent meaningful phase in the
                // status header so the user has a quick read-at-a-glance.
                modalRefs.statusEl.textContent = line.slice(0, 120);
              }
            }
          });
          unlistenDone = await tauri.event.listen('ml-install:done', (e) => {
            const payload = (e && e.payload) || {};
            if (modalRefs && modalRefs.statusEl) {
              if (payload.ok) {
                modalRefs.statusEl.textContent = '✓ pip finished · respawning sidecar';
                modalRefs.statusEl.style.color = 'var(--good, #58e6a1)';
              } else {
                modalRefs.statusEl.textContent = '⚠ pip exited with code ' + payload.exit_code;
                modalRefs.statusEl.style.color = 'var(--bad, #ff6b6b)';
              }
            }
          });
        } catch (_) { /* event API mismatch — fall back to silent invoke */ }
      }
      try {
        await tauri.core.invoke('install_ml_deps');
        if (modalRefs && modalRefs.statusEl) {
          modalRefs.statusEl.textContent = '✓ INSTALL COMPLETE · restarting AI server';
          modalRefs.statusEl.style.color = 'var(--good, #58e6a1)';
        }
        appendLogLine('--- Reloading page in ~5 seconds. ---');
        clearBanner();
        setTimeout(() => { location.reload(); }, 5000);
      } catch (err) {
        appendLogLine('--- pip install failed ---');
        appendLogLine(String(err));
        if (modalRefs && modalRefs.statusEl) {
          modalRefs.statusEl.textContent = '⚠ INSTALL FAILED · see log above; server restarted regardless';
          modalRefs.statusEl.style.color = 'var(--bad, #ff6b6b)';
        }
      } finally {
        try { if (typeof unlistenLine === 'function') unlistenLine(); } catch {}
        try { if (typeof unlistenDone === 'function') unlistenDone(); } catch {}
      }
      return;
    }

    // Pure-browser fallback: use the existing server-side /deps/install
    // endpoint with WebSocket progress events. Will hit WinError 32 if
    // any of the heavy deps are already imported by the live server, but
    // there's nothing we can do about that without Tauri's process control.
    if (!window.SeekDeepEvents) {
      setTimeout(() => {
        ensureSubscriptions();
        if (!window.SeekDeepEvents && modalRefs && modalRefs.statusEl) {
          modalRefs.statusEl.textContent = '⚠ Event bus unavailable — install progress won\'t stream. The install is still running server-side.';
        }
      }, 750);
    }

    try {
      const r = await fetch(BASE + '/deps/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirements_file: 'requirements-ml.txt' }),
      });
      if (!r.ok) {
        const text = await r.text();
        appendLogLine('POST /deps/install -> ' + r.status);
        appendLogLine(text);
        if (modalRefs && modalRefs.statusEl) {
          modalRefs.statusEl.textContent = '⚠ FAILED TO START · ' + r.status;
          modalRefs.statusEl.style.color = 'var(--bad, #ff6b6b)';
        }
        return;
      }
      const data = await r.json();
      appendLogLine('POST /deps/install OK');
      appendLogLine('  requirements_file: ' + (data.requirements_file || '?'));
      appendLogLine('  ' + (data.note || ''));
    } catch (err) {
      appendLogLine('POST /deps/install error: ' + err);
      if (modalRefs && modalRefs.statusEl) {
        modalRefs.statusEl.textContent = '⚠ NETWORK ERROR';
        modalRefs.statusEl.style.color = 'var(--bad, #ff6b6b)';
      }
    }
  }

  // --- Boot probe ----------------------------------------------------------

  async function probe() {
    try {
      const r = await fetch(BASE + '/ml_deps', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!r.ok) return;
      const data = await r.json();
      if (data.available === false && Array.isArray(data.missing) && data.missing.length > 0) {
        showBanner(data.missing);
      } else {
        // Available — clear any lingering banner (e.g. left over from a
        // previous failed state that fixed itself).
        clearBanner();
      }
    } catch {
      // /ml_deps unreachable — server probably not up yet. The
      // seekdeep-loading page handles that case; we stay silent here.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', probe, { once: true });
  } else {
    probe();
  }
})();
