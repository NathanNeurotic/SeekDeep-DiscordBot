/* ============================================================
   add-model.html — wizard logic
   ============================================================
   Drives the multi-step form, talks to:
     - POST /model/install   (install + optional role assignment)
     - POST /config          (only used as a fallback if /model/install
                              doesn't write the LOCAL_CHAT_<ROLE>_* keys
                              itself — most builds do)

   Query-param prefill (from model-install.js's quick-picks):
     ?prefill=<modelId>&backend=<hf|ollama|…>&autostart=1
       → jumps the user past the steps it can answer for them.
   ============================================================ */
(function () {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // Tauri 2 on Windows serves bundled pages from http://tauri.localhost.
  // Force 127.0.0.1:7865 in Tauri context; otherwise same-origin/fallback.
  const BASE = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function')
    ? window.SeekDeepResolveBase()
    : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')
        ? 'http://127.0.0.1:7865'
        : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));

  const state = {
    step: 1,
    backend: null,
    model_id: '',
    api_url: '',
    api_key: '',
    api_version: '2023-06-01',
    role: '',
  };

  // ============================================================
  // Step rendering
  // ============================================================
  function isRemote(b) { return b && b !== 'hf' && b !== 'ollama'; }
  function isInstallStep() { return state.step === 5; }

  function setStep(n) {
    state.step = n;
    $$('.step').forEach(s => s.classList.toggle('active', +s.dataset.step === n));
    const crumbSteps = [1, 2, 3, 4];
    $$('#crumbs .crumb').forEach(c => {
      const cn = +c.dataset.step;
      c.classList.remove('active', 'done', 'skipped');
      if (cn === n) c.classList.add('active');
      else if (cn < n) c.classList.add('done');
      // Mark step 3 skipped when backend is local
      if (cn === 3 && !isRemote(state.backend)) {
        c.classList.add('skipped');
        if (cn < n) { c.classList.remove('done'); c.classList.add('skipped'); }
      }
    });

    const back = $('#btnBack');
    const next = $('#btnNext');
    back.style.visibility = (n === 1 || n === 5) ? 'hidden' : 'visible';
    next.style.display = (n === 5) ? 'none' : '';
    next.textContent = n === 4 ? '▸ Install' : 'Next ›';
    refreshCtx();
    refreshNextEnabled();
  }
  // CodeQL js/xss: state.model_id can arrive from the ?prefill= query param or from
  // untrusted Ollama-registry tag metadata, and several wizard steps interpolate it
  // into innerHTML. Escape it at every such sink.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }
  function refreshCtx() {
    const c = $('#ctx');
    if (state.step === 1) c.innerHTML = 'Pick a backend to begin · <em>5 backends · 5 chat roles</em>';
    else if (state.step === 2) c.innerHTML = `Backend · <em>${labelFor(state.backend)}</em>`;
    else if (state.step === 3) c.innerHTML = `Backend · <em>${labelFor(state.backend)}</em> · model · <em>${esc(state.model_id)}</em>`;
    else if (state.step === 4) c.innerHTML = `Ready to install · <em>${labelFor(state.backend)}</em> · <em>${esc(state.model_id)}</em>`;
    else c.innerHTML = '';
  }
  function refreshNextEnabled() {
    const n = $('#btnNext');
    let ok = false;
    if (state.step === 1) ok = !!state.backend;
    else if (state.step === 2) ok = !!$('#modelId').value.trim();
    else if (state.step === 3) ok = !!$('#apiUrl').value.trim() && !!$('#apiKey').value;
    else if (state.step === 4) ok = !!state.backend && !!state.model_id;
    n.disabled = !ok;
  }

  function labelFor(b) {
    return ({
      'hf': 'HuggingFace · local',
      'ollama': 'Ollama · local daemon',
      'openai-compat': 'OpenAI-compat · remote',
      'anthropic': 'Anthropic · remote',
      'gemini': 'Gemini · remote',
    })[b] || '—';
  }

  // ============================================================
  // Step 1 · backend picker
  // ============================================================
  $$('.backend-card').forEach(card => {
    const pick = () => pickBackend(card.dataset.backend);
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
  function pickBackend(b) {
    state.backend = b;
    $$('.backend-card').forEach(c => c.classList.toggle('sel', c.dataset.backend === b));
    refreshCtx();
    refreshNextEnabled();
  }

  // ============================================================
  // Step 2 · model id + suggestions
  // ============================================================
  const SUGGESTIONS = {
    'hf': {
      src: 'huggingface.co — popular chat picks',
      items: [
        'meta-llama/Llama-3.1-8B-Instruct',
        'Qwen/Qwen2.5-7B-Instruct',
        'microsoft/phi-4',
        'mistralai/Mistral-Nemo-Instruct-2407',
        'google/gemma-3n-E4B-it',
      ],
    },
    'ollama': {
      src: '/health.ollama.tags',
      items: null,   // populated dynamically from /health
      placeholder: '(no tags installed yet — type a tag and SeekDeep will pull it)',
    },
    'openai-compat': {
      src: 'provider-specific',
      items: ['deepseek-chat', 'gpt-4o-mini', 'grok-4', 'moonshotai/kimi-k2', 'openrouter/auto'],
    },
    'anthropic': {
      src: 'Anthropic — current Claude line',
      items: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
    'gemini': {
      src: 'Google — current Gemini line',
      items: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    },
  };

  function paintStep2() {
    const b = state.backend;
    const titles = {
      'hf': 'Which Hugging Face model?',
      'ollama': 'Which Ollama tag?',
      'openai-compat': 'Which OpenAI-compat model?',
      'anthropic': 'Which Claude model?',
      'gemini': 'Which Gemini model?',
    };
    const subs = {
      'hf': 'A repo ID like <span class="mono">meta-llama/Llama-3.1-8B-Instruct</span>. Anything on <a href="https://huggingface.co/models" target="_blank">huggingface.co</a> works.',
      'ollama': 'Either pick from the chips below or type a new tag. Anything not installed yet gets pulled automatically (e.g. <span class="mono">llama3.1:8b-instruct-q4_K_M</span>).',
      'openai-compat': 'Provider-specific model name. e.g. <span class="mono">deepseek-chat</span>, <span class="mono">gpt-4o-mini</span>, <span class="mono">grok-4</span>.',
      'anthropic': 'Pick a Claude model. Any current <span class="mono">claude-*</span> ID works.',
      'gemini': 'Pick a Gemini model. Any current <span class="mono">gemini-*</span> ID works.',
    };
    const placeholders = {
      'hf': 'org/repo-name',
      'ollama': 'name:tag',
      'openai-compat': 'model-name',
      'anthropic': 'claude-sonnet-4-6',
      'gemini': 'gemini-2.5-flash',
    };
    $('#step2Title').textContent = titles[b] || titles.hf;
    $('#step2Sub').innerHTML = subs[b] || '';
    $('#modelHint').innerHTML = '';
    $('#modelId').placeholder = placeholders[b] || '';
    if (state.model_id) $('#modelId').value = state.model_id;

    const conf = SUGGESTIONS[b];
    const list = $('#suggestList');
    const block = $('#suggestBlock');
    if (!conf) { block.style.display = 'none'; return; }
    block.style.display = '';
    $('#suggestSrc').textContent = '· ' + conf.src;
    list.innerHTML = '';

    let items = conf.items;
    if (b === 'ollama') {
      // Try /health for installed tags; otherwise show placeholder hint.
      fetch(BASE + '/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
        .then(r => r.ok ? r.json() : null)
        .then(h => {
          const tags = h?.ollama?.tags || h?.ollama_tags || [];
          if (tags.length) renderChips(list, tags);
          else renderChips(list, [], conf.placeholder);
        })
        .catch(() => renderChips(list, [], conf.placeholder));
      return;
    }
    renderChips(list, items);
  }
  function renderChips(list, items, placeholderText) {
    list.innerHTML = '';
    if (!items.length) {
      const c = document.createElement('span');
      c.className = 'chip placeholder';
      c.textContent = placeholderText || '(no suggestions)';
      list.appendChild(c);
      return;
    }
    items.forEach(it => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = it;
      c.addEventListener('click', () => {
        $('#modelId').value = it;
        state.model_id = it;
        refreshNextEnabled();
      });
      list.appendChild(c);
    });
  }
  $('#modelId').addEventListener('input', (e) => {
    state.model_id = e.target.value.trim();
    refreshNextEnabled();
  });

  // ============================================================
  // Step 3 · credentials
  // ============================================================
  function paintStep3() {
    const b = state.backend;
    const urlDefaults = {
      'openai-compat': 'https://api.openai.com/v1',
      'anthropic':     'https://api.anthropic.com/v1/messages',
      'gemini':        'https://generativelanguage.googleapis.com/v1beta',
    };
    if (!$('#apiUrl').value) $('#apiUrl').value = urlDefaults[b] || '';
    $('#anthropicVerWrap').style.display = b === 'anthropic' ? 'block' : 'none';
  }
  // Anthropic-specific: apiVersion has its own input but used to lack
  // a listener, so typing a fresh version after jumping back from
  // Step 4 Review (via the Edit link) sent the stale state value to
  // /model/install. Including it in the same input gate fixes that.
  ['#apiUrl', '#apiKey', '#apiVersion'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('input', refreshNextEnabled);
  });
  // Mirror live edits into state so a user typing a new version then
  // clicking Install directly (skipping the Next button) sends the
  // freshly-typed value, not the previous Step-3-advance snapshot.
  $('#apiUrl')?.addEventListener('input', (e) => { state.api_url = e.target.value.trim(); });
  $('#apiKey')?.addEventListener('input', (e) => { state.api_key = e.target.value.trim(); });
  $('#apiVersion')?.addEventListener('input', (e) => { state.api_version = e.target.value.trim(); });

  // ============================================================
  // Step 4 · review
  // ============================================================
  function paintStep4() {
    $('#sumBackend').textContent = labelFor(state.backend);
    $('#sumModel').textContent   = state.model_id || '—';
    const remote = isRemote(state.backend);
    $('#sumApiRow').style.display = remote ? 'grid' : 'none';
    $('#sumKeyRow').style.display = remote ? 'grid' : 'none';
    $('#sumUrl').textContent = state.api_url || '—';
    $('#sumKey').textContent = state.api_key ? (state.api_key.slice(0, 4) + '••••••' + state.api_key.slice(-3)) : '—';
    const r = $('#sumRole');
    if (state.role) { r.textContent = state.role; r.classList.remove('empty'); }
    else            { r.textContent = '(unassigned)'; r.classList.add('empty'); }
  }
  $('#role').addEventListener('change', (e) => { state.role = e.target.value; paintStep4(); });

  $$('.review-row .edit').forEach(btn => {
    btn.addEventListener('click', () => setStep(+btn.dataset.jump));
  });

  // ============================================================
  // Step 5 · install
  // ============================================================
  function appendLog(line, cls) {
    const pre = $('#installLog');
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = line + '\n';
    pre.appendChild(span);
    pre.scrollTop = pre.scrollHeight;
  }
  async function runInstall() {
    setStep(5);
    const pane = $('#installPane');
    pane.classList.remove('done', 'error');
    $('#installTitle').textContent = 'Installing…';
    $('#installSummary').innerHTML = `<code>${labelFor(state.backend)}</code> · <code>${esc(state.model_id)}</code>`;
    $('#installSub').innerHTML = 'Talking to <code>POST /model/install</code> · downloading, probing, and writing config keys. This window stays put — don\'t close.';
    $('#installLog').innerHTML = '';
    appendLog(`▸ POST ${BASE}/model/install`);
    appendLog(`  backend=${state.backend} model_id=${state.model_id}` + (state.role ? ` role=${state.role}` : ''));

    const body = { backend: state.backend, model_id: state.model_id };
    if (state.role) body.role = state.role;
    if (state.backend === 'ollama') body.auto_pull = true;
    if (isRemote(state.backend)) {
      body.api_url = state.api_url;
      body.api_key = state.api_key;
      if (state.backend === 'anthropic') body.api_version = state.api_version;
    }

    try {
      const res = await fetch(BASE + '/model/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        if (data.files_downloaded) appendLog(`  · ${data.files_downloaded} files downloaded`, 'line-ok');
        if (data.local_dir)        appendLog(`  · cached to ${data.local_dir}`);
        if (data.note)             appendLog(`  · note: ${data.note}`, 'line-warn');
        if (data.external)         appendLog('  ⚠ external · prompts leave the local machine', 'line-warn');
        appendLog('✓ install complete', 'line-ok');
        pane.classList.add('done');
        $('#installTitle').textContent = 'Model installed';
        $('#installSub').innerHTML = state.role
          ? `Assigned to <code>${state.role}</code>. You can route to it from the playground now.`
          : `Stored as a standalone. Assign it to a role from the <a href="app.html#sec-models" style="color:var(--cyan-1);">Models pane</a> when you\'re ready.`;
        // Replace footer with "Done · open chat" + "Install another"
        renderInstallDoneFooter();
        if (window.SeekDeepNotify) {
          window.SeekDeepNotify.toast({ tone: 'good', title: 'Model ready', body: `${state.model_id} installed`, ttl: 4000 });
        }
      } else {
        const msg = data.error || data.detail || res.statusText || ('http ' + res.status);
        appendLog(`✕ ${res.status} · ${msg}`, 'line-bad');
        markError(msg);
      }
    } catch (e) {
      appendLog(`✕ couldn't reach /model/install · ${e.message || e}`, 'line-bad');
      markError(e.message || String(e));
    }
  }
  function markError(msg) {
    const pane = $('#installPane');
    pane.classList.add('error');
    $('#installTitle').textContent = 'Install failed';
    $('#installSub').textContent = msg;
    renderInstallErrorFooter();
    if (window.SeekDeepNotify) {
      window.SeekDeepNotify.toast({ tone: 'bad', title: 'Install failed', body: msg, ttl: 6000 });
    }
  }
  function renderInstallDoneFooter() {
    const foot = $('.wiz-foot');
    foot.innerHTML = `
      <div class="ctx">Install complete · <em>${esc(state.model_id)}</em></div>
      <button type="button" class="btn btn-ghost" id="installAgain">Install another</button>
      <a href="chat.html" class="btn btn-primary">▸ Open chat</a>
    `;
    $('#installAgain').addEventListener('click', () => { resetWizard(); });
  }
  function renderInstallErrorFooter() {
    const foot = $('.wiz-foot');
    foot.innerHTML = `
      <div class="ctx">Install failed — review the log above</div>
      <button type="button" class="btn btn-ghost" id="installBack">‹ Back to review</button>
      <button type="button" class="btn btn-primary" id="installRetry">▸ Retry</button>
    `;
    $('#installBack').addEventListener('click', () => { renderDefaultFooter(); setStep(4); });
    $('#installRetry').addEventListener('click', () => { renderDefaultFooter(); runInstall(); });
  }
  function renderDefaultFooter() {
    const foot = $('.wiz-foot');
    foot.innerHTML = `
      <div class="ctx" id="ctx"></div>
      <button type="button" class="btn btn-ghost" id="btnBack">‹ Back</button>
      <button type="button" class="btn btn-primary" id="btnNext">Next ›</button>
    `;
    $('#btnBack').addEventListener('click', advance.regress);
    $('#btnNext').addEventListener('click', advance.next);
  }
  function resetWizard() {
    Object.assign(state, { step: 1, backend: null, model_id: '', api_url: '', api_key: '', api_version: '2023-06-01', role: '' });
    $('#modelId').value = '';
    $('#apiUrl').value = '';
    $('#apiKey').value = '';
    $('#role').value = '';
    $$('.backend-card').forEach(c => c.classList.remove('sel'));
    renderDefaultFooter();
    setStep(1);
  }

  // ============================================================
  // Footer navigation
  // ============================================================
  const advance = {
    next() {
      if (state.step === 1) {
        if (!state.backend) return;
        paintStep2();
        return setStep(2);
      }
      if (state.step === 2) {
        state.model_id = $('#modelId').value.trim();
        if (!state.model_id) return;
        if (isRemote(state.backend)) {
          paintStep3();
          return setStep(3);
        }
        paintStep4();
        return setStep(4);
      }
      if (state.step === 3) {
        state.api_url = $('#apiUrl').value.trim();
        state.api_key = $('#apiKey').value;
        state.api_version = $('#apiVersion')?.value?.trim() || '2023-06-01';
        if (!state.api_url || !state.api_key) return;
        paintStep4();
        return setStep(4);
      }
      if (state.step === 4) {
        return runInstall();
      }
    },
    regress() {
      if (state.step === 4) {
        return setStep(isRemote(state.backend) ? 3 : 2);
      }
      if (state.step > 1) setStep(state.step - 1);
    },
  };
  $('#btnNext').addEventListener('click', advance.next);
  $('#btnBack').addEventListener('click', advance.regress);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        advance.next();
      }
      return;
    }
    if (e.key === 'Enter' && !isInstallStep()) advance.next();
    if (e.key === 'Escape' && state.step > 1 && !isInstallStep()) advance.regress();
  });

  // ============================================================
  // Prefill from ?prefill=<id>&backend=<…>&autostart=1
  // (used by model-install.js quick-picks)
  // ============================================================
  const params = new URLSearchParams(location.search);
  const prefill = params.get('prefill');
  const backendParam = params.get('backend');
  const autostart = params.get('autostart') === '1';

  if (backendParam) {
    pickBackend(backendParam);
    paintStep2();
    if (prefill) {
      state.model_id = prefill;
      $('#modelId').value = prefill;
    }
    if (isRemote(state.backend)) {
      // Remote backends always need credentials — jump to step 3 so the user
      // sees what's missing before install can start.
      setStep(3);
      paintStep3();
    } else if (prefill && autostart) {
      paintStep4();
      setStep(4);
      // Give the user a beat to bail AND wait for the events bus to
      // come up before kicking install. On a cold Tauri boot, 600ms
      // is too tight — the sidecar is still binding the port and
      // setting up CORS, so the POST /model/install would fail with
      // "couldn't reach" on a perfectly healthy system. Wait for
      // SeekDeepEvents.connected with a 12s ceiling.
      (async () => {
        const t0 = performance.now();
        while (performance.now() - t0 < 12_000) {
          if (state.step !== 4) return;  // user navigated away
          if (window.SeekDeepEvents && window.SeekDeepEvents.connected) break;
          await new Promise(r => setTimeout(r, 200));
        }
        // Final guard: even if events bus never connected (no auth
        // token, server actually down), still try the install — the
        // user explicitly autostart-requested it, so giving up
        // silently is worse than a clear HTTP error.
        if (state.step === 4) runInstall();
      })();
    } else if (prefill) {
      paintStep4();
      setStep(4);
    } else {
      setStep(2);
    }
  } else {
    setStep(1);
  }

  refreshNextEnabled();
})();
