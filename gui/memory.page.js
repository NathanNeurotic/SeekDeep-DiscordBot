/* ============================================================
   Memory recall UI · Task 12
   ============================================================
   Backend contract (designed against, paired in HANDOFF_CLAUDE_CODE.md):

     GET    /memory/users
              → { ok, users: [ { user_id, display, fact_count, bytes, updatedAt } ] }
     GET    /memory/user/{id}
              → { ok, user_id, facts: [ { text, at } ], updatedAt, bytes }
     POST   /memory/user/{id}/fact
              body: { text }          → append new fact (501-style 422 on > 500 chars / > 25 facts)
     PATCH  /memory/user/{id}/fact/{n}
              body: { text }          → edit fact at index n
     DELETE /memory/user/{id}/fact/{n}
              → remove fact n
     DELETE /memory/user/{id}
              → wipe row (sets facts: [])
     GET    /memory/user/{id}/export
              → application/json download of just this user's row
     GET    /memory/presets/{id}
              → { ok, presets: [string], updatedAt }
     POST   /memory/presets/{id}
              body: { presets: [string] }  → replace the user's preset list

   All writes are X-SeekDeep-Token guarded · the nav.js interceptor adds it.

   All endpoints above are shipped on the local AI server. If the server is
   unreachable the UI falls back to a small in-page sample so the design still
   renders — marked with an OFFLINE tag in the rail, flips back to BACKEND
   LIVE on the first 200 response.
*/
(function () {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  const KNOWN_PRESETS = [
    { k: 'brief',                  d: 'shorter, fewer caveats' },
    { k: 'expert',                 d: 'assume domain knowledge' },
    { k: 'no-emoji',               d: 'never use emoji in output' },
    { k: 'no-followup-questions',  d: 'just answer, no clarifying' },
    { k: 'formal',                 d: 'no contractions, hedged tone' },
    { k: 'casual',                 d: 'looser register, contractions ok' },
  ];

  const MAX_FACTS = 25;
  const MAX_FACT_CHARS = 500;
  const MAX_USER_BYTES = 12800; // 25 × 500 chars + json overhead ≈ 12.5 KB

  let state = {
    isMock: false,
    users:  [],
    activeId: null,
    facts: [],
    updatedAt: null,
    presets: [],
  };

  // --- demo seed (offline state only) -------------------------------
  // ONE visibly-fake user so the page has something to render when the
  // backend is unreachable. Previously had five fake users with realistic-
  // looking Discord IDs + names ("nautilus#0001", "k-ray#1111", "abyssalbot
  // #0888", etc.) which were easy to mistake for real users. Now there's
  // one user named "(demo · server offline)" with explicitly-fake facts
  // so nobody mistakes them for real memory data.
  const MOCK_USERS = {
    '000000000000000000': {
      display: '(demo · server offline)',
      facts: [
        { text: 'This is sample data shown while the AI server is unreachable.', at: Date.now() - 60*1000 },
        { text: 'Start the SeekDeep stack to see real per-user facts here.',     at: Date.now() - 90*1000 },
        { text: 'Add facts in Discord with `@SeekDeep remember <fact about me>`.', at: Date.now() - 120*1000 },
      ],
      presets: ['(offline demo)'],
    },
  };

  // --- helpers ------------------------------------------------------
  function base() {
    // Tauri 2 on Windows serves bundled pages from http://tauri.localhost.
    // Force 127.0.0.1:7865 in Tauri context.
    if (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')) {
      return 'http://127.0.0.1:7865';
    }
    return (location.protocol === 'http:' || location.protocol === 'https:')
      ? location.origin
      : 'http://127.0.0.1:7865';
  }
  function fmtAgo(ts) {
    // ts may be epoch-ms (a fact's .at) OR an ISO string (row.updatedAt =
    // server _now_iso()). `Date.now() - "<iso>"` is NaN, which rendered as
    // "updated NaNd ago" in the header against a live server. Normalize first.
    const t = (typeof ts === 'number') ? ts : Date.parse(ts);
    if (!isFinite(t)) return '—';
    const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60)   return s + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400)return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }
  function bytesOf(facts) {
    return new TextEncoder().encode(JSON.stringify(facts || [])).length;
  }
  function avInit(name) { return (name || '?').slice(0, 1).toUpperCase(); }

  async function safeFetch(url, opts) {
    try {
      const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(5000) }, opts || {}));
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // --- API layer (live first, mock fallback) ------------------------
  async function listUsers() {
    const r = await safeFetch(base() + '/memory/users');
    if (r && r.ok && Array.isArray(r.users)) { state.isMock = false; return r.users; }
    state.isMock = true;
    return Object.entries(MOCK_USERS).map(([uid, u]) => ({
      user_id: uid, display: u.display,
      fact_count: u.facts.length, bytes: bytesOf(u.facts),
      updatedAt: u.facts[0]?.at || null,
    }));
  }
  async function loadUser(uid) {
    const r = await safeFetch(base() + '/memory/user/' + encodeURIComponent(uid));
    if (r && r.ok) { state.isMock = false; return { facts: r.facts || [], updatedAt: r.updatedAt }; }
    state.isMock = true;
    const u = MOCK_USERS[uid];
    return { facts: u ? u.facts.slice() : [], updatedAt: u?.facts[0]?.at || null };
  }
  async function loadPresets(uid) {
    const r = await safeFetch(base() + '/memory/presets/' + encodeURIComponent(uid));
    if (r && r.ok && Array.isArray(r.presets)) return r.presets;
    return (MOCK_USERS[uid]?.presets || []).slice();
  }
  // Write helpers — return TRUE on server-confirmed success, FALSE on
  // any failure (network, 4xx, 5xx). Callers must check and roll back
  // optimistic UI changes when false. Previously these used safeFetch
  // which swallowed everything and returned null silently, so a
  // 404/401/500 from the server looked identical to success and the
  // UI happily showed phantom state.
  async function writeOk(url, opts) {
    try {
      const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(5000) }, opts || {}));
      if (!r.ok) return false;
      const j = await r.json().catch(() => ({ ok: true }));
      return j && j.ok !== false;
    } catch { return false; }
  }
  async function writeFact(uid, text)         { return writeOk(base() + '/memory/user/' + uid + '/fact', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text}) }); }
  async function editFact(uid, n, text)       { return writeOk(base() + '/memory/user/' + uid + '/fact/' + n, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text}) }); }
  async function deleteFact(uid, n)           { return writeOk(base() + '/memory/user/' + uid + '/fact/' + n, { method: 'DELETE' }); }
  async function clearUser(uid)               { return writeOk(base() + '/memory/user/' + uid, { method: 'DELETE' }); }
  async function savePresets(uid, list)       { return writeOk(base() + '/memory/presets/' + uid, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({presets: list}) }); }

  // --- render -------------------------------------------------------
  function renderUsersRail(users, query) {
    const host = $('#rUsers');
    const q = (query || '').toLowerCase();
    const filtered = users.filter(u => !q || (u.display + ' ' + u.user_id).toLowerCase().includes(q));
    if (!filtered.length) {
      // Distinguish a genuinely-empty store (zero saved users) from a
      // search that filtered everyone out — the guidance differs.
      host.innerHTML = users.length
        ? '<div class="empty" style="padding:16px 8px;">no users match</div>'
        : '<div class="empty" style="padding:20px 12px; line-height:1.7; text-transform:none; letter-spacing:0.04em;">No saved memory yet — run <span style="color:var(--cyan-1)">@SeekDeep remember &lt;a fact about you&gt;</span> in Discord, then click Refresh.</div>';
      return;
    }
    // XSS-safe: build with createElement + textContent so a malicious display
    // name ("<img onerror=…>") can't escape the row markup. user_id IDs go
    // via setAttribute (escaped) instead of attribute interpolation.
    host.innerHTML = '';
    const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
    filtered.forEach(u => {
      const item = document.createElement('div');
      item.className = 'user-item' + (u.user_id === state.activeId ? ' active' : '');
      item.setAttribute('data-id', String(u.user_id || ''));
      item.appendChild(mk('div', 'av', avInit(u.display)));
      const mid = document.createElement('div');
      mid.appendChild(mk('div', 'name', String(u.display || u.user_id || '')));
      mid.appendChild(mk('div', 'id',   String(u.user_id || '')));
      item.appendChild(mid);
      item.appendChild(mk('div', 'count', String(u.fact_count != null ? u.fact_count : '')));
      item.addEventListener('click', () => selectUser(item.dataset.id));
      host.appendChild(item);
    });
    $('#rUserCount').textContent = filtered.length + (filtered.length !== users.length ? ' / ' + users.length : '');
  }

  function renderFacts() {
    const host = $('#factsList');
    if (!state.activeId) { host.innerHTML = '<div class="empty">⋯ pick a user from the rail</div>'; return; }
    if (!state.facts.length) {
      host.innerHTML = `<div class="empty">▸ no facts yet · type something in the composer below or run <span style="color:var(--cyan-1)">@SeekDeep remember</span> in Discord</div>`;
      return;
    }
    host.innerHTML = state.facts.map((f, i) => `
      <div class="fact" data-idx="${i}">
        <div class="fact-head">
          <span class="idx">#${i + 1}</span>
          <span class="when">${fmtAgo(f.at)}</span>
        </div>
        <div class="fact-text" data-text>${escapeHtml(f.text)}</div>
        <div class="fact-actions">
          <button class="mini-btn" data-act="edit">EDIT</button>
          <button class="mini-btn good" data-act="save" style="display:none;">SAVE</button>
          <button class="mini-btn" data-act="cancel" style="display:none;">CANCEL</button>
          <button class="mini-btn bad" data-act="forget">FORGET</button>
        </div>
      </div>
    `).join('');
    host.querySelectorAll('.fact').forEach(wireFactCard);
  }

  function wireFactCard(card) {
    const idx = +card.dataset.idx;
    const textEl = card.querySelector('[data-text]');
    const editBtn = card.querySelector('[data-act="edit"]');
    const saveBtn = card.querySelector('[data-act="save"]');
    const cancelBtn = card.querySelector('[data-act="cancel"]');
    const forgetBtn = card.querySelector('[data-act="forget"]');
    let originalText = state.facts[idx].text;

    editBtn.addEventListener('click', () => {
      textEl.setAttribute('contenteditable', 'true');
      textEl.focus();
      editBtn.style.display = 'none';
      saveBtn.style.display = ''; cancelBtn.style.display = '';
    });
    cancelBtn.addEventListener('click', () => {
      textEl.removeAttribute('contenteditable');
      textEl.textContent = originalText;
      editBtn.style.display = ''; saveBtn.style.display = 'none'; cancelBtn.style.display = 'none';
    });
    saveBtn.addEventListener('click', async () => {
      const newText = textEl.textContent.trim();
      if (!newText || newText === originalText) { cancelBtn.click(); return; }
      if (newText.length > MAX_FACT_CHARS) { (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'warn', title:`Fact exceeds ${MAX_FACT_CHARS} chars (${newText.length})`}); return; }
      state.facts[idx].text = newText;
      state.facts[idx].at   = Date.now();
      // CRITICAL: server expects 1-based fact index (PATCH/DELETE
      // /memory/user/{id}/fact/{n} routes use `n - 1` internally).
      // Passing the 0-based array idx made n=0 -> 404 "no fact at
      // index 0", and n=1 -> overwrote/deleted the fact at array
      // index 0 instead of the one the user clicked. Ghost-edits +
      // ghost-deletes of neighbors. Now we pass idx+1 explicitly.
      const ok = await editFact(state.activeId, idx + 1, newText);
      if (ok === false) {
        // Roll back the optimistic UI change since the write failed.
        state.facts[idx].text = originalText;
        (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'bad', title:`Could not save fact #${idx + 1}`, body:'Server may be down or the token may have rotated. Try Reload.'});
        return;
      }
      textEl.removeAttribute('contenteditable');
      editBtn.style.display = ''; saveBtn.style.display = 'none'; cancelBtn.style.display = 'none';
      originalText = newText;
      if (state.isMock) MOCK_USERS[state.activeId].facts = state.facts.slice();
      renderMeters(); renderInjection();
    });
    forgetBtn.addEventListener('click', async () => {
      confirmModal(`Forget fact #${idx + 1}?`, state.facts[idx].text, async () => {
        // Hit the server FIRST so a write-failure doesn't ghost-delete
        // from the UI. Pass idx+1 because routes use n-1 (1-based on
        // the wire). Roll back on failure.
        const ok = await deleteFact(state.activeId, idx + 1);
        if (ok === false) {
          (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'bad', title:`Could not forget fact #${idx + 1}`, body:'Server may be down or the token may have rotated.'});
          return;
        }
        state.facts.splice(idx, 1);
        if (state.isMock) MOCK_USERS[state.activeId].facts = state.facts.slice();
        renderFacts(); renderMeters(); renderInjection(); refreshUserRow();
      });
    });
  }

  function refreshUserRow() {
    const row = state.users.find(u => u.user_id === state.activeId);
    if (row) { row.fact_count = state.facts.length; row.bytes = bytesOf(state.facts); row.updatedAt = Date.now(); }
    renderUsersRail(state.users, $('#rSearch').value);
  }

  function renderMeters() {
    const fc = state.facts.length;
    const bs = bytesOf(state.facts);
    const fp = Math.min(100, (fc / MAX_FACTS) * 100);
    const bp = Math.min(100, (bs / MAX_USER_BYTES) * 100);
    $('#mFactsLbl').textContent = fc + ' / ' + MAX_FACTS;
    $('#mStorageLbl').textContent = (bs < 1024 ? bs + ' B' : (bs/1024).toFixed(1) + ' KB') + ' / 12.5 KB';
    const fbar = $('#mFactsBar'); fbar.style.width = fp + '%'; fbar.className = fp > 80 ? 'warn' : '';
    const bbar = $('#mStorageBar'); bbar.style.width = bp + '%'; bbar.className = bp > 80 ? 'warn' : '';
    if (state.updatedAt) $('#hUpdated').textContent = 'updated ' + fmtAgo(state.updatedAt);
    else $('#hUpdated').textContent = 'no writes yet';
  }

  function renderPresets() {
    const host = $('#presetGrid');
    host.innerHTML = KNOWN_PRESETS.map(p => `
      <div class="preset-chip ${state.presets.includes(p.k) ? 'on' : ''}" data-k="${p.k}">
        <div>
          <div>${p.k}</div>
          <span class="ds">${p.d}</span>
        </div>
        <span class="tick"></span>
      </div>
    `).join('');
    host.querySelectorAll('.preset-chip').forEach(el => {
      el.addEventListener('click', async () => {
        if (!state.activeId) return;
        const k = el.dataset.k;
        const i = state.presets.indexOf(k);
        // Optimistic toggle, with rollback on server failure. Was:
        // silent fire-and-forget that lied when the POST failed.
        const before = state.presets.slice();
        if (i >= 0) state.presets.splice(i, 1); else state.presets.push(k);
        el.classList.toggle('on');
        const ok = await savePresets(state.activeId, state.presets);
        if (ok === false) {
          state.presets = before;
          el.classList.toggle('on');
          (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'bad', title:'Could not save preset selection', body:'Server may be down.'});
          return;
        }
        if (state.isMock && MOCK_USERS[state.activeId]) MOCK_USERS[state.activeId].presets = state.presets.slice();
        renderInjection();
        $('#psCount').textContent = state.presets.length + ' active';
      });
    });
    $('#psCount').textContent = state.presets.length + ' active';
  }

  function renderInjection() {
    const presetLine = state.presets.length
      ? 'Apply: ' + state.presets.join(', ') + '.'
      : '(no presets active)';
    const factLines = state.facts.length
      ? state.facts.map(f => '<span class="inj">- ' + escapeHtml(f.text) + '</span>').join('\n')
      : '<span class="inj">(nothing yet — facts append here in /chat)</span>';
    $('#injectionPreview').innerHTML =
      '<span class="sys"># system prompt</span>\n' +
      'You are SeekDeep. <span class="inj">' + escapeHtml(presetLine) + '</span>\n\n' +
      '<span class="inj"># injected memory · ' + state.facts.length + ' fact' + (state.facts.length === 1 ? '' : 's') + '</span>\n' +
      factLines + '\n\n' +
      '<span class="usr"># user</span>\n' +
      '<span class="usr">@SeekDeep …</span>';
  }

  async function selectUser(uid) {
    state.activeId = uid;
    const u = state.users.find(x => x.user_id === uid);
    $('#hUserName').textContent = u?.display || uid;
    $('#hUserId').textContent   = uid;
    $('#hPath').textContent     = 'GET /memory/user/' + uid;
    $('#factsList').innerHTML   = '<div class="empty">⋯ loading facts…</div>';
    const [data, presets] = await Promise.all([loadUser(uid), loadPresets(uid)]);
    state.facts     = data.facts;
    state.updatedAt = data.updatedAt;
    state.presets   = presets;
    renderUsersRail(state.users, $('#rSearch').value);
    renderFacts(); renderMeters(); renderPresets(); renderInjection();
    updateMockTag();
  }

  function updateMockTag() {
    const tag = $('#memBackendTag');
    if (!tag) return;
    if (state.isMock) {
      tag.style.color = 'var(--warn)';
      tag.style.borderColor = 'color-mix(in oklab, var(--warn) 45%, transparent)';
      tag.innerHTML = '<span class="dot" style="background:var(--warn); box-shadow: 0 0 6px var(--warn);"></span>OFFLINE';
      tag.title = 'GET /memory/users is shipped but the local AI server is unreachable. Showing in-page sample data as a placeholder.';
    } else {
      tag.style.color = '';
      tag.style.borderColor = '';
      tag.innerHTML = '<span class="dot"></span>BACKEND LIVE';
      tag.title = 'data/user-facts.json · live';
    }
  }

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // --- compose new fact ---------------------------------------------
  const newFactInput = $('#newFact');
  newFactInput.addEventListener('input', () => {
    $('#newFactLen').textContent = newFactInput.value.length + ' / ' + MAX_FACT_CHARS;
  });
  newFactInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('#addFactBtn').click(); });
  $('#addFactBtn').addEventListener('click', async () => {
    const text = newFactInput.value.trim();
    if (!text) return;
    if (text.length > MAX_FACT_CHARS) { (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'warn', title:`Fact exceeds ${MAX_FACT_CHARS} chars`}); return; }
    if (state.facts.length >= MAX_FACTS) { (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'warn', title:`Already at the ${MAX_FACTS}-fact cap`, body:'Forget one first.'}); return; }
    if (!state.activeId) { (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'warn', title:'Pick a user first.'}); return; }
    // Server write first; UI commit only on success. Previously the
    // optimistic unshift stayed visible even when the POST failed,
    // so users thought a fact was saved when it wasn't.
    const ok = await writeFact(state.activeId, text);
    if (ok === false) {
      (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'bad', title:'Could not save fact', body:'Server may be down or token rotated.'});
      return;
    }
    state.facts.unshift({ text, at: Date.now() });
    state.updatedAt = Date.now();
    if (state.isMock) MOCK_USERS[state.activeId].facts = state.facts.slice();
    newFactInput.value = '';
    $('#newFactLen').textContent = '0 / ' + MAX_FACT_CHARS;
    renderFacts(); renderMeters(); renderInjection(); refreshUserRow();
  });

  // --- danger zone --------------------------------------------------
  $('#clearBtn').addEventListener('click', () => {
    if (!state.activeId) return;
    if (!state.facts.length) { (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'info', title:'Already empty.'}); return; }
    confirmModal('Wipe all facts?', `This will DELETE all ${state.facts.length} fact${state.facts.length===1?'':'s'} for ${$('#hUserName').textContent}. Atomic write · no soft-delete · cannot be undone.`, async () => {
      const ok = await clearUser(state.activeId);
      if (ok === false) {
        (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'bad', title:'Could not clear facts', body:'Server may be down or token rotated. Nothing was deleted.'});
        return;
      }
      state.facts = []; state.updatedAt = Date.now();
      if (state.isMock) MOCK_USERS[state.activeId].facts = [];
      renderFacts(); renderMeters(); renderInjection(); refreshUserRow();
    });
  });

  $('#exportBtn').addEventListener('click', async () => {
    if (!state.activeId) return;
    const payload = { user_id: state.activeId, display: $('#hUserName').textContent, facts: state.facts, presets: state.presets, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(payload, null, 2);
    const fname = `seekdeep-memory-${state.activeId}.json`;
    // <a download> is silently dropped by the Tauri WebView2 — save through the
    // loopback server (writes to Downloads, returns path); anchor as browser fallback.
    if (window.SeekDeepSaveFile) {
      try {
        const path = await window.SeekDeepSaveFile(fname, json);
        window.SeekDeepNotify?.toast?.({ tone: 'good', title: '✓ Exported', body: '→ ' + path });
      } catch (err) {
        window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Export failed', body: String(err && err.message || err) });
      }
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  // --- search rail --------------------------------------------------
  $('#rSearch').addEventListener('input', () => renderUsersRail(state.users, $('#rSearch').value));

  // --- boot ---------------------------------------------------------
  // Run AFTER nav.js (deferred, below) has patched fetch with the GUI token.
  // Deferred scripts execute before DOMContentLoaded, so gating on it guarantees
  // the patch is installed. Firing during parse (as this IIFE used to) sent the
  // first /memory/users on the UNpatched fetch → 401 → the page fell back to the
  // offline mock seed and never recovered ("stuck in mock").
  function memoryBoot() {
    (async function () {
      state.users = await listUsers();
      renderUsersRail(state.users);
      updateMockTag();
      if (state.users.length) selectUser(state.users[0].user_id);
    })();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', memoryBoot, { once: true });
  else memoryBoot();
})();
