  // Model manager · keep-resident toggles (self-contained, surfaced on the Model
  // pane so users don't hunt for them in Config). Hydrate from /config; POST the
  // single changed LOCAL_*_KEEP_RESIDENT key on toggle (nav.js adds the token).
  (function () {
    // Tauri-aware loopback base — window.SEEKDEEP_BASE was never a real global
    // (the SEEKDEEP_BASE consts elsewhere are block-scoped), so this used to always
    // fall back to location.origin = http://tauri.localhost in the app and the
    // toggles never reached the server. Use the shared resolver like every other page.
    var base = (typeof window.SeekDeepResolveBase === 'function')
      ? window.SeekDeepResolveBase()
      : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')
          ? 'http://127.0.0.1:7865'
          : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
    var ctls = Array.prototype.slice.call(document.querySelectorAll('[data-resident-key]'));
    if (!ctls.length) return;
    function toast(tone, title, body) {
      try { if (window.SeekDeepNotify && window.SeekDeepNotify.toast) window.SeekDeepNotify.toast({ tone: tone, title: title, body: body, ttl: 6000 }); } catch (e) {}
    }
    function truthy(v) { v = String(v == null ? '' : v).toLowerCase(); return v === 'on' || v === 'true' || v === '1' || v === 'yes'; }
    fetch(base + '/config', { signal: AbortSignal.timeout(5000) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var env = (d && d.env) || {};
        ctls.forEach(function (t) { t.classList.toggle('on', truthy(env[t.getAttribute('data-resident-key')])); });
      })
      .catch(function () {});
    ctls.forEach(function (t) {
      t.addEventListener('click', function () {
        var key = t.getAttribute('data-resident-key');
        var on = !t.classList.contains('on');
        t.classList.toggle('on', on);
        var upd = {}; upd[key] = on ? 'on' : 'off';
        fetch(base + '/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: upd }),
          signal: AbortSignal.timeout(8000),
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          toast('good', 'Saved', key + ' = ' + (on ? 'on' : 'off') + ' · restart the AI server to apply.');
        }).catch(function (e) {
          t.classList.toggle('on', !on);
          toast('bad', 'Save failed', String((e && e.message) || e));
        });
      });
    });
  })();

/* Delegated handlers — replace the inline onclick/onchange (CSP). Toggle
   switches carry data-toggle-dirty; dirty-tracked inputs carry
   data-change-dirty. window.markDirty is defined in app.page2.js and resolved
   at event time, so load order is irrelevant. Event delegation on document
   needs no elements present at attach time. */
(function () {
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle-dirty]');
    if (t) { t.classList.toggle('on'); if (window.markDirty) window.markDirty(t); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.matches('[data-change-dirty]') && window.markDirty) window.markDirty(e.target);
  });
})();
