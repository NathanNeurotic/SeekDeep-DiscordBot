/* SeekDeep version.js
 * ===================
 * Single source of truth: every page renders the actual server version
 * instead of a hardcoded literal. Fetches /health once on load, swaps
 * every [data-version] element's textContent with the value.
 *
 * Auto-loaded by nav.js (alongside events.js), so pages just need to
 * mark their version cells:
 *
 *   <span data-version>v10.35</span>
 *
 * The literal text inside the element is the static fallback that shows
 * if /health is unreachable (e.g. when opening the file directly without
 * the server running). When the fetch succeeds, the text is replaced.
 *
 * /health returns a `version` field sourced from package.json so the
 * Node bot, the FastAPI side-car, and the GUI are guaranteed to agree.
 *
 * To force the prefix, set data-version-prefix="v":
 *   <span data-version data-version-prefix="v">v10.35</span>
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

  async function fetchVersion() {
    if (state.fetched) return state.version;
    state.fetched = true;
    // Resolver lives in nav.js; falls back to inline detection that
    // accounts for Tauri 2 on Windows (http://tauri.localhost origin).
    const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function')
      ? window.SeekDeepResolveBase()
      : ((typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost'))
          ? 'http://127.0.0.1:7865'
          : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
    try {
      const r = await fetch(base + '/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j.version === 'string') {
          state.version = j.version;
          applyAll();
          return state.version;
        }
      }
    } catch {}
    // Fall through: leave the hardcoded fallback text in place.
    return null;
  }

  window.SeekDeepVersion = {
    get: () => state.version,
    refresh: () => { state.fetched = false; return fetchVersion(); },
    applyAll,
  };

  // Defer slightly so [data-version] elements added late by other scripts
  // also get caught.
  setTimeout(fetchVersion, 100);
})();
