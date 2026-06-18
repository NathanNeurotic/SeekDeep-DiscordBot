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

  // Tauri serves bundled pages from tauri.localhost — server calls must target
  // the loopback API base, not the page origin (a relative fetch never reaches
  // the Python server in the desktop app). Mirrors api.page.js / app.page2.js.
  const BASE = (function () {
    try { if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase(); } catch (_) {}
    if (window.__TAURI__ || (window.location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    return (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
  })();

  function setError(msg) {
    const e = $('ev-error');
    if (!e) return;
    if (!msg) { e.textContent = ''; show(e, false); return; }
    e.textContent = msg;
    show(e, true);
  }

  async function getJSON(url) {
    const r = await fetch(BASE + url, { headers: { 'Accept': 'application/json' } });
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

  function renderEmojis(data, guildId) {
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
      tile.style.position = 'relative';
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
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ev-del';
      del.textContent = '×';
      del.title = 'Delete :' + e.name + ':';
      del.setAttribute('aria-label', 'Delete ' + e.name);
      del.style.cssText = 'position:absolute;top:3px;right:3px;width:20px;height:20px;line-height:17px;'
        + 'padding:0;border-radius:50%;border:1px solid rgba(255,90,90,.55);background:rgba(25,0,0,.74);'
        + 'color:#ff6b6b;font-size:14px;cursor:pointer;';
      del.addEventListener('click', () => deleteEmoji(guildId, e.id, e.name, tile));
      tile.appendChild(del);
      grid.appendChild(tile);
    });
  }

  async function loadEmojis(guildId) {
    setError('');
    const grid = $('ev-grid');
    const sum = $('ev-summary');
    const backup = $('ev-backup');
    const imp = $('ev-import');
    if (backup) backup.disabled = true;
    if (imp) imp.disabled = true;
    if (!guildId) { if (grid) grid.textContent = ''; if (sum) sum.textContent = ''; return; }
    if (sum) sum.textContent = 'Loading emojis…';
    if (grid) grid.textContent = '';
    try {
      const data = await getJSON('/emoji-vault/' + encodeURIComponent(guildId) + '/emojis');
      if (currentGuild !== guildId) return;  // a newer server selection won the race
      renderEmojis(data, guildId);
      if (backup) backup.disabled = !(data.count > 0);
      if (imp) imp.disabled = false;  // import is allowed even into an empty server
    } catch (err) {
      if (currentGuild !== guildId) return;
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
    if (backup) { backup.disabled = true; backup.textContent = 'Saving…'; }
    setError('');
    const result = $('ev-importresult');
    if (result) { result.className = 'ev-msg ev-hidden'; result.textContent = ''; }
    try {
      // save=1 -> the server writes the .zip to the user's Downloads folder and
      // returns its path. A server-side save is the reliable download here: the
      // Tauri WebView2 silently drops blob/anchor downloads, and the server runs
      // on the same machine as the GUI (loopback), so the file lands locally.
      const r = await fetch(BASE + '/emoji-vault/' + encodeURIComponent(guildId) + '/backup.zip?save=1', { headers: { 'Accept': 'application/json' } });
      let body = null; try { body = await r.json(); } catch (_) {}
      if (!r.ok || !body || body.ok === false) {
        throw new Error((body && (body.detail || body.error)) || ('HTTP ' + r.status));
      }
      // Only paint the result if we're still on the guild we backed up — the
      // save can take seconds and the user may have switched servers since.
      if (result && currentGuild === guildId) {
        result.className = 'ev-msg info';
        result.textContent = '✓ Backed up ' + (body.count != null ? body.count : '?') + ' emoji(s) → ' + (body.path || '(saved)');
      }
    } catch (err) {
      setError('Backup failed: ' + err.message);
    } finally {
      // Only restore THIS guild's button; if the user switched servers mid-build,
      // loadEmojis() already set the correct disabled state for the new one.
      if (backup) {
        backup.textContent = label || 'Save backup (.zip)';
        if (currentGuild === guildId) backup.disabled = false;
      }
    }
  }

  async function deleteEmoji(guildId, emojiId, name, tile) {
    if (!guildId || !emojiId) return;
    // In-app modal, not raw confirm() — WebView2 in the Tauri app suppresses
    // window.confirm (returns false, no dialog), which silently blocked deletes.
    // The two APIs take different args: SeekDeepConfirm wants an options object,
    // window.confirm wants a plain string (passing the object yields "[object
    // Object]"), so branch rather than `(SeekDeepConfirm || confirm)(opts)`.
    const ok = window.SeekDeepConfirm
      ? await window.SeekDeepConfirm({
          title: 'Delete :' + name + ':?',
          body: 'This permanently removes the emoji from this server and cannot be undone.',
          confirmLabel: 'Delete', destructive: true,
        })
      : window.confirm('Delete :' + name + ':?\nThis permanently removes the emoji from this server and cannot be undone.');
    if (!ok) return;
    setError('');
    try {
      const r = await fetch(BASE + '/emoji-vault/' + encodeURIComponent(guildId) + '/emojis/' + encodeURIComponent(emojiId), {
        method: 'DELETE', headers: { 'Accept': 'application/json' }
      });
      if (!r.ok) {
        let detail = 'HTTP ' + r.status;
        try { const j = await r.json(); detail = j.detail || j.error || detail; } catch (_) {}
        throw new Error(detail);
      }
      if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
      if (currentGuild === guildId) loadEmojis(guildId);  // refresh counts honestly
    } catch (err) {
      setError('Delete failed: ' + err.message);
    }
  }

  function showImportResult(res) {
    const box = $('ev-importresult');
    if (!box) return;
    const s = (res && res.summary) || { created: 0, skipped: 0, failed: 0 };
    let txt = 'Import: created ' + s.created + ' · skipped ' + s.skipped + ' · failed ' + s.failed + '.';
    const fails = (res && res.failed) || [];
    if (fails.length) {
      txt += ' Failures: ' + fails.slice(0, 8).map((f) => (f.name || '?') + ' (' + (f.error || 'error') + ')').join(', ')
        + (fails.length > 8 ? ', …' : '');
    }
    box.textContent = txt;
    box.classList.toggle('err', s.created === 0 && s.failed > 0);
    show(box, true);
  }

  async function importZip(guildId, file) {
    if (!guildId || !file) return;
    const imp = $('ev-import');
    const label = imp ? imp.textContent : '';
    if (imp) { imp.disabled = true; imp.textContent = 'Importing…'; }
    setError('');
    show($('ev-importresult'), false);
    try {
      // Raw .zip bytes as the body; nav.js attaches the GUI token to the POST.
      const r = await fetch(BASE + '/emoji-vault/' + encodeURIComponent(guildId) + '/import', { method: 'POST', body: file });
      let body = null;
      try { body = await r.json(); } catch (_) {}
      if (!r.ok) {
        const d = (body && (body.detail || body.error)) || ('HTTP ' + r.status);
        throw new Error(d);
      }
      showImportResult(body || {});
      if (currentGuild === guildId) loadEmojis(guildId);
    } catch (err) {
      setError('Import failed: ' + err.message);
    } finally {
      if (imp) { imp.textContent = label || 'Import .zip…'; if (currentGuild === guildId) imp.disabled = false; }
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
    const imp = $('ev-import');
    const impFile = $('ev-import-file');
    if (imp && impFile) {
      imp.addEventListener('click', () => { if (!imp.disabled) impFile.click(); });
      impFile.addEventListener('change', () => {
        const f = impFile.files && impFile.files[0];
        impFile.value = '';  // let the user re-pick the same file later
        if (f && currentGuild) importZip(currentGuild, f);
      });
    }
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
