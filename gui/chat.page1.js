  // No service worker. Caching a GUI that ships with the .msi and is served
  // from loopback is pure downside: every release would land on disk but
  // not be seen because the SW would happily serve last week's bytes from
  // its precache. Instead: actively UNREGISTER any SW left over from prior
  // installs and wipe all CacheStorage entries. Idempotent — no-op on a
  // fresh install. Catches any SW that got registered before this change
  // shipped + protects against future regressions.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      for (const r of regs) r.unregister().catch(() => {});
    }).catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => {});
  }
