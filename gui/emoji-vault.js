/* SeekDeep · emoji-vault.js
   Logic for gui/emoji-vault.html — the read-only Emoji Vault page. Talks to the
   token-gated GET /emoji-vault/* endpoints (Python -> Discord REST). External
   (not inline) so it adds nothing to the script-src 'unsafe-inline' debt, and
   uses addEventListener (no inline on*= handlers) so it stays CSP-clean. Self-
   gates: no-ops unless the emoji-vault page markup is present. nav.js's fetch
   interceptor auto-attaches X-SeekDeep-Token to /emoji-vault/* GETs. */
(function () {
  'use strict';
  if (!document.getElementById('ev-main')) return;
  if (window.__seekdeepEmojiVaultLoaded) return;
  window.__seekdeepEmojiVaultLoaded = true;

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.classList.toggle('ev-hidden', !on); };

  function setError(msg) {
    const e = $('ev-error');
    if (!e) return;
    if (!msg) { e.textContent = ''; show(e, false); return; }
    e.textContent = msg;
    show(e, true);
  }

  async function getJSON(url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok) {
      const detail = (body && (body.detail || body.error)) || ('HTTP ' + r.status);
      const err = new Error(detail);
      err.status = r.status;
      throw err;
    }
    return body || {};
  }

  let currentGuild = '';

  function renderEmojis(data) {
    const grid = $('ev-grid');
    const sum = $('ev-summary');
    if (sum) {
      sum.textContent = data.count
        ? (data.count + ' emoji' + (data.count === 1 ? '' : 's') + ' · ' + data.animated + ' animated · ' + data.static + ' static')
        : 'No custom emojis on this server.';
    }
    if (!grid) return;
    grid.textContent = '';
    (data.emojis || []).forEach((e) => {
      const tile = document.createElement('div');
      tile.className = 'ev-tile';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = e.url;
      img.alt = e.name;
      img.title = ':' + e.name + ':';
      img.addEventListener('error', () => { img.style.opacity = '0.25'; });
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = ':' + e.name + ':';
      tile.appendChild(img);
      tile.appendChild(nm);
      if (e.animated) {
        const a = document.createElement('div');
        a.className = 'anim';
        a.textContent = 'GIF';
        tile.appendChild(a);
      }
      grid.appendChild(tile);
    });
  }

  async function loadEmojis(guildId) {
    setError('');
    const grid = $('ev-grid');
    const sum = $('ev-summary');
    const backup = $('ev-backup');
    if (backup) backup.disabled = true;
    if (!guildId) { if (grid) grid.textContent = ''; if (sum) sum.textContent = ''; return; }
    if (sum) sum.textContent = 'Loading emojis…';
    if (grid) grid.textContent = '';
    try {
      const data = await getJSON('/emoji-vault/' + encodeURIComponent(guildId) + '/emojis');
      renderEmojis(data);
      if (backup) backup.disabled = !(data.count > 0);
    } catch (err) {
      if (sum) sum.textContent = '';
      setError('Could not load emojis: ' + err.message);
    }
  }

  async function downloadBackup() {
    // Capture the active guild up front: the user can switch servers mid-build
    // (the fetch can take seconds on emoji-heavy servers). Using the snapshot
    // keeps the filename + the finally-block state tied to the guild we backed up.
    const guildId = currentGuild;
    if (!guildId) return;
    const backup = $('ev-backup');
    const label = backup ? backup.textContent : '';
    if (backup) { backup.disabled = true; backup.textContent = 'Building…'; }
    setError('');
    try {
      const r = await fetch('/emoji-vault/' + encodeURIComponent(guildId) + '/backup.zip');
      if (!r.ok) {
        let detail = 'HTTP ' + r.status;
        try { const j = await r.json(); detail = j.detail || j.error || detail; } catch (_) {}
        throw new Error(detail);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'emoji-backup-' + guildId + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      setError('Backup failed: ' + err.message);
    } finally {
      // Only restore THIS guild's button; if the user switched servers mid-build,
      // loadEmojis() already set the correct disabled state for the new one.
      if (backup) {
        backup.textContent = label || 'Download backup (.zip)';
        if (currentGuild === guildId) backup.disabled = false;
      }
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
      loadEmojis(currentGuild);
    }
  }

  async function init() {
    // Feature gate — defensive: the nav hides the link, but the URL can be
    // opened directly. GET /config/features is open (no token).
    let enabled = false;
    try {
      const feats = await getJSON('/config/features');
      enabled = !!(feats && feats.features && feats.features.SEEKDEEP_FEATURE_EMOJI_VAULT);
    } catch (_) { enabled = false; }

    if (!enabled) {
      show($('ev-disabled'), true);
      show($('ev-main'), false);
      return;
    }
    show($('ev-disabled'), false);
    show($('ev-main'), true);

    const sel = $('ev-guild');
    const backup = $('ev-backup');
    if (backup) backup.addEventListener('click', downloadBackup);
    if (sel) {
      sel.addEventListener('change', () => {
        currentGuild = sel.value || '';
        loadEmojis(currentGuild);
      });
    }

    try {
      const data = await getJSON('/emoji-vault/guilds');
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
