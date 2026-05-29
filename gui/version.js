/* SeekDeep version.js
 * ===================
 * Single source of truth: every page renders the actual server version
 * instead of a hardcoded literal. Fetches /health once on load, swaps
 * every [data-version] element's textContent with the value.
 *
 * Auto-loaded by nav.js (alongside events.js), so pages just need to
 * mark their version cells:
 *
 *   <span data-version>v10.35.6</span>
 *
 * The literal text inside the element is the static fallback that shows
 * if /health is unreachable (e.g. when opening the file directly without
 * the server running). When the fetch succeeds, the text is replaced.
 *
 * /health returns a `version` field sourced from package.json so the
 * Node bot, the FastAPI side-car, and the GUI are guaranteed to agree.
 *
 * To force the prefix, set data-version-prefix="v":
 *   <span data-version data-version-prefix="v">v10.35.6</span>
 * If /health.version is "10.35", the element becomes "v10.35".
 *
 * To suppress the prefix entirely, use data-version-raw:
 *   <span data-version data-version-raw>10.35</span>
 */

(function () {
  'use strict';
  if (window.SeekDeepVersion) return;

  const state = {
    version: null,
    fetched: false,
  };

  function applyTo(el) {
    if (!state.version) return;
    // Skip outer elements that have a [data-version] descendant — they're
    // wrapper pills like <span class="pill" data-version>v10.35 · LOCAL</span>
    // where the inner <span data-version>v10.35.6</span> is the real cell.
    // Without this guard, setting textContent on the wrapper would wipe the
    // " · LOCAL" suffix (and any other siblings). The inner node still gets
    // rewritten via the descendant pass.
    if (el.querySelector('[data-version]')) return;
    const raw = el.hasAttribute('data-version-raw');
    const prefix = el.getAttribute('data-version-prefix');
    let text = state.version;
    if (!raw) {
      // Honor explicit prefix, else default to 'v' if version starts with a digit
      if (prefix != null) text = prefix + text;
      else if (/^\d/.test(text)) text = 'v' + text;
    }
    el.textContent = text;
  }

  function applyAll() {
    document.querySelectorAll('[data-version]').forEach(applyTo);
  }

  function resolveBase() {
    if (typeof window === 'undefined') return 'http://127.0.0.1:7865';
    if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  }

  async function fetchOnce() {
    const base = resolveBase();
    try {
      const r = await fetch(base + '/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j.version === 'string') {
          state.version = j.version;
          state.fetched = true;
          applyAll();
          return true;
        }
      }
    } catch {}
    return false;
  }

  // Persistent retry loop. The previous one-shot fetch left the hardcoded
  // fallback in every pill for the rest of the session when /health was
  // unreachable at page-load time (common case: AI server is mid-respawn
  // during the install→launch transition). Backoff 1s → 2s → 4s → 8s → 16s,
  // cap 30s; resets to 1s on document.visibilitychange so the version pill
  // refreshes the moment the user comes back to the window after fixing
  // whatever was wrong with the sidecar.
  let attempt = 0;
  let timer = null;
  function nextDelay() {
    const base = Math.min(30, Math.pow(2, attempt));
    attempt += 1;
    return base * 1000;
  }
  function scheduleRetry() {
    if (state.fetched) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const ok = await fetchOnce();
      if (!ok) scheduleRetry();
    }, nextDelay());
  }
  async function kick() {
    if (state.fetched) return;
    attempt = 0;
    if (timer) { clearTimeout(timer); timer = null; }
    const ok = await fetchOnce();
    if (!ok) scheduleRetry();
  }

  window.SeekDeepVersion = {
    get: () => state.version,
    refresh: () => { state.fetched = false; attempt = 0; return kick(); },
    applyAll,
  };

  // Kick off slightly after page load so [data-version] elements added late
  // by other scripts get caught.
  setTimeout(kick, 100);

  // Refresh when the tab regains focus — covers the "I fixed the sidecar in
  // another window, come back, why is the version still wrong" path.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !state.fetched) {
        attempt = 0;
        kick();
      }
    });
  }
})();
