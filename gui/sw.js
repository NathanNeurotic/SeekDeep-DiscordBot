/* SeekDeep · chat shell service worker (Task 11).
 *
 * Scope: chat.html ONLY. Other pages don't register this SW.
 *
 * Strategy:
 *   - Cache the static shell (chat.html, styles.css, nav.js, the three maintainer-owned
 *     siblings nav.js auto-loads, manifest.json, the mark webp, the two Google Fonts CSS
 *     endpoints) on install so the chat client loads offline.
 *   - All /chat, /image, /vision, /health and other API calls bypass the cache entirely —
 *     they're always network-first, never staled. (We don't want to serve a stale model
 *     response, ever.)
 *   - Same for /events (WebSocket): SW doesn't intercept those.
 *
 * Path convention: SHELL paths are RELATIVE to this worker's URL. We register the worker
 * at gui/sw.js, so 'chat.html' resolves to gui/chat.html. If you ever move sw.js to repo
 * root or to a subdirectory, every entry in SHELL needs to be adjusted accordingly.
 *
 * Update: bump CACHE_VERSION when shipping a new chat.html. Old caches are pruned on
 * the next 'activate' phase.
 */

const CACHE_VERSION = 'seekdeep-shell-v10.35.0-8';
const SHELL = [
  'chat.html',
  'styles.css',
  'nav.js',
  // Maintainer-owned siblings auto-loaded by nav.js's autoLoadSiblings tail.
  // Without these in the cache, an offline chat.html load misses the token
  // interceptor + the live event bus + the version-rewriter + the playground
  // composer wiring — i.e. the page renders but the playground does nothing.
  'events.js',
  'version.js',
  'playground.js',
  'stats.js',
  // notify.js · shared banner / modal / toast primitive (designer zip 43);
  // ml-deps + model-install consumers reach for it via SeekDeepNotify.
  'notify.js',
  'ml-deps.js',
  'model-install.js',
  'updater.js',
  'launcher.js',
  'seekdeep-loading.html',
  // add-model.html · 4-step wizard (designer zip 43); model-install.js's
  // banner deep-links into it for the "Open the full wizard" CTA.
  'add-model.html',
  'manifest.json',
  'assets/seekdeep-mark.webp',
  // Google Fonts CSS — the font files themselves come from fonts.gstatic.com and are
  // cache-controlled by the browser; we just cache the CSS index so the @font-face
  // declarations stay resolvable offline.
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // addAll is all-or-nothing — if any fail (e.g. offline first install), we still want
    // the SW to install so subsequent fetches can warm the cache opportunistically.
    await Promise.allSettled(SHELL.map(u => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Bypass list — anything matching these patterns is always network, never cache.
const BYPASS_RE = /\/(chat|image|img2img|instruct-pix2pix|inpaint|upscale|vision|chart|unload|health|gpu|logs|launcher|launchers|config|model|route|events|token|memory|persona|stats|archive|ml_deps|deps|models)(\b|\/|\?)/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache API/dynamic endpoints.
  if (BYPASS_RE.test(url.pathname)) return;

  // Never cache WebSocket upgrades.
  if (req.headers.get('upgrade') === 'websocket') return;

  // Same-origin shell or whitelisted CDN.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req, { ignoreSearch: false });
    // Cache-first for the shell, with revalidation in the background.
    if (cached) {
      // Fire-and-forget revalidation
      fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()); }).catch(() => {});
      return cached;
    }
    try {
      const r = await fetch(req);
      if (r && r.ok && (url.origin === self.location.origin || url.host.endsWith('googleapis.com') || url.host.endsWith('gstatic.com'))) {
        cache.put(req, r.clone()).catch(() => {});
      }
      return r;
    } catch (e) {
      // Network failed and we have nothing cached — let it surface as a normal network
      // failure so the page can show the offline state itself.
      return Response.error();
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'sd:skip-waiting') self.skipWaiting();
});
