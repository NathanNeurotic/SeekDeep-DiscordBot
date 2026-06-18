/* SeekDeep universal nav — auto-injects a floating "jump anywhere" palette
   on every page that includes this script. Keyboard: Ctrl/Cmd + K, Esc to close.
   Inject pattern: <script src="nav.js" defer></script> just before </body>.

   Also: monkey-patches window.fetch to attach the X-SeekDeep-Token header on
   POST requests to the local server. Token is fetched once from GET /token
   (loopback-only) and cached. GET requests are not affected. Cross-origin
   POSTs are not affected. See MAINTAINER.md for the auth model. */
(function () {
  'use strict';
  if (document.getElementById('sd-nav-root')) return;

  // Two-part fix for the Webview2 text-input cold-start (5s UI freeze on
  // first textarea focus on Windows):
  //
  //   1. disableSpellcheckEverywhere — sets spellcheck=false on every text
  //      input so spellcheck-COM specifically doesn't init. Helps for the
  //      Grammarly-style hangs but doesn't cover TSF init.
  //
  //   2. warmTextInput — synchronously focus+blur+remove a real spellcheck=true
  //      textarea on script entry, BEFORE the page is interactive. The 5s
  //      freeze (if any) happens during page load — user sees "Chat" tab
  //      taking a beat to render — instead of on their first click. Earlier
  //      version ran at requestIdleCallback time, which collided with user
  //      input; that broke Send. Running before paint avoids the race.
  (function disableSpellcheckEverywhere() {
    if (window.__seekdeepSpellOff) return;
    window.__seekdeepSpellOff = true;
    const off = (el) => {
      if (!el || el.__sdOff) return;
      el.__sdOff = true;
      try {
        el.setAttribute('spellcheck', 'false');
        el.setAttribute('autocorrect', 'off');
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('data-gramm', 'false');
        if ('spellcheck' in el) el.spellcheck = false;  // also the IDL property
      } catch {}
    };
    const walk = () => {
      document.querySelectorAll('textarea, input[type="text"], input:not([type]), input[type="search"], [contenteditable=""], [contenteditable="true"]').forEach(off);
    };
    if (document.body) walk();
    else document.addEventListener('DOMContentLoaded', walk, { once: true });
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches?.('textarea, input[type="text"], input:not([type]), input[type="search"], [contenteditable=""], [contenteditable="true"]')) off(n);
          n.querySelectorAll?.('textarea, input[type="text"], input:not([type]), input[type="search"], [contenteditable=""], [contenteditable="true"]').forEach(off);
        }
      });
      if (document.body) mo.observe(document.body, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }), { once: true });
    }
  })();

  (function warmTextInput() {
    // sessionStorage persists across same-tab navigations within the Tauri
    // window. window.__seekdeepTextWarmed alone resets per page-load, so
    // the warm-up was firing on EVERY navigation (boot.html → loading →
    // app.html → chat.html) and the user perceived it as "delay on the
    // chat tab." First page eats the cost; every subsequent navigation
    // skips it because sessionStorage remembers TSF is already warm.
    let alreadyWarmed = false;
    try { alreadyWarmed = sessionStorage.getItem('__sdTextWarmed') === '1'; } catch {}
    if (alreadyWarmed || window.__seekdeepTextWarmed) return;
    window.__seekdeepTextWarmed = true;
    const run = () => {
      if (!document.body) return;
      try {
        const prev = document.activeElement;
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
        if (prev && prev !== document.body && typeof prev.focus === 'function') {
          try { prev.focus(); } catch {}
        }
        try { sessionStorage.setItem('__sdTextWarmed', '1'); } catch {}
      } catch {}
    };
    if (document.body) run();
    else document.addEventListener('DOMContentLoaded', run, { once: true });
  })();

  // ===== Token auth: auto-inject X-SeekDeep-Token on POSTs to our server =====
  // Done as a fetch monkey-patch so designer-shipped HTMLs (app.html, chat.html
  // etc) don't need to know about auth — they just call fetch() and the header
  // appears. Keeps the auth concern out of the design surfaces.
  (function installTokenInterceptor() {
    const TOKEN_HEADER = 'X-SeekDeep-Token';
    const origFetch = window.fetch.bind(window);
    // Tauri 2 on Windows serves bundled pages from http://tauri.localhost,
    // so location.origin would be 'http://tauri.localhost' — pointing the
    // GUI at its own WebView instead of the local AI server. Always force
    // 127.0.0.1:7865 when we detect Tauri context. Stash a single resolver
    // on window so every other consumer (events.js, version.js, stats.js,
    // ml-deps.js, model-install.js, playground.js, page inline scripts)
    // can share it without duplicating the detection.
    function getBase() {
      if (typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')) {
        return 'http://127.0.0.1:7865';
      }
      return (location.protocol === 'http:' || location.protocol === 'https:')
        ? location.origin : 'http://127.0.0.1:7865';
    }
    if (typeof window !== 'undefined' && !window.SeekDeepResolveBase) {
      window.SeekDeepResolveBase = getBase;
    }
    let cached = null;          // '' = tried and got nothing; null = not tried yet
    let inflight = null;        // promise of in-flight /token fetch
    async function fetchToken() {
      // Cache hit: return immediately. But ONLY if cached is a non-empty
      // string — an empty cache from a previous failed fetch should never
      // permanently lock us out of trying again. Previously this returned
      // '' forever after one transient /token failure during server
      // restart, making every subsequent POST go unauthed → 401 →
      // "TypeError: Failed to fetch" in launcher.js's catch.
      if (typeof cached === 'string' && cached !== '') return cached;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const r = await origFetch(getBase() + '/token', { cache: 'no-store' });
          if (r.ok) {
            const j = await r.json();
            if (j && j.disabled) { cached = ''; return ''; }
            cached = (j && j.token) ? String(j.token) : '';
            return cached;
          }
        } catch (_) { /* server unreachable; cache empty */ }
        // Leave cached as null (not '') so the NEXT call tries again
        // instead of returning '' instantly. Net effect: a failed token
        // fetch isn't sticky.
        cached = null;
        return '';
      })();
      const t = await inflight;
      inflight = null;
      return t;
    }
    // Expose a small surface for callers that want to force-refresh after a
    // 401 (e.g. user rotated the token mid-session by editing .env).
    window.SeekDeepAuth = {
      header: TOKEN_HEADER,
      get: fetchToken,
      reset: () => { cached = null; },
    };
    // Warm the cache on load so the first POST doesn't pay the round-trip.
    fetchToken();

    function urlString(input) {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      try { return String(input); } catch { return ''; }
    }
    function isOurServer(url) {
      // Relative paths (root or otherwise) are always same-origin.
      if (!/^https?:/i.test(url)) return true;
      // GUI-1: compare ORIGINS exactly, not a prefix. A prefix match treated
      // http://127.0.0.1:7865.evil.com/ as "ours" and would attach the
      // X-SeekDeep-Token to it (token exfil via a user-pasted URL).
      try {
        var target = new URL(url);
        var base = new URL(getBase() || location.origin, location.origin);
        return target.origin === base.origin;
      } catch (e) {
        return false;
      }
    }
    function ensureHeader(headers, name, value) {
      if (headers instanceof Headers) {
        if (!headers.has(name)) headers.set(name, value);
        return headers;
      }
      if (Array.isArray(headers)) {
        const lname = name.toLowerCase();
        if (!headers.some(h => Array.isArray(h) && String(h[0]).toLowerCase() === lname)) {
          headers.push([name, value]);
        }
        return headers;
      }
      headers = headers || {};
      // Check both casings in case caller used lowercase
      const has = Object.keys(headers).some(k => k.toLowerCase() === name.toLowerCase());
      if (!has) headers[name] = value;
      return headers;
    }
    // GET requests to these paths require the X-SeekDeep-Token header on the
    // backend (AUD-003 — sensitive reads policy). Without auto-attaching the
    // header here every GUI page that fetches /memory/users / per-guild
    // archive config / logs/tail would hit 401. AUD-003.
    //
    // `/logs/(tail|stream)` was missing — that's why Logs Viewer rendered
    // "logs unavailable · HTTP 401" on a fresh page load and never recovered
    // (the 401 retry path below is ALSO gated on needsToken so it never
    // tried to refresh the token either).
    //
    // Trailing terminator includes `?` — server log dump showed actual URLs
    // like `/logs/tail?n=20`, where the previous `(\/|$)` failed to match
    // because the query string starts with `?`. Result: token wasn't pre-
    // attached, every Logs Viewer poll wasted a 401 round-trip before the
    // catch-all retry kicked in. Now any of /, ?, or end-of-string ends
    // the matched path segment.
    const SENSITIVE_READ_RE = /\/(memory|logs\/(tail|stream)|emoji-vault|force-react|data\/(user-facts|memory-presets|archive-config|archive-optout|archive-guild-config|archive-snapshot|prompt-templates)\.json)(\/|\?|$)/;
    window.fetch = async function patchedFetch(input, init) {
      init = init || {};
      const method = (init.method || (input && input.method) || 'GET').toUpperCase();
      const url = urlString(input);
      const needsToken =
        url && isOurServer(url) &&
        (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ||
         (method === 'GET' && SENSITIVE_READ_RE.test(url)));
      if (needsToken) {
        const tok = await fetchToken();
        if (tok) {
          init.headers = ensureHeader(init.headers, TOKEN_HEADER, tok);
        }
      }
      let response;
      try {
        response = await origFetch(input, init);
      } catch (err) {
        throw err;
      }
      // Auto-retry on 401 for ANY of our server's endpoints (not gated on
      // needsToken). Previously this branch only fired when needsToken was
      // already true — but a GET to a sensitive endpoint NOT in the regex
      // (e.g. /logs/tail before the regex caught it, or any future token-
      // gated read) would still return 401, and the retry path wouldn't
      // attempt because needsToken was false. Now: ANY 401 from our own
      // server triggers a token-cache reset + re-fetch + one retry with
      // the fresh token attached. The server tells us whether auth was
      // actually required — if it 401'd, it was. Idempotent on GETs;
      // for writes the server is responsible for not double-applying a
      // re-played POST (every write endpoint reads then writes atomically).
      if (url && isOurServer(url) && response.status === 401 && !init.__seekdeepRetried) {
        if (typeof window.SeekDeepAuth?.reset === 'function') {
          window.SeekDeepAuth.reset();
        }
        const fresh = await fetchToken();
        if (fresh) {
          init.headers = ensureHeader(init.headers || {}, TOKEN_HEADER, fresh);
          init.__seekdeepRetried = true;
          try { response = await origFetch(input, init); } catch (err) { throw err; }
        }
      }
      return response;
    };
  })();

  // ===== Cross-browser polyfills ===============================================
  // The GUI uses AbortSignal.timeout(ms) heavily — easier than the explicit
  // AbortController + setTimeout dance. It's Chrome 103+ / Firefox 100+ /
  // Safari 15.4+. Tauri WebView 2 ships Chromium 100+ so this is mostly to
  // cover the case where a user opens the static HTML in an older browser
  // (Firefox 95 ESR, etc.) — the page no longer hard-crashes with
  // "TypeError: AbortSignal.timeout is not a function".
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = function (ms) {
      const ctl = new AbortController();
      setTimeout(() => {
        try { ctl.abort(new DOMException('TimeoutError', 'TimeoutError')); }
        catch { ctl.abort(); }
      }, Math.max(0, Number(ms) || 0));
      return ctl.signal;
    };
  }
  // structuredClone landed Chrome 98 / Firefox 94 / Safari 15.4. Nothing
  // currently depends on it, but defensive — falls back to JSON round-trip
  // which covers ~95% of cases (no functions, no DOM nodes, no BigInt).
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = (v) => {
      try { return JSON.parse(JSON.stringify(v)); }
      catch { return v; }
    };
  }

  // ===== External links open in the system browser ============================
  // In the Tauri desktop app the webview is locked to the app origin, so a plain
  // `<a href="https://…">` click just dies — the webview won't navigate out and
  // there's no new-tab. Route external links (+ discord: deep-links) through the
  // shipped `open_external` Tauri command, which opens the OS browser after an
  // allowlist check (github / huggingface / discord / python.org / pytorch /
  // ollama / docker / nvidia — see src-tauri lib.rs). JS-only, so it ships via
  // self-update. In a plain browser this is a no-op: links navigate normally.
  (function () {
    const inTauri = !!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function');
    if (!inTauri) return;
    const APP_HOSTS = new Set(['tauri.localhost', '127.0.0.1', 'localhost', '']);
    document.addEventListener('click', function (e) {
      const a = (e.target && e.target.closest) ? e.target.closest('a[href]') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!/^(https?:|discord:)/i.test(href)) return; // only absolute external schemes
      if (/^https?:/i.test(href)) {
        let host = '';
        try { host = new URL(href, location.href).hostname.toLowerCase(); } catch (_) { return; }
        if (APP_HOSTS.has(host)) return; // same-origin / loopback — let the webview handle it
      }
      e.preventDefault();
      e.stopPropagation();
      window.__TAURI__.core.invoke('open_external', { url: href }).catch(function (err) {
        console.warn('[SeekDeep] external link blocked/failed:', href, String(err));
        try { window.SeekDeepNotify && window.SeekDeepNotify.toast && window.SeekDeepNotify.toast('Could not open link: ' + href, 'warn'); } catch (_) {}
      });
    }, true); // capture phase: beat in-page handlers + the webview navigation
  })();

  // ===== Save a file to the user's Downloads ==================================
  // The Tauri WebView2 silently drops blob/anchor downloads, so GUI "download/
  // export/save" buttons can't rely on <a download>.click(). This routes the
  // bytes through the loopback server (POST /save-file), which runs on the same
  // machine as the GUI and writes to ~/Downloads, returning the path. Accepts a
  // Blob, a blob:/data: URL string, or a plain text/JSON string. Returns the
  // saved absolute path (string); throws on failure. Used by image-studio,
  // image-A/B, memory + prompt exports. (Loopback browser works the same way.)
  async function blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000; // avoid arg-count limits in String.fromCharCode
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    return btoa(bin);
  }
  window.SeekDeepSaveFile = async function (filename, source) {
    let b64;
    if (source instanceof Blob) {
      b64 = await blobToBase64(source);
    } else if (typeof source === 'string' && source.startsWith('blob:')) {
      b64 = await blobToBase64(await (await fetch(source)).blob());
    } else if (typeof source === 'string' && source.startsWith('data:')) {
      b64 = source.slice(source.indexOf(',') + 1);
    } else if (typeof source === 'string') {
      b64 = btoa(unescape(encodeURIComponent(source))); // UTF-8 safe
    } else {
      throw new Error('SeekDeepSaveFile: unsupported source');
    }
    const base = (typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : '';
    const r = await fetch(base + '/save-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ filename: filename, content_b64: b64 }),
    });
    let body = null; try { body = await r.json(); } catch (_) {}
    if (!r.ok || !body || body.ok === false) throw new Error((body && (body.error || body.detail)) || ('HTTP ' + r.status));
    return body.path;
  };

  // ===== Global error logger ===================================================
  // Surface silent failures so empty `catch {}` patterns elsewhere don't hide
  // real bugs. Two hooks:
  //   1. window.error                — uncaught exceptions, syntax errors,
  //                                    failing image/script loads.
  //   2. window.unhandledrejection   — Promises that reject without a .catch.
  // Output:
  //   - console.warn with a [SeekDeep] prefix (always)
  //   - Toast via window.SeekDeepNotify.toast() when it's loaded, throttled
  //     to one toast per 10s per error message so a flapping endpoint
  //     can't spam the user with stacks.
  (function installErrorSurfacing() {
    const recent = new Map();  // msg -> lastShownTs
    const TOAST_THROTTLE_MS = 10000;
    // AbortError + TimeoutError on polling endpoints are NORMAL during
    // server restarts (Reload .env, ML install respawn, sidecar crash
    // recovery). Toasting them spams the user with "SeekDeep /logs/tail
    // POLL · TimeoutError: signal timed out" every time they restart
    // anything — which is exactly when they're paying the most attention
    // and the toasts look most broken. Filter at the surface so every
    // SeekDeepDebug.warn() caller benefits without per-call boilerplate.
    // Real errors (HTTP 5xx, CORS, JSON parse, network unreachable in
    // ways that aren't a timeout) still toast normally.
    function isBenignTransient(detail) {
      if (!detail) return false;
      const name = detail.name || '';
      if (name === 'AbortError' || name === 'TimeoutError') return true;
      const msg = String(detail.message || detail || '');
      if (/timed out|aborted|signal timed out/i.test(msg)) return true;
      // During a known AI server restart window (Self-update, Lock cache,
      // manual Restart), TypeError: Failed to fetch is expected and spammy
      // to toast. The restarting flag is set by the action that triggered
      // the restart; expires ~10s later when the sidecar is back up.
      if (window.__seekdeepRestartingUntil && Date.now() < window.__seekdeepRestartingUntil) {
        if (/failed to fetch|networkerror|load failed/i.test(msg) || name === 'TypeError') return true;
      }
      return false;
    }
    function surface(label, detail) {
      try {
        if (isBenignTransient(detail)) {
          // Console-only — still show up in dev tools for debugging.
          console.warn('[SeekDeep ' + label + '] (transient) ' + String(detail && detail.message || detail));
          return;
        }
        const msg = String(detail || '').slice(0, 600);
        if (!msg) return;
        const key = label + '::' + msg.slice(0, 120);
        const now = Date.now();
        if (recent.get(key) && (now - recent.get(key)) < TOAST_THROTTLE_MS) {
          console.warn('[SeekDeep ' + label + '] (throttled) ' + msg);
          return;
        }
        recent.set(key, now);
        console.warn('[SeekDeep ' + label + '] ' + msg);
        const sdn = window.SeekDeepNotify;
        if (sdn && typeof sdn.toast === 'function') {
          sdn.toast({ tone: 'bad', title: 'SeekDeep ' + label, body: msg.slice(0, 200), ttl: 5500 });
        }
      } catch { /* logging itself failed — don't loop */ }
    }
    window.addEventListener('error', (e) => {
      // Filter out cross-origin script load errors (no actionable detail)
      if (!e || !e.message) return;
      // Skip noise from third-party CDN scripts that block (React/Babel UMD on chat.html / app.html)
      if (e.filename && /unpkg\.com|cdn\./i.test(e.filename)) return;
      surface('JS error', `${e.message} @ ${e.filename || '(unknown)'}:${e.lineno || '?'}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      if (!r) return;
      // AbortError is a normal user-cancel signal; skip toast.
      if (r.name === 'AbortError' || /aborted/i.test(String(r.message || r))) return;
      // TimeoutError from AbortSignal.timeout(...) is benign on offline-fallback paths
      if (r.name === 'TimeoutError' || /timed out/i.test(String(r.message || r))) return;
      surface('unhandled promise', String(r.message || r));
    });
    // Expose so other modules can opt in to the same logger
    window.SeekDeepDebug = { warn: (label, detail) => surface(label, detail) };
  })();

  // ===== Service-worker tombstone reload listener ============================
  // sw.js posts a "seekdeep:sw-cleaned" message to every client when it
  // self-unregisters. Previously the SW called client.navigate() directly,
  // which wiped any unsaved form data (memory.html composer, app.html
  // Config pane dirty rows, prompts.html in-progress edits). Now we ask
  // the user first if anything's dirty, otherwise reload silently.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async (e) => {
      const m = e && e.data;
      if (!m || m.type !== 'seekdeep:sw-cleaned' || !m.reload) return;
      const hasDirty = document.querySelectorAll('.cfg-section .save').length
        ? [...document.querySelectorAll('.cfg-section .save')].some(s => /DIRTY/i.test(s.textContent || ''))
        : false;
      if (hasDirty) {
        if (!await (window.SeekDeepConfirm || window.confirm)('SeekDeep service worker was cleaned up — reload now? Unsaved config changes will be lost.')) return;
      }
      try { location.reload(); } catch (_) {}
    });
  }

  // ===== Multi-window detection (BroadcastChannel) ============================
  // Two SeekDeep windows open simultaneously can fight over destructive ops:
  // each clicks "Reload .env" → both restart the sidecar → race; both POST
  // dirty config updates → last writer wins, earlier user thinks they saved.
  // This module:
  //   1. Establishes a BroadcastChannel("seekdeep-app") on every nav.js-using page
  //   2. Each window announces itself on load and replies to "who's there" pings
  //   3. Builds a Set of peer window IDs (heartbeat every 5s, expire at 12s)
  //   4. Exposes window.SeekDeepWindows = { count(), peers(), confirmIfMultiple(msg) }
  //   5. Renders a small "N other SeekDeep windows open" pill in the topnav when count > 1
  // Dangerous-action wrappers (Reload .env / Force kill / Lock cache) can call
  // confirmIfMultiple() to gate behind a confirm() dialog.
  (function installMultiWindowGuard() {
    if (typeof BroadcastChannel !== 'function') {
      // Older browsers (Safari < 15.4 etc) skip the guard. Single-window
      // behavior remains correct; we just lose the "other windows" warning.
      window.SeekDeepWindows = { count: () => 1, peers: () => [], confirmIfMultiple: async () => true };
      return;
    }
    const SELF_ID = 'sd-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
    const HEARTBEAT_MS = 5000;
    const EXPIRE_MS    = 12000;
    const peers = new Map();  // id -> {lastSeen, page}
    const channel = new BroadcastChannel('seekdeep-app');
    function activePage() {
      try { return (location.pathname.split('/').pop() || 'index.html').toLowerCase(); }
      catch { return 'unknown'; }
    }
    function broadcast(type, extra) {
      try { channel.postMessage({ type, from: SELF_ID, page: activePage(), ts: Date.now(), ...(extra || {}) }); }
      catch {}
    }
    function expireStale() {
      const cutoff = Date.now() - EXPIRE_MS;
      for (const [id, info] of peers) {
        if (info.lastSeen < cutoff) peers.delete(id);
      }
      renderPill();
    }
    function renderPill() {
      // Render in topnav.row if it exists; harmless to inject everywhere.
      let pill = document.getElementById('sd-multi-window-pill');
      const n = peers.size;
      if (n === 0) {
        if (pill) pill.remove();
        return;
      }
      if (!pill) {
        const host = document.querySelector('.topnav .row') || document.querySelector('.topnav') || document.body;
        if (!host) return;
        pill = document.createElement('span');
        pill.id = 'sd-multi-window-pill';
        pill.className = 'pill warn';
        pill.style.cssText = 'padding: 3px 9px; font-size: 10px; letter-spacing: 0.14em; cursor: default;';
        pill.title = '';
        host.appendChild(pill);
      }
      pill.innerHTML = '<span class="dot"></span>' + n + ' OTHER WINDOW' + (n === 1 ? '' : 'S');
      pill.title = [...peers.values()].map(p => p.page).join(', ') + '\n\nDestructive actions (Reload .env, Force kill, Lock cache, Save config) will prompt for confirmation while other windows are open, to avoid races.';
    }
    channel.addEventListener('message', (e) => {
      const m = e.data || {};
      if (!m.from || m.from === SELF_ID) return;
      // hello/heartbeat/pong → record peer; bye → drop
      if (m.type === 'bye') {
        peers.delete(m.from);
        renderPill();
        return;
      }
      peers.set(m.from, { lastSeen: m.ts || Date.now(), page: m.page || 'unknown' });
      renderPill();
      // Reply to a hello with our own pong so the new window learns about us
      if (m.type === 'hello' || m.type === 'whoIsThere') {
        broadcast('pong');
      }
    });
    // Announce + ask who's there. Heartbeat thereafter.
    broadcast('hello');
    broadcast('whoIsThere');
    setInterval(() => { broadcast('heartbeat'); expireStale(); }, HEARTBEAT_MS);
    // Notify peers we're going away (browser may not deliver this, but try)
    window.addEventListener('beforeunload', () => broadcast('bye'));

    window.SeekDeepWindows = {
      id: SELF_ID,
      count: () => peers.size + 1,
      peers: () => [...peers.values()],
      // async + in-app modal: WebView2 in the Tauri app suppresses window.confirm
      // (returns false, no dialog), which silently BLOCKED every multi-window-
      // guarded action (Save config / Reload .env / Force-kill / HF-cache-lock).
      confirmIfMultiple: async (action) => {
        if (peers.size === 0) return true;
        const list = [...peers.values()].map(p => '  · ' + p.page).join('\n');
        const body = 'You have ' + peers.size + ' other SeekDeep window' + (peers.size === 1 ? '' : 's') + ' open:\n' +
          list + '\n\nProceed with "' + action + '" anyway? This affects the shared local stack and may race with the other window(s).';
        return window.SeekDeepConfirm
          ? await window.SeekDeepConfirm({ title: 'Other SeekDeep windows open', body, confirmLabel: 'Proceed', destructive: true })
          : true; // no notify.js -> preserve the legacy "proceed" intent
      },
    };
  })();

  const PAGES = [
    { id: 'index',        title: 'Hub',                 path: 'index.html',        glyph: '⌂', meta: '01 · home' },
    { id: 'app',          title: 'Control Center',      path: 'app.html',          glyph: '⌘', meta: '02 · wired · events bus' },
    { id: 'chat',         title: 'Chat Client',         path: 'chat.html',         glyph: '▸', meta: '03 · PWA · service worker' },
    { id: 'installer',    title: 'Installer',           path: 'installer.html',    glyph: '⚙', meta: '04 · 9-step wizard' },
    { id: 'docs',         title: 'Docs',                path: 'docs.html',         glyph: '▤', meta: '05 · COMMANDS.md mirror' },
    { id: 'api',          title: 'API Explorer',        path: 'api.html',          glyph: '⚡', meta: '06 · live + offline + route inspector' },
    { id: 'architecture', title: 'Architecture',        path: 'architecture.html', glyph: '⌬', meta: '07 · system map' },
    { id: 'roadmap',      title: 'Roadmap',             path: 'roadmap.html',      glyph: '▦', meta: '08 · PLANNED.md' },
    { id: 'changelog',    title: 'Changelog',           path: 'changelog.html',    glyph: '⊞', meta: '09 · v10.x history' },
    { id: 'memory',       title: 'Memory',              path: 'memory.html',       glyph: '⌗', meta: '10 · user-facts · live' },
    { id: 'image_ab',     title: 'Image A/B',           path: 'image-ab.html',     glyph: '▩', meta: '11 · 4 pipelines side-by-side' },
    { id: 'prompts',      title: 'Prompt Templates',    path: 'prompts.html',      glyph: '◩', meta: '12 · local template library + #prompts share flow' },
    { id: 'boot',         title: 'Boot sequence',       path: 'boot.html',         glyph: '◉', meta: '13 · splash' },
    { id: 'add_model',    title: 'Add a Model',         path: 'add-model.html',    glyph: '+', meta: '14 · wizard · POST /model/install' },
    { id: 'setup_wizard', title: 'Setup Wizard',        path: 'setup-wizard.html', glyph: '◇', meta: '15 · zero-terminal first-run · auto-detect + auto-fix' },
    { id: 'settings',     title: 'All Settings',        path: 'settings.html',     glyph: '⛭', meta: '16 · every .env key · typed + grouped' },
    { id: 'personas',     title: 'Personas',            path: 'personas.html',     glyph: '☺', meta: '17 · custom personas · list/create/assign · live' },
    // tts / landing / pitch / tour / mobile were removed from the jump
    // palette (2026-05-29 surface audit, docs/audits/SURFACES.md): they are
    // self-labeled design mocks / marketing pages with no live backend, so
    // jumping to them from ⌘K landed users on dead surfaces. The files remain
    // in-repo (and bundled) for the web/marketing context — they're just no
    // longer offered as in-app navigation targets.
  ];

  // Detect current page from URL filename
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  const css = `
    .sd-jump-btn {
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 9998;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--cyan-1, #2dd4ff), var(--cyan-2, #00a8e8));
      border: 1px solid rgba(109,240,255,0.65);
      color: #001525;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(45,212,255,0.4), 0 0 30px rgba(45,212,255,0.3),
                  inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,80,120,0.4);
      display: grid; place-items: center;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      animation: sdJumpPulse 3s ease-in-out infinite;
    }
    .sd-jump-btn:hover { transform: scale(1.08); box-shadow: 0 8px 30px rgba(45,212,255,0.6), 0 0 40px rgba(45,212,255,0.5); }
    .sd-jump-btn span.glyph { font-size: 22px; line-height: 1; }
    .sd-jump-btn span.kbd { font-size: 8px; opacity: 0.7; margin-top: 2px; }
    @keyframes sdJumpPulse {
      0%, 100% { box-shadow: 0 6px 20px rgba(45,212,255,0.4), 0 0 30px rgba(45,212,255,0.3), inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,80,120,0.4); }
      50%      { box-shadow: 0 6px 20px rgba(45,212,255,0.6), 0 0 48px rgba(45,212,255,0.55), inset 0 1px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(0,80,120,0.4); }
    }

    .sd-jump-backdrop {
      position: fixed; inset: 0; z-index: 9999;
      background: radial-gradient(circle at 50% 50%, rgba(2,6,15,0.85), rgba(2,6,15,0.95));
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: none;
      opacity: 0;
      transition: opacity 0.18s ease;
    }
    .sd-jump-backdrop.open { display: block; opacity: 1; }

    .sd-jump-panel {
      position: fixed;
      left: 50%; top: 50%;
      transform: translate(-50%, -50%) scale(0.96);
      z-index: 10000;
      width: min(560px, calc(100vw - 40px));
      max-height: min(620px, calc(100vh - 80px));
      background: linear-gradient(180deg, rgba(10,26,48,0.96), rgba(6,18,31,0.98));
      border: 1px solid rgba(45,212,255,0.45);
      border-radius: 10px;
      box-shadow: 0 30px 90px rgba(0,0,0,0.7), 0 0 60px rgba(45,212,255,0.25);
      display: none;
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
      overflow: hidden;
      font-family: var(--font-display, system-ui), sans-serif;
    }
    .sd-jump-backdrop.open + .sd-jump-panel,
    .sd-jump-panel.open {
      display: flex; flex-direction: column;
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    .sd-jump-panel::before {
      content: ""; position: absolute; inset: 8px;
      pointer-events: none;
      background:
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) top left / 16px 1px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) top left / 1px 16px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) top right / 16px 1px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) top right / 1px 16px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) bottom left / 16px 1px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) bottom left / 1px 16px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) bottom right / 16px 1px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) bottom right / 1px 16px no-repeat;
      filter: drop-shadow(0 0 4px rgba(109,240,255,0.6));
      z-index: 1;
    }

    .sd-jump-head {
      padding: 18px 22px 12px;
      border-bottom: 1px solid rgba(45,212,255,0.25);
      position: relative; z-index: 2;
    }
    .sd-jump-head .label {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.22em;
      color: var(--hull-3, #7d92b8);
      text-transform: uppercase;
      margin-bottom: 6px;
      display: flex; justify-content: space-between;
    }
    .sd-jump-head .label em {
      font-style: normal;
      color: var(--cyan-1, #2dd4ff);
    }
    .sd-jump-head input {
      width: 100%;
      background: rgba(0,0,0,0.45);
      border: 1px solid rgba(45,212,255,0.25);
      color: var(--hull, #f4f8ff);
      border-radius: 4px;
      padding: 10px 14px;
      font-family: var(--font-display, system-ui), sans-serif;
      font-size: 15px;
      outline: none;
      letter-spacing: 0.01em;
    }
    .sd-jump-head input:focus {
      border-color: var(--cyan-1, #2dd4ff);
      box-shadow: inset 0 0 0 1px rgba(45,212,255,0.5), 0 0 0 2px rgba(45,212,255,0.18);
    }

    .sd-jump-list {
      overflow-y: auto;
      padding: 8px;
      position: relative; z-index: 2;
      flex: 1;
    }
    .sd-jump-item {
      display: grid;
      grid-template-columns: 36px 1fr auto;
      gap: 14px;
      align-items: center;
      padding: 10px 14px;
      border-radius: 4px;
      cursor: pointer;
      color: var(--hull-2, #c7d6f0);
      text-decoration: none;
      border: 1px solid transparent;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
      margin: 2px 0;
      user-select: none;
    }
    .sd-jump-item:hover,
    .sd-jump-item.active {
      background: rgba(45,212,255,0.10);
      border-color: rgba(45,212,255,0.35);
      color: var(--cyan-1, #2dd4ff);
    }
    .sd-jump-item.here { background: rgba(45,212,255,0.06); }
    .sd-jump-item.here .title::after {
      content: " · YOU ARE HERE";
      color: var(--good, #58e6a1);
      font-family: var(--font-mono, monospace);
      font-size: 9px;
      letter-spacing: 0.18em;
      margin-left: 6px;
    }
    .sd-jump-item .glyph {
      width: 36px; height: 36px;
      display: grid; place-items: center;
      border: 1px solid rgba(45,212,255,0.30);
      border-radius: 4px;
      background: rgba(0,0,0,0.40);
      color: var(--cyan-1, #2dd4ff);
      font-size: 18px;
    }
    .sd-jump-item .info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .sd-jump-item .title {
      font-size: 14px;
      font-weight: 500;
      letter-spacing: -0.01em;
      color: var(--hull, #f4f8ff);
    }
    .sd-jump-item.active .title { color: var(--cyan-0, #6df0ff); }
    .sd-jump-item .meta {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.12em;
      color: var(--hull-3, #7d92b8);
      text-transform: uppercase;
    }
    .sd-jump-item .kbd-hint {
      font-family: var(--font-mono, monospace);
      font-size: 9px;
      letter-spacing: 0.14em;
      color: var(--hull-3, #7d92b8);
      padding: 3px 7px;
      border: 1px solid rgba(45,212,255,0.25);
      border-radius: 3px;
      background: rgba(0,0,0,0.45);
    }
    .sd-jump-foot {
      padding: 10px 22px;
      border-top: 1px solid rgba(45,212,255,0.25);
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.16em;
      color: var(--hull-3, #7d92b8);
      text-transform: uppercase;
      display: flex; justify-content: space-between;
      position: relative; z-index: 2;
    }
    .sd-jump-foot kbd {
      display: inline-block;
      padding: 1px 6px;
      margin: 0 2px;
      font-family: inherit;
      font-size: 9px;
      color: var(--cyan-1, #2dd4ff);
      background: rgba(0,4,12,0.7);
      border: 1px solid rgba(45,212,255,0.30);
      border-radius: 3px;
    }
    .sd-jump-empty {
      padding: 30px;
      text-align: center;
      color: var(--hull-3, #7d92b8);
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      letter-spacing: 0.14em;
    }

    /* Bump the logo's glow so the animated GIF reads more clearly */
    img[src*="seekdeep-mark"] {
      animation: sdMarkPulse 3.5s ease-in-out infinite;
    }
    @keyframes sdMarkPulse {
      0%, 100% {
        box-shadow:
          inset 0 0 0 1px rgba(109,240,255,0.28),
          0 0 24px rgba(45,212,255,0.45),
          0 0 60px rgba(45,212,255,0.22);
      }
      50% {
        box-shadow:
          inset 0 0 0 1px rgba(109,240,255,0.55),
          0 0 32px rgba(45,212,255,0.70),
          0 0 90px rgba(45,212,255,0.40);
      }
    }

    /* Caret that hints the lockup / titlebar opens the palette */
    .sd-lockup-caret {
      display: inline-block;
      margin-left: 8px;
      color: var(--cyan-1, #2dd4ff);
      font-size: 0.7em;
      opacity: 0.55;
      transition: opacity 0.15s ease, transform 0.2s ease;
      transform: translateY(-1px);
      letter-spacing: 0;
    }
    .lockup:hover .sd-lockup-caret,
    .win-titlebar .title:hover .sd-lockup-caret {
      opacity: 1;
      color: var(--cyan-0, #6df0ff);
      transform: translateY(1px);
    }
    .lockup, .win-titlebar .title { transition: opacity 0.15s ease; }
    .lockup:hover, .win-titlebar .title:hover { opacity: 1; }
    .lockup:hover .wm, .win-titlebar .title:hover em {
      text-shadow: 0 0 12px rgba(45, 212, 255, 0.5);
    }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'sd-nav-root';
  root.innerHTML = `
    <button class="sd-jump-btn" id="sdJumpBtn" title="Jump anywhere (Ctrl+K)">
      <span class="glyph">◐</span>
      <span class="kbd">⌘K</span>
    </button>
    <div class="sd-jump-backdrop" id="sdJumpBack"></div>
    <div class="sd-jump-panel" id="sdJumpPanel" role="dialog" aria-label="Jump anywhere">
      <div class="sd-jump-head">
        <div class="label"><span>JUMP ANYWHERE</span><em>SEEKDEEP · <span data-stat-surfaces>${PAGES.length}</span> SURFACES</em></div>
        <input id="sdJumpSearch" type="text" placeholder="Type to filter · ↑↓ to navigate · ↵ to jump" autocomplete="off" />
      </div>
      <div class="sd-jump-list" id="sdJumpList"></div>
      <div class="sd-jump-foot">
        <span><kbd>⌘K</kbd> open · <kbd>Esc</kbd> close · <kbd>↵</kbd> jump</span>
        <span><span data-version>v—</span> · LOCAL</span>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const panel = document.getElementById('sdJumpPanel');
  const backdrop = document.getElementById('sdJumpBack');
  const list = document.getElementById('sdJumpList');
  const search = document.getElementById('sdJumpSearch');
  const btn = document.getElementById('sdJumpBtn');

  let filtered = PAGES.slice();
  let cursor = 0;

  function render() {
    list.innerHTML = '';
    if (!filtered.length) {
      list.innerHTML = '<div class="sd-jump-empty">▸ no match</div>';
      return;
    }
    filtered.forEach((p, i) => {
      const a = document.createElement('a');
      a.href = p.path;
      a.className = 'sd-jump-item' + (i === cursor ? ' active' : '') + (p.path === here ? ' here' : '');
      a.innerHTML = `
        <span class="glyph">${p.glyph}</span>
        <span class="info">
          <span class="title">${p.title}</span>
          <span class="meta">${p.meta}</span>
        </span>
        <span class="kbd-hint">${p.path}</span>
      `;
      a.addEventListener('mouseenter', () => { cursor = i; updateActive(); });
      list.appendChild(a);
    });
  }
  function updateActive() {
    [...list.children].forEach((c, i) => c.classList.toggle('active', i === cursor));
    const el = list.children[cursor];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    backdrop.classList.add('open');
    panel.classList.add('open');
    cursor = 0;
    filtered = PAGES.slice();
    search.value = '';
    render();
    setTimeout(() => search.focus(), 30);
  }
  function close() {
    backdrop.classList.remove('open');
    panel.classList.remove('open');
  }
  function fuzzyFilter(q) {
    if (!q) return PAGES.slice();
    q = q.toLowerCase();
    return PAGES.filter(p => (p.title + ' ' + p.path + ' ' + p.meta + ' ' + p.id).toLowerCase().includes(q));
  }

  btn.addEventListener('click', open);
  backdrop.addEventListener('click', close);

  // Bind the SEEKDEEP lockup / window title as a jump opener
  // (works retroactively on every page — no per-file edits needed)
  function bindLockup(el) {
    if (!el || el.dataset.sdJumpBound) return;
    el.dataset.sdJumpBound = '1';
    el.style.cursor = 'pointer';
    el.title = 'Jump anywhere · Ctrl+K';
    // Append a small caret to signal it's openable
    if (!el.querySelector('.sd-lockup-caret')) {
      const caret = document.createElement('span');
      caret.className = 'sd-lockup-caret';
      caret.textContent = '▾';
      el.appendChild(caret);
    }
    el.addEventListener('click', e => {
      // Don't intercept clicks on actual <a> children (e.g. the home logo link)
      const link = e.target.closest('a[href]');
      if (link && link !== el && link.getAttribute('href') && link.getAttribute('href') !== '#') {
        // It's a nested link — but if the user clicked on the caret or the wordmark itself, open
        if (e.target.classList.contains('sd-lockup-caret') ||
            e.target.classList.contains('wm') ||
            e.target.classList.contains('title')) {
          e.preventDefault();
          open();
        }
        return;
      }
      e.preventDefault();
      open();
    });
  }
  document.querySelectorAll('.lockup, .win-titlebar .title').forEach(bindLockup);
  // Also catch lockups injected later (rare, but safe)
  const mo = new MutationObserver(() => {
    document.querySelectorAll('.lockup:not([data-sd-jump-bound]), .win-titlebar .title:not([data-sd-jump-bound])').forEach(bindLockup);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  search.addEventListener('input', () => {
    filtered = fuzzyFilter(search.value);
    cursor = 0;
    render();
  });
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(filtered.length - 1, cursor + 1); updateActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); updateActive(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const p = filtered[cursor];
      if (p) location.href = p.path;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      panel.classList.contains('open') ? close() : open();
    } else if (e.key === 'Escape' && panel.classList.contains('open')) {
      close();
    }
  });

  // ====================================================================
  // SeekDeepPrompt — on-demand missing-value collector + CPU-mode banner
  // ====================================================================
  const promptCSS = `
    .sd-prompt-back {
      position: fixed; inset: 0; z-index: 10001;
      background: radial-gradient(circle at 50% 50%, rgba(2,6,15,0.88), rgba(2,6,15,0.96));
      backdrop-filter: blur(10px);
      display: none; opacity: 0;
      transition: opacity 0.2s ease;
    }
    .sd-prompt-back.open { display: block; opacity: 1; }
    .sd-prompt-modal {
      position: fixed; left: 50%; top: 50%;
      transform: translate(-50%, -50%) scale(0.96);
      z-index: 10002;
      width: min(560px, calc(100vw - 40px));
      background: linear-gradient(180deg, rgba(10,26,48,0.97), rgba(6,18,31,0.99));
      border: 1px solid rgba(45,212,255,0.50);
      border-radius: 10px;
      box-shadow: 0 30px 90px rgba(0,0,0,0.75), 0 0 60px rgba(45,212,255,0.30);
      display: none; opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
      font-family: var(--font-display, system-ui), sans-serif;
      overflow: hidden;
    }
    .sd-prompt-modal.open { display: block; opacity: 1; transform: translate(-50%, -50%) scale(1); }
    .sd-prompt-modal::before {
      content: ""; position: absolute; inset: 8px; pointer-events: none;
      background:
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) top left / 16px 1px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) top left / 1px 16px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) bottom right / 16px 1px no-repeat,
        linear-gradient(rgba(109,240,255,0.7), rgba(109,240,255,0.7)) bottom right / 1px 16px no-repeat;
      filter: drop-shadow(0 0 4px rgba(109,240,255,0.6));
    }
    .sd-prompt-head { padding: 20px 24px 14px; border-bottom: 1px solid rgba(45,212,255,0.25); position: relative; z-index: 1; }
    .sd-prompt-head .label { font-family: var(--font-mono, monospace); font-size: 10px; letter-spacing: 0.22em; color: var(--warn, #ffb84d); text-transform: uppercase; margin-bottom: 6px; }
    .sd-prompt-head h3 { font-size: 20px; letter-spacing: -0.01em; margin: 0 0 6px; color: var(--hull, #f4f8ff); font-weight: 500; }
    .sd-prompt-head p { font-size: 13px; color: var(--hull-3, #7d92b8); line-height: 1.55; margin: 0; }
    .sd-prompt-body { padding: 18px 24px; max-height: 60vh; overflow-y: auto; position: relative; z-index: 1; }
    .sd-prompt-field { margin-bottom: 16px; }
    .sd-prompt-field label { display: block; font-family: var(--font-mono, monospace); font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--cyan-1, #2dd4ff); margin-bottom: 6px; }
    .sd-prompt-field label .opt { color: var(--hull-3, #7d92b8); margin-left: 8px; }
    .sd-prompt-field input { width: 100%; background: rgba(0,0,0,0.55); border: 1px solid rgba(45,212,255,0.25); color: var(--hull, #f4f8ff); border-radius: 4px; padding: 9px 12px; font-family: var(--font-mono, monospace); font-size: 13px; outline: none; }
    .sd-prompt-field input:focus { border-color: var(--cyan-1, #2dd4ff); box-shadow: inset 0 0 0 1px rgba(45,212,255,0.5); }
    .sd-prompt-field .desc { font-size: 11px; color: var(--hull-3, #7d92b8); font-family: var(--font-mono, monospace); line-height: 1.55; margin-top: 5px; }
    .sd-prompt-foot { padding: 14px 24px; border-top: 1px solid rgba(45,212,255,0.25); display: flex; gap: 10px; justify-content: flex-end; position: relative; z-index: 1; }
    .sd-prompt-foot button { font-family: var(--font-mono, monospace); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; padding: 8px 16px; border-radius: 4px; cursor: pointer; border: 1px solid rgba(45,212,255,0.30); background: transparent; color: var(--cyan-1, #2dd4ff); }
    .sd-prompt-foot button.primary { background: linear-gradient(180deg, var(--cyan-1, #2dd4ff), var(--cyan-2, #00a8e8)); color: #001525; font-weight: 700; border-color: rgba(109,240,255,0.65); box-shadow: 0 4px 14px rgba(45,212,255,0.35); }
    .sd-prompt-foot button:disabled { opacity: 0.5; cursor: wait; }

    /* CPU-only mode banner — sits at the top of every page when no GPU detected */
    .sd-cpu-banner {
      position: fixed; top: 0; left: 0; right: 0; z-index: 9997;
      background: linear-gradient(90deg, rgba(255,184,77,0.16), rgba(255,184,77,0.10));
      border-bottom: 1px solid rgba(255,184,77,0.45);
      color: var(--warn, #ffb84d);
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 8px 16px;
      display: flex; gap: 14px; align-items: center; justify-content: center;
      backdrop-filter: blur(6px);
    }
    .sd-cpu-banner b { color: var(--warn, #ffb84d); font-weight: 700; }
    .sd-cpu-banner em { color: var(--hull-2, #c7d6f0); font-style: normal; }
    .sd-cpu-banner button { background: transparent; border: 1px solid var(--warn, #ffb84d); color: var(--warn, #ffb84d); font-family: inherit; font-size: 10px; letter-spacing: 0.14em; padding: 3px 10px; border-radius: 3px; cursor: pointer; }
    .sd-cpu-banner button:hover { background: rgba(255,184,77,0.10); }
  `;
  const promptStyle = document.createElement('style');
  promptStyle.textContent = promptCSS;
  document.head.appendChild(promptStyle);

  const promptRoot = document.createElement('div');
  promptRoot.innerHTML = `
    <div class="sd-prompt-back" id="sdPromptBack"></div>
    <div class="sd-prompt-modal" id="sdPromptModal" role="dialog">
      <div class="sd-prompt-head">
        <div class="label" id="sdPromptLabel">▸ MISSING VALUES</div>
        <h3 id="sdPromptTitle">SeekDeep needs a few things</h3>
        <p id="sdPromptDesc">Fill in the values below. They go straight to <span style="color:var(--cyan-1, #2dd4ff);">.env</span> via the local API — never anywhere else.</p>
      </div>
      <div class="sd-prompt-body" id="sdPromptBody"></div>
      <div class="sd-prompt-foot">
        <button id="sdPromptCancel">Skip</button>
        <button class="primary" id="sdPromptSave">▸ Save &amp; continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(promptRoot);

  const promptBack   = document.getElementById('sdPromptBack');
  const promptModal  = document.getElementById('sdPromptModal');
  const promptBody   = document.getElementById('sdPromptBody');
  const promptCancel = document.getElementById('sdPromptCancel');
  const promptSave   = document.getElementById('sdPromptSave');

  let promptResolver = null;

  function promptOpen(fields, opts = {}) {
    if (opts.title) document.getElementById('sdPromptTitle').textContent = opts.title;
    if (opts.desc)  document.getElementById('sdPromptDesc').innerHTML = opts.desc;
    if (opts.label) document.getElementById('sdPromptLabel').textContent = opts.label;

    promptBody.innerHTML = '';
    fields.forEach(f => {
      const wrap = document.createElement('div');
      wrap.className = 'sd-prompt-field';
      const isSecret = f.kind === 'secret' || /TOKEN|KEY|SECRET/.test(f.key);
      wrap.innerHTML = `
        <label>${f.key}${f.required ? '' : ' <span class="opt">optional</span>'}</label>
        <input type="${isSecret ? 'password' : 'text'}" data-key="${f.key}" value="${(f.value || '').replace(/"/g,'&quot;')}" autocomplete="off" placeholder="${f.placeholder || ''}" />
        <div class="desc">${f.description || ''}</div>
      `;
      promptBody.appendChild(wrap);
    });
    promptBack.classList.add('open');
    promptModal.classList.add('open');
    setTimeout(() => { promptBody.querySelector('input')?.focus(); }, 30);

    return new Promise(resolve => { promptResolver = resolve; });
  }
  function promptClose(payload) {
    promptBack.classList.remove('open');
    promptModal.classList.remove('open');
    if (promptResolver) { promptResolver(payload); promptResolver = null; }
  }
  promptBack.addEventListener('click', () => promptClose(null));
  promptCancel.addEventListener('click', () => promptClose(null));
  promptSave.addEventListener('click', async () => {
    const updates = {};
    promptBody.querySelectorAll('input[data-key]').forEach(i => {
      const v = (i.value || '').trim();
      if (v) updates[i.dataset.key] = v;
    });
    if (!Object.keys(updates).length) { promptClose(null); return; }
    promptSave.disabled = true;
    promptSave.textContent = '⋯ saving…';
    try {
      const base = (window.SeekDeepResolveBase ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865')));
      const r = await fetch(base + '/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        promptClose(updates);
      } else {
        promptSave.textContent = '✕ failed · ' + r.status;
        setTimeout(() => { promptSave.disabled = false; promptSave.textContent = '▸ Save & continue'; }, 1800);
      }
    } catch (e) {
      promptSave.textContent = '✕ server offline';
      // Still resolve with values so the caller can try direct again
      setTimeout(() => promptClose(updates), 1200);
    }
  });

  // Public API
  window.SeekDeepPrompt = {
    open: promptOpen,
    close: promptClose,
    // Convenience: collect by key names. Looks up descriptions from /config/status.
    collect: async (keys, opts) => {
      const base = (window.SeekDeepResolveBase ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865')));
      let meta = null;
      try {
        const r = await fetch(base + '/config/status', { signal: AbortSignal.timeout(3000) });
        if (r.ok) meta = await r.json();
      } catch {}
      const known = [...(meta?.required || []), ...(meta?.optional || [])];
      const fields = keys.map(k => {
        const m = known.find(x => x.key === k);
        return m
          ? { key: k, description: m.description, kind: m.kind, required: !!meta?.required?.find(r => r.key === k), value: m.value || '' }
          : { key: k, description: '', kind: 'text', required: false, value: '' };
      });
      return promptOpen(fields, opts);
    },
  };

  // CPU-only mode banner — surfaces when /health says no CUDA.
  // Auto-detect on load, refresh every minute in case a GPU comes online.
  //
  // NOTE: cuda_available===false has TWO causes — (a) torch isn't installed
  // yet (ml_deps_missing), or (b) torch IS installed but can't see CUDA.
  // The CPU-ONLY banner only makes sense for (b); for (a), the ml-deps
  // banner is the right CTA, and claiming "no CUDA device detected" when
  // we literally cannot import torch is just lying — the user may well
  // have a 5090 sitting right there. Gate on h.gpu.torch_present === true.
  // Apply the CPU-only banner state from a /health-shaped payload.
  // Called from both the event-driven health.tick path and the safety-net poll.
  function applyGpuMode(h) {
    try {
      const torchPresent = (h && h.gpu && h.gpu.torch_present === true);
      const noCuda = (h.cuda_available === false) && torchPresent;
      let banner = document.querySelector('.sd-cpu-banner');
      if (noCuda) {
        if (!banner) {
          banner = document.createElement('div');
          banner.className = 'sd-cpu-banner';
          banner.innerHTML = `
            <span><b>⚠ CPU-ONLY MODE</b> · <em>no CUDA device detected</em> · chat models will load slowly · SDXL image gen unavailable</span>
            <button id="sdCpuDismiss">DISMISS</button>
          `;
          document.body.appendChild(banner);
          document.getElementById('sdCpuDismiss').addEventListener('click', () => {
            banner.remove();
            try { sessionStorage.setItem('sd-cpu-banner-dismissed', '1'); } catch {}
          });
          if (sessionStorage.getItem('sd-cpu-banner-dismissed') === '1') banner.remove();
        }
      } else if (banner) {
        banner.remove();
      }
    } catch {}
  }
  async function checkGpuMode() {
    const base = (window.SeekDeepResolveBase ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865')));
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(2000), cache: 'no-store' });
      if (!r.ok) return;
      applyGpuMode(await r.json());
    } catch {}
  }
  // Live path: health.tick streams the same payload every 5s when WS is up.
  // The setInterval below stays as a safety net (relaxed to 5min) for when
  // the bus is down — bumped from 60s now that the live event covers freshness.
  try {
    if (window.SeekDeepEvents && typeof window.SeekDeepEvents.on === 'function') {
      window.SeekDeepEvents.on('health.tick', (data) => { if (data) applyGpuMode(data); });
    }
  } catch {}
  // Auto-trigger missing-required-keys modal on first load if config/status flags it
  async function checkConfigStatus() {
    const base = (window.SeekDeepResolveBase ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865')));
    try {
      const r = await fetch(base + '/config/status', { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return;
      const s = await r.json();
      if (s.needs_setup && !sessionStorage.getItem('sd-setup-prompted')) {
        sessionStorage.setItem('sd-setup-prompted', '1');
        const fields = s.missing_required.map(m => ({
          key: m.key, description: m.description, kind: m.kind, required: true, value: m.value || '',
        }));
        await window.SeekDeepPrompt.open(fields, {
          label: '▸ SETUP REQUIRED',
          title: 'SeekDeep needs a few values before it can run',
          desc: 'These keys are missing or still placeholders in your <span style="color:var(--cyan-1, #2dd4ff);">.env</span>. Save them here and the bot will be ready.',
        });
      }
    } catch {}
  }
  setTimeout(() => { checkGpuMode(); checkConfigStatus(); }, 400);
  setInterval(checkGpuMode, 300_000);  // 5min safety net; live updates via health.tick above.

  // ====================================================================
  // Title-bar LIVE / OFFLINE pill — Task 6.
  // We inject a small pill into every page's titlebar (.win-titlebar or .topnav),
  // then drive it off the SeekDeepEvents bus when present (added by the events.js
  // auto-loader at the tail of this file — see TODO below). Falls back to the
  // existing /health probe model when the bus isn't available.
  // ====================================================================
  const pillCSS = `
    .sd-live-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 9px;
      border-radius: var(--r-md, 2px);
      font-family: var(--font-mono, monospace);
      font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase;
      border: 1px solid rgba(125,146,184,0.35);
      background: linear-gradient(180deg, rgba(10,26,48,0.85), rgba(6,18,31,0.85));
      color: var(--hull-3, #7d92b8);
      margin-left: 10px;
      cursor: default;
      vertical-align: middle;
      transition: color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .sd-live-pill .sd-live-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 6px currentColor;
    }
    .sd-live-pill[data-state="live"] {
      color: var(--good, #58e6a1);
      border-color: color-mix(in oklab, var(--good, #58e6a1) 45%, transparent);
      box-shadow: 0 0 12px color-mix(in oklab, var(--good, #58e6a1) 25%, transparent);
    }
    .sd-live-pill[data-state="live"] .sd-live-dot { animation: sdLivePulse 1.6s ease-in-out infinite; }
    .sd-live-pill[data-state="offline"] {
      color: var(--bad, #ff6b6b);
      border-color: color-mix(in oklab, var(--bad, #ff6b6b) 45%, transparent);
    }
    .sd-live-pill[data-state="probing"] {
      color: var(--warn, #ffb84d);
      border-color: color-mix(in oklab, var(--warn, #ffb84d) 45%, transparent);
    }
    @keyframes sdLivePulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.85); } }
  `;
  const pillStyle = document.createElement('style');
  pillStyle.textContent = pillCSS;
  document.head.appendChild(pillStyle);

  function setLiveState(state) {
    document.querySelectorAll('.sd-live-pill').forEach(p => {
      p.dataset.state = state;
      p.querySelector('.sd-live-label').textContent =
        state === 'live'    ? 'LIVE' :
        state === 'offline' ? 'OFFLINE' :
                              'PROBING';
    });
  }

  function injectLivePill() {
    // Skip if a page already has its own #liveModePill (app.html, api.html)
    if (document.getElementById('liveModePill')) {
      // Adopt that pill — give it our class + dataset so the bus wiring below drives it too
      const adopted = document.getElementById('liveModePill');
      if (!adopted.classList.contains('sd-live-pill')) {
        adopted.classList.add('sd-live-pill');
        adopted.innerHTML = '<span class="sd-live-dot"></span><span class="sd-live-label">PROBING</span>';
        adopted.dataset.state = 'probing';
      }
      return;
    }
    // Pick the most specific available host. querySelectorAll order is
    // document order, which would pick the topnav parent before its .row
    // child — so query each in priority order instead.
    const host = document.querySelector('.win-titlebar .title')
              || document.querySelector('.topnav .row')
              || document.querySelector('.topnav');
    if (!host || host.querySelector('.sd-live-pill')) return;
    const pill = document.createElement('span');
    pill.className = 'sd-live-pill';
    pill.dataset.state = 'probing';
    pill.title = 'WebSocket bus · /events';
    pill.innerHTML = '<span class="sd-live-dot"></span><span class="sd-live-label">PROBING</span>';
    host.appendChild(pill);
  }

  injectLivePill();
  // Re-run in case the titlebar mounts late
  setTimeout(injectLivePill, 200);
  setTimeout(injectLivePill, 1200);

  function wireLivePill() {
    if (window.SeekDeepEvents && typeof window.SeekDeepEvents.on === 'function') {
      try {
        window.SeekDeepEvents.on('_open',  () => setLiveState('live'));
        // _probing fires immediately on close before scheduleReconnect runs,
        // so the pill shows PROBING (yellow) during the brief reconnect
        // window instead of OFFLINE (red) — important for the "server
        // restart from sidecar respawn" case, which used to leave the
        // pill OFFLINE for up to 30s.
        window.SeekDeepEvents.on('_probing', () => setLiveState('probing'));
        window.SeekDeepEvents.on('_close', () => setLiveState('probing'));
        setLiveState(window.SeekDeepEvents.connected ? 'live' : 'probing');
        return true;
      } catch {}
    }
    return false;
  }
  if (!wireLivePill()) {
    // Bus not loaded yet — poll briefly while events.js auto-loader mounts it
    let tries = 0;
    const iv = setInterval(() => {
      if (wireLivePill() || ++tries > 20) clearInterval(iv);
    }, 250);
    // Fallback: probe /health for liveness if bus never arrives. 6s
    // timeout because /health does an Ollama probe (~2s) + role-backend
    // resolution; 2s was too aggressive on cold starts.
    setTimeout(async () => {
      if (window.SeekDeepEvents) return;
      try {
        const base = (window.SeekDeepResolveBase ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865')));
        const r = await fetch(base + '/health', { signal: AbortSignal.timeout(6000), cache: 'no-store' });
        setLiveState(r.ok ? 'live' : 'offline');
      } catch { setLiveState('offline'); }
    }, 6000);
  }

  // ====================================================================
  // Dynamic --topnav-h CSS var — keeps body.has-topnav math correct when
  // the topnav reflows at narrow viewports (links wrap, hamburger drawer
  // opens, etc.). Without this, the .app-wrap calc(100vh - 88px) clips
  // content whenever the nav grows past the assumed 88px.
  // ====================================================================
  (function trackTopnavHeight() {
    function update() {
      const nav = document.querySelector('.topnav');
      if (!nav) return;
      const h = Math.ceil(nav.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--topnav-h', h + 'px');
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', update, { once: true });
    } else {
      update();
    }
    // Re-measure on resize + when the nav itself reflows.
    window.addEventListener('resize', update);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(update);
      // Defer to next tick so the nav is in the DOM.
      setTimeout(() => {
        const nav = document.querySelector('.topnav');
        if (nav) ro.observe(nav);
      }, 0);
    }
    // After font load (font metrics shift the nav height), re-measure.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(update).catch(() => {});
    }
  })();

  // ====================================================================
  // Mobile menu toggle — at narrow widths the topnav links collapse into
  // a hamburger drawer. Pure CSS handles the visual; this JS just toggles
  // the .is-open class on click + closes on link / outside click / Esc.
  // ====================================================================
  (function mobileMenuToggle() {
    function attach() {
      const nav = document.querySelector('.topnav');
      if (!nav || nav.querySelector('.menu-toggle')) return false;
      const btn = document.createElement('button');
      btn.className = 'menu-toggle';
      btn.setAttribute('aria-label', 'Toggle menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '<span></span><span></span><span></span>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = nav.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      nav.appendChild(btn);
      // Close on link click (drawer was open).
      nav.querySelectorAll('.links a').forEach(a =>
        a.addEventListener('click', () => {
          nav.classList.remove('is-open');
          btn.setAttribute('aria-expanded', 'false');
        })
      );
      // Close on outside click + Esc.
      document.addEventListener('click', (e) => {
        if (!nav.contains(e.target)) {
          nav.classList.remove('is-open');
          btn.setAttribute('aria-expanded', 'false');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          nav.classList.remove('is-open');
          btn.setAttribute('aria-expanded', 'false');
        }
      });
      return true;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    } else {
      attach();
    }
  })();

  // ====================================================================
  // "More" nav dropdown — surface real-but-secondary features.
  // The per-page topnav lists the 8 primary surfaces; several real, wired
  // features (Memory, Image A/B, Prompts, Add a Model, Changelog) were only
  // reachable via Cmd-K, so users never found them (docs/audits/SURFACES.md).
  // Inject a compact "More v" dropdown into .topnav .links on every page that
  // has the standard nav. Purely additive — no per-page edits. The trigger is
  // a real <a> so it inherits the page's own ".topnav .links a" styling; the
  // panel rules are scoped under ".topnav .links" so they win specificity over
  // the base link colour. Runs AFTER mobileMenuToggle so the injected trigger
  // doesn't pick up the drawer's "close on link click" handler.
  // ====================================================================
  (function injectMoreMenu() {
    const MORE_ITEMS = [
      { title: 'All Settings', path: 'settings.html'  },
      { title: 'Memory',      path: 'memory.html'    },
      { title: 'Image A/B',   path: 'image-ab.html'  },
      { title: 'Prompts',     path: 'prompts.html'   },
      { title: 'Personas',    path: 'personas.html'  },
      { title: 'Add a Model', path: 'add-model.html' },
      { title: 'Changelog',   path: 'changelog.html' },
      { title: 'TTS Voice',   path: 'tts.html'       },
      { title: 'DATA DASH!',  path: 'activity/index.html' },
    ];
    // Feature-gated items: shown only when their env flag is ON (read from the
    // open GET /config/features). Keeps Discord-only admin tools out of the nav
    // until the operator enables the feature.
    const GATED_ITEMS = [
      { title: 'Emoji Vault', path: 'emoji-vault.html', flag: 'SEEKDEEP_FEATURE_EMOJI_VAULT' },
      { title: 'Force React', path: 'force-react.html', flag: 'SEEKDEEP_FEATURE_FORCE_REACT' },
      { title: 'Bot Bridge', path: 'bot-bridge.html', flag: 'SEEKDEEP_FEATURE_BOT_BRIDGE' },
    ];
    const moreCSS = `
      .topnav .links .sd-more { position: relative; display: inline-flex; align-items: center; }
      .topnav .links a.sd-more-btn { cursor: pointer; }
      .topnav .links a.sd-more-btn .sd-more-caret { font-size: 0.8em; margin-left: 4px; opacity: 0.7; }
      .topnav .links .sd-more-panel {
        position: absolute; top: calc(100% + 9px); right: 0; z-index: 9996;
        min-width: 196px; padding: 6px;
        background: linear-gradient(180deg, rgba(10,26,48,0.98), rgba(6,18,31,0.99));
        border: 1px solid rgba(45,212,255,0.45); border-radius: 8px;
        box-shadow: 0 18px 50px rgba(0,0,0,0.6), 0 0 36px rgba(45,212,255,0.18);
        display: none; flex-direction: column; gap: 1px;
        text-align: left;
      }
      .topnav .links .sd-more.open .sd-more-panel { display: flex; }
      .topnav .links .sd-more-panel a {
        display: block; padding: 8px 12px; margin: 0; border-radius: 5px;
        color: var(--hull-2, #c7d6f0); border: 1px solid transparent;
        white-space: nowrap; text-align: left;
      }
      .topnav .links .sd-more-panel a::after { content: none !important; }
      .topnav .links .sd-more-panel a:hover,
      .topnav .links .sd-more-panel a.here {
        background: rgba(45,212,255,0.10);
        border-color: rgba(45,212,255,0.30);
        color: var(--cyan-1, #2dd4ff);
      }
      /* In the mobile hamburger drawer the links stack vertically; render the
         panel inline (indented) instead of as a floating popover. */
      @media (max-width: 760px) {
        .topnav .links .sd-more { display: block; width: 100%; }
        .topnav .links .sd-more-panel {
          position: static; display: flex; box-shadow: none; border: 0;
          padding: 0 0 0 12px; background: transparent; min-width: 0;
        }
      }
    `;
    const st = document.createElement('style');
    st.textContent = moreCSS;
    document.head.appendChild(st);

    function attach() {
      const links = document.querySelector('.topnav .links');
      if (!links || links.querySelector('.sd-more')) return true; // absent or already done
      const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
      const onMore = MORE_ITEMS.concat(GATED_ITEMS).some((it) => it.path === here);

      const wrap = document.createElement('div');
      wrap.className = 'sd-more';

      const btn = document.createElement('a');
      btn.className = 'sd-more-btn' + (onMore ? ' active' : '');
      btn.href = '#';
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = 'More<span class="sd-more-caret" aria-hidden="true">▾</span>';

      const panel = document.createElement('div');
      panel.className = 'sd-more-panel';
      panel.setAttribute('role', 'menu');
      MORE_ITEMS.forEach((it) => {
        const a = document.createElement('a');
        a.href = it.path;
        a.textContent = it.title;
        a.setAttribute('role', 'menuitem');
        if (it.path === here) a.classList.add('here');
        panel.appendChild(a);
      });

      wrap.appendChild(btn);
      wrap.appendChild(panel);
      links.appendChild(wrap);

      function setOpen(open) {
        wrap.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!wrap.classList.contains('open'));
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen(!wrap.classList.contains('open'));
        } else if (e.key === 'Escape') {
          setOpen(false);
        }
      });
      // Close on outside click + Esc (panel item clicks navigate away).
      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setOpen(false);
      });

      // Append feature-gated items once the flags are known (additive,
      // non-blocking). Emoji Vault only appears when SEEKDEEP_FEATURE_EMOJI_VAULT
      // is on; the GET /config/features endpoint is open (no token).
      if (GATED_ITEMS.length && /^https?:/.test(location.protocol)) {
        const base = (window.SeekDeepResolveBase ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865')));
        fetch(base + '/config/features')
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const feats = (j && j.features) || {};
            GATED_ITEMS.forEach((it) => {
              if (!feats[it.flag]) return;
              if (panel.querySelector(`a[href="${it.path}"]`)) return;
              const a = document.createElement('a');
              a.href = it.path;
              a.textContent = it.title;
              a.setAttribute('role', 'menuitem');
              if (it.path === here) a.classList.add('here');
              panel.appendChild(a);
            });
          })
          .catch(() => {});
      }

      return true;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    } else {
      attach();
    }
    // Retry in case the topnav mounts late on some pages.
    setTimeout(attach, 300);
    setTimeout(attach, 1200);
  })();

  // Auto-load sibling helper scripts (events.js + version.js + playground.js)
  // via dynamic <script> appends so designer-shipped HTMLs only need to
  // include nav.js — they get window.SeekDeepEvents, window.SeekDeepVersion,
  // and (on chat.html) the live playground composer for free.
  // Skipped if already loaded explicitly, or if we're on file://.
  (function autoLoadSiblings() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const navScript = document.querySelector('script[src$="nav.js"], script[src*="/nav.js"]');
    const base = navScript ? navScript.src.replace(/nav\.js(\?.*)?$/, '') : '';
    function inject(name, globalKey) {
      if (globalKey && window[globalKey]) return;
      const existing = document.querySelector(`script[src$="${name}"], script[src*="/${name}"]`);
      if (existing) return;
      const s = document.createElement('script');
      s.src = base + name;
      s.defer = true;
      document.head.appendChild(s);
    }
    inject('events.js',  'SeekDeepEvents');
    inject('version.js', 'SeekDeepVersion');
    // fetch.js · resilient fetch with exponential backoff + visibility
    // recovery. Closes audit §5 — every bare fetch() with a one-shot
    // timeout that leaves stale data on screen when the sidecar is
    // mid-respawn. Load BEFORE any consumer (launcher.js, app.html
    // inline blocks) so window.SeekDeepFetch is available everywhere.
    inject('fetch.js', 'SeekDeepFetch');
    // fix-action.js · shared retry/watch_events/hint helper used by both
    // app.html's launcher fix-button and setup-wizard.html's runFix. Single
    // source of truth so the .subscribe-vs-.on class of bug (Phase 1) can't
    // recur per-pane.
    inject('fix-action.js', 'SeekDeepFixAction');
    // playground.js targets chat.html only; auto-inject everywhere and let
    // the script no-op on non-chat pages (the file checks location.pathname).
    // Gated by SEEKDEEP_FEATURE_WEB_PLAYGROUND when the bot serves /gui
    // (env-flag readable via <meta name="seekdeep-feature-web-playground">
    // injected by gui_endpoints.py /token endpoint when ENABLED).
    // For v1 we default to ON since playground.js is small + self-gating.
    inject('playground.js', null);
    // stats.js · /stats/counts → [data-stat-*] cells (designer-shipped)
    inject('stats.js', null);
    // notify.js · shared banner + modal + toast primitive (designer-shipped).
    // Must load BEFORE ml-deps.js + model-install.js + long-task.js because
    // they all consume it.
    inject('notify.js', 'SeekDeepNotify');
    // long-task.js · page-wide live progress banner for deps.install /
    // doctor / self-update event streams. Loads after notify.js so the
    // banner primitive is available; idempotent module gate prevents
    // double-binding when a page also includes the script directly.
    inject('long-task.js', null);
    // ml-deps.js · first-use pip-install banner (designer-shipped)
    inject('ml-deps.js', null);
    // model-install.js · first-use HF/Ollama weight-download banner (designer-shipped)
    inject('model-install.js', null);
    // updater.js · Tauri-only update checker (pings GitHub releases API,
    // surfaces a notify.banner if a newer stable tag exists). Self-gates
    // to chat.html + Tauri context; harmless to inject everywhere.
    inject('updater.js', null);
    // launcher.js · wires app.html's launcher cards + Quick Actions to
    // the real /launcher/* + /unload + Tauri restart_sidecar paths. Polls
    // GET /launchers/status every 5s. Self-gates to app.html.
    inject('launcher.js', null);
  })();

  // ===== Kill-all-bot-instances action (right-click menu item) =============
  // When bot processes pile up (stale launcher PIDs, leaked node.exe from
  // a crashed sidecar restart, manual `node index.js` runs that escaped
  // the launcher), the launcher card's "stop" only kills the one we know
  // about. This nukes every node.exe running this repo's index.js. Scoped
  // server-side to the resolved bot_cwd path so unrelated Node projects
  // are never touched.
  async function killAllBotInstances() {
    const ok = await (window.SeekDeepConfirm
      ? window.SeekDeepConfirm({
          title: 'Kill all SeekDeep bot processes?',
          body: 'This force-kills every node.exe running this repo\'s index.js — '
              + 'including any that piled up outside the launcher. The Discord bot '
              + 'will go offline until you start it again.',
          confirmLabel: 'Kill all',
          destructive: true,
        })
      : Promise.resolve(window.confirm('Kill all SeekDeep bot processes?')));
    if (!ok) return;
    let body = null;
    try {
      const base = (window.SeekDeepResolveBase ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865')));
      const r = await fetch(base + '/launcher/bot/kill-all', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}' });
      body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.detail || body?.error || `HTTP ${r.status}`);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (window.SeekDeepNotify?.toast) {
        window.SeekDeepNotify.toast({ title: 'Kill-all failed', body: msg, tone: 'error' });
      } else {
        alert('Kill-all failed: ' + msg);
      }
      return;
    }
    const killedN = (body?.killed || []).length;
    const failedN = (body?.failed || []).length;
    const foundN  = body?.found ?? (killedN + failedN);
    const tone = failedN ? 'warning' : (killedN ? 'success' : 'info');
    const title = killedN === 0 && foundN === 0
      ? 'No bot processes found'
      : `Killed ${killedN} bot process${killedN === 1 ? '' : 'es'}`
        + (failedN ? ` (${failedN} failed)` : '');
    const detail = (body?.killed || []).slice(0, 6).map(k => `PID ${k.pid}`).join(', ')
      + (killedN > 6 ? `, +${killedN - 6} more` : '');
    if (window.SeekDeepNotify?.toast) {
      window.SeekDeepNotify.toast({ title, body: detail, tone });
    } else if (foundN === 0) {
      // No toast helper and nothing to report — stay silent.
    } else {
      alert(`${title}\n${detail}`);
    }
  }

  // ===== Generic POST + toast helper used by the context menu actions =====
  // Wraps fetch with token injection, error capture, and a SeekDeepNotify
  // toast for both success and failure. Returns the parsed JSON body so
  // callers can inspect counts / details if they want richer feedback.
  async function sdContextAction(opts) {
    const { method = 'POST', endpoint, body = null, label = 'Action',
            successTitle, successBody, errorTitle, tauriCommand = null,
            requireConfirm = null } = opts;
    if (requireConfirm) {
      const ok = await (window.SeekDeepConfirm
        ? window.SeekDeepConfirm(requireConfirm)
        : Promise.resolve(window.confirm(requireConfirm.title + '\n\n' + (requireConfirm.body || ''))));
      if (!ok) return null;
    }
    // Prefer Tauri command when available (matches the in-tray Restart sidecar
    // path so a single code path handles both invocations).
    if (tauriCommand) {
      try {
        const tauri = window.__TAURI__;
        if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
          window.__seekdeepRestartingUntil = Date.now() + 12000;
          await tauri.core.invoke(tauriCommand);
          if (window.SeekDeepNotify?.toast) {
            window.SeekDeepNotify.toast({
              tone: 'good',
              title: successTitle || (label + ' OK'),
              body: successBody || (tauriCommand + ' invoked'),
              ttl: 5000,
            });
          }
          return { ok: true, tauri: true };
        }
      } catch (err) {
        if (window.SeekDeepNotify?.toast) {
          window.SeekDeepNotify.toast({
            tone: 'bad',
            title: errorTitle || (label + ' failed'),
            body: String(err.message || err),
            ttl: 7000,
          });
        }
        return null;
      }
    }
    if (!endpoint) return null;
    try {
      const r = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body == null ? '{}' : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: AbortSignal.timeout(60000),
      });
      const parsed = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(parsed.detail || parsed.error || ('HTTP ' + r.status));
      if (window.SeekDeepNotify?.toast) {
        window.SeekDeepNotify.toast({
          tone: 'good',
          title: successTitle || (label + ' OK'),
          body: successBody || (parsed.note || 'done'),
          ttl: 5000,
        });
      }
      return parsed;
    } catch (err) {
      if (window.SeekDeepNotify?.toast) {
        window.SeekDeepNotify.toast({
          tone: 'bad',
          title: errorTitle || (label + ' failed'),
          body: String(err.message || err),
          ttl: 7000,
        });
      } else {
        alert((errorTitle || (label + ' failed')) + ': ' + (err.message || err));
      }
      return null;
    }
  }

  // ===== Custom contextmenu: SeekDeep-styled, no generic browser menu =====
  // Default Chromium right-click made the app feel like a webpage (Save As,
  // View Source, etc.). Replace with a branded menu that surfaces every
  // useful one-shot action: Restart / Kill / Flush / Smoke / Self-update /
  // Doctor / Reload .env, plus the usual Copy/Paste/Reload basics.
  (function installContextMenu() {
    if (document.getElementById('sd-ctx-style')) return;
    const st = document.createElement('style');
    st.id = 'sd-ctx-style';
    st.textContent = `
      .sd-ctx-menu{position:fixed;z-index:999999;min-width:180px;background:#0f1115;border:1px solid #2a2f3a;border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.5);font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6e9ef;user-select:none}
      .sd-ctx-item{padding:6px 12px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:8px}
      .sd-ctx-item:hover{background:#1d2330}
      .sd-ctx-item.disabled{color:#5a6170;cursor:default}
      .sd-ctx-item.disabled:hover{background:transparent}
      .sd-ctx-item.danger{color:#ff6868}
      .sd-ctx-item.danger:hover{background:#3a1212;color:#ffb0b0}
      .sd-ctx-sep{height:1px;background:#2a2f3a;margin:4px 0}
      .sd-ctx-kbd{margin-left:auto;font-size:11px;color:#8a92a3;padding:1px 5px;border:1px solid #2a2f3a;border-radius:3px}
    `;
    document.head.appendChild(st);
    let menu = null;
    function closeMenu() {
      if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
      menu = null;
    }
    function build(items, x, y) {
      closeMenu();
      menu = document.createElement('div');
      menu.className = 'sd-ctx-menu';
      items.forEach(it => {
        if (it === '-') {
          const sep = document.createElement('div');
          sep.className = 'sd-ctx-sep';
          menu.appendChild(sep);
          return;
        }
        const el = document.createElement('div');
        el.className = 'sd-ctx-item'
          + (it.disabled ? ' disabled' : '')
          + (it.danger ? ' danger' : '');
        const label = document.createElement('span');
        label.textContent = it.label;
        el.appendChild(label);
        if (it.kbd) {
          const k = document.createElement('span');
          k.className = 'sd-ctx-kbd';
          k.textContent = it.kbd;
          el.appendChild(k);
        }
        if (!it.disabled) {
          el.addEventListener('click', () => { closeMenu(); try { it.action(); } catch (e) {} });
        }
        menu.appendChild(el);
      });
      document.body.appendChild(menu);
      const r = menu.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      menu.style.left = Math.max(4, Math.min(x, vw - r.width - 4)) + 'px';
      menu.style.top  = Math.max(4, Math.min(y, vh - r.height - 4)) + 'px';
    }
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sel = (window.getSelection && window.getSelection().toString()) || '';
      const target = e.target;
      const tag = target && target.tagName;
      const isEditable = !!(target && (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable));
      const items = [];
      if (sel) {
        items.push({ label: 'Copy', kbd: 'Ctrl+C', action: () => {
          try { navigator.clipboard.writeText(sel); } catch (_) {
            try { document.execCommand('copy'); } catch (__) {}
          }
        }});
      }
      if (isEditable) {
        items.push({ label: 'Paste', kbd: 'Ctrl+V', action: async () => {
          try {
            const t = await navigator.clipboard.readText();
            if (target.setRangeText) {
              const start = target.selectionStart || 0;
              const end = target.selectionEnd || 0;
              target.setRangeText(t, start, end, 'end');
              target.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (target.isContentEditable) {
              document.execCommand('insertText', false, t);
            }
          } catch (_) {}
        }});
      }
      if (items.length) items.push('-');

      // PAGE
      items.push({ label: '↻ Reload page', kbd: 'F5', action: () => location.reload() });

      // SERVICES — every launcher action one click away from anywhere
      items.push('-');
      items.push({ label: '⟳ Restart bot', action: () => sdContextAction({
        endpoint: '/launcher/bot/restart', label: 'Bot restart',
        successTitle: 'Bot restarting',
        successBody: 'Discord-ready watchdog will auto-restart again if connect fails',
      })});
      items.push({ label: '⟳ Restart AI server', action: () => sdContextAction({
        tauriCommand: 'restart_sidecar',
        endpoint: '/launcher/ai-server/restart',  // fallback when not in Tauri
        label: 'AI server restart',
        successTitle: 'AI server restarting',
        successBody: '~5–10s; the bot stays up',
      })});
      items.push({ label: '⟳ Restart SearXNG', action: () => sdContextAction({
        endpoint: '/launcher/searxng/restart', label: 'SearXNG restart',
      })});
      items.push({ label: '▸ Restart whole stack', action: () => sdContextAction({
        endpoint: '/system/launch-all', label: 'Stack restart',
        successTitle: 'Stack relaunched',
        successBody: 'SearXNG → AI server → bot, in order',
      })});

      // MODELS + CONFIG
      items.push('-');
      items.push({ label: '⤓ Flush model cache', action: () => sdContextAction({
        endpoint: '/unload', body: { force: true }, label: 'Flush',
        successTitle: 'Models unloaded',
        successBody: 'Next request reloads from disk cache',
      })});
      items.push({ label: '⟳ Reload .env', action: () => sdContextAction({
        endpoint: '/config/reload', label: 'Reload .env',
        successTitle: 'Reloaded .env',
        successBody: 'In-memory config refreshed',
      })});

      // DIAGNOSTICS
      items.push('-');
      items.push({ label: '⟳ Smoke test', action: () => sdContextAction({
        endpoint: '/system/smoke', label: 'Smoke',
        successTitle: 'Smoke test ran',
        successBody: 'See banner / Logs viewer for details',
      })});
      items.push({ label: '⚕ Doctor (preflight)', action: () => sdContextAction({
        endpoint: '/system/doctor', label: 'Doctor',
        successTitle: 'Doctor finished',
        successBody: 'Open the wizard to see findings',
      })});
      items.push({ label: '⤴ Self-update from GitHub', action: () => sdContextAction({
        endpoint: '/system/self-update', label: 'Self-update',
        successTitle: 'Self-update started',
        successBody: 'AI server will auto-restart when files land',
        requireConfirm: {
          title: 'Self-update from GitHub?',
          body: 'Pulls latest local_ai_server.py + gui_endpoints.py + gui/ + scripts/ from main, writes them to the runtime dir, then auto-restarts the AI server.',
          confirmLabel: 'Update',
        },
      })});

      // DANGER — explicit confirm prompts on every entry here.
      items.push('-');
      items.push({ label: '↯ Kill all bot instances', danger: true, action: () => killAllBotInstances() });
      items.push({ label: '↯ Force kill entire stack', danger: true, action: () => sdContextAction({
        endpoint: '/system/kill-all', label: 'Force kill all',
        successTitle: 'Stack killed',
        successBody: 'bot + searxng force-killed · AI server kept (it\'s us)',
        requireConfirm: {
          title: 'Force-kill bot + SearXNG?',
          body: 'Hard kill, no graceful shutdown. AI server is NOT killed (it would terminate this request). Use the tray icon to bounce the AI server.',
          confirmLabel: 'Force kill',
          destructive: true,
        },
      })});

      build(items, e.clientX, e.clientY);
    }, true);
    document.addEventListener('mousedown', (e) => {
      if (menu && !menu.contains(e.target)) closeMenu();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (menu && e.key === 'Escape') { closeMenu(); e.stopPropagation(); }
    }, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  })();
})();
