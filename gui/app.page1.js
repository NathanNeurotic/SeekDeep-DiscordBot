  // ===== Server stats · live wiring (GET /data/server-stats.json) =====
  (function wireStats() {
    const bars = document.getElementById('statsBars');
    const lb = document.getElementById('statsLeaderboard');
    if (!bars || !lb) return;
    let loaded = false;
    async function load() {
      if (loaded) return;
      loaded = true;
      try {
        const r = await sdPollFetch(SEEKDEEP_BASE + '/data/server-stats.json', { timeout: 3000, attempts: 2 });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const wrap = await r.json();
        const data = wrap.data || wrap;
        // Totals
        const setTxt = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.textContent = (typeof v === 'number') ? v.toLocaleString() : v; };
        setTxt('statTotalMessages', data.totals?.messages ?? data.messages);
        setTxt('statTotalImages',   data.totals?.images ?? data.images);
        setTxt('statTotalVision',   data.totals?.vision ?? data.vision);
        // 30-day bars: prefer day_buckets.messages, fall back to images
        const dayBuckets = data.day_buckets || data.dayBuckets || {};
        const series = dayBuckets.messages || dayBuckets.chats || dayBuckets.images || [];
        if (series.length) {
          const max = Math.max(...series, 1);
          bars.innerHTML = '';
          series.slice(-30).forEach(v => {
            const col = document.createElement('div');
            col.className = 'col';
            col.style.height = Math.round((v / max) * 100) + '%';
            col.title = String(v);
            bars.appendChild(col);
          });
        }
        // Leaderboard
        const top = data.top || data.topContributors || data.users || [];
        if (Array.isArray(top) && top.length) {
          lb.innerHTML = '';
          const total = top.reduce((s, u) => s + (u.count || 0), 0) || 1;
          // XSS-safe build: every runtime user field goes through textContent,
          // not innerHTML interpolation. A guild member with display name
          // "<img src=x onerror=alert(1)>" can't break out of the row markup.
          top.slice(0, 10).forEach((u, i) => {
            const row = document.createElement('div');
            row.className = 'lb-row';
            const name = String(u.name || u.username || u.id || '');
            const initial = (name || '?').charAt(0).toUpperCase();
            const pct = Math.round(((u.count || 0) / total) * 100);
            const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; el.textContent = text; return el; };
            row.appendChild(mk('span', 'rk', String(i+1).padStart(2,'0')));
            row.appendChild(mk('span', 'av', initial));
            row.appendChild(mk('span', '',   name));
            row.appendChild(mk('span', 'count', (u.count || 0).toLocaleString()));
            row.appendChild(mk('span', 'pct', pct + '%'));
            lb.appendChild(row);
          });
        }
      } catch (e) {
        loaded = false;
        // Soft fail — the leaderboard already has its empty-state in markup
        // ("no data yet · launchers/data needs a fetch") so we just bail.
      }
    }
    function onActive() {
      const pane = document.querySelector('[data-pane="stats"]');
      if (pane && pane.classList.contains('active')) load();
    }
    document.querySelectorAll('.sidebar a[data-mod="stats"]').forEach(a =>
      a.addEventListener('click', () => setTimeout(onActive, 50))
    );
    onActive();
  })();

  // ===== Auto-react rules · live wiring (GET /data/auto-reactions.json) =====
  (function wireReactRules() {
    const list = document.getElementById('reactRulesList');
    if (!list) return;
    let loaded = false;
    async function load() {
      if (loaded) return;
      loaded = true;
      try {
        const r = await sdPollFetch(SEEKDEEP_BASE + '/data/auto-reactions.json', { timeout: 3000, attempts: 2 });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const wrap = await r.json();
        const data = wrap.data || wrap;
        // Paint the built-in toggles regardless of whether per-guild custom
        // rules exist. The normalizer aggregates each builtin's enabled
        // state across guilds (any guild has it on → on).
        const builtins = data.builtins || {};
        document.querySelectorAll('[data-builtin-toggle]').forEach(t => {
          const key = t.getAttribute('data-builtin-toggle');
          const b = builtins[key];
          if (!b) { t.classList.remove('on'); }
          else {
            t.classList.toggle('on', b.enabled === true);
            const guildsOn = Array.isArray(b.guilds_on) ? b.guilds_on : [];
            t.title = (b.enabled ? 'ON' : 'OFF') + (guildsOn.length ? ' in ' + guildsOn.length + ' guild' + (guildsOn.length === 1 ? '' : 's') : '') + (b.threshold ? ' · threshold ' + b.threshold : '');
          }
          // Wire click → POST /reacts/builtin/{key}. Idempotent: replace any
          // existing handler so reloading the panel doesn't stack listeners.
          if (!t.__wired) {
            t.__wired = true;
            t.addEventListener('click', async () => {
              const gid = document.getElementById('rrGuildId')?.value.trim() || '';
              if (!gid) {
                const statusEl = document.getElementById('rrAddStatus');
                if (statusEl) {
                  statusEl.style.color = 'var(--warn)';
                  statusEl.textContent = '▸ enter a Guild ID in the form above first — built-in toggles are per-guild';
                }
                return;
              }
              const next = !t.classList.contains('on');
              t.classList.toggle('on', next);  // optimistic
              try {
                const r = await fetch(SEEKDEEP_BASE + '/reacts/builtin/' + encodeURIComponent(key), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ guild_id: gid, enabled: next }),
                });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                (window.SeekDeepNotify?.toast || (() => {}))({ tone: 'good', title: `${key} ${next ? 'on' : 'off'}`, ttl: 2500 });
              } catch (err) {
                t.classList.toggle('on', !next);  // revert
                // WebView2 suppresses alert(); use the in-app toast so the failure is visible.
                (window.SeekDeepNotify?.toast || ((o) => alert(o.body ? o.title + ': ' + o.body : o.title)))({ tone: 'bad', title: `Toggle ${key} failed`, body: String(err.message || err) });
              }
            });
          }
        });
        // Populate the guild-ID datalist with any guilds we've already seen
        // rules for, so the Add form auto-suggests instead of forcing the
        // user to look up the ID every time.
        try {
          const dl = document.getElementById('rrGuildList');
          if (dl) {
            const seen = Array.isArray(data.guilds_with_rules) ? data.guilds_with_rules
                       : (data.guilds && typeof data.guilds === 'object') ? Object.keys(data.guilds)
                       : [];
            dl.innerHTML = '';
            seen.forEach(gid => { const o = document.createElement('option'); o.value = String(gid); dl.appendChild(o); });
          }
        } catch {}
        const rules = data.rules || (Array.isArray(data) ? data : []);
        if (!rules.length) {
          list.innerHTML = '<div style="padding:20px; text-align:center; font-family:var(--font-mono); font-size:12px; color:var(--hull-3); letter-spacing:0.06em;">▸ no custom rules defined · fill in the form above and click <span style="color:var(--cyan-1);">▸ ADD</span></div>';
          return;
        }
        list.innerHTML = '';
        // XSS-safe: every rule field flows via textContent / setAttribute, not
        // raw innerHTML interpolation. A rule with emoji '<img onerror=…>' or
        // an id that breaks attribute quoting can't escape the row.
        rules.forEach(rule => {
          const row = document.createElement('div');
          row.className = 'rule-row';
          const scope = rule.channel ? '#' + rule.channel : (rule.user ? 'user: ' + rule.user : 'any channel');
          const enabled = rule.enabled !== false;
          const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
          row.appendChild(mk('span', 'emo',     String(rule.emoji || '?')));
          row.appendChild(mk('span', 'pattern', String(rule.pattern || '')));
          row.appendChild(mk('span', 'scope',   scope));
          row.appendChild(mk('span', null,      (rule.hits || 0).toLocaleString()));
          const toggleHost = document.createElement('span');
          const toggle = document.createElement('div');
          toggle.className = 'toggle' + (enabled ? ' on' : '');
          toggle.setAttribute('data-rule-id', String(rule.id || ''));
          toggleHost.appendChild(toggle);
          row.appendChild(toggleHost);
          const actions = document.createElement('div');
          const btnEdit    = mk('button', 'btn-mini', 'EDIT');
          const btnInspect = mk('button', 'btn-mini', '⌕'); btnInspect.setAttribute('data-act','inspect');
          const btnRemove  = mk('button', 'btn-mini bad', '✕ REMOVE'); btnRemove.setAttribute('data-act','remove');
          // Per-row buttons hit POST/PATCH/DELETE /reacts/rule directly.
          // nav.js auto-injects X-SeekDeep-Token on writes.
          async function callRule(method, ruleId, body) {
            const init = { method, headers: { 'Content-Type': 'application/json' } };
            if (body) init.body = JSON.stringify(body);
            const url = SEEKDEEP_BASE + '/reacts/rule' + (ruleId ? '/' + encodeURIComponent(ruleId) : '');
            const r = await fetch(url, init);
            if (!r.ok) {
              let msg = 'HTTP ' + r.status;
              try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
              throw new Error(msg);
            }
            return r.json();
          }
          async function doEdit(rule) {
            // In-app modal, not raw prompt() — WebView2 in the Tauri app returns
            // null from window.prompt (no dialog), which silently aborted Edit.
            let emoji, pattern;
            const modalFn = window.SeekDeepNotify && window.SeekDeepNotify.modal;
            if (modalFn) {
              let emojiIn, patIn;
              const res = await modalFn({
                title: 'Edit auto-react rule', tone: 'info',
                render: (bodyEl) => {
                  const mk = (lbl, val, ph) => {
                    const w = document.createElement('label');
                    w.style.cssText = 'display:block;margin:6px 0;font:11px var(--font-mono);letter-spacing:0.06em;color:var(--hull-2);';
                    w.textContent = lbl;
                    const i = document.createElement('input');
                    i.type = 'text'; i.value = val || ''; i.placeholder = ph || '';
                    i.style.cssText = 'width:100%;margin-top:4px;padding:8px 10px;background:rgba(6,18,31,0.9);color:var(--hull);border:1px solid var(--stroke);border-radius:8px;font-size:14px;box-sizing:border-box;';
                    w.appendChild(i); bodyEl.appendChild(w); return i;
                  };
                  emojiIn = mk('Emoji (blank = keep current)', rule.emoji, rule.emoji || '🙂');
                  patIn = mk('Pattern (blank = keep current)', rule.pattern, rule.pattern || 'word|regex');
                },
                primary: { label: 'Save' },
                secondary: { label: 'Cancel', tone: 'neutral' },
                dismissible: true,
              });
              if (res !== 'primary') return;
              emoji = emojiIn ? emojiIn.value : '';
              pattern = patIn ? patIn.value : '';
            } else {
              emoji = prompt('New emoji (blank = keep current):', rule.emoji || '');
              if (emoji == null) return;
              pattern = prompt('New pattern (blank = keep current):', rule.pattern || '');
              if (pattern == null) return;
            }
            const body = {};
            if (emoji.trim()) body.emoji = emoji.trim();
            if (pattern.trim()) body.pattern = pattern.trim();
            if (!Object.keys(body).length) return;
            try { await callRule('PATCH', rule.id, body); loaded = false; load(); }
            catch (err) { (window.SeekDeepNotify?.toast || ((o) => alert(o.body ? o.title + ': ' + o.body : o.title)))({ tone: 'bad', title: 'Edit failed', body: String(err.message || err) }); }
          }
          async function doRemove(rule) {
            if (!await (window.SeekDeepConfirm || window.confirm)(`Remove rule ${rule.emoji} → ${rule.pattern}?`)) return;
            try { await callRule('DELETE', rule.id); loaded = false; load(); }
            catch (err) { (window.SeekDeepNotify?.toast || ((o) => alert(o.body ? o.title + ': ' + o.body : o.title)))({ tone: 'bad', title: 'Remove failed', body: String(err.message || err) }); }
          }
          async function doToggle(rule, toggleEl) {
            const next = !(rule.enabled !== false);
            try {
              await callRule('PATCH', rule.id, { enabled: next });
              toggleEl.classList.toggle('on', next);
              rule.enabled = next;
            } catch (err) { (window.SeekDeepNotify?.toast || ((o) => alert(o.body ? o.title + ': ' + o.body : o.title)))({ tone: 'bad', title: 'Toggle failed', body: String(err.message || err) }); }
          }
          btnInspect.addEventListener('click', () => {
            const m = document.createElement('div');
            m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:grid;place-items:center;';
            const json = JSON.stringify(rule, null, 2);
            m.innerHTML = `
              <div style="background:var(--substrate-2);border:1px solid var(--stroke);border-radius:var(--r-md);padding:24px;max-width:640px;color:var(--hull-2);font-family:var(--font-grotesk);">
                <h3 style="margin:0 0 12px 0;color:var(--cyan-1);font-family:var(--font-mono);letter-spacing:0.1em;">⌕ INSPECT · ${escapeHtml(rule.emoji || '?')} · ${escapeHtml(rule.pattern || '')}</h3>
                <pre style="background:#000;border:1px solid var(--stroke);border-radius:var(--r-sm);padding:12px;color:var(--cyan-1);font-size:11px;max-height:420px;overflow:auto;">${json.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</pre>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
                  <button id="riClose" style="background:transparent;color:var(--hull-2);border:1px solid var(--stroke);padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Close</button>
                </div>
              </div>`;
            document.body.appendChild(m);
            m.querySelector('#riClose').onclick = () => m.remove();
            m.onclick = (e) => { if (e.target === m) m.remove(); };
          });
          btnEdit.addEventListener('click', () => doEdit(rule));
          btnRemove.addEventListener('click', () => doRemove(rule));
          toggle.addEventListener('click', () => doToggle(rule, toggle));
          actions.appendChild(btnEdit); actions.append(' '); actions.appendChild(btnInspect); actions.appendChild(btnRemove);
          row.appendChild(actions);
          list.appendChild(row);
        });
      } catch (e) {
        loaded = false;
      }
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    // Wire the inline create-rule form. POST /reacts/rule with body
    // { guild_id, emoji, pattern, scope?, target? }. nav.js auto-injects
    // X-SeekDeep-Token. On success we reload the rules list.
    (function wireAddRule() {
      const btn = document.getElementById('rrAddBtn');
      const statusEl = document.getElementById('rrAddStatus');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const emoji   = document.getElementById('rrEmoji')?.value.trim() || '';
        const pattern = document.getElementById('rrPattern')?.value.trim() || '';
        const scope   = document.getElementById('rrScope')?.value || '';
        const target  = document.getElementById('rrTarget')?.value.trim() || '';
        const guildId = document.getElementById('rrGuildId')?.value.trim() || '';
        if (!emoji || !pattern || !guildId) {
          statusEl.style.color = 'var(--warn)';
          statusEl.textContent = '▸ emoji, pattern, and guild ID are all required';
          return;
        }
        if (scope && !target) {
          statusEl.style.color = 'var(--warn)';
          statusEl.textContent = '▸ scope was set but target is empty — pick a channel/user ID or set scope = any';
          return;
        }
        statusEl.style.color = 'var(--hull-3)';
        statusEl.textContent = '▸ saving…';
        btn.disabled = true;
        try {
          const body = { guild_id: guildId, emoji, pattern, enabled: true };
          if (scope) { body.scope = scope; body.target = target; }
          const r = await fetch(SEEKDEEP_BASE + '/reacts/rule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
            throw new Error(msg);
          }
          statusEl.style.color = 'var(--cyan-1)';
          statusEl.textContent = '▸ rule added · refreshing…';
          // Clear form
          ['rrEmoji','rrPattern','rrTarget'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
          loaded = false;
          await load();
          statusEl.textContent = '';
        } catch (err) {
          statusEl.style.color = 'var(--warn)';
          statusEl.textContent = '▸ add failed · ' + err.message;
        } finally {
          btn.disabled = false;
        }
      });
    })();
    function onActive() {
      const pane = document.querySelector('[data-pane="reacts"]');
      if (pane && pane.classList.contains('active')) load();
    }
    document.querySelectorAll('.sidebar a[data-mod="reacts"]').forEach(a =>
      a.addEventListener('click', () => setTimeout(onActive, 50))
    );
    onActive();
  })();

  
  // ===== (removed: dead wireArchive that hit a non-existent plural snapshot filename) =====
  // The real wiring lives below in wireArchiveBrowser, which reads the
  // correct singular /data/archive-snapshot.json that the bot's
  // seekdeepBuildArchiveSnapshot writes every 6h. The old wireArchive
  // raced for the same #archTabs + #archGrid DOM nodes but always
  // 404'd because the filename was wrong + the schema didn't match.

  // ===== Universal Archive · author-notify settings (v2 follow-up) =====
  // Persists to data/archive-config.json via POST /archive/config. Read on mount.
  // Mode options mirror the bot's index.js seekdeepArchiveNotifyMode constants:
  //   silent | dm | reply | react
  // "silent" is the v1 default — author never hears about it. Anything else
  // triggers a notification per the embed preview below the strip.
  (function wireArchiveNotify() {
    const mode    = document.getElementById('archNotifyMode');
    const selfTog = document.getElementById('archNotifySelfTog');
    const sentLbl = document.getElementById('archNotifySent');
    const preview = document.getElementById('archNotifyPreview');
    if (!mode || !selfTog) return;

    const BASE = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function')
      ? window.SeekDeepResolveBase()
      : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')
          ? 'http://127.0.0.1:7865'
          : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));

    let state = { mode: 'silent', notify_self: false, sent_24h: 0 };

    function render() {
      mode.value = state.mode;
      selfTog.classList.toggle('on', !!state.notify_self);
      sentLbl.textContent = state.sent_24h ? String(state.sent_24h) : '0';
      // Hide preview if Silent — nothing gets sent.
      preview.style.display = state.mode === 'silent' ? 'none' : 'block';
    }

    async function load() {
      try {
        const r = await fetch(BASE + '/archive/config', { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const j = await r.json();
          if (j && j.ok) state = Object.assign(state, j.config || {});
        }
      } catch (err) { window.SeekDeepDebug?.warn('archive/config load', err); }
      render();
    }
    async function save(patch) {
      Object.assign(state, patch);
      render();
      try {
        await fetch(BASE + '/archive/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: patch }),
        });
      } catch {
        // graceful — settings still applied in-page; will retry on next change.
      }
    }

    mode.addEventListener('change',    () => save({ mode: mode.value }));
    selfTog.addEventListener('click',  () => save({ notify_self: !state.notify_self }));

    // Only load when the archive pane becomes active (first time).
    let loaded = false;
    const pane = document.querySelector('[data-pane="archive"]');
    function onActive() {
      if (loaded) return;
      if (!pane || !pane.classList.contains('active')) return;
      loaded = true;
      load();
    }
    document.querySelectorAll('.sidebar a[data-mod="archive"]').forEach(a =>
      a.addEventListener('click', () => setTimeout(onActive, 60))
    );
    onActive();
  })();
  // The LIVE poller already updates VRAM in the sidebar status panel. This adds a
  // tiny extra: if /health exposes queue depth in future, we'll surface it here.
  // Currently a no-op placeholder so the wiring is in place when the field appears.

  // ===== Archive browser · live wiring (GET /data/archive-snapshot.json) =====
  // Reads the JSON the bot writes every 6h (see seekdeepBuildArchiveSnapshot
  // in index.js). Builds one tab per thread (ALL + SHARED + each user
  // thread), renders entries as cards, runs Search + Sort client-side.
  // Token-gated by gui_endpoints.py — nav.js auto-injects X-SeekDeep-Token.
  (function wireArchiveBrowser() {
    const tabs = document.getElementById('archTabs');
    const grid = document.getElementById('archGrid');
    const meta = document.getElementById('archSnapshotMeta');
    const searchInput = document.getElementById('archSearchInput');
    const sortSelect = document.getElementById('archSortSelect');
    const refreshBtn = document.getElementById('archRefreshBtn');
    if (!tabs || !grid) return;

    let snapshot = null;       // last loaded snapshot
    let activeTab = '*';       // '*' = all entries; thread_id otherwise
    let searchQ = '';
    let sortKey = 'ts-desc';

    function _escape(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }
    function _fmtAgo(ts) {
      if (!ts) return '—';
      const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
      if (s < 60)    return s + 's ago';
      if (s < 3600)  return Math.floor(s/60) + 'm ago';
      if (s < 86400) return Math.floor(s/3600) + 'h ago';
      return Math.floor(s/86400) + 'd ago';
    }

    // Walk snapshot → flat list of {entry, threadId, threadName, kind, guildId}
    function flattenEntries(snap) {
      const out = [];
      if (!snap || !snap.guilds) return out;
      for (const [gid, g] of Object.entries(snap.guilds)) {
        if (g.shared && Array.isArray(g.shared.entries)) {
          for (const e of g.shared.entries) out.push({ entry: e, threadId: g.shared.thread_id, threadName: g.shared.thread_name || 'shared', kind: 'shared', guildId: gid, guildName: g.guild_name });
        }
        if (g.users && typeof g.users === 'object') {
          for (const [uid, u] of Object.entries(g.users)) {
            if (!Array.isArray(u.entries)) continue;
            for (const e of u.entries) out.push({ entry: e, threadId: u.thread_id, threadName: u.thread_name || (u.nickname ? 'archive-' + u.nickname : 'archive-' + uid.slice(-6)), kind: 'user', guildId: gid, guildName: g.guild_name, userId: uid });
          }
        }
      }
      return out;
    }

    function renderTabs() {
      if (!snapshot) { tabs.innerHTML = '<span class="chip active" data-thread="*">ALL · —</span>'; return; }
      const all = flattenEntries(snapshot);
      const byThread = new Map();  // threadId → { name, kind, count }
      for (const item of all) {
        if (!byThread.has(item.threadId)) byThread.set(item.threadId, { name: item.threadName, kind: item.kind, count: 0 });
        byThread.get(item.threadId).count += 1;
      }
      tabs.innerHTML = '';
      const allChip = document.createElement('span');
      allChip.className = 'chip' + (activeTab === '*' ? ' active' : '');
      allChip.setAttribute('data-thread', '*');
      allChip.textContent = `ALL · ${all.length}`;
      tabs.appendChild(allChip);
      // Sort threads: shared first, then by entry count desc
      const threadEntries = [...byThread.entries()].sort((a, b) => {
        if (a[1].kind === 'shared' && b[1].kind !== 'shared') return -1;
        if (b[1].kind === 'shared' && a[1].kind !== 'shared') return 1;
        return b[1].count - a[1].count;
      });
      for (const [tid, info] of threadEntries) {
        const chip = document.createElement('span');
        chip.className = 'chip' + (activeTab === tid ? ' active' : '');
        chip.setAttribute('data-thread', tid);
        chip.textContent = `${info.kind === 'shared' ? 'SHARED' : (info.name || 'archive').replace(/^archive-/, '@')} · ${info.count}`;
        chip.title = info.name + ' · ' + info.kind + ' · ' + info.count + ' entries';
        tabs.appendChild(chip);
      }
      // Wire chip clicks
      tabs.querySelectorAll('.chip[data-thread]').forEach(c => {
        c.addEventListener('click', () => {
          activeTab = c.dataset.thread;
          tabs.querySelectorAll('.chip').forEach(x => x.classList.remove('active'));
          c.classList.add('active');
          renderGrid();
        });
      });
    }

    function renderGrid() {
      if (!snapshot) {
        grid.innerHTML = '<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--hull-3); font-family: var(--font-mono); font-size: 12px;">▸ snapshot not loaded yet · click ⟳ Refresh</div>';
        return;
      }
      let items = flattenEntries(snapshot);
      // Tab filter
      if (activeTab !== '*') items = items.filter(it => it.threadId === activeTab);
      // Search filter (prompt + key + requester + model)
      const q = searchQ.toLowerCase();
      if (q) {
        items = items.filter(it => {
          const e = it.entry;
          const hay = ((e.prompt || '') + ' ' + (e.refined || '') + ' ' + (e.key || '') + ' ' + (e.requester || '') + ' ' + (e.model || '')).toLowerCase();
          return hay.includes(q);
        });
      }
      // Sort
      const cmp = {
        'ts-desc':     (a, b) => (b.entry.created_ts || 0) - (a.entry.created_ts || 0),
        'ts-asc':      (a, b) => (a.entry.created_ts || 0) - (b.entry.created_ts || 0),
        'prompt-asc':  (a, b) => String(a.entry.prompt || '').localeCompare(String(b.entry.prompt || '')),
        'prompt-desc': (a, b) => String(b.entry.prompt || '').localeCompare(String(a.entry.prompt || '')),
      }[sortKey] || ((a, b) => 0);
      items.sort(cmp);

      if (!items.length) {
        grid.innerHTML = '<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--hull-3); font-family: var(--font-mono); font-size: 12px;">▸ no entries match'
          + (q ? ` "<span style="color:var(--cyan-1)">${_escape(q)}</span>"` : '')
          + '</div>';
        return;
      }

      // Render grid (XSS-safe via _escape on every server-provided string)
      grid.innerHTML = '';
      const MAX_RENDER = 200;  // keep DOM size sane
      const slice = items.slice(0, MAX_RENDER);
      for (const it of slice) {
        const e = it.entry;
        const card = document.createElement('a');
        card.href = e.message_url || '#';
        if (e.message_url) card.target = '_blank';
        card.style.cssText = 'display:flex; flex-direction:column; gap:6px; padding:10px; background: rgba(8,20,52,0.45); border:1px solid var(--stroke); border-radius: var(--r-md); text-decoration: none; color: inherit; transition: border-color 0.15s, box-shadow 0.15s; min-height: 200px;';
        card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--cyan-1)'; card.style.boxShadow = 'var(--cyan-glow)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--stroke)'; card.style.boxShadow = ''; });
        const thumbUrl = e.thumbnail || e.proxy_thumbnail || '';
        const thumb = document.createElement('div');
        thumb.style.cssText = 'width:100%; aspect-ratio: 1; border-radius: 4px; background: linear-gradient(135deg, var(--abyss-3), var(--cyan-3)); background-size: cover; background-position: center; flex-shrink: 0;';
        // Discord CDN URLs carry a signed `&hm=` token that's computed against
        // the literal query string. _escape() (HTML-entity escape) turned `&`
        // into `&amp;`, mangled the signature, and Discord rejected every
        // request — gradient placeholder for the whole archive grid. Validate
        // the origin so we still XSS-guard against snapshot tampering, then
        // pass the URL through verbatim. For CSS url() inside a double-quoted
        // string only `"` and `\` need escaping, and the trusted Discord
        // origins never include either.
        if (thumbUrl && /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(thumbUrl)) {
          thumb.style.backgroundImage = `url("${thumbUrl}")`;
        }
        card.appendChild(thumb);
        const promptEl = document.createElement('div');
        promptEl.style.cssText = 'font-size: 11px; color: var(--hull-2); line-height: 1.4; max-height: 56px; overflow: hidden; text-overflow: ellipsis;';
        promptEl.textContent = (e.prompt || '(no prompt)').slice(0, 160);
        card.appendChild(promptEl);
        const meta1 = document.createElement('div');
        meta1.style.cssText = 'font-size: 10px; color: var(--hull-3); font-family: var(--font-mono); letter-spacing: 0.08em; display: flex; justify-content: space-between; gap: 6px;';
        const left = document.createElement('span');
        left.textContent = (it.kind === 'shared' ? 'SHARED' : '@' + (it.threadName || '').replace(/^archive-/, ''));
        left.style.color = 'var(--cyan-1)';
        const right = document.createElement('span');
        right.textContent = _fmtAgo(e.created_ts);
        meta1.appendChild(left); meta1.appendChild(right);
        card.appendChild(meta1);
        if (e.model || e.seed || (e.width && e.height)) {
          const meta2 = document.createElement('div');
          meta2.style.cssText = 'font-size: 9px; color: var(--hull-3); font-family: var(--font-mono); opacity: 0.8;';
          const bits = [];
          if (e.model)  bits.push(String(e.model).split('/').pop().slice(0, 24));
          if (e.width && e.height) bits.push(e.width + '×' + e.height);
          if (e.seed != null) bits.push('seed ' + String(e.seed).slice(0, 10));
          meta2.textContent = bits.join(' · ');
          card.appendChild(meta2);
        }
        grid.appendChild(card);
      }
      if (items.length > MAX_RENDER) {
        const more = document.createElement('div');
        more.style.cssText = 'grid-column: 1/-1; padding: 14px; text-align: center; color: var(--hull-3); font-family: var(--font-mono); font-size: 11px;';
        more.textContent = `▸ showing first ${MAX_RENDER} of ${items.length} · narrow the search to see more`;
        grid.appendChild(more);
      }
    }

    function renderMeta() {
      if (!meta) return;
      if (!snapshot) { meta.textContent = '— snapshot pending'; return; }
      const total = (snapshot.total_shared_entries || 0) + (snapshot.total_user_entries || 0);
      const when = snapshot.generated_at ? new Date(snapshot.generated_at).toLocaleString() : '—';
      meta.textContent = `▸ ${total} entries across ${snapshot.guild_count} guild${snapshot.guild_count === 1 ? '' : 's'} · ${snapshot.shared_thread_count + snapshot.user_thread_count} threads · generated ${when}`;
    }

    async function load() {
      if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '⏳ Loading…'; }
      try {
        const r = await sdPollFetch(SEEKDEEP_BASE + '/data/archive-snapshot.json', { timeout: 5000, attempts: 2 });
        if (r.status === 401) throw new Error('unauthorized · refresh page so nav.js can inject the token');
        if (r.status === 404) {
          // No snapshot file yet (bot hasn't written one).
          snapshot = null;
          if (meta) meta.textContent = '— bot has not written a snapshot yet · run "@SeekDeep archive snapshot" in Discord';
          renderTabs(); renderGrid();
          return;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // Parse the (potentially multi-MB) payload ONCE — the old empty-check
        // did r.clone().json() then r.json() again, double-parsing the body.
        const wrap = await r.json().catch(() => null);
        if (!wrap || wrap.empty) {
          // Empty snapshot (bot hasn't written one yet)
          snapshot = null;
          if (meta) meta.textContent = '— bot has not written a snapshot yet · run "@SeekDeep archive snapshot" in Discord';
          renderTabs(); renderGrid();
          return;
        }
        snapshot = wrap.data || wrap;
        if (snapshot && snapshot.generated_at == null && snapshot.guilds == null) snapshot = null;
        renderTabs(); renderGrid(); renderMeta();
      } catch (err) {
        if (meta) meta.textContent = '— snapshot load failed: ' + String(err.message || err);
      } finally {
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '⟳ Refresh'; }
      }
    }

    searchInput?.addEventListener('input', e => { searchQ = (e.target.value || '').trim(); renderGrid(); });
    sortSelect?.addEventListener('change', e => { sortKey = e.target.value; renderGrid(); });
    refreshBtn?.addEventListener('click', () => load());

    // Auto-load when the archive pane becomes active. Drop the !snapshot
    // gate so clicking back to the pane after the bot ran a fresh
    // @SeekDeep archive snapshot picks up the new file — without the gate
    // the GUI was showing stale "bot has not written a snapshot yet" even
    // though the snapshot existed on disk.
    function onActive() {
      const pane = document.querySelector('[data-pane="archive"]');
      if (pane && pane.classList.contains('active')) load();
    }
    document.querySelectorAll('.sidebar a[data-mod="archive"]').forEach(a => {
      a.addEventListener('click', () => setTimeout(onActive, 50));
    });
    onActive();
    // Live-event hook: when the bot emits a snapshot.complete (or any
    // archive.* signal), re-load so the pane reflects the new file without
    // the user having to click Refresh. The bot's seekdeepBuildArchiveSnapshot
    // path can be extended to publish this; for now we also poll once a
    // minute as a cheap safety net.
    if (window.SeekDeepEvents && typeof window.SeekDeepEvents.on === 'function') {
      window.SeekDeepEvents.on('archive.snapshot.written', () => load());
      window.SeekDeepEvents.on('bot.discord.ready',       () => load());
    }
    setInterval(() => {
      const pane = document.querySelector('[data-pane="archive"]');
      if (pane && pane.classList.contains('active')) load();
    }, 60_000);
  })();

  // ===== Model row buttons · live wiring (POST /model/warm and /unload) =====
  document.querySelectorAll('.model-row[data-role]').forEach(row => {
    const role = row.dataset.role;
    const actions = row.querySelectorAll('.actions .btn-mini');
    actions.forEach(btn => {
      const txt = btn.textContent.trim().toUpperCase();
      btn.addEventListener('click', async () => {
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⋯ ' + orig.replace(/^[^A-Z]+/, '');
        try {
          let url, body;
          if (txt.includes('WARM') || txt.includes('PIN')) {
            url = SEEKDEEP_BASE + '/model/warm';
            body = JSON.stringify({ role });
          } else if (txt.includes('EVICT') || txt.includes('UNLOAD')) {
            url = SEEKDEEP_BASE + '/unload';
            body = JSON.stringify({ role });
          } else {
            // DEL or unknown — no backend wire for delete; fall through to flash only
            setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 600);
            return;
          }
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body, signal: AbortSignal.timeout(30000),
          });
          if (r.ok) {
            btn.textContent = '✓ ' + orig;
            // Trigger a /health refresh so the resident pill updates
            if (typeof LIVE !== 'undefined' && LIVE.probe) LIVE.probe();
          } else if (r.status === 404) {
            btn.textContent = '✕ missing';
          } else {
            btn.textContent = '✕ ' + r.status;
          }
        } catch (e) {
          btn.textContent = '✕ offline';
        } finally {
          setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 1800);
        }
      });
    });
  });
