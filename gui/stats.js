/* SeekDeep · /stats/counts consumer.

   Auto-injected by nav.js's autoLoadSiblings tail (alongside events.js,
   version.js, playground.js). Fetches GET /stats/counts once on load
   and rewrites every [data-stat-<key>] element's text with the live
   count from the response. The static literal between the tags stays
   as the fallback when the backend is unreachable.

   Schema (see INTEGRATION.md § 3.8):
     { ok, smoke_tests, gui_smoke_tests, releases, commands, surfaces,
       generated_at, sources }

   Designer adoption (per § 3.8):
     <span data-stat-smoke_tests>274</span>
     <span data-stat-releases>35</span>
     <span data-stat-commands>109</span>
     <span data-stat-surfaces>18</span>

   Each attribute name corresponds to a key on the response.
*/
(function () {
  'use strict';
  if (window.__seekdeepStatsLoaded) return;
  window.__seekdeepStatsLoaded = true;

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

  function apply(data) {
    if (!data || typeof data !== 'object') return 0;
    let rewritten = 0;
    // Iterate every key on the payload and rewrite matching data-stat-<key>
    // cells. Skips boolean / null / object values so we don't paint "true"
    // into a number cell.
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (v == null || typeof v === 'object' || typeof v === 'boolean') continue;
      document.querySelectorAll('[data-stat-' + k + ']').forEach((el) => {
        el.textContent = String(v);
        rewritten++;
      });
    }
    return rewritten;
  }

  async function probe() {
    try {
      const r = await fetch(BASE + '/stats/counts', {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return;
      const d = await r.json();
      const n = apply(d);
      window.SeekDeepStats = d;
      if (n > 0) console.log('[SeekDeep stats] rewrote ' + n + ' cell(s) from /stats/counts');
    } catch {
      // Silent fallback — static literals between the tags remain visible.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', probe, { once: true });
  } else {
    probe();
  }
})();
