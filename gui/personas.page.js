/* ============================================================
   Persona manager · GUI surface for data/custom-personas.json
   ============================================================
   Backend contract:
     GET    /personas                → { ok, builtin:[{slug,description}],
                                          custom:[{slug,tone,updatedAt}], count, max }
     POST   /personas { slug, tone } → create / update a custom persona
     DELETE /personas/{slug}         → remove a custom persona (404 if built-in/absent)
     GET    /persona                 → { ok, valid_personas, env_default, global,
                                          effective_global, channels_count, guilds_count }
     POST   /persona { scope, persona | action:'reset', channel_id?, guild_id? }

   GET /personas + GET /persona are open. Writes (POST/DELETE) are token-gated;
   nav.js's patched fetch attaches X-SeekDeep-Token automatically. If the server
   is unreachable the page renders a clearly-labelled OFFLINE placeholder and
   flips to BACKEND LIVE on the first 200.
*/
(function () {
  const $ = (s, r = document) => r.querySelector(s);

  const SLUG_MAX = 32;
  const TONE_MIN = 2;
  const TONE_MAX = 2000;
  const SLUG_RE  = /^[a-z0-9_-]{2,32}$/;
  // Mirror index.js + gui_endpoints.py so the form gives the same verdict the
  // server will (instant feedback; the server stays the authority).
  const RESERVED = new Set(['reset', 'show', 'create', 'remove', 'list', 'channel', 'server', 'guild']);
  const BUILTIN_SLUGS = ['neurotic', 'unsettling', 'clinical', 'chaotic'];
  const BUILTIN_FALLBACK_DESC = {
    neurotic:   'Anxious over-thinker (the default).',
    unsettling: 'Quietly ominous, faintly wrong.',
    clinical:   'Cold, precise, minimal warmth.',
    chaotic:    'Manic and unpredictable.',
  };

  const state = {
    live: false,
    builtin: [],     // [{slug, description}]
    custom: [],      // [{slug, tone, updatedAt}]
    assign: null,    // GET /persona body
    editingSlug: null,
  };

  // --- helpers ------------------------------------------------------
  function base() {
    if (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')) {
      return 'http://127.0.0.1:7865';
    }
    return (location.protocol === 'http:' || location.protocol === 'https:')
      ? location.origin
      : 'http://127.0.0.1:7865';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtAgo(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (isNaN(t)) return '—';
    const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function toast(tone, title, body) {
    const fn = (window.SeekDeepNotify && window.SeekDeepNotify.toast) || ((o) => alert(o.title));
    fn({ tone, title, body, ttl: tone === 'bad' ? 6500 : 4000 });
  }
  async function safeGet(url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  // Write helper — resolves to parsed JSON on success, throws Error(detail) on
  // any failure so callers can surface the server's 4xx message verbatim.
  async function writeJson(method, url, bodyObj) {
    const opts = { method, signal: AbortSignal.timeout(8000) };
    if (bodyObj !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(bodyObj);
    }
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      const msg = (j && (j.detail || j.error)) || ('HTTP ' + r.status);
      throw new Error(msg);
    }
    return j || { ok: true };
  }

  function personaSlugs() {
    return [...state.builtin.map(b => b.slug), ...state.custom.map(c => c.slug)];
  }

  // --- load ---------------------------------------------------------
  async function loadAll() {
    const [pj, aj] = await Promise.all([
      safeGet(base() + '/personas'),
      safeGet(base() + '/persona'),
    ]);
    if (pj && pj.ok) {
      state.live = true;
      state.builtin = Array.isArray(pj.builtin) ? pj.builtin : [];
      state.custom  = Array.isArray(pj.custom)  ? pj.custom  : [];
    } else {
      state.live = false;
      state.builtin = BUILTIN_SLUGS.map(s => ({ slug: s, description: BUILTIN_FALLBACK_DESC[s] || '(built-in persona)' }));
      state.custom = [];
    }
    if (aj && aj.ok) {
      state.assign = aj;
    } else if (!state.assign) {
      state.assign = { ok: false, valid_personas: BUILTIN_SLUGS.slice(), env_default: 'neurotic', global: null, effective_global: 'neurotic', channels_count: 0, guilds_count: 0 };
    }
    renderAll();
  }

  // --- render -------------------------------------------------------
  function renderAll() { renderTag(); renderList(); renderAssign(); renderPreview(); updateSaveState(); }

  function renderTag() {
    const tag = $('#pBackendTag');
    if (!tag) return;
    if (state.live) {
      tag.style.color = ''; tag.style.borderColor = '';
      tag.innerHTML = '<span class="dot"></span>BACKEND LIVE';
      tag.title = 'data/custom-personas.json · live';
    } else {
      tag.style.color = 'var(--warn)';
      tag.style.borderColor = 'color-mix(in oklab, var(--warn) 45%, transparent)';
      tag.innerHTML = '<span class="dot" style="background:var(--warn); box-shadow:0 0 6px var(--warn);"></span>OFFLINE';
      tag.title = 'GET /personas unreachable — start the local AI server.';
    }
  }

  function renderList() {
    // Built-in: read-only chips. description comes from the server (escape it).
    $('#builtinList').innerHTML = state.builtin.map(b => `
      <div class="p-builtin">
        <div class="nm"><span>${escapeHtml(b.slug)}</span><span class="ro">built-in</span></div>
        <div class="ds">${escapeHtml(b.description || '')}</div>
      </div>
    `).join('') || '<div class="empty" style="padding:14px 8px;">no built-ins</div>';

    // Custom: editable cards with Edit + Remove. Use index-based lookup for
    // actions so the (server-supplied) slug never has to round-trip through an
    // HTML attribute. All visible text is escaped.
    $('#customCount').textContent = state.custom.length + ' / 50';
    const host = $('#customList');
    if (!state.custom.length) {
      host.innerHTML = state.live
        ? '<div class="empty" style="padding:16px 8px;">no custom personas yet ·<br>add one with the form →</div>'
        : '<div class="empty" style="padding:16px 8px;">server offline ·<br>custom personas unavailable</div>';
      return;
    }
    host.innerHTML = state.custom.map((p, i) => {
      const preview = (p.tone || '').length > 140 ? (p.tone || '').slice(0, 140) + '…' : (p.tone || '');
      return `
        <div class="p-custom ${p.slug === state.editingSlug ? 'editing' : ''}" data-i="${i}">
          <div class="nm"><span>${escapeHtml(p.slug)}</span><span class="when">${escapeHtml(fmtAgo(p.updatedAt))}</span></div>
          <div class="tone">${escapeHtml(preview)}</div>
          <div class="row">
            <button class="mini-btn" data-act="edit">Edit</button>
            <button class="mini-btn bad" data-act="remove">Remove</button>
          </div>
        </div>`;
    }).join('');
    host.querySelectorAll('.p-custom').forEach(card => {
      const i = +card.dataset.i;
      card.querySelector('[data-act="edit"]').addEventListener('click', () => startEdit(i));
      card.querySelector('[data-act="remove"]').addEventListener('click', () => startRemove(i));
    });
  }

  function fillSelect(sel, current) {
    const slugs = personaSlugs();
    sel.innerHTML = slugs.map(s => `<option value="${escapeHtml(s)}"${s === current ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
  }

  function renderAssign() {
    const a = state.assign || {};
    $('#asgTag').textContent = state.live ? 'LIVE' : 'OFFLINE';
    $('#asgTag').style.color = state.live ? 'var(--cyan-1)' : 'var(--warn)';
    const g = a.global || null;
    $('#asgCurrent').innerHTML =
      `<div><span class="k">env default</span> · <span class="v">${escapeHtml(a.env_default || 'neurotic')}</span></div>` +
      `<div><span class="k">global override</span> · <span class="v">${g ? escapeHtml(g) : '<span style="color:var(--hull-3)">none</span>'}</span></div>` +
      `<div><span class="k">effective global</span> · <span class="v">${escapeHtml(a.effective_global || a.env_default || 'neurotic')}</span></div>` +
      `<div><span class="k">channel overrides</span> · <span class="v">${Number(a.channels_count || 0)}</span> &nbsp; <span class="k">server overrides</span> · <span class="v">${Number(a.guilds_count || 0)}</span></div>`;
    fillSelect($('#asgGlobalSel'), a.effective_global || a.env_default);
    fillSelect($('#asgChannelSel'), a.effective_global || a.env_default);
    fillSelect($('#asgServerSel'), a.effective_global || a.env_default);
  }

  function renderPreview() {
    const slug = ($('#pSlug').value || '').trim().toLowerCase();
    const tone = ($('#pTone').value || '').trim();
    const shown = tone || '(type a description above to preview)';
    $('#pPreview').innerHTML =
      '<span style="color:var(--cyan-1)"># system prompt</span>\n' +
      'You are SeekDeep.\n\n' +
      '<span style="color:var(--cyan-1)"># persona' + (slug ? ' · ' + escapeHtml(slug) : '') + '</span>\n' +
      '<span style="color:var(--good)">Tone: ' + escapeHtml(shown) + '</span>';
  }

  // --- editor -------------------------------------------------------
  function setEditing(slug) {
    state.editingSlug = slug || null;
    $('#pMode').textContent = slug ? ('EDITING · ' + slug) : 'NEW PERSONA';
    // re-mark the active card without a full reload
    document.querySelectorAll('.p-custom').forEach((c, i) => {
      c.classList.toggle('editing', !!slug && state.custom[+c.dataset.i] && state.custom[+c.dataset.i].slug === slug);
    });
  }
  function startEdit(i) {
    const p = state.custom[i];
    if (!p) return;
    $('#pSlug').value = p.slug;
    $('#pTone').value = p.tone || '';
    setEditing(p.slug);
    updateCounter();
    renderPreview();
    $('#pTone').focus();
  }
  function clearForm() {
    $('#pSlug').value = '';
    $('#pTone').value = '';
    setEditing(null);
    updateCounter();
    renderPreview();
  }

  function updateCounter() {
    const n = $('#pTone').value.length;
    const el = $('#pToneLen');
    el.textContent = n + ' / ' + TONE_MAX;
    el.style.color = n > TONE_MAX ? 'var(--bad)' : '';
    updateSaveState();
  }
  function slugVerdict(slug) {
    if (!SLUG_RE.test(slug)) return 'slug must be 2–' + SLUG_MAX + ' chars: a–z, 0–9, - or _';
    if (BUILTIN_SLUGS.includes(slug)) return '"' + slug + '" is a built-in persona';
    if (RESERVED.has(slug)) return '"' + slug + '" is a reserved keyword';
    return '';
  }
  function updateSaveState() {
    const slug = ($('#pSlug').value || '').trim().toLowerCase();
    const raw = $('#pTone').value || '';
    const trimmed = raw.trim();
    const ok = state.live && !slugVerdict(slug) && trimmed.length >= TONE_MIN && raw.length <= TONE_MAX;
    const btn = $('#pSave');
    btn.disabled = !ok;
    btn.style.opacity = ok ? '' : '0.5';
    btn.style.pointerEvents = ok ? '' : 'none';
  }

  async function savePersona() {
    const slug = ($('#pSlug').value || '').trim().toLowerCase();
    const tone = ($('#pTone').value || '').trim();
    const sv = slugVerdict(slug);
    if (sv) { toast('warn', sv); return; }
    if (tone.length < TONE_MIN) { toast('warn', 'Description is too short', 'Give the persona at least a sentence.'); return; }
    if (($('#pTone').value || '').length > TONE_MAX) { toast('warn', 'Description is too long', 'Trim to ' + TONE_MAX + ' chars or fewer.'); return; }
    if (!state.live) { toast('bad', 'Server offline', 'Start the local AI server to save personas.'); return; }
    const btn = $('#pSave');
    btn.disabled = true; btn.textContent = '⋯ saving…';
    try {
      const res = await writeJson('POST', base() + '/personas', { slug, tone });
      toast('good', '✓ Persona "' + slug + '" ' + (res.created ? 'created' : 'updated'));
      clearForm();
      await loadAll();
    } catch (err) {
      toast('bad', 'Save failed', err.message || String(err));
    } finally {
      btn.textContent = '▸ Save persona';
      updateSaveState();
    }
  }

  function startRemove(i) {
    const p = state.custom[i];
    if (!p) return;
    if (!state.live) { toast('bad', 'Server offline', 'Cannot remove personas while the server is unreachable.'); return; }
    confirmModal('Remove persona?',
      'This deletes custom persona "' + p.slug + '" from data/custom-personas.json. Any channel/server override pointing at it falls back to the default on the bot\'s next message. Cannot be undone.',
      async () => {
        try {
          await writeJson('DELETE', base() + '/personas/' + encodeURIComponent(p.slug));
          toast('good', '✓ Removed "' + p.slug + '"');
          if (state.editingSlug === p.slug) clearForm();
          await loadAll();
        } catch (err) {
          toast('bad', 'Remove failed', err.message || String(err));
        }
      });
  }

  // --- assign -------------------------------------------------------
  async function doAssign(payload, label) {
    if (!state.live && !state.assign) { /* still try — /persona may be up */ }
    try {
      await writeJson('POST', base() + '/persona', payload);
      toast('good', '✓ ' + label);
      const aj = await safeGet(base() + '/persona');
      if (aj && aj.ok) { state.assign = aj; renderAssign(); }
    } catch (err) {
      toast('bad', 'Assign failed', err.message || String(err));
    }
  }

  function wireAssign() {
    $('#asgGlobalSet').addEventListener('click', () =>
      doAssign({ scope: 'global', persona: $('#asgGlobalSel').value }, 'Global persona set to "' + $('#asgGlobalSel').value + '"'));
    $('#asgGlobalReset').addEventListener('click', () =>
      doAssign({ scope: 'global', action: 'reset' }, 'Global override cleared'));

    $('#asgChannelSet').addEventListener('click', () => {
      const cid = ($('#asgChannelId').value || '').trim();
      if (!cid) { toast('warn', 'Enter a channel ID first'); return; }
      doAssign({ scope: 'channel', channel_id: cid, persona: $('#asgChannelSel').value }, 'Channel ' + cid + ' → "' + $('#asgChannelSel').value + '"');
    });
    $('#asgChannelReset').addEventListener('click', () => {
      const cid = ($('#asgChannelId').value || '').trim();
      if (!cid) { toast('warn', 'Enter a channel ID first'); return; }
      doAssign({ scope: 'channel', channel_id: cid, action: 'reset' }, 'Channel ' + cid + ' override cleared');
    });

    $('#asgServerSet').addEventListener('click', () => {
      const gid = ($('#asgServerId').value || '').trim();
      if (!gid) { toast('warn', 'Enter a guild ID first'); return; }
      doAssign({ scope: 'server', guild_id: gid, persona: $('#asgServerSel').value }, 'Server ' + gid + ' → "' + $('#asgServerSel').value + '"');
    });
    $('#asgServerReset').addEventListener('click', () => {
      const gid = ($('#asgServerId').value || '').trim();
      if (!gid) { toast('warn', 'Enter a guild ID first'); return; }
      doAssign({ scope: 'server', guild_id: gid, action: 'reset' }, 'Server ' + gid + ' override cleared');
    });
  }

  // --- confirm modal ------------------------------------------------
  function confirmModal(title, body, ok) {
    $('#cfTitle').textContent = title;
    $('#cfBody').textContent  = body;
    $('#cf').classList.add('open');
    $('#cfBack').classList.add('open');
    const close = () => { $('#cf').classList.remove('open'); $('#cfBack').classList.remove('open'); };
    $('#cfCancel').onclick = close;
    $('#cfBack').onclick   = close;
    $('#cfOk').onclick     = async () => { close(); await ok(); };
  }

  // --- wire form ----------------------------------------------------
  $('#pSlug').addEventListener('input', () => { updateSaveState(); renderPreview(); });
  $('#pTone').addEventListener('input', () => { updateCounter(); renderPreview(); });
  $('#pSave').addEventListener('click', savePersona);
  $('#pNew').addEventListener('click', () => { clearForm(); $('#pSlug').focus(); });
  wireAssign();

  // --- boot ---------------------------------------------------------
  // Run AFTER nav.js (deferred, below) patches fetch with the GUI token so the
  // token-gated writes carry X-SeekDeep-Token. Deferred scripts run before
  // DOMContentLoaded, so gating on it guarantees the patch is installed — firing
  // fetches at parse time would send them on the unpatched fetch → 401 → mock
  // (the exact bug memory.html + prompts.html both hit).
  function boot() { updateCounter(); loadAll(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
