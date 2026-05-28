/* SeekDeep · fix-action.js
   ========================
   Shared helper for "click a FIX button → POST an endpoint → watch for the
   terminal event → settle". Consolidates the retry / watch_events / hint /
   timeout pattern that used to live duplicated in app.html (Control Center
   first-run banner), setup-wizard.html (full-screen wizard), and ml-deps.js
   (notify-modal install). Each duplicate had its own subtle bugs — the
   Control Center variant checked SeekDeepEvents?.subscribe (which doesn't
   exist; the real API is .on), so its watch_events branch was dead code
   and the button flashed DONE on the synchronous POST response. One source
   of truth fixes that class of bug for every consumer.

   API:
     await SeekDeepFixAction.run({
       endpoint:      '/deps/install',        // required
       method:        'POST',                 // default POST
       body:          { ... },                // optional JSON body
       watchEvents:   ['deps.install.complete', 'deps.install.failed'],
       longRunning:   true,                   // 600s vs 60s fetch timeout
       eventTimeoutMs: 15 * 60 * 1000,       // default: 15 min
       onLine:        (data) => { ... },     // optional progress callback
                                              // (data from <prefix>.line events)
     })
     // → { ok, payload, error?, hint?, terminal_event?, settled_via }

   `ok` is true iff the action POST succeeded AND no watched-failure event fired.
   On failure, `error` + `hint` carry the human-readable cause. `payload` is the
   final terminal event's data (when watchEvents were given), or the initial
   POST response (when watchEvents was empty).

   `settled_via` distinguishes between resolution paths so callers can adapt UI:
     - 'sync-post'    : no watch_events, POST returned terminal result directly
     - 'watch-event'  : a watched event fired (success or failure)
     - 'event-timeout': watchEvents given but no terminal event in eventTimeoutMs
     - 'post-error'   : POST itself errored / 4xx/5xx response
*/
(function () {
  'use strict';
  if (window.SeekDeepFixAction) return; // idempotent

  // Base URL resolver — mirrors what other GUI scripts use. Tauri serves
  // pages from tauri.localhost so location.origin is wrong there; nav.js
  // exposes SeekDeepResolveBase() as the canonical resolver.
  function resolveBase() {
    if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  }

  // Extract the most user-friendly error description from a terminal failure
  // event's data payload. Backend's post_deps_install + post_reinstall_torch
  // both attach .hint (classified) + .error + .exit_code + .detail (pip tail).
  function describeFailure(data) {
    if (!data) return { error: 'event reported failure', hint: '' };
    const hint = (data.hint || '').toString();
    let error = (data.error || data.note || '').toString();
    if (!error && data.exit_code != null) error = `exit ${data.exit_code}`;
    if (!error) error = 'event reported failure';
    return { error, hint };
  }

  async function run(opts) {
    opts = opts || {};
    const endpoint = opts.endpoint;
    if (!endpoint) throw new Error('SeekDeepFixAction.run: endpoint is required');
    const method = (opts.method || 'POST').toUpperCase();
    const body = opts.body;
    const watchEvents = Array.isArray(opts.watchEvents) ? opts.watchEvents.slice() : [];
    const longRunning = !!opts.longRunning;
    const eventTimeoutMs = Number.isFinite(opts.eventTimeoutMs) ? opts.eventTimeoutMs : 15 * 60 * 1000;
    const onLine = typeof opts.onLine === 'function' ? opts.onLine : null;

    const base = resolveBase();
    const init = { method, headers: { 'Content-Type': 'application/json' } };
    if (body != null) init.body = JSON.stringify(body);
    // Fetch timeout: short for non-long-running, generous for the 2 GB pip
    // installs. Independent of the watch_events timeout below — the POST
    // returns immediately ("install started"), the actual work runs async.
    init.signal = AbortSignal.timeout(longRunning ? 600_000 : 60_000);

    // --- POST ---
    let postOk = false, postPayload = null, postErr = null, httpStatus = null;
    try {
      const r = await fetch(base + endpoint, init);
      httpStatus = r.status;
      postPayload = await r.json().catch(() => ({}));
      postOk = r.ok && (postPayload?.ok !== false);
      if (!postOk) {
        postErr = postPayload?.error || postPayload?.detail || ('HTTP ' + r.status);
      }
    } catch (err) {
      postErr = String(err?.message || err);
    }

    if (!postOk) {
      return {
        ok: false,
        payload: postPayload,
        error: postErr,
        hint: postPayload?.hint || '',
        terminal_event: null,
        settled_via: 'post-error',
        http_status: httpStatus,
      };
    }

    // --- No watch events → sync result is terminal ---
    if (!watchEvents.length || !window.SeekDeepEvents?.on) {
      return {
        ok: true,
        payload: postPayload,
        error: null,
        hint: '',
        terminal_event: null,
        settled_via: 'sync-post',
        http_status: httpStatus,
      };
    }

    // --- Wait for a watched terminal event ---
    // Subscribe to each watch_events type AND its sibling .line type (if any)
    // so progress callbacks work. The first matching .complete / .failed / .error
    // wins the race.
    return new Promise((resolve) => {
      let settled = false;
      const unsubs = [];
      const cleanup = () => { unsubs.forEach(u => { try { u && u(); } catch {} }); };

      const settle = (evType, data, ok) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (ok) {
          resolve({
            ok: true, payload: data || postPayload,
            error: null, hint: '',
            terminal_event: evType, settled_via: 'watch-event',
            http_status: httpStatus,
          });
        } else {
          const { error, hint } = describeFailure(data);
          resolve({
            ok: false, payload: data || postPayload,
            error, hint,
            terminal_event: evType, settled_via: 'watch-event',
            http_status: httpStatus,
          });
        }
      };

      for (const evType of watchEvents) {
        const isFailureEvent = /\.(failed|error)$/.test(evType);
        unsubs.push(window.SeekDeepEvents.on(evType, (data) => settle(evType, data, !isFailureEvent)));
        // Subscribe to the sibling .line type so onLine callbacks fire during
        // long-running pip installs etc. We don't enumerate this — we infer it
        // by stripping the trailing .complete/.failed/.error.
        if (onLine) {
          const prefix = evType.replace(/\.(complete|failed|error)$/, '');
          if (prefix && prefix !== evType) {
            const lineEvType = prefix + '.line';
            unsubs.push(window.SeekDeepEvents.on(lineEvType, (data) => {
              if (!settled) onLine(data);
            }));
          }
        }
      }

      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          ok: false, payload: postPayload,
          error: `timed out after ${Math.round(eventTimeoutMs / 60000)} min — no terminal event arrived`,
          hint: 'check the Logs viewer (or `logs/` directory) for the full pip output',
          terminal_event: null, settled_via: 'event-timeout',
          http_status: httpStatus,
        });
      }, eventTimeoutMs);
    });
  }

  window.SeekDeepFixAction = { run };
})();
