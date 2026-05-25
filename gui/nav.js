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

  // ===== Token auth: auto-inject X-SeekDeep-Token on POSTs to our server =====
  // Done as a fetch monkey-patch so designer-shipped HTMLs (app.html, chat.html
  // etc) don't need to know about auth — they just call fetch() and the header
  // appears. Keeps the auth concern out of the design surfaces.
  (function installTokenInterceptor() {
    const TOKEN_HEADER = 'X-SeekDeep-Token';
    const origFetch = window.fetch.bind(window);
    function getBase() {
      return (location.protocol === 'http:' || location.protocol === 'https:')
        ? location.origin : 'http://127.0.0.1:7865';
    }
    let cached = null;          // '' = tried and got nothing; null = not tried yet
    let inflight = null;        // promise of in-flight /token fetch
    async function fetchToken() {
      if (cached !== null) return cached;
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
        cached = '';
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
      return url.indexOf(getBase()) === 0;
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
    window.fetch = async function patchedFetch(input, init) {
      init = init || {};
      const method = (init.method || (input && input.method) || 'GET').toUpperCase();
      const url = urlString(input);
      if (method === 'POST' && url && isOurServer(url)) {
        const tok = await fetchToken();
        if (tok) {
          init.headers = ensureHeader(init.headers, TOKEN_HEADER, tok);
        }
      }
      return origFetch(input, init);
    };
  })();

  const PAGES = [
    { id: 'index',        title: 'Hub',                 path: 'index.html',        glyph: '⌂', meta: '01 · home' },
    { id: 'landing',      title: 'Landing',             path: 'landing.html',      glyph: '◐', meta: '02 · marketing' },
    { id: 'app',          title: 'Control Center',      path: 'app.html',          glyph: '⌘', meta: '03 · 10 modules · wired' },
    { id: 'chat',         title: 'Chat Client',         path: 'chat.html',         glyph: '▸', meta: '04 · wired' },
    { id: 'installer',    title: 'Installer',           path: 'installer.html',    glyph: '⚙', meta: '05 · 9-step wizard · wired' },
    { id: 'docs',         title: 'Docs',                path: 'docs.html',         glyph: '▤', meta: '06 · 109 commands' },
    { id: 'roadmap',      title: 'Roadmap',             path: 'roadmap.html',      glyph: '▦', meta: '07 · PLANNED.md' },
    { id: 'api',          title: 'API Explorer',        path: 'api.html',          glyph: '⚡', meta: '08 · live + mock' },
    { id: 'architecture', title: 'Architecture',        path: 'architecture.html', glyph: '⌬', meta: '09 · system map' },
    { id: 'boot',         title: 'Boot sequence',       path: 'boot.html',         glyph: '◉', meta: '10 · splash' },
    { id: 'changelog',    title: 'Changelog',           path: 'changelog.html',    glyph: '⊞', meta: '11 · v10.x history' },
    { id: 'memory',       title: 'Memory · preview',    path: 'memory.html',       glyph: '⌗', meta: '12 · roadmap mock' },
    { id: 'mobile',       title: 'Mobile',              path: 'mobile.html',       glyph: '▢', meta: '13 · phone mocks' },
    { id: 'tour',         title: 'Tour',                path: 'tour.html',         glyph: '⊕', meta: '14 · guided' },
    { id: 'pitch',        title: 'Pitch deck',          path: 'pitch.html',        glyph: '◊', meta: '15 · 9 slides' },
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
        <div class="label"><span>JUMP ANYWHERE</span><em>SEEKDEEP · 15 SURFACES</em></div>
        <input id="sdJumpSearch" type="text" placeholder="Type to filter · ↑↓ to navigate · ↵ to jump" autocomplete="off" />
      </div>
      <div class="sd-jump-list" id="sdJumpList"></div>
      <div class="sd-jump-foot">
        <span><kbd>⌘K</kbd> open · <kbd>Esc</kbd> close · <kbd>↵</kbd> jump</span>
        <span>v10.35 · LOCAL</span>
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
      const base = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
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
      const base = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
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
  async function checkGpuMode() {
    const base = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(2000), cache: 'no-store' });
      if (!r.ok) return;
      const h = await r.json();
      const noCuda = h.cuda_available === false;
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
  // Explicit-only modal trigger. Callers (action handlers, user clicks)
  // can invoke this when /config/status flags needs_setup. We deliberately
  // do NOT auto-pop on every page load — the user finds that nagging.
  //
  // Surfaces can call it on demand, e.g.:
  //   if ((await fetch('/config/status').then(r => r.json())).needs_setup) {
  //     await window.SeekDeepPrompt.promptForMissing();
  //   }
  // or for a specific failure:
  //   if (resp.status === 400 && resp.error === 'missing_keys') {
  //     await window.SeekDeepPrompt.collect(resp.required_keys);
  //   }
  window.SeekDeepPrompt.promptForMissing = async function () {
    const base = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
    try {
      const r = await fetch(base + '/config/status', { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return null;
      const s = await r.json();
      if (!s.needs_setup) return {};
      const fields = s.missing_required.map(m => ({
        key: m.key, description: m.description, kind: m.kind, required: true, value: m.value || '',
      }));
      return await window.SeekDeepPrompt.open(fields, {
        label: '▸ SETUP REQUIRED',
        title: 'SeekDeep needs a few values before it can run',
        desc: 'These keys are missing or still placeholders in your <span style="color:var(--cyan-1, #2dd4ff);">.env</span>. Save them here and the bot will be ready.',
      });
    } catch { return null; }
  };
  // GPU banner is informational + non-blocking; safe to run on load + every 60s.
  setTimeout(checkGpuMode, 400);
  setInterval(checkGpuMode, 60_000);

  // Auto-load events.js (WebSocket pub/sub for live server events). Done as a
  // dynamic <script> append so designer-shipped HTMLs only need to include
  // nav.js — they get window.SeekDeepEvents for free without modification.
  // Skipped if a page already loaded events.js explicitly, or if we're not
  // being served from a web origin (file:// would block WS anyway).
  (function autoLoadEvents() {
    if (window.SeekDeepEvents) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const existing = document.querySelector('script[src$="events.js"], script[src*="/events.js"]');
    if (existing) return;
    const navScript = document.querySelector('script[src$="nav.js"], script[src*="/nav.js"]');
    const base = navScript ? navScript.src.replace(/nav\.js(\?.*)?$/, '') : '';
    const s = document.createElement('script');
    s.src = base + 'events.js';
    s.defer = true;
    document.head.appendChild(s);
  })();
})();
