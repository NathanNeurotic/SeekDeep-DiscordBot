/* ============================================================
   Task 1 · Add-a-Model wizard logic
   ============================================================ */
(function () {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  const wiz       = $('#wiz');
  const wizBack   = $('#wizBack');
  const stepPill  = $('#wizStepPill');
  const nextBtn   = $('#wizNext');
  const backBtn   = $('#wizBack2');

  let step = 1;
  const state = { backend: null, model_id: '', api_url: '', api_key: '', api_version: '2023-06-01', role: '' };

  function open() {
    wiz.classList.add('open');
    wizBack.classList.add('open');
    go(1);
  }
  function close() {
    wiz.classList.remove('open');
    wizBack.classList.remove('open');
    $('#wizResult').style.display = 'none';
    $('#wizResult').textContent = '';
  }

  function go(n) {
    step = n;
    $$('.wiz-body .step').forEach(el => el.classList.toggle('active', +el.dataset.step === n));
    $$('.wiz-stepper .s').forEach((el, i) => {
      el.classList.remove('active', 'done');
      if (i + 1 === n) el.classList.add('active');
      else if (i + 1 < n) el.classList.add('done');
    });
    const names = ['', 'BACKEND', 'MODEL ID', 'CREDENTIALS', 'ASSIGN + CONFIRM'];
    stepPill.textContent = `STEP ${n} OF 4 · ${names[n]}`;
    backBtn.style.display = n === 1 ? 'none' : '';
    nextBtn.textContent = n === 4 ? '▸ Install' : 'Next ›';
    // Skip credentials for local backends
    if (n === 3 && (state.backend === 'hf' || state.backend === 'ollama')) {
      return go(4);
    }
    if (n === 4) renderSummary();
  }

  function pickBackend(b) {
    state.backend = b;
    $$('.backend-card').forEach(c => c.classList.toggle('sel', c.dataset.backend === b));
    const desc = {
      'hf':            'Free-text repo ID. Browse <a href="https://huggingface.co/models" target="_blank" style="color:var(--cyan-1);">huggingface.co/models</a> for ideas.',
      'ollama':        'Pick from installed tags below, or type a new tag to pull (e.g. <span class="mono">llama3.1:8b-instruct-q4_K_M</span>).',
      'openai-compat': 'Provider-specific model name. e.g. <span class="mono">deepseek-chat</span>, <span class="mono">gpt-4</span>, <span class="mono">grok-4</span>, <span class="mono">moonshotai/kimi-k2</span>.',
      'anthropic':     'Pick a Claude model below, or type any current <span class="mono">claude-*</span> ID.',
      'gemini':        'Pick a Gemini model below, or type any current <span class="mono">gemini-*</span> ID.',
    };
    $('#wizModelDesc').innerHTML = desc[b] || '';
    $('#wizOllamaTags').style.display       = b === 'ollama'    ? 'block' : 'none';
    $('#wizAnthropicChoices').style.display = b === 'anthropic' ? 'block' : 'none';
    $('#wizGeminiChoices').style.display    = b === 'gemini'    ? 'block' : 'none';
    $('#wizAnthropicVersion').style.display = b === 'anthropic' ? 'block' : 'none';

    const urlDefaults = {
      'openai-compat': 'https://api.openai.com/v1',
      'anthropic':     'https://api.anthropic.com/v1/messages',
      'gemini':        'https://generativelanguage.googleapis.com/v1beta',
    };
    $('#wizApiUrl').value = urlDefaults[b] || '';
  }

  function renderSummary() {
    $('#sumBackend').textContent = state.backend || '—';
    $('#sumModel').textContent   = state.model_id || '—';
    const remote = state.backend && state.backend !== 'hf' && state.backend !== 'ollama';
    $('#sumApiRow').style.display = remote ? 'grid' : 'none';
    $('#sumKeyRow').style.display = remote ? 'grid' : 'none';
    $('#sumUrl').textContent = state.api_url || '—';
    $('#sumKey').textContent = state.api_key ? state.api_key.slice(0, 4) + '••••' + state.api_key.slice(-2) : '—';
    $('#sumRole').textContent = state.role || '(unassigned)';
  }

  async function submit() {
    const body = { backend: state.backend, model_id: state.model_id };
    if (state.role) body.role = state.role;
    if (state.backend === 'ollama') body.auto_pull = true;
    if (state.backend && state.backend !== 'hf' && state.backend !== 'ollama') {
      body.api_url = state.api_url;
      body.api_key = state.api_key;
      if (state.backend === 'anthropic') body.api_version = state.api_version;
    }
    const r = $('#wizResult');
    r.style.display = 'block';
    r.style.color = 'var(--hull-2)';
    r.style.background = 'rgba(45,212,255,0.05)';
    r.style.border = '1px solid var(--stroke)';
    r.innerHTML = '⋯ <span style="color:var(--cyan-1)">POST /model/install</span> · downloading and probing …';
    nextBtn.disabled = true;
    try {
      const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
      const res = await fetch(base + '/model/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        r.style.color = 'var(--good)';
        r.style.background = 'rgba(88,230,161,0.06)';
        r.style.borderColor = 'color-mix(in oklab, var(--good) 40%, transparent)';
        let extra = '';
        if (data.files_downloaded) extra += ` · ${data.files_downloaded} files`;
        if (data.local_dir)        extra += `\n  cached to ${data.local_dir}`;
        if (data.note)             extra += `\n  note: ${data.note}`;
        if (data.external)         extra += '\n  ⚠ external · prompts leave the local machine';
        r.textContent = `✓ ${body.backend} · ${body.model_id} installed${extra}`;
        r.style.whiteSpace = 'pre-wrap';
        nextBtn.textContent = 'Done · close';
        // Re-enable (the disable at the top of submit() was only for the
        // in-flight request) AND remove the stale `advance` click listener so
        // this button now ONLY closes — otherwise a click fires both onclick
        // (close+reload) and advance() (a re-submit). Without the re-enable the
        // user was stranded on the success screen, unable to click 'Done'.
        nextBtn.removeEventListener('click', advance);
        nextBtn.disabled = false;
        nextBtn.onclick = () => { close(); location.reload(); };
      } else {
        r.style.color = 'var(--bad)';
        r.style.background = 'rgba(255,107,107,0.06)';
        r.style.borderColor = 'color-mix(in oklab, var(--bad) 40%, transparent)';
        r.textContent = `✕ ${res.status} · ${data.error || data.detail || res.statusText}`;
        nextBtn.disabled = false;
      }
    } catch (e) {
      r.style.color = 'var(--bad)';
      r.style.background = 'rgba(255,107,107,0.06)';
      r.style.borderColor = 'color-mix(in oklab, var(--bad) 40%, transparent)';
      r.textContent = `✕ couldn't reach /model/install · ${e.message || e}`;
      nextBtn.disabled = false;
    }
  }

  function advance() {
    if (step === 1) {
      if (!state.backend) return;
      return go(2);
    }
    if (step === 2) {
      state.model_id = $('#wizModelId').value.trim();
      if (!state.model_id) return;
      const isLocal = state.backend === 'hf' || state.backend === 'ollama';
      return go(isLocal ? 4 : 3);
    }
    if (step === 3) {
      state.api_url = $('#wizApiUrl').value.trim();
      state.api_key = $('#wizApiKey').value;
      state.api_version = $('#wizApiVersion').value.trim() || '2023-06-01';
      if (!state.api_url || !state.api_key) return;
      return go(4);
    }
    if (step === 4) {
      state.role = $('#wizRole').value;
      return submit();
    }
  }
  function regress() {
    if (step === 4) {
      const isLocal = state.backend === 'hf' || state.backend === 'ollama';
      return go(isLocal ? 2 : 3);
    }
    if (step > 1) go(step - 1);
  }

  $('#openAddModel')?.addEventListener('click', open);

  // Search models filter — case-insensitive, matches name + role + backend.
  // Hides rows that don't match so the user can find a model in a list of
  // ~25 entries without scrolling. Empty query restores all rows.
  $('#modelSearchInput')?.addEventListener('input', (e) => {
    const q = (e.target.value || '').trim().toLowerCase();
    document.querySelectorAll('.model-row').forEach(row => {
      if (!q) { row.style.display = ''; return; }
      const hay = ((row.dataset.model || '') + ' ' +
                   (row.dataset.role  || '') + ' ' +
                   (row.dataset.backend || '') + ' ' +
                   (row.textContent || '')).toLowerCase();
      row.style.display = hay.includes(q) ? '' : 'none';
    });
  });

  $('#wizCancel').addEventListener('click', close);
  wizBack.addEventListener('click', close);
  nextBtn.addEventListener('click', advance);
  backBtn.addEventListener('click', regress);
  $$('.backend-card').forEach(c => c.addEventListener('click', () => pickBackend(c.dataset.backend)));
  $$('#wizOllamaTagsList .chip, #wizAnthropicChoices .chip, #wizGeminiChoices .chip').forEach(c => {
    c.addEventListener('click', () => {
      if (c.dataset.tag) $('#wizModelId').value = c.dataset.tag;
    });
  });
  // Wire the per-row Remove buttons
  document.querySelectorAll('.model-row [data-act="remove"]').forEach(b => {
    b.addEventListener('click', async () => {
      const row = b.closest('.model-row');
      const model = row.dataset.model || row.querySelector('.name')?.firstChild?.textContent?.trim();
      const role = row.dataset.role || '';
      const backend = row.dataset.backend || 'hf';
      const sdn = window.SeekDeepNotify;
      const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
      // Hydrate role binding from live /models/available BEFORE confirming, so
      // we don't tell the user they're detaching a role that's actually
      // pointing at a different model than the stale HTML row claims.
      // Hardcoded rows ship with default model_ids (e.g. Llama-3.1-8B-Instruct
      // for default_chat) that may not match the user's live config.
      let liveRoleBindsThisModel = false;
      let liveRoleModelId = '';
      if (role) {
        try {
          const ar = await fetch(base + '/models/available', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
          if (ar.ok) {
            const ad = await ar.json();
            const cur = ad.current || {};
            const envKey = role === 'image' ? 'LOCAL_IMAGE_MODEL_ID'
                         : role === 'vision' ? 'LOCAL_VISION_MODEL_ID'
                         : 'LOCAL_CHAT_MODEL_ID';
            liveRoleModelId = String(cur[envKey] || '').replace(/^ollama:/, '');
            liveRoleBindsThisModel = (liveRoleModelId === model);
          }
        } catch {}
      }
      const detachWarning = (role && liveRoleBindsThisModel)
        ? `\n\nThis role currently points at this model. Removing it will blank the ${role} binding in .env and the next /chat will fall back to whatever LOCAL_CHAT_BACKEND points at.`
        : (role && liveRoleModelId && liveRoleModelId !== model)
          ? `\n\nNote: role "${role}" is currently bound to "${liveRoleModelId}", NOT this model. Removing the disk cache for "${model}" will not change the role binding.`
          : '';
      const okPrompt = window.SeekDeepConfirm || (async (msg) => window.confirm(msg));
      if (!await okPrompt(`Remove ${model}?\nBackend: ${backend.toUpperCase()}\nRole: ${role || '(unassigned)'}${detachWarning}`)) return;
      try {
        const r = await fetch(base + '/model/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ backend, model_id: model, role: role || undefined }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          const freed = Number.isFinite(data.freed_bytes) ? ` · freed ${(data.freed_bytes/1024/1024).toFixed(1)} MB` : '';
          row.style.opacity = '0.4';
          row.querySelector('[data-role-state]')?.replaceChildren();
          row.querySelector('[data-role-state]')?.append(Object.assign(document.createElement('span'), { className: 'pill bad', innerHTML: '<span class="dot"></span>NOT INSTALLED' }));
          const body = data.env_skip_reason ? `${data.env_skip_reason}${freed}` : `Removed${freed}`;
          if (sdn?.toast) sdn.toast({ tone: 'good', title: '✓ uninstalled', body, ttl: 6000 });
          else alert(`✓ uninstalled${freed}`);
        } else {
          if (sdn?.toast) sdn.toast({ tone: 'bad', title: `✕ HTTP ${r.status}`, body: data.error || r.statusText, ttl: 6000 });
          else alert(`✕ ${r.status} · ${data.error || r.statusText}`);
        }
      } catch (e) {
        if (sdn?.toast) sdn.toast({ tone: 'bad', title: '✕ couldn\'t reach /model/uninstall', body: String(e.message || e), ttl: 6000 });
        else alert(`✕ couldn't reach /model/uninstall · ${e.message || e}`);
      }
    });
  });
  // Wire the per-row WARM buttons. /model/warm dispatches by role:
  //   image   -> calls the image warmup handler
  //   vision  -> calls the vision warmup handler
  //   <chat>  -> loads the chat model for that role
  // GUI feedback: row state pill flips to "WARMING", and on response we
  // flip to "RESIDENT" (success) / "ERROR" (failure). The Model.loaded
  // event from /events will also reach setRowState below, so the pill
  // stabilizes even if /model/warm's response races.
  document.querySelectorAll('.model-row [data-act="warm"]').forEach(b => {
    b.addEventListener('click', async () => {
      const row = b.closest('.model-row');
      const role = row.dataset.role || '';
      const model = row.dataset.model || row.querySelector('.name')?.firstChild?.textContent?.trim() || '';
      if (!role) {
        (window.SeekDeepNotify?.toast || ((o) => alert(o.body ? o.title + ': ' + o.body : o.title)))({ tone: 'warn', title: 'No role assigned', body: `${model} has no role; /model/warm needs one.` });
        return;
      }
      const stateEl = row.querySelector('[data-role-state]');
      const setPill = (cls, text) => {
        if (!stateEl) return;
        stateEl.innerHTML = `<span class="pill ${cls}" style="padding: 2px 6px;"><span class="dot"></span>${text}</span>`;
      };
      setPill('warn', 'WARMING…');
      try {
        const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
        const r = await fetch(base + '/model/warm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
          signal: AbortSignal.timeout(180_000),  // up to 3 min for cold load
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok !== false) {
          setPill('on', 'RESIDENT');
          const sdn = window.SeekDeepNotify;
          if (sdn?.toast) sdn.toast({ tone: 'good', title: 'Model warm', body: `${role} loaded`, ttl: 4000 });
        } else {
          setPill('bad', 'ERROR');
          alert(`✕ warm failed · ${data.error || r.statusText || 'HTTP ' + r.status}`);
        }
      } catch (e) {
        setPill('bad', 'ERROR');
        alert(`✕ couldn't reach /model/warm · ${e.message || e}`);
      }
    });
  });
  // Wire the per-row Inspect (⌕) buttons. Pops a small modal with the
  // model id, role, backend, current state, and a copyable JSON dump
  // of whatever /health.models / /models/installed knows about it.
  document.querySelectorAll('.model-row [data-act="inspect"]').forEach(b => {
    b.addEventListener('click', async () => {
      const row = b.closest('.model-row');
      const model = row.dataset.model || '';
      const role = row.dataset.role || '(unassigned)';
      const backend = row.dataset.backend || 'hf';
      const sizeEl = row.querySelector('.actions')?.previousElementSibling;
      const size = sizeEl ? sizeEl.previousElementSibling?.textContent : '';
      let installedInfo = null;
      try {
        const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : 'http://127.0.0.1:7865';
        const r = await fetch(base + '/models/installed', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const all = await r.json();
          const list = Array.isArray(all?.models) ? all.models : (Array.isArray(all) ? all : []);
          installedInfo = list.find(m => (m.id || m.model_id || m) === model) || null;
        }
      } catch {}
      const cell = (k, v) => { const e = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); return `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid var(--stroke);"><div style="color:var(--hull-3);font-family:var(--font-mono);font-size:11px;">${e(k)}</div><div style="font-family:var(--font-mono);font-size:12px;color:var(--hull-1);">${e(v)}</div></div>`; };
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:grid;place-items:center;';
      modal.innerHTML = `
        <div style="background:var(--substrate-2);border:1px solid var(--stroke);border-radius:var(--r-md);padding:24px;max-width:560px;min-width:480px;color:var(--hull-2);font-family:var(--font-grotesk);">
          <h3 style="margin:0 0 16px 0;color:var(--cyan-1);font-family:var(--font-mono);letter-spacing:0.1em;">⌕ INSPECT MODEL</h3>
          ${cell('Model ID', model)}
          ${cell('Role', role)}
          ${cell('Backend', backend.toUpperCase())}
          ${cell('Size', size || '—')}
          ${cell('Installed?', installedInfo ? 'YES' : 'unknown (try /models/installed)')}
          ${installedInfo ? cell('Cached bytes', installedInfo.size_bytes ? (installedInfo.size_bytes/1024/1024/1024).toFixed(2) + ' GB' : '—') : ''}
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
            <button id="inspCopyBtn" style="background:var(--cyan-2);color:#000;border:0;padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Copy ID</button>
            <button id="inspCloseBtn" style="background:transparent;color:var(--hull-2);border:1px solid var(--stroke);padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Close</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('#inspCopyBtn').onclick = async () => { try { await navigator.clipboard.writeText(model); } catch {} };
      modal.querySelector('#inspCloseBtn').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    });
  });
})();
