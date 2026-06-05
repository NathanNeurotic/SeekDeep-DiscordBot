  // ===== All-settings page =====================================================
  // Renders every key in .env.default (via GET /config/schema) as a typed,
  // grouped control, hydrated with current values (GET /config, secrets redacted),
  // and saves changed keys to the real .env (POST /config). Gated on
  // DOMContentLoaded so it runs AFTER nav.js (token-patched fetch + base resolver)
  // — an inline <script defer> otherwise runs mid-parse, before nav.js.
  function initAllSettings() {
    function base() {
      if (window.SeekDeepResolveBase) return window.SeekDeepResolveBase();
      if (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
      return (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
    }
    const bodyEl = document.getElementById('setBody');
    const emptyEl = document.getElementById('setEmpty');
    const searchEl = document.getElementById('setSearch');
    const saveBtn = document.getElementById('saveBtn');
    const discardBtn = document.getElementById('discardBtn');
    const restartBtn = document.getElementById('restartBtn');
    const changedEl = document.getElementById('changedCount');
    const kcountEl = document.getElementById('kcount');

    let current = {};                 // current .env values (secrets => '*****' or '')
    const dirty = new Map();          // key -> new string value
    const rows = new Map();           // key -> { el, field, read, baseline, refresh }

    // Shared renderer (config-render.js) — single source of truth for control
    // rendering + boolean vocab, so All Settings and the Control Center can't drift.
    const R = window.SeekDeepConfigRender;
    const isOn = R.isOn;
    const boolVocab = R.boolVocab;
    // Baseline string a control is compared against to decide "dirty".
    function baselineOf(f) {
      if (f.kind === 'secret') return '';   // never known; dirty only if user types
      const cur = current[f.key];
      return (cur !== undefined && cur !== null) ? String(cur) : String(f.default == null ? '' : f.default);
    }

    function updateBars() {
      const n = dirty.size;
      saveBtn.disabled = n === 0;
      discardBtn.disabled = n === 0;
      saveBtn.textContent = n ? `Save ${n}` : 'Save';
      changedEl.textContent = n ? `${n} unsaved` : 'no changes';
      changedEl.classList.toggle('dirty', n > 0);
      // section dirty dots
      document.querySelectorAll('.set-sec').forEach(sec => {
        const any = [...sec.querySelectorAll('.set-row')].some(r => r.classList.contains('dirty'));
        sec.classList.toggle('has-dirty', any);
      });
    }

    function evaluate(key) {
      const r = rows.get(key);
      if (!r) return;
      const val = r.read();
      const baseline = baselineOf(r.field);
      let changed;
      if (r.field.kind === 'toggle') changed = isOn(val) !== isOn(baseline);
      else changed = String(val) !== String(baseline);
      if (changed) dirty.set(key, val); else dirty.delete(key);
      r.el.classList.toggle('dirty', changed);
      // can-reset: control value differs from the template default
      const def = String(r.field.default == null ? '' : r.field.default);
      const differsFromDefault = r.field.kind === 'toggle' ? (isOn(val) !== isOn(def)) : (String(val) !== def);
      r.el.classList.toggle('can-reset', differsFromDefault && r.field.kind !== 'secret');
      const state = r.el.querySelector('.state');
      if (state) state.textContent = changed ? 'EDITED' : (r.field.kind === 'secret' ? '' : 'SAVED');
      updateBars();
    }

    function buildRow(f) {
      const row = document.createElement('div');
      row.className = 'set-row';
      row.dataset.key = f.key;
      row.dataset.search = (f.key + ' ' + (f.desc || '')).toLowerCase();

      const meta = document.createElement('div');
      meta.className = 'meta';
      const lock = f.kind === 'secret' ? '<span class="lock">SECRET</span>' : '';
      meta.innerHTML = `<div class="key">${lock}</div>` + (f.desc ? `<div class="desc"></div>` : '');
      meta.querySelector('.key').insertAdjacentText('afterbegin', f.key);  // FE-5: render the config key as text, never interpolated HTML
      if (f.desc) meta.querySelector('.desc').textContent = f.desc;
      row.appendChild(meta);

      const ctrl = document.createElement('div');
      ctrl.className = 'ctrl';

      // Control rendering is shared with the Control Center via config-render.js
      // so the two surfaces can't diverge on how a key renders.
      const c = R.makeControl(f, { baseline: baselineOf(f), current, onChange: () => evaluate(f.key) });
      c.nodes.forEach((n) => ctrl.appendChild(n));

      const reset = document.createElement('button');
      reset.className = 'reset'; reset.type = 'button'; reset.title = 'Reset to default'; reset.textContent = '↺';
      reset.addEventListener('click', () => { c.reset(); evaluate(f.key); });
      ctrl.appendChild(reset);

      const state = document.createElement('span');
      state.className = 'state';
      ctrl.appendChild(state);

      row.appendChild(ctrl);
      rows.set(f.key, { el: row, field: f, read: c.read });
      return row;
    }

    function render(schema) {
      bodyEl.querySelectorAll('.set-sec').forEach(s => s.remove());
      let total = 0;
      for (const sec of (schema.sections || [])) {
        const det = document.createElement('details');
        det.className = 'set-sec';
        // Collapse the big catch-all "…advanced" section by default so the page
        // opens on the common settings; it's one click (or a search) away.
        // Search force-opens any matching section (see applyFilter).
        det.open = !/\badvanced\b/i.test(sec.title || '');
        const sum = document.createElement('summary');
        sum.innerHTML = `<span class="chev">▸</span><span class="set-sec-title"></span><span class="set-sec-dirty"></span><span class="set-sec-ct"></span>`;
        sum.querySelector('.set-sec-title').textContent = sec.title;
        sum.querySelector('.set-sec-ct').textContent = sec.keys.length;
        det.appendChild(sum);
        for (const f of sec.keys) { det.appendChild(buildRow(f)); total++; }
        bodyEl.appendChild(det);
      }
      kcountEl.textContent = `${total} keys`;
      rows.forEach((_, k) => evaluate(k));
      updateBars();
    }

    function applyFilter() {
      const q = (searchEl.value || '').trim().toLowerCase();
      let anyVisible = false;
      document.querySelectorAll('.set-sec').forEach(sec => {
        let secVisible = 0;
        sec.querySelectorAll('.set-row').forEach(r => {
          const show = !q || (r.dataset.search || '').includes(q);
          r.style.display = show ? '' : 'none';
          if (show) secVisible++;
        });
        sec.style.display = secVisible ? '' : 'none';
        if (secVisible) anyVisible = true;
        if (q && secVisible) sec.open = true;
      });
      emptyEl.style.display = anyVisible ? 'none' : 'block';
      if (!anyVisible) emptyEl.textContent = q ? 'No settings match.' : 'No settings.';
    }

    async function save() {
      if (!dirty.size) return;
      const updates = {};
      for (const [k, v] of dirty) updates[k] = v;
      const count = dirty.size;
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        const r = await fetch(base() + '/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }), signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json().catch(() => ({}));
        // Commit: fold saved values into the baseline, clear dirty, refresh states.
        for (const [k, v] of Object.entries(updates)) {
          const r = rows.get(k);
          const f = r && r.field;
          current[k] = (f && f.kind === 'secret') ? '*****' : v;
          // A just-saved secret stays in the field as plaintext; since the
          // secret baseline is always '' it would re-flag as dirty. Clear it —
          // it's persisted now, and the field is ready for the next replacement.
          if (f && f.kind === 'secret') {
            const inp = r.el.querySelector('input');
            if (inp) { inp.value = ''; inp.placeholder = '•••••• set · type to replace'; }
          }
        }
        dirty.clear();
        rows.forEach((_, k) => evaluate(k));
        updateBars();
        const saved = (j && Array.isArray(j.updated)) ? j.updated.length : count;
        window.SeekDeepNotify?.toast?.({ tone: 'good', title: `Saved ${saved} setting${saved === 1 ? '' : 's'}`, body: 'Click ↻ Restart bot to apply.', ttl: 5000 });
        if (restartBtn) restartBtn.style.boxShadow = '0 0 0 2px var(--good, #3ba55d)';
      } catch (e) {
        window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Save failed', body: String((e && e.message) || e), ttl: 6000 });
      } finally {
        updateBars();
      }
    }

    function discard() {
      if (!dirty.size) return;
      // Rebuild the controls from baselines by re-rendering with the last schema.
      if (window.__SD_SCHEMA) render(window.__SD_SCHEMA);
      applyFilter();
    }

    async function loadAll() {
      try {
        const [sRes, cRes] = await Promise.all([
          fetch(base() + '/config/schema', { cache: 'no-store', signal: AbortSignal.timeout(6000) }),
          fetch(base() + '/config', { cache: 'no-store', signal: AbortSignal.timeout(6000) }),
        ]);
        const schema = await sRes.json();
        current = ((await cRes.json()) || {}).env || {};
        if (!schema || !schema.ok || !Array.isArray(schema.sections)) {
          emptyEl.textContent = 'Could not load settings schema.';
          return;
        }
        window.__SD_SCHEMA = schema;
        emptyEl.style.display = 'none';
        render(schema);
        jumpToKey();
      } catch (e) {
        emptyEl.textContent = 'Settings server not reachable. Start the AI server, then reload.';
      }
    }

    async function restartBot() {
      if (!restartBtn) return;
      const prev = restartBtn.textContent;
      restartBtn.disabled = true; restartBtn.textContent = '↻ Restarting…';
      try {
        const r = await fetch(base() + '/launcher/bot/restart', { method: 'POST', signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        restartBtn.style.boxShadow = '';
        window.SeekDeepNotify?.toast?.({ tone: 'good', title: 'Bot restarting…', body: 'Your saved .env changes are being applied (~15s).', ttl: 6000 });
      } catch (e) {
        window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Restart request failed', body: String((e && e.message) || e) + '. Try again in a moment.', ttl: 7000 });
      } finally {
        restartBtn.disabled = false; restartBtn.textContent = prev;
      }
    }

    // Deep-link: settings.html#SEEKDEEP_X (or ?key=SEEKDEEP_X) opens straight to
    // that setting — expands its section, scrolls, highlights, focuses it. Lets
    // any page (docs, ⌘K, a description elsewhere) link to one exact knob.
    function jumpToKey() {
      let key = '';
      try {
        const h = (location.hash || '').replace(/^#/, '');
        const q = new URLSearchParams(location.search).get('key') || '';
        key = decodeURIComponent(h || q || '').trim();
      } catch (_) {}
      if (!key) return;
      const sel = (window.CSS && CSS.escape) ? CSS.escape(key) : key;
      const row = bodyEl.querySelector('.set-row[data-key="' + sel + '"]');
      if (!row) return;
      const det = row.closest('.set-sec');
      if (det) det.open = true;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prevBg = row.style.backgroundColor;
      row.style.transition = 'background-color .25s ease';
      row.style.backgroundColor = 'rgba(59,165,93,0.18)';
      setTimeout(() => { row.style.backgroundColor = prevBg || ''; }, 1600);
      const inp = row.querySelector('input, select, textarea');
      if (inp) { try { inp.focus({ preventScroll: true }); } catch (_) {} }
    }

    searchEl.addEventListener('input', applyFilter);
    saveBtn.addEventListener('click', save);
    discardBtn.addEventListener('click', discard);
    restartBtn?.addEventListener('click', restartBot);
    window.addEventListener('hashchange', jumpToKey);
    // Ctrl/Cmd+S saves
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
    });
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAllSettings, { once: true });
  } else {
    initAllSettings();
  }
