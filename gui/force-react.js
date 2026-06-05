/* SeekDeep · force-react.js
   Logic for gui/force-react.html — configures the Force React picker. Talks to the
   token-gated /force-react/* endpoints (config read/write is a local data file; the
   server + emoji lists come from Discord REST). External (not inline) so it adds
   nothing to the script-src 'unsafe-inline' debt; all addEventListener (CSP-clean).
   nav.js's fetch interceptor auto-attaches X-SeekDeep-Token to /force-react/* GETs
   and to the POST. Self-gates: no-ops unless the page markup is present. */
(function () {
  'use strict';
  if (!document.getElementById('fr-main')) return;
  if (window.__seekdeepForceReactLoaded) return;
  window.__seekdeepForceReactLoaded = true;

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.classList.toggle('fr-hidden', !on); };
  let currentGuild = '';
  let emojiCount = 0;

  function setError(msg) {
    const e = $('fr-error');
    if (!e) return;
    if (!msg) { e.textContent = ''; show(e, false); return; }
    e.textContent = msg;
    show(e, true);
  }
  function flashSaved() { const s = $('fr-saved'); if (!s) return; show(s, true); setTimeout(() => show(s, false), 2500); }

  async function getJSON(url, opts) {
    const r = await fetch(url, opts || {});
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok) {
      const d = (body && (body.detail || body.error)) || ('HTTP ' + r.status);
      const e = new Error(d);
      e.status = r.status;
      throw e;
    }
    return body || {};
  }

  function checkedIds() {
    return Array.from(document.querySelectorAll('#fr-grid input[type=checkbox]:checked')).map((c) => c.value);
  }
  function setAll(on) {
    document.querySelectorAll('#fr-grid input[type=checkbox]').forEach((c) => { c.checked = on; });
  }

  function renderEmojis(emojis, allowedIds) {
    emojiCount = emojis.length;
    if ($('fr-poolcount')) $('fr-poolcount').textContent = emojis.length + ' emoji';
    const grid = $('fr-grid');
    if (!grid) return;
    grid.textContent = '';
    // Empty allow-list = "all allowed".
    const allowAll = !allowedIds || allowedIds.length === 0;
    const allowed = new Set(allowedIds || []);
    emojis.forEach((e) => {
      const tile = document.createElement('label');
      tile.className = 'fr-tile';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = e.id;
      cb.checked = allowAll || allowed.has(e.id);
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = e.url;
      img.alt = e.name;
      img.addEventListener('error', () => { img.style.opacity = '0.25'; });
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = ':' + e.name + ':';
      nm.title = ':' + e.name + ':';
      tile.appendChild(cb);
      tile.appendChild(img);
      tile.appendChild(nm);
      grid.appendChild(tile);
    });
    show($('fr-pool'), true);
  }

  async function loadGuild(guildId) {
    setError('');
    show($('fr-pool'), false);
    if ($('fr-save')) $('fr-save').disabled = true;
    if (!guildId) return;
    try {
      const [cfg, emo] = await Promise.all([
        getJSON('/force-react/' + encodeURIComponent(guildId) + '/config'),
        getJSON('/force-react/' + encodeURIComponent(guildId) + '/emojis'),
      ]);
      if (currentGuild !== guildId) return;  // a newer guild selection won the race
      const c = (cfg && cfg.config) || {};
      if ($('fr-cap')) $('fr-cap').value = c.cap != null ? c.cap : 3;
      if ($('fr-cooldown')) $('fr-cooldown').value = Math.round((c.cooldown_ms || 0) / 1000);
      renderEmojis((emo && emo.emojis) || [], c.allowed_emoji_ids || []);
      if ($('fr-save')) $('fr-save').disabled = false;
    } catch (err) {
      if (currentGuild !== guildId) return;  // stale request lost the race; ignore its error
      setError('Could not load: ' + err.message + (err.status === 503 ? ' (is DISCORD_TOKEN set?)' : ''));
    }
  }

  async function save() {
    const guildId = currentGuild;
    if (!guildId) return;
    const btn = $('fr-save');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    setError('');
    const capRaw = parseInt(($('fr-cap') || {}).value, 10);
    const cap = Math.max(1, Math.min(20, isNaN(capRaw) ? 3 : capRaw));
    const cooldownMs = Math.max(0, (parseInt(($('fr-cooldown') || {}).value, 10) || 0) * 1000);
    const checked = checkedIds();
    // All checked => store [] (= all, and future emoji auto-included).
    const allowed = (emojiCount > 0 && checked.length === emojiCount) ? [] : checked;
    try {
      await getJSON('/force-react/' + encodeURIComponent(guildId) + '/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cap, cooldown_ms: cooldownMs, allowed_emoji_ids: allowed }),
      });
      flashSaved();
    } catch (err) {
      setError('Save failed: ' + err.message);
    } finally {
      if (btn) { btn.textContent = label || 'Save'; btn.disabled = (currentGuild !== guildId) ? btn.disabled : false; }
    }
  }

  function populateGuilds(sel, guilds) {
    sel.textContent = '';
    if (!guilds.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No servers found';
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Select a server…';
    sel.appendChild(ph);
    guilds.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.name;
      sel.appendChild(o);
    });
    if (guilds.length === 1) {
      sel.value = guilds[0].id;
      currentGuild = guilds[0].id;
      loadGuild(currentGuild);
    }
  }

  async function init() {
    let enabled = false;
    try {
      const f = await getJSON('/config/features');
      enabled = !!(f && f.features && f.features.SEEKDEEP_FEATURE_FORCE_REACT);
    } catch (_) { enabled = false; }
    if (!enabled) {
      show($('fr-disabled'), true);
      show($('fr-main'), false);
      return;
    }
    show($('fr-disabled'), false);
    show($('fr-main'), true);

    const sel = $('fr-guild');
    if (sel) sel.addEventListener('change', () => { currentGuild = sel.value || ''; loadGuild(currentGuild); });
    if ($('fr-save')) $('fr-save').addEventListener('click', save);
    if ($('fr-all')) $('fr-all').addEventListener('click', () => setAll(true));
    if ($('fr-none')) $('fr-none').addEventListener('click', () => setAll(false));

    try {
      const data = await getJSON('/force-react/guilds');
      if (sel) populateGuilds(sel, (data && data.guilds) || []);
    } catch (err) {
      if (sel) {
        sel.textContent = '';
        const o = document.createElement('option');
        o.value = '';
        o.textContent = 'Error loading servers';
        sel.appendChild(o);
        sel.disabled = true;
      }
      setError('Could not load servers: ' + err.message + (err.status === 503 ? ' (is DISCORD_TOKEN set?)' : ''));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
