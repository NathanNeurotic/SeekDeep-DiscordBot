/* SeekDeep · self-unregistering service worker.
 *
 * SeekDeep ships as a desktop app (Tauri shell). The GUI files are bundled
 * into the .msi, extracted to %APPDATA% on every boot, and served from
 * loopback. Caching them is pure downside — every release would land on
 * disk but never be seen because the SW would happily serve last week's
 * bytes from its precache, forcing users to manually "Clear site data."
 *
 * What this file is FOR now: cleaning up after itself. Anyone whose old
 * install registered the previous shell-caching SW will, on next boot:
 *   1. Hit chat.html (or any page) which now has no SW registration call
 *   2. This SW activates one last time
 *   3. The activate handler deletes every cache it owned and calls
 *      registration.unregister() — the SW removes itself from the
 *      browser
 *   4. clients.claim() forces immediate control of open tabs so the
 *      pages reload free of the SW's intercept
 *
 * Future installs will never register a worker (chat.html's inline script
 * stopped doing so). This file stays as a self-destruct safety net.
 */

self.addEventListener('install', () => {
  // Skip waiting so we activate immediately and don't have to wait for
  // the user to close every tab the old worker is controlling.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (_) { /* best-effort */ }
    try {
      // Claim control of open clients (e.g. an already-open chat.html tab)
      // so they immediately stop being intercepted by this SW.
      await self.clients.claim();
    } catch (_) { /* best-effort */ }
    try {
      // Tombstone: remove ourselves from the browser entirely. Next page
      // load won't see any SW at all.
      await self.registration.unregister();
    } catch (_) { /* best-effort */ }
    // Force open clients to reload so they pick up the now-uncached pages
    // immediately rather than running stale JS that was intercepted on
    // first paint. POST a "pls-reload" message instead of calling
    // c.navigate(c.url) — the latter wipes any unsaved form state in
    // memory.html / chat.html / app.html's Config pane. The receiving
    // page can listen for this message and decide WHEN to reload
    // (e.g. only if no dirty state, or after a beforeunload prompt).
    try {
      const all = await self.clients.matchAll({ type: 'window' });
      for (const c of all) {
        try { c.postMessage({ type: 'seekdeep:sw-cleaned', reload: true }); } catch (_) { /* best-effort */ }
      }
    } catch (_) { /* best-effort */ }
  })());
});

// During the brief window when an old install's SW is still in control
// (between activate firing and registration.unregister() resolving), any
// fetch event still routes through us. Pass through to the network with
// no caching so users don't see stale responses even during the transition.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request).catch(() => Response.error()));
});
