(function () {
  const $ = (s, r=document) => r.querySelector(s);

  // Smart base — same Tauri/loopback/origin pattern every other page uses.
  const SEEKDEEP_BASE = (function() {
    if (typeof window === 'undefined') return 'http://127.0.0.1:7865';
    if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  })();

  // Demo seed used ONLY when /data/prompt-templates.json is unreachable
  // (server offline or token missing). Replaced by the real list on first
  // successful fetch — see hydrateFromBackend() below.
  const TEMPLATES = [
    {
      id: 'cli-reviewer', name: 'cli-reviewer', source: 'own', vars: ['language', 'code'],
      uses: 18, lastUsed: '4h ago', author: '@offline-demo',
      shared: { guild: '(demo guild)', age_days: 3, msg_id: 'm-31a8…' },
      body: `You are a code reviewer specializing in {{language}}.

Review the following code with a focus on:
1. Performance
2. Idiomatic style
3. Edge cases / failure modes
4. Naming
5. Maintainability over the next 6 months

\`\`\`{{language}}
{{code}}
\`\`\`

Output numbered points, terse. Cite line numbers. No filler.`,
    },
    {
      id: 'meeting-distiller', name: 'meeting-distiller', source: 'imported', vars: ['transcript'],
      uses: 7, lastUsed: '1d ago', author: '@offline-demo',
      body: `Read this meeting transcript and produce:
1. The 3 decisions made (verbatim where possible)
2. The 3 open questions raised but not answered
3. Who owns what

Be ruthless. Skip anything that's small-talk or hedging.

Transcript:
{{transcript}}`,
    },
    {
      id: 'tweet-shrink', name: 'tweet-shrink', source: 'own', vars: ['idea', 'voice'],
      uses: 33, lastUsed: '3h ago', author: '@offline-demo',
      shared: { guild: '(demo guild)', age_days: 24, msg_id: 'm-08c1…' },
      body: `Convert this idea into 3 tweet-sized variants ({{voice}} voice):
- < 240 chars each
- no hashtags
- no thread teasers
- punchy ending

idea: {{idea}}`,
    },
    {
      id: 'changelog-from-diff', name: 'changelog-from-diff', source: 'imported', vars: ['diff'],
      uses: 12, lastUsed: '5d ago', author: '@offline-demo',
      body: `Convert this git diff into a user-facing changelog entry. Group by:
- feat
- fix
- perf
- docs
Mention the file path in parens. Skip pure refactors.

\`\`\`diff
{{diff}}
\`\`\``,
    },
    {
      id: 'rubber-duck', name: 'rubber-duck', source: 'own', vars: ['problem'],
      uses: 41, lastUsed: '2h ago', author: '@offline-demo',
      shared: null,
      body: `You are a rubber duck. Read my problem and ask me one clarifying question per turn — never more — until I tell you I've figured it out.

When I'm done, summarize what I worked through and one risk I might have missed.

Problem: {{problem}}`,
    },
    {
      id: 'one-shot-fastapi', name: 'one-shot-fastapi', source: 'imported', vars: ['feature'],
      uses: 3, lastUsed: '2 weeks ago', author: '@offline-demo',
      body: `Scaffold a FastAPI route for: {{feature}}

Requirements:
- Pydantic request + response models
- 400 / 404 / 500 paths
- one happy-path test using TestClient
- no DB layer — assume an injected repository

Output: one file. No prose.`,
    },
    {
      id: 'persona-clinical', name: 'persona-clinical', source: 'own', vars: [],
      uses: 9, lastUsed: '6d ago', author: '@offline-demo',
      body: `Reply in clinical persona:
- numbered points
- footnoted citations where relevant
- minimal warmth
- like a manpage with feelings

The user wants information density, not company.`,
    },
  ];

  let active = TEMPLATES[0];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function _fmtAgo(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (isNaN(t)) return '—';
    const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }

  function paintBackendTag(state) {
    const tag = document.getElementById('tplBackendTag');
    const banner = document.getElementById('tplBanner');
    if (!tag) return;
    if (state === 'live') {
      tag.textContent = 'LIVE · ' + TEMPLATES.length + ' template' + (TEMPLATES.length === 1 ? '' : 's');
      tag.style.color = 'var(--cyan-1)';
      if (banner) banner.style.display = 'block';
    } else if (state === 'empty') {
      tag.textContent = 'LIVE · no templates yet · run @SeekDeep template save in Discord';
      tag.style.color = 'var(--hull-3)';
      if (banner) banner.style.display = 'block';
    } else if (state === 'offline') {
      tag.textContent = 'OFFLINE · showing demo seed · server unreachable';
      tag.style.color = 'var(--warn)';
      if (banner) {
        banner.style.background = 'rgba(255,184,77,0.08)';
        banner.style.borderColor = 'color-mix(in oklab, var(--warn) 35%, transparent)';
        banner.innerHTML = '<strong>⚠ OFFLINE.</strong> Couldn\'t reach <span class="mono">GET /data/prompt-templates.json</span> — showing in-page demo seed instead. Start the local AI server (or wait for it to come back) and reload this page.';
      }
    }
  }

  // Hydrate from /data/prompt-templates.json on load. Token-gated; nav.js's
  // patchedFetch auto-injects X-SeekDeep-Token on this path. Falls back to
  // the in-page demo seed if the server is unreachable.
  async function hydrateFromBackend(attempt) {
    attempt = attempt || 0;
    try {
      const r = await fetch(SEEKDEEP_BASE + '/data/prompt-templates.json', {
        signal: AbortSignal.timeout(4000),
        cache: 'no-store',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const wrap = await r.json();
      const d = wrap.data || wrap;
      const list = Array.isArray(d.templates) ? d.templates : [];
      // Replace TEMPLATES contents in place so the existing references stay valid.
      TEMPLATES.length = 0;
      // The bot's prompt-templates.json file mixes templates created
      // by guild members (kind=guild / source=imported) with the
      // current viewer's own templates. We can't know who the viewer
      // is from inside the browser, so we fall back to: anything with
      // a `imported_from_msg` or a non-matching `guild` field is
      // tagged 'imported'. Templates with no guild or owned-flag are
      // 'own'. This restores the IMPORTED chip + the Edit-button gate
      // that was always-OWN before.
      for (const t of list) {
        const isImported = !!(t.imported_from_msg || t.imported || (t.source === 'imported'));
        TEMPLATES.push({
          id:        String(t.id || ''),
          name:      String(t.name || '(unnamed)'),
          source:    isImported ? 'imported' : 'own',
          vars:      Array.isArray(t.vars) ? t.vars : [],
          uses:      Number(t.used_count || 0),
          lastUsed:  _fmtAgo(t.updated_at),
          author:    '@' + String(t.owner_user_id || '').slice(-6),
          shared:    isImported && t.imported_from_msg ? { guild: String(t.guild || ''), age_days: 0, msg_id: String(t.imported_from_msg || '') } : null,
          body:      String(t.prompt || ''),
          // Extra fields surfaced to the GUI viewer:
          char_count:  Number(t.char_count || 0),
          created_at:  String(t.created_at || ''),
          updated_at:  String(t.updated_at || ''),
          owner_id:    String(t.owner_user_id || ''),
          guild_id:    String(t.guild || ''),
        });
      }
      if (!TEMPLATES.length) {
        paintBackendTag('empty');
        // Render a single placeholder card so the viewer doesn't look broken.
        // Push it into TEMPLATES so renderList shows the card AND select('_empty')
        // can find it — previously `active` was set to a non-member object, so
        // select() reset active to undefined (empty list) and threw on
        // active.name, dropping the page into a false "OFFLINE" state for any
        // user with zero saved templates.
        active = { id: '_empty', name: '(no templates yet)', source: 'own', vars: [], uses: 0, lastUsed: '—', author: '—', shared: null, body: '▸ No templates saved yet.\n\nIn Discord, run:\n  @SeekDeep template save <name>: <prompt body with {{variables}}>\n\nExample:\n  @SeekDeep template save tldr: Summarize {{text}} in 3 bullets, no filler.' };
        TEMPLATES.push(active);
        renderList('');
        select('_empty');
        return;
      }
      active = TEMPLATES[0];
      renderList('');
      select(active.id);
      paintBackendTag('live');
    } catch (err) {
      // This inline init runs BEFORE the deferred nav.js installs its token
      // interceptor, so the first fetch to the token-gated templates file
      // 401s; sidecar respawns cause transient blips too. Retry across that
      // window before falling back to the labeled offline demo seed — that's
      // what used to make the sample @offline-demo rows show as "the
      // marketplace" on every normal load (mirrors the bootSeqLog fix).
      if (attempt < 4) {
        setTimeout(() => hydrateFromBackend(attempt + 1), 250 * attempt + 250);
        return;
      }
      paintBackendTag('offline');
      // Genuine offline after retries — keep the in-page demo seed (labeled).
    }
  }

  function renderList(q) {
    const host = $('#tplList');
    const filtered = TEMPLATES.filter(t => !q || t.name.toLowerCase().includes(q.toLowerCase()));
    // XSS-safe: t.name + t.id come from data/prompt-templates.json (user
    // input via @SeekDeep template create / Discord #prompts imports), so
    // every interpolation runs through escapeHtml. Numeric fields stay raw.
    host.innerHTML = filtered.map(t => `
      <div class="tpl ${t.id === active.id ? 'active' : ''}" data-id="${escapeHtml(t.id)}">
        <div class="nm">${escapeHtml(t.name)}</div>
        <div class="meta">
          <span><em>${t.vars.length}</em> var${t.vars.length === 1 ? '' : 's'} · <em>${t.uses}</em> uses</span>
          <span class="src-tag ${t.source === 'own' ? 'own' : 'imported'}">${t.source === 'own' ? 'OWN' : 'IMPORTED'}</span>
        </div>
      </div>
    `).join('');
    host.querySelectorAll('.tpl').forEach(el => el.addEventListener('click', () => select(el.dataset.id)));
  }
  function highlightVars(body, vars) {
    let s = escapeHtml(body);
    vars.forEach(v => {
      s = s.replaceAll(`{{${v}}}`, `<span class="placeholder">{{${v}}}</span>`);
    });
    return s;
  }

  function select(id) {
    active = TEMPLATES.find(t => t.id === id) || TEMPLATES[0];
    if (!active) { renderList($('#filter').value); return; }  // empty list — nothing to paint (avoids undefined-active throw)
    renderList($('#filter').value);
    $('#vName').textContent = active.name;
    $('#vSub').innerHTML = `▸ data/prompt-templates.json · ${active.source === 'own' ? 'local · authored here' : 'imported from #prompts'}`;
    // Edit button only enabled for OWN templates (imported ones round-trip thru
    // re-share locally); never for the '(no templates yet)' placeholder, which
    // would otherwise let a save create a junk template.
    const editBtn = $('#vEdit');
    if (editBtn) {
      const editable = active.source === 'own' && active.id !== '_empty';
      editBtn.disabled = !editable;
      editBtn.style.opacity = editable ? '' : '0.35';
      editBtn.style.pointerEvents = editable ? '' : 'none';
      editBtn.title = editable
        ? 'Edit body / re-share'
        : (active.id === '_empty'
            ? 'No templates yet — author one in Discord: @SeekDeep template save'
            : 'Imported templates are read-only here — duplicate to fork.');
    }
    // XSS-safe: every user-controlled field (vars list, guild name, author)
    // flows through escapeHtml before interpolation.
    $('#vMeta').innerHTML = `
      <span><em>source</em> ${escapeHtml(active.source)}</span>
      <span><em>variables</em> ${active.vars.map(escapeHtml).join(', ') || '(none)'}</span>
      <span><em>chars</em> ${active.body.length}</span>
      <span><em>uses</em> ${active.uses}</span>
      <span><em>last used</em> ${escapeHtml(active.lastUsed)}</span>
      <span><em>shared</em> ${active.shared
        ? escapeHtml(active.shared.guild) + ' · ' + (active.shared.age_days < 1 ? 'today' : active.shared.age_days + 'd ago')
        : '<span style="color:var(--hull-3)">never</span>'}</span>
    `;
    $('#vBody').innerHTML = highlightVars(active.body, active.vars);
    // Embed preview
    $('#eTitle').textContent = `Template: ${active.name}`;
    $('#eDesc').innerHTML    = `Posted by <b>${escapeHtml(active.author)}</b> · ${active.vars.length} variable${active.vars.length === 1 ? '' : 's'}`;
    $('#eVars').textContent  = active.vars.length ? active.vars.map(v => `{{${v}}}`).join(', ') : '(none)';
    $('#eLen').textContent   = `${active.body.length} chars`;
    $('#eAuth').textContent  = active.author;
    $('#eBody').textContent  = active.body.length > 360 ? active.body.slice(0, 360) + '\n…' : active.body;
  }

  $('#filter').addEventListener('input', () => renderList($('#filter').value));

  // Share modal
  const shBack = $('#shBack'), sh = $('#sh');
  $('#vShare').addEventListener('click', () => { sh.classList.add('open'); shBack.classList.add('open'); });
  function closeShare() { sh.classList.remove('open'); shBack.classList.remove('open'); }
  $('#shCancel').addEventListener('click', closeShare);
  shBack.addEventListener('click', closeShare);
  // Honest helper: prompt-templates writes only happen via the bot's
  // Discord slash command (no GUI write endpoint exists). Show the
  // command + Copy button instead of pretending to write locally.
  function showPromptDiscordHint(title, cmd, body) {
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:grid;place-items:center;';
    m.innerHTML = `
      <div style="background:var(--substrate-2);border:1px solid var(--stroke);border-radius:var(--r-md);padding:24px;max-width:640px;color:var(--hull-2);font-family:var(--font-grotesk);">
        <h3 style="margin:0 0 8px 0;color:var(--cyan-1);font-family:var(--font-mono);letter-spacing:0.1em;">${title}</h3>
        <p style="color:var(--hull-3);font-size:13px;line-height:1.55;margin-bottom:12px;">${body}</p>
        <pre style="background:#000;border:1px solid var(--stroke);border-radius:var(--r-sm);padding:12px;color:var(--cyan-1);font-size:12px;overflow:auto;user-select:all;">${cmd.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</pre>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button id="phCopy" style="background:var(--cyan-2);color:#000;border:0;padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Copy</button>
          <button id="phClose" style="background:transparent;color:var(--hull-2);border:1px solid var(--stroke);padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Close</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('#phCopy').onclick = async () => { try { await navigator.clipboard.writeText(cmd); } catch {} };
    m.querySelector('#phClose').onclick = () => m.remove();
    m.onclick = (e) => { if (e.target === m) m.remove(); };
  }

  $('#shGo').addEventListener('click', () => {
    closeShare();
    const body = (active.body || '').replace(/\n/g, ' ').slice(0, 200);
    showPromptDiscordHint(
      '▸ Post to #prompts',
      `@SeekDeep template share ${active.name}`,
      "GUI doesn't have a write endpoint for #prompts yet. Run this in any guild channel where SeekDeep can post to #prompts:",
    );
  });

  // Import button in the discord-mock — mock toggle
  $('#dImport').addEventListener('click', e => {
    e.currentTarget.textContent = '✓ IMPORTED · saved locally';
    e.currentTarget.style.background = '#57f287';
    e.currentTarget.style.color = '#1e1f22';
  });

  // === Storage scope (guild_id + owner_user_id), sticky via localStorage ===
  const SCOPE_LS_KEY = 'seekdeep:prompts:scope';
  function getScope() {
    return {
      guild_id: ($('#tplGuildId')?.value || '').trim(),
      owner_user_id: ($('#tplOwnerId')?.value || '').trim(),
    };
  }
  (function loadScope() {
    try {
      const raw = localStorage.getItem(SCOPE_LS_KEY);
      if (!raw) return;
      const j = JSON.parse(raw);
      if ($('#tplGuildId') && j.guild_id) $('#tplGuildId').value = j.guild_id;
      if ($('#tplOwnerId') && j.owner_user_id) $('#tplOwnerId').value = j.owner_user_id;
    } catch {}
  })();
  ['#tplGuildId', '#tplOwnerId'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('input', () => {
      try { localStorage.setItem(SCOPE_LS_KEY, JSON.stringify(getScope())); } catch {}
    });
  });
  function scopeReady(action) {
    const s = getScope();
    if (s.guild_id && s.owner_user_id) return s;
    window.SeekDeepNotify?.toast?.({
      tone: 'warn', title: `${action} needs storage scope`,
      body: 'Set guild ID + your Discord user ID in the left rail first.',
      ttl: 6000,
    });
    return null;
  }
  function templateBase() {
    return (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function')
      ? window.SeekDeepResolveBase()
      : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')
          ? 'http://127.0.0.1:7865'
          : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
  }
  async function postTemplate(name, body) {
    const s = getScope();
    const r = await fetch(templateBase() + '/prompts/template', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guild_id: s.guild_id, owner_user_id: s.owner_user_id, name, prompt: body }),
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }
  async function deleteTemplate(name) {
    const s = getScope();
    const id = `${s.guild_id}:${s.owner_user_id}:${name}`;
    const r = await fetch(templateBase() + '/prompts/template/' + encodeURIComponent(id), {
      method: 'DELETE',
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); msg = j.detail || j.error || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }

  $('#vDup').addEventListener('click', async () => {
    if (!scopeReady('Duplicate') || !active) return;
    const copyName = `${active.name}-copy`;
    try {
      await postTemplate(copyName, active.body || '');
      window.SeekDeepNotify?.toast?.({ tone: 'good', title: `✓ Duplicated as ${copyName}`, ttl: 4000 });
      if (typeof hydrateFromBackend === 'function') hydrateFromBackend();
    } catch (err) {
      window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Duplicate failed', body: err.message || String(err), ttl: 6000 });
    }
  });

  $('#vDelete').addEventListener('click', async () => {
    if (!active || !scopeReady('Delete')) return;
    const ok = await (window.SeekDeepConfirm || window.confirm)(`Delete template "${active.name}"?\nThis is permanent.`);
    if (!ok) return;
    try {
      await deleteTemplate(active.name);
      window.SeekDeepNotify?.toast?.({ tone: 'good', title: `✓ Deleted ${active.name}`, ttl: 4000 });
      if (typeof hydrateFromBackend === 'function') hydrateFromBackend();
    } catch (err) {
      window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Delete failed', body: err.message || String(err), ttl: 6000 });
    }
  });
  $('#vExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(active, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = active.name + '.template.json';
    // Defer revoke — revoking synchronously right after click() cancels the
    // download in Firefox/Safari before the browser reads the blob.
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 100);
  });

  $('#jumpChBtn').addEventListener('click', async () => {
    // Deep-link straight into the Discord desktop client. The bot stores the
    // #prompts channel per guild (admin: "@SeekDeep prompts channel here"); we
    // read it from /prompts/channels and open discord://-/channels/<g>/<c>,
    // falling back to the https form (which the desktop app also handles).
    function openDiscord(deepUrl, webUrl) {
      try {
        const t = window.__TAURI__;
        if (t && t.core && typeof t.core.invoke === 'function') {
          t.core.invoke('open_external', { url: deepUrl })
            .catch(() => { try { window.open(webUrl, '_blank'); } catch (_) {} });
          return;
        }
      } catch (_) {}
      try { window.open(webUrl, '_blank'); } catch (_) {}
    }
    let channels = [];
    try {
      const r = await fetch(templateBase() + '/prompts/channels', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (r.ok) channels = (((await r.json()) || {}).channels) || [];
    } catch (_) { /* server not up — fall through to the hint */ }
    if (channels.length) {
      const wantGuild = (($('#tplGuildId') && $('#tplGuildId').value) || '').trim();
      const target = channels.find((c) => c.guild_id === wantGuild) || channels[0];
      openDiscord(
        `discord://-/channels/${target.guild_id}/${target.channel_id}`,
        `https://discord.com/channels/${target.guild_id}/${target.channel_id}`,
      );
      return;
    }
    // No channel configured yet — honest guidance (an admin must opt in once).
    showPromptDiscordHint(
      'Jump to #prompts',
      `@SeekDeep prompts channel here`,
      'No #prompts channel is configured yet. A server admin runs <span class="mono">@SeekDeep prompts channel here</span> once in the channel they want — then this button jumps you straight into it in the Discord desktop app.',
    );
  });
  $('#newBtn').addEventListener('click', () => {
    if (!scopeReady('Create new')) return;
    active = {
      id: 'draft-' + Date.now(),
      name: 'new-template',
      body: 'Replace this with your prompt. Use {{variables}} for placeholders.',
      vars: ['variables'],
      author: getScope().owner_user_id || 'you',
      source: 'own',
      shared: null,
    };
    if (Array.isArray(window.TEMPLATES)) window.TEMPLATES.push(active);
    if (typeof select === 'function') select(active.id);
    if (typeof openEdit === 'function') openEdit();
  });

  // ===== Edit-in-place flow (v2 follow-up — prompts marketplace) =====
  // Mirrors the bot side: when a previously-shared template is edited, the
  // user picks edit-in-place (≤ 14d old, recommended) or tombstone+repost.
  // The 14-day cut-off matches Discord's hard limit on bot message edits.
  const SHARE_EDIT_CUTOFF_DAYS = 14;
  const edBack = $('#edBack'), ed = $('#ed');
  function openEdit() {
    if (!active || active.source !== 'own') return;
    $('#edName').textContent = active.name;
    $('#edInputName').value = active.name;
    $('#edInputBody').value = active.body;
    updateLen();
    // Strategy strip wiring
    const wrap = $('#edStrategyWrap');
    if (active.shared) {
      wrap.style.display = '';
      $('#edSharedAgo').textContent  = active.shared.age_days < 1
        ? 'today'
        : active.shared.age_days + ' day' + (active.shared.age_days === 1 ? '' : 's') + ' ago';
      $('#edSharedGuild').textContent = active.shared.guild;
      const inWindow = active.shared.age_days <= SHARE_EDIT_CUTOFF_DAYS;
      const pick = inWindow ? 'edit-in-place' : 'tombstone-repost';
      $('#edStratPicked').innerHTML = inWindow
        ? 'Within the <b>' + SHARE_EDIT_CUTOFF_DAYS + '-day</b> edit window — <span style="color: var(--good)">edit-in-place recommended</span>.'
        : 'Past the <b>' + SHARE_EDIT_CUTOFF_DAYS + '-day</b> edit window — <span style="color: var(--warn)">tombstone + repost</span> required.';
      document.querySelectorAll('input[name="edStrat"]').forEach(r => r.checked = (r.value === pick));
      document.querySelector('input[name="edStrat"][value="edit-in-place"]').disabled = !inWindow;
      // Visually grey the disabled option.
      const eipLabel = document.querySelector('.strat-opt[data-strat="edit-in-place"]');
      eipLabel.style.opacity = inWindow ? '' : '0.45';
      eipLabel.style.cursor  = inWindow ? '' : 'not-allowed';
    } else {
      wrap.style.display = 'none';
    }
    ed.classList.add('open'); edBack.classList.add('open');
  }
  function closeEdit() { ed.classList.remove('open'); edBack.classList.remove('open'); }
  function updateLen() {
    $('#edInputLen').textContent = ($('#edInputBody').value.length) + ' chars';
  }
  $('#edInputBody').addEventListener('input', updateLen);
  $('#vEdit').addEventListener('click', openEdit);
  $('#edCancel').addEventListener('click', closeEdit);
  edBack.addEventListener('click', closeEdit);

  function commitLocal() {
    active.name = $('#edInputName').value.trim() || active.name;
    active.body = $('#edInputBody').value;
    // Re-compute vars from {{ }} tokens in body.
    const tokens = new Set();
    (active.body.match(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi) || []).forEach(m => {
      const v = m.replace(/[{}\s]/g, '');
      if (v) tokens.add(v);
    });
    active.vars = [...tokens];
  }

  $('#edSaveLocal').addEventListener('click', async () => {
    if (!scopeReady('Save local')) return;
    commitLocal();
    try {
      const r = await postTemplate(active.name, active.body);
      closeEdit();
      select(active.id);
      flashChannelState(`✓ SAVED · ${r.char_count || active.body.length} chars · ${(r.vars||[]).length} vars`);
      window.SeekDeepNotify?.toast?.({ tone: 'good', title: `✓ Saved ${active.name}`, body: r.created ? 'New template created' : 'Updated existing', ttl: 4000 });
      if (typeof hydrateFromBackend === 'function') hydrateFromBackend();
    } catch (err) {
      window.SeekDeepNotify?.toast?.({ tone: 'bad', title: 'Save failed', body: err.message || String(err), ttl: 6000 });
    }
  });

  $('#edSaveReshare').addEventListener('click', () => {
    commitLocal();
    if (active.shared) {
      const strat = (document.querySelector('input[name="edStrat"]:checked') || {}).value;
      if (strat === 'edit-in-place') {
        // "message.edit()" — keep same msg_id, mark edited.
        active.shared.age_days = 0;
        flashChannelState('✓ EDIT-IN-PLACE · #prompts embed updated');
      } else {
        // tombstone the old, post a fresh one
        active.shared = { guild: active.shared.guild, age_days: 0, msg_id: 'm-' + Math.random().toString(16).slice(2,6) + '…' };
        flashChannelState('✓ TOMBSTONED + REPOSTED · fresh embed in #prompts');
      }
    } else {
      // first-time share
      active.shared = { guild: '(demo guild)', age_days: 0, msg_id: 'm-' + Math.random().toString(16).slice(2,6) + '…' };
      flashChannelState('✓ POSTED · #prompts embed shipped');
    }
    closeEdit();
    select(active.id);
  });

  function flashChannelState(msg) {
    const ch = $('#chState');
    if (!ch) return;
    const orig = ch.textContent;
    ch.textContent = msg;
    ch.style.color = '#57f287';
    setTimeout(() => { ch.textContent = orig; ch.style.color = ''; }, 4000);
  }

  renderList();
  select(TEMPLATES[0].id);
  // Replace the demo seed with live data. hydrateFromBackend() fetches the
  // token-gated /data/prompt-templates.json, so it MUST run after nav.js (below,
  // deferred) patches fetch — deferred scripts execute before DOMContentLoaded.
  // Firing it inline during parse sent the fetch on the UNpatched fetch → 401 →
  // the page stuck on the demo seed + OFFLINE banner (same race as memory.html).
  // nav.js's patchedFetch then attaches the token; _normalize_prompt_templates
  // flattens the guild→user→name nesting into a flat list with extracted {{vars}}.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrateFromBackend, { once: true });
  else hydrateFromBackend();
})();
