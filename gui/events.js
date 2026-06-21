/* SeekDeep events.js
 * ===================
 * Lightweight WebSocket pub/sub for live server events.
 *
 * Auto-loaded by nav.js, so every page that includes <script src="nav.js" defer>
 * automatically gets `window.SeekDeepEvents`. Pages can also load this file
 * directly if they prefer to not include nav.js (the API is the same).
 *
 * API:
 *
 *   window.SeekDeepEvents.on(type, handler) -> unsubscribe()
 *     Subscribe to a server event topic. `handler(data, fullEvent)` is called
 *     for every matching event. Returns a function that removes the handler.
 *
 *   window.SeekDeepEvents.off(type, handler)
 *     Remove a specific handler.
 *
 *   window.SeekDeepEvents.connected
 *     Boolean. True when the underlying WebSocket is in OPEN state.
 *
 * Special pseudo-topics emitted locally:
 *   '_open'   - WS just connected (data: {})
 *   '_close'  - WS just disconnected (data: { code, reason })
 *   '_error'  - WS error (data: { message })
 *
 * Server-pushed topics defined so far:
 *   'hello'         - sent once on connect; data: { server_time_ms, subscribers }
 *   'heartbeat'     - every 10s while at least one subscriber is connected
 *   'model.loaded'  - data: { role, model, vram_mb }
 *   'model.evicted' - data: { role, reason, freed_mb }
 *   'vram.sample'   - data: { used_mb, total_mb, loaded }
 *   'queue.depth'   - data: { image, chat, vision }
 *   'request.start' - data: { id, kind, user_id? }
 *   'request.done'  - data: { id, ok, elapsed_ms }
 *   'log.line'      - data: { level, src, msg }
 *
 * The set is open: any server producer can publish any `type`, and any client
 * `on('type', ...)` will receive it. Treat the list above as a starting catalog.
 *
 * Connection lifecycle:
 *   - On load, fetches the auth token from window.SeekDeepAuth.get() (set up
 *     by nav.js's installTokenInterceptor) and opens the WS to /events?token=...
 *   - On disconnect, retries with exponential backoff capped at 30s.
 *   - On `_open`, retry interval resets to 1s.
 *
 * Auth: the WS endpoint requires the token in the query string because
 * browsers cannot set headers on the initial WebSocket handshake. Same token
 * value as the X-SeekDeep-Token header used by POST endpoints. */

(function () {
  'use strict';
  if (window.SeekDeepEvents) return;

  const handlers = new Map();      // type -> Set<handler>
  let ws = null;
  let reconnectMs = 1000;
  let reconnectTimer = null;
  let consecutiveFailures = 0;
  let manualClose = false;

  function emit(type, data, fullEvent) {
    const set = handlers.get(type);
    if (!set || !set.size) return;
    for (const h of Array.from(set)) {
      try { h(data, fullEvent); }
      catch (err) { console.warn('[SeekDeepEvents] handler error for', type, err); }
    }
  }

  function wsBase() {
    // Tauri 2 on Windows serves bundled pages from http://tauri.localhost.
    // location.origin would be that, not the local AI server — force
    // 127.0.0.1:7865 in Tauri context. Delegates to nav.js's resolver
    // when present so the detection lives in one place.
    let origin;
    if (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') {
      origin = window.SeekDeepResolveBase();
    } else if (typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')) {
      origin = 'http://127.0.0.1:7865';
    } else {
      origin = (location.protocol === 'http:' || location.protocol === 'https:')
        ? location.origin
        : 'http://127.0.0.1:7865';
    }
    return origin.replace(/^http/, 'ws');
  }

  async function getToken() {
    if (window.SeekDeepAuth && typeof window.SeekDeepAuth.get === 'function') {
      try { return await window.SeekDeepAuth.get(); }
      catch { return ''; }
    }
    return '';
  }

  // Safe mode (the FX toggle's deepest tier) pauses the live bus so the server's
  // tick loop idles. Read the global nav.js exposes, with a localStorage fallback
  // for the brief window before nav.js has run.
  function safeModeOn() {
    try {
      if (typeof window.SeekDeepSafeMode === 'function' && window.SeekDeepSafeMode()) return true;
      return localStorage.getItem('seekdeep.safeMode') === '1';
    } catch (_) { return false; }
  }

  async function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (safeModeOn()) { emit('_paused', { reason: 'safe-mode' }); return; }  // don't open the bus in Safe mode
    manualClose = false;
    // On every reconnect, FORCE-REFRESH the token. The previous one may be
    // stale (server restart rotated it, or token expired in some future
    // version). nav.js's SeekDeepAuth.reset() clears its cache so the
    // next get() re-fetches /token. Without this we'd happily reconnect
    // with a dead token and get rejected forever.
    try { window.SeekDeepAuth?.reset?.(); } catch {}
    const tok = await getToken();
    const url = wsBase() + '/events' + (tok ? ('?token=' + encodeURIComponent(tok)) : '');
    try {
      ws = new WebSocket(url);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      reconnectMs = 250;
      consecutiveFailures = 0;
      emit('_open', {});
    };
    ws.onmessage = (e) => {
      let payload;
      try { payload = JSON.parse(e.data); }
      catch { return; }
      if (!payload || typeof payload.type !== 'string') return;
      emit(payload.type, payload.data || {}, payload);
    };
    ws.onclose = (e) => {
      emit('_close', { code: e.code, reason: e.reason });
      // Immediately emit _probing so the sd-live-pill shows PROBING
      // (yellow) during the reconnect window instead of OFFLINE (red)
      // for users who are actually fine — the server is local + always-up,
      // a dropped WS almost always reconnects in under a second.
      if (!manualClose) {
        emit('_probing', { reason: e.reason || 'reconnecting' });
        scheduleReconnect();
      }
    };
    ws.onerror = () => { emit('_error', { message: 'websocket error' }); };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    consecutiveFailures += 1;
    const delay = reconnectMs;
    // Keep the fast 250ms→5s ramp for the common case — a sidecar respawn
    // (stale-version detection, crash-watchdog) reconnects in well under a
    // second, and the server is on loopback so there's no bandwidth case for
    // backing off early. But once the server has been unreachable for a while
    // (>~6 straight failures), widen the cap to 20s so a durably-down server
    // isn't retried ~every 5s forever — that also throttles the downstream
    // launcher status/gpu pumps. Resets to fast on the next successful _open.
    const cap = consecutiveFailures > 6 ? 20_000 : 5_000;
    reconnectMs = Math.min(cap, Math.round(reconnectMs * 1.8));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  window.SeekDeepEvents = {
    on(type, handler) {
      if (typeof type !== 'string' || typeof handler !== 'function') return () => {};
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => this.off(type, handler);
    },
    off(type, handler) {
      const set = handlers.get(type);
      if (set) set.delete(handler);
    },
    get connected() {
      return !!(ws && ws.readyState === WebSocket.OPEN);
    },
    // Force a reconnect (useful after a token rotation).
    reconnect() {
      manualClose = true;
      if (ws) { try { ws.close(); } catch {} }
      manualClose = false;
      connect();
    },
    // Close and stop reconnecting (mostly for cleanup in tests).
    close() {
      manualClose = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch {} ws = null; }
    },
  };

  // React to Safe-mode flips: pause (close + stop reconnecting) when it turns on,
  // resume (connect) when it turns off. Same-window via the custom event nav.js
  // dispatches; cross-window via the 'storage' event on the safe-mode key.
  function applyMode() {
    if (safeModeOn()) {
      manualClose = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) {
        // Detach handlers BEFORE close(): ws.close() is async, so the discarded
        // socket's onclose would fire next tick and emit _close — which the live
        // pill turns into PROBING, clobbering the PAUSED we set just below.
        // (manualClose suppresses the reconnect, but _close still fires.)
        ws.onclose = null;
        ws.onerror = null;
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      emit('_paused', { reason: 'safe-mode' });
    } else {
      connect();
    }
  }
  try { window.addEventListener('seekdeep:fxmode', applyMode); } catch (_) {}
  try { window.addEventListener('storage', (e) => { if (e && e.key === 'seekdeep.safeMode') applyMode(); }); } catch (_) {}

  // Open on load (a no-op while Safe mode is on); defer so SeekDeepAuth is ready.
  setTimeout(connect, 50);
})();
