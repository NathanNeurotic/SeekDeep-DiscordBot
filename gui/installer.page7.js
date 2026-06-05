  // Step config
  // Smart BASE — when served from local_ai_server.py via /gui mount, use same origin.
// When opened directly (file://) or from another origin, fall back to :7865.
// Tauri 2 on Windows serves bundled pages from http://tauri.localhost, so we
// must NOT use location.origin in that case (would point at the WebView itself).
const SEEKDEEP_BASE = (function() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:7865';
  if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
  if (window.__TAURI__ || (window.location.hostname || '') === 'tauri.localhost') {
    return 'http://127.0.0.1:7865';
  }
  const sameOrigin = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  if (sameOrigin && window.location.host) {
    // Drop the /gui prefix if present
    return window.location.origin;
  }
  return 'http://127.0.0.1:7865';
})();


  const STEPS = [
    { id: 'welcome',   name: 'Welcome',        meta: 'INTRO' },
    { id: 'syscheck',  name: 'System check',   meta: 'PROBES' },
    { id: 'bootstrap', name: 'Bootstrap',      meta: 'CLONE + DEPS' },
    { id: 'token',     name: 'Discord token',  meta: 'CONFIG' },
    { id: 'models',    name: 'Models',         meta: 'PICK ROLES' },
    { id: 'searxng',   name: 'SearXNG',        meta: 'WEB SEARCH' },
    { id: 'warmup',    name: 'Warmup',         meta: 'PULL WEIGHTS' },
    { id: 'launch',    name: 'Launch + smoke', meta: 'GO LIVE' },
    { id: 'done',      name: 'Done',           meta: 'SURFACE' }
  ];

  // State (localStorage-persisted)
  const STORE_KEY = 'seekdeep-installer-v1';
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
  }
  function saveState() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }
  const state = Object.assign({
    currentStep: 0,
    stepsDone: {},
    flags: {},
    selections: { chat: 'meta-llama/Llama-3.1-8B-Instruct', vision: 'Qwen/Qwen2.5-VL-3B-Instruct', image: 'Lykon/dreamshaper-xl-1-0' },
    sizes:      { chat: 5.1, vision: 3.4, image: 6.8 },
    token: '', clientId: '', admin: '', hf: ''
  }, loadState());

  // Build the step rail
  const rail = document.getElementById('stepsRail');
  STEPS.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'step-item';
    el.dataset.idx = i;
    el.innerHTML = `
      <div class="step-num">${String(i+1).padStart(2,'0')}</div>
      <div><div class="step-name">${s.name}</div></div>
      <div class="step-meta">${s.meta}</div>
    `;
    el.addEventListener('click', () => goTo(i));
    rail.insertBefore(el, rail.querySelector('.rail-progress'));
  });

  function goTo(idx) {
    state.currentStep = Math.max(0, Math.min(STEPS.length-1, idx));
    saveState();
    render();
  }

  function render() {
    const i = state.currentStep;
    document.querySelectorAll('.step-item').forEach((el, j) => {
      el.classList.toggle('active', j === i);
      el.classList.toggle('done', !!state.stepsDone[STEPS[j].id] || j < i);
    });
    document.querySelectorAll('.step-pane').forEach(p => {
      p.classList.toggle('active', p.dataset.step === STEPS[i].id);
    });
    document.getElementById('mainTitle').textContent = STEPS[i].name;
    document.getElementById('mainSub').textContent = '▸ ' + (STEPS[i].meta || '').toLowerCase().replace(/_/g, ' ');
    document.getElementById('stepOfNum').textContent = String(i+1).padStart(2,'0');
    document.getElementById('stepCount').textContent = i + 1;

    const pct = Math.round((i / (STEPS.length-1)) * 100);
    document.getElementById('meterBar').style.width = pct + '%';
    document.getElementById('pctLabel').textContent = pct + '%';

    document.getElementById('backBtn').style.visibility = i === 0 ? 'hidden' : 'visible';
    const nextBtn = document.getElementById('nextBtn');
    const onLastStep = i === STEPS.length - 1;
    nextBtn.textContent = onLastStep ? '✓ Finished — Open Control Center →' : 'Next →';
    // Don't disable on the last step — Finished should DO something:
    // navigate to the Control Center so the user lands somewhere useful.
    // Previously this was disabled (dead click), which is exactly the
    // 'nothing feels shipment ready' complaint.
    nextBtn.disabled = false;
    document.getElementById('skipBtn').style.display = onLastStep ? 'none' : 'inline-flex';
  }

  document.getElementById('nextBtn').addEventListener('click', () => {
    state.stepsDone[STEPS[state.currentStep].id] = true;
    saveState();
    if (state.currentStep === STEPS.length - 1) {
      // On the last step: Finished navigates to the Control Center. If
      // the user hasn't applied .env yet, that's fine — they can still
      // come back here. The wizard is fundamentally optional past this
      // point.
      window.location.href = 'app.html';
      return;
    }
    goTo(state.currentStep + 1);
  });
  document.getElementById('backBtn').addEventListener('click', () => goTo(state.currentStep - 1));
  document.getElementById('skipBtn').addEventListener('click', () => goTo(state.currentStep + 1));

  // Toggles. Two kinds, distinguished by data-readonly:
  //   * Settings toggles (default): clickable, persisted to localStorage,
  //     reflected in .env preview. e.g. quant_4bit, web_auto.
  //   * Read-only status indicators (data-readonly="true"): NOT clickable,
  //     NOT persisted, state comes from runtime probes. e.g. warmup_done,
  //     which must reflect actual disk cache state — not a flag the user
  //     accidentally clicked once and locked ON in localStorage.
  document.querySelectorAll('.toggle').forEach(t => {
    const flag = t.dataset.flag;
    const readonly = t.dataset.readonly === 'true';
    if (readonly) {
      t.style.cursor = 'default';
      t.style.pointerEvents = 'none';
      t.style.opacity = '0.85';
      return;
    }
    if (state.flags[flag] !== undefined) {
      t.classList.toggle('on', !!state.flags[flag]);
    } else {
      state.flags[flag] = t.classList.contains('on');
    }
    t.addEventListener('click', () => {
      t.classList.toggle('on');
      state.flags[flag] = t.classList.contains('on');
      saveState();
      updateEnvPreview();
    });
  });
  // Wipe any historic localStorage state for the read-only indicators —
  // earlier versions wired them as clickable, so users may have flipped
  // them ON and that wrong state persisted across reloads.
  ['warmup_done'].forEach(k => { if (state.flags && k in state.flags) delete state.flags[k]; });
  saveState();

  // Copy buttons
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn[data-copy]');
    if (!btn) return;
    const targetId = btn.dataset.copy;
    const el = document.getElementById(targetId);
    if (!el) return;
    const txt = el.innerText.replace(/^PS>\s/gm, '').replace(/^#.*$/gm, '').trim();
    navigator.clipboard.writeText(txt).then(() => {
      const orig = btn.textContent;
      btn.textContent = '✓ COPIED';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
    });
  });

  // ============ SYSTEM CHECK ============
  function setCheckState(name, status, read, action) {
    const row = document.querySelector(`[data-check="${name}"]`);
    if (!row) return;
    // 'warn' is amber (Docker-up-but-container-not-running, etc.) — the
    // setup isn't broken, a feature is just disabled until you fix it.
    row.classList.remove('checking', 'ok', 'bad', 'warn');
    if (status) row.classList.add(status);
    const readCell = row.querySelector('[data-read]');
    if (read != null) readCell.textContent = read;
    // Optional inline action button. Used by the GPU row's "wrong wheel"
    // state so the user can one-click reinstall torch with the right
    // CUDA variant instead of just reading a paragraph telling them to
    // visit pytorch.org. action = { label, title, onClick }.
    // Previous fix call's button is torn down on every setCheckState
    // so stale Fix buttons don't accumulate as the probe re-runs.
    const oldBtn = row.querySelector('.row-fix-btn');
    if (oldBtn) oldBtn.remove();
    if (action && action.onClick) {
      const btn = document.createElement('button');
      btn.className = 'row-fix-btn';
      btn.textContent = action.label || 'FIX';
      btn.title = action.title || '';
      btn.style.cssText = 'margin-left:10px;padding:4px 10px;background:var(--cyan-2,#2dd4ff);color:#000;border:0;border-radius:4px;cursor:pointer;font-family:var(--font-mono);font-size:11px;letter-spacing:0.1em;font-weight:600;';
      btn.addEventListener('click', (e) => { e.preventDefault(); action.onClick(); });
      readCell.appendChild(btn);
    }
  }

  // ===== Installer GPU row: one-click torch reinstall (Tauri path) ============
  // Mirrors the chat.html cell click handler. In Tauri context we invoke
  // install_torch_variant which kills the sidecar, runs pip with the
  // variant-specific index URL, and respawns. In a browser opened against
  // the .bat-launched server we can't bounce the .venv shell from JS, so
  // we fall back to a copy-paste modal with the exact pip command.
  async function runInstallerTorchReinstall(gpuName, variant) {
    const inTauri = !!(window.__TAURI__ && window.__TAURI__.core);
    if (inTauri) {
      const ok = await (window.SeekDeepConfirm || window.confirm)(
        `Reinstall torch with ${variant} for ${gpuName}?\n\n`
        + `This will:\n`
        + `  • Stop the AI server\n`
        + `  • pip uninstall torch torchvision torchaudio\n`
        + `  • pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/${variant}\n`
        + `  • Restart the AI server\n\n`
        + `~2 GB download. Takes 1-5 minutes on a decent connection.\n`
        + `Chat / image / vision will be unavailable during the reinstall.`
      );
      if (!ok) return;
      // Mark the row as in-progress so the user has feedback before pip
      // even starts streaming output. The probe loop will overwrite this
      // when the sidecar comes back and /gpu starts answering again.
      setCheckState('gpu', 'checking', `Reinstalling torch with ${variant} for ${gpuName} — this can take 1-5 minutes…`);
      try {
        const out = await window.__TAURI__.core.invoke('install_torch_variant', { variant });
        console.log('[SeekDeep installer torch reinstall] pip output:\n' + (out || ''));
        // Don't immediately re-probe — boot_sequence is racing with us.
        // Give the sidecar ~6s to come back up before the next /gpu poll.
        setTimeout(() => {
          if (typeof runAllChecks === 'function') runAllChecks();
        }, 6000);
      } catch (err) {
        setCheckState('gpu', 'bad', `Torch reinstall failed: ${String(err).slice(0, 220)}`);
      }
      return;
    }
    // Non-Tauri fallback: command + copy modal.
    const cmd = `pip uninstall -y torch torchvision torchaudio\npip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/${variant}`;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:grid;place-items:center;';
    modal.innerHTML = `
      <div style="background:var(--substrate-2);border:1px solid var(--stroke);border-radius:var(--r-md);padding:24px;max-width:680px;color:var(--hull-2);font-family:var(--font-mono);">
        <h3 style="margin:0 0 8px 0;color:var(--cyan-1);">Torch reinstall · ${gpuName}</h3>
        <p style="color:var(--hull-3);font-size:13px;margin-bottom:12px;line-height:1.5;">
          Browser mode can't bounce the .bat-launched AI server. Stop the server
          (Ctrl+C in its PowerShell window), run these in the activated .venv,
          then restart with <code>seekdeep_launcher.bat</code> option 4.
        </p>
        <pre style="background:#000;border:1px solid var(--stroke);border-radius:var(--r-sm);padding:12px;color:var(--cyan-1);font-size:12px;overflow:auto;user-select:all;">${cmd}</pre>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button id="instCopyBtn" style="background:var(--cyan-2);color:#000;border:0;padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Copy</button>
          <button id="instCloseBtn" style="background:transparent;color:var(--hull-2);border:1px solid var(--stroke);padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Close</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#instCopyBtn').onclick = async () => {
      try { await navigator.clipboard.writeText(cmd); } catch {}
    };
    modal.querySelector('#instCloseBtn').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  }

  async function probeAiHealth(timeoutMs = 6000) {
    // 6s default — /health calls ollama_available() (up to 2s) + iterates
    // every chat role to resolve backends. The previous 1.2s was way too
    // tight; healthy installs were showing "timeout" because the server
    // was just slow-but-fine. Same root cause as the chat.html cLIVE fix.
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(SEEKDEEP_BASE + '/health', { signal: ctl.signal });
      clearTimeout(tm);
      if (!r.ok) return { up: false, reason: 'http ' + r.status };
      const data = await r.json().catch(() => ({}));
      return { up: true, data };
    } catch (e) {
      return { up: false, reason: (e && e.name === 'AbortError') ? 'timeout' : 'unreachable' };
    }
  }
  async function probeAiGpu() {
    try {
      // 4s — /gpu can stall briefly on torch.cuda.mem_get_info() when VRAM
      // is fragmented or torch isn't installed. 1.2s was too tight.
      const r = await fetch(SEEKDEEP_BASE + '/gpu', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  async function probeSearxng() {
    try {
      const r = await fetch('http://127.0.0.1:8080/healthz', { mode: 'no-cors', signal: AbortSignal.timeout(1200) });
      // no-cors makes status opaque — any response means it's there
      return true;
    } catch { return false; }
  }
  async function probeDocker() {
    // /system/docker spawns `docker info` server-side, distinguishing
    // running / installed-but-stopped / not-installed. Replaces the old
    // "infer from SearXNG" path which lied because SearXNG being down
    // doesn't say anything about Docker (could be a stopped container).
    // 14s client timeout: server probe is capped at 12s, plus 2s slack
    // for the round-trip. Was 5s — false-positived "unresponsive" on
    // normal WSL2 Docker Desktop warm-up which takes 10-15s.
    try {
      const r = await fetch(SEEKDEEP_BASE + '/system/docker', { signal: AbortSignal.timeout(14000) });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  async function probeRuntime() {
    // /system/runtime spawns node --version + git --version + reads
    // sys.version + shutil.disk_usage so we can give real per-row answers
    // for Node / Python / Git / Disk instead of the previous "server up
    // implies node ok" placeholder text.
    try {
      const r = await fetch(SEEKDEEP_BASE + '/system/runtime', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function runAllChecks() {
    const all = ['node','python','git','docker','gpu','disk','aiserver','searxng'];
    all.forEach(c => setCheckState(c, 'checking', 'probing…'));

    // Live probes
    const [ai, sx] = await Promise.all([probeAiHealth(), probeSearxng()]);

    if (ai.up) {
      setCheckState('aiserver', 'ok', 'live on :7865');
      const [gpu, docker, runtime] = await Promise.all([probeAiGpu(), probeDocker(), probeRuntime()]);

      // ---- GPU row ----------------------------------------------------
      // /gpu now returns { available, total_mb, used_mb, ..., nvidia_smi:
      //   { detected, name, total_mb, driver } }.
      // We distinguish four states:
      //   1. torch + CUDA running   → green "X GB · Y% used"
      //   2. nvidia-smi sees GPU, torch missing → yellow "GPU detected,
      //      install ML deps to enable local chat/image/vision"
      //   3. nvidia-smi sees GPU, torch present but no CUDA → yellow
      //      "GPU + driver OK, but PyTorch CUDA build missing"
      //   4. nvidia-smi finds nothing → yellow "no GPU · CPU mode"
      // Was: always (2)/(3)/(4) collapsed to "no GPU · CPU mode" — fresh
      // installs with a 4090 saw the same red dot as users without a GPU.
      // Hoist `rt` BEFORE the GPU branches so the cross-reference reads
      // below don't trip ReferenceError ('Cannot access rt before
      // initialization'). The temporal-dead-zone bug surfaced as the
      // entire installer's RUN ALL CHECKS being stuck on "probing…"
      // because the GPU branch threw before any setCheckState fired.
      const rt = (runtime && runtime.runtime) || {};
      if (gpu && gpu.total_mb) {
        const usedPct = Math.round((gpu.used_mb / gpu.total_mb) * 100);
        const name = (gpu.nvidia_smi && gpu.nvidia_smi.name) ? gpu.nvidia_smi.name : (gpu.device_name || 'CUDA device');
        setCheckState('gpu', 'ok', `${name} · ${(gpu.total_mb/1024).toFixed(1)} GB · ${usedPct}% used`);
      } else if (gpu && gpu.nvidia_smi && gpu.nvidia_smi.detected) {
        // GPU is here; PyTorch can't see it. Five possible reasons:
        //   1. Running Python is 3.13+ (no PyTorch wheels exist yet) ← top cause
        //   2. torch not installed at all
        //   3. torch is CPU-only (default pip install on systems without CUDA)
        //   4. Wheel CUDA arch doesn't match GPU (cu121 won't drive Blackwell)
        //   5. Driver too old for the wheel's CUDA build
        // Cross-reference the Python row's torch_supported_by_version so
        // we don't tell a 3.14 user to "reinstall with cu124" — there are
        // NO cu* wheels for 3.14 yet, the real fix is SEEKDEEP_PYTHON.
        const name = gpu.nvidia_smi.name || 'NVIDIA GPU';
        const totalGb = gpu.nvidia_smi.total_mb ? (gpu.nvidia_smi.total_mb / 1024).toFixed(1) : null;
        const totalTag = totalGb ? ` · ${totalGb} GB VRAM` : '';
        const pyTooNewForTorch = rt.python?.torch_supported_by_version === false;
        if (pyTooNewForTorch) {
          // Root cause is the Python row, not the GPU — point there.
          setCheckState('gpu', 'bad', `${name}${totalTag} detected by driver, but the running Python (${rt.python.version}) has no PyTorch wheels yet — see the Python row above. Set SEEKDEEP_PYTHON to a 3.11 or 3.12 interpreter and restart, or install one of those alongside 3.${rt.python?.minor ?? '14'} (the Tauri sidecar auto-prefers the torch-compatible version when both are present).`);
        } else if (gpu.torch_present === false) {
          setCheckState('gpu', 'bad', `${name}${totalTag} detected by driver, but PyTorch isn't installed yet. Click "Install ML libraries" in the Control Center (or run "pip install -r requirements-ml.txt") to unlock local chat/image/vision.`);
        } else {
          // torch loaded but CUDA isn't available. Use the wheel-arch
          // info from /health.gpu (newly added) and /system/runtime
          // .python.torch_cuda_built (existing) to give an honest
          // diagnosis instead of always saying "wrong wheel · cu124".
          //   • CPU-only wheel  -> reinstall helps
          //   • cu121 + Blackwell -> reinstall helps
          //   • cu124+ wheel    -> wheel is fine; driver / mismatch
          const looksBlackwell = /\bRTX\s*5\d{3}\b/i.test(name);
          const wheelBuilt = gpu.torch_cuda_built || rt.python?.torch_cuda_built;
          if (!wheelBuilt) {
            setCheckState('gpu', 'bad',
              `${name}${totalTag} detected by driver, but the loaded torch is a CPU-only wheel (no torch.version.cuda). Click FIX to reinstall with cu124.`,
              { label: '▸ FIX', title: 'Reinstall torch with cu124 (~2 GB; sidecar restarts when done)',
                onClick: () => runInstallerTorchReinstall(name, 'cu124') });
          } else {
            const major = Number(String(wheelBuilt).split('.')[0]);
            const minor = Number(String(wheelBuilt).split('.')[1] || 0);
            const cu = `cu${(major || 12) * 10 + (minor || 0)}`;
            const tooOldForBlackwell = looksBlackwell && cu === 'cu121';
            if (tooOldForBlackwell) {
              setCheckState('gpu', 'bad',
                `${name}${totalTag} detected (Blackwell), but the loaded torch wheel is cu121 — cu121 doesn't support sm_120. Click FIX to reinstall with cu124.`,
                { label: '▸ FIX', title: 'Reinstall torch with cu124 (~2 GB; sidecar restarts when done)',
                  onClick: () => runInstallerTorchReinstall(name, 'cu124') });
            } else {
              // Wheel is already CUDA-capable. Don't offer a reinstall —
              // the user would just be downloading the same arch again.
              // Most likely: driver < CUDA build, or this AI server is
              // running on a different Python than the user's .venv.
              setCheckState('gpu', 'bad',
                `${name}${totalTag} detected by driver, torch wheel is ${cu} (CUDA-capable), but torch.cuda.is_available() is False. Most likely the NVIDIA driver is older than the wheel needs, OR the AI server is running on a different Python than your .venv. Verify with .venv\\Scripts\\python -c "import torch; print(torch.cuda.is_available())".`);
            }
          }
        }
      } else if (gpu && gpu.available === false) {
        // No GPU at all (nvidia-smi didn't find one). Use warn (amber):
        // CPU mode is a valid choice for remote-backend users, not a
        // "your install is broken" failure.
        const err = gpu.nvidia_smi && gpu.nvidia_smi.error;
        setCheckState('gpu', 'warn', 'no GPU · CPU mode' + (err ? ' (' + err + ')' : '') + ' — ok for remote backends; local HF chat/image/vision will be slow or unavailable.');
      } else {
        setCheckState('gpu', 'ok', 'detected (no detail)');
      }

      // node / python / git / disk: real probes via /system/runtime
      // instead of "server up implies node ok" placeholders. `rt` was
      // already declared above (hoisted so the GPU branch could read
      // rt.python.torch_supported_by_version without TDZ-erroring).
      // Node
      if (rt.node?.installed) {
        if (rt.node.meets_min) setCheckState('node', 'ok',  `v${rt.node.version} (≥ ${rt.node.min_required} required)`);
        else                   setCheckState('node', 'bad', `v${rt.node.version} · need ≥ ${rt.node.min_required} · upgrade Node from nodejs.org`);
      } else {
        setCheckState('node', 'bad', 'node not on PATH · install from nodejs.org (LTS 20+)');
      }
      // Python — surface the actual interpreter the AI server is using
      // and warn LOUDLY on 3.13+ where PyTorch wheels don't exist yet.
      // The common failure mode the user kept hitting: Tauri sidecar
      // spawns system Python 3.14 because the .venv lives in the cloned
      // repo dir (not the Tauri runtime dir), torch can't be imported
      // there, GPU check fails — but the user's .bat launcher works
      // fine because IT uses .venv. Surfacing the executable lets the
      // user see which Python they're actually running.
      if (rt.python?.installed) {
        const py = rt.python;
        const venvTag = py.venv_active ? ' · venv' : '';
        const exec    = py.executable ? py.executable.split(/[\\/]/).slice(-3).join('/') : '';
        const baseLine = `${py.version}${venvTag} (${exec})`;
        // Three failure tiers, in priority order:
        //   1. Python too OLD (< 3.11) — meets_min false
        //   2. Python too NEW for torch (>= 3.13) — torch_supported_by_version false
        //   3. Python is fine but torch is missing/broken
        //   4. All good
        if (!py.meets_min) {
          setCheckState('python', 'bad', `${baseLine} — need ≥ ${py.min_required}. The AI server is running on a too-old Python; install 3.11 or 3.12 and point SEEKDEEP_PYTHON at it in .env.`);
        } else if (py.torch_supported_by_version === false) {
          setCheckState('python', 'bad', `${baseLine} — PyTorch has no wheels for Python ${py.version} yet (max supported: ${py.max_torch_supported}). Either install Python 3.11 or 3.12 alongside this version (the Tauri sidecar walks the py launcher's list and auto-prefers a torch-compatible interpreter when one is present), or in .env set SEEKDEEP_PYTHON=C:\\\\path\\\\to\\\\python3.12\\\\python.exe and Reload .env. The .bat launcher already runs through .venv which is on 3.11 — that's why it works for you and the sidecar didn't.`);
        } else if (py.torch_present === false) {
          setCheckState('python', 'bad', `${baseLine} — Python version is fine but torch isn't installed in it. Click "Install ML libraries" in the Control Center, or point SEEKDEEP_PYTHON in .env at a venv that has torch.`);
        } else if (!py.torch_cuda_runtime) {
          const cudaTag = py.torch_cuda_built ? ` (wheel built for ${py.torch_cuda_built})` : '';
          setCheckState('python', 'bad', `${baseLine} — torch ${py.torch_version || ''}${cudaTag} loaded but torch.cuda.is_available()=False. Either the wheel doesn't match your GPU (Blackwell needs cu124+, Ampere/Ada fine on cu121) or the driver is too old.`);
        } else {
          setCheckState('python', 'ok',  `${baseLine} · torch ${py.torch_version || ''} (${py.torch_cuda_built || 'cpu'}) CUDA available`);
        }
      } else {
        setCheckState('python', 'bad', 'FastAPI is alive so Python must be installed; version probe failed');
      }
      // Git
      if (rt.git?.installed) {
        setCheckState('git', 'ok', rt.git.version || 'installed');
      } else {
        setCheckState('git', 'bad', 'git not on PATH · install for clone/pull (npm install also needs it for some deps)');
      }
      // Disk
      if (rt.disk?.free_gb != null) {
        const txt = `${rt.disk.free_gb} GB free of ${rt.disk.total_gb} GB · ${rt.disk.used_pct}% used`;
        if (rt.disk.meets_min) setCheckState('disk', 'ok',  txt);
        else                   setCheckState('disk', 'bad', `${txt} · ${rt.disk.min_recommended_gb} GB recommended for full ML cache`);
      } else {
        setCheckState('disk', 'bad', 'disk probe failed — check repo path permissions');
      }

      // ---- Docker row -------------------------------------------------
      // /system/docker tells us the real state — running / installed_not_
      // running / not_installed. SearXNG state is a separate signal: even
      // when Docker is up, the user might not have launched the SearXNG
      // container. Both surface cleanly in the row.
      if (docker && docker.state === 'running') {
        const ver = docker.server_version ? ` v${docker.server_version}` : '';
        if (sx) {
          setCheckState('docker', 'ok', `Docker daemon up${ver} · searxng container up`);
        } else {
          // Daemon is healthy — this is a soft warning, NOT a failure.
          // Was 'bad' (red): the user's screenshot 2026-05-26 showed
          // "Docker daemon up v29.4.0" with a red dot which is misleading
          // because Docker itself is fine. Using 'warn' (amber) communicates
          // "feature limited, fix when you need web search" instead of
          // "your install is broken".
          setCheckState('docker', 'warn', `Docker daemon up${ver} · searxng container NOT running — web search disabled until you start it. Run "docker compose up -d searxng" from the repo root, or skip if you don't need web-routed chat.`);
        }
      } else if (docker && docker.state === 'installed_not_running') {
        setCheckState('docker', 'bad', `Docker is installed but the daemon isn't running. Click "Try start" to launch Docker Desktop, or open it manually. ${docker.detail ? '(' + docker.detail + ')' : ''}`);
      } else if (docker && docker.state === 'not_installed') {
        setCheckState('docker', 'bad', 'Docker not installed — install Docker Desktop to enable SearXNG-backed web search.');
      } else {
        // Probe itself failed (server unreachable mid-check?). Fall back
        // to the searxng-inference message instead of fabricating a state.
        setCheckState('docker', sx ? 'ok' : 'bad', sx ? 'searxng container up' : 'docker probe failed — try running System Check again');
      }
    } else {
      setCheckState('aiserver', 'bad', ai.reason);
      // Fall back to "unknown" yellow for everything else
      ['node','python','git','docker','gpu','disk'].forEach(c => {
        setCheckState(c, 'bad', 'install + come back');
      });
    }
    setCheckState('searxng', sx ? 'ok' : 'bad', sx ? 'live on :8080' : 'unreachable');
  }

  document.getElementById('runChecks').addEventListener('click', runAllChecks);

  // Docker row "Try start" button. Tauri path: invoke try_start_docker_desktop
  // which probes `docker info` → `docker --version` → spawns Docker Desktop
  // if installed but not running. Browser path: swap to the Install link
  // (we can't shell out from a browser).
  (function wireDockerTryStart() {
    const tryBtn = document.getElementById('dockerTryStartBtn');
    const installLink = document.getElementById('dockerInstallLink');
    if (!tryBtn) return;
    const isTauri = !!(window.__TAURI__) || (window.location.hostname || '') === 'tauri.localhost';
    if (!isTauri || !window.__TAURI__?.core) {
      // Non-Tauri: hide the Try button, show the Install link.
      tryBtn.style.display = 'none';
      if (installLink) installLink.style.display = '';
      return;
    }
    tryBtn.addEventListener('click', async () => {
      const sdn = window.SeekDeepNotify;
      tryBtn.textContent = 'Probing…';
      tryBtn.disabled = true;
      try {
        const result = await window.__TAURI__.core.invoke('try_start_docker_desktop');
        if (result?.state === 'running') {
          if (sdn) sdn.toast({ tone: 'good', title: 'Docker is already running', ttl: 4000 });
        } else if (result?.state === 'launched') {
          if (sdn) sdn.toast({ tone: 'good', title: 'Docker Desktop launching…', body: 'Give it ~20-30 s to start up, then re-run System Check.', ttl: 6000 });
        } else if (result?.state === 'not_installed') {
          if (sdn) sdn.toast({ tone: 'info', title: 'Docker not installed', body: 'Opening docker.com/products/docker-desktop in your browser.', ttl: 5000 });
          if (installLink) installLink.click();
        } else {
          if (sdn) sdn.toast({ tone: 'bad', title: 'Docker launch failed', body: result?.detail || 'unknown error; launch Docker Desktop manually', ttl: 7000 });
        }
        // Re-probe in 2s so the row updates if Docker came up fast.
        setTimeout(runAllChecks, 2000);
      } catch (err) {
        if (sdn) sdn.toast({ tone: 'bad', title: 'try_start_docker_desktop failed', body: String(err), ttl: 6000 });
      } finally {
        tryBtn.textContent = 'Try start';
        tryBtn.disabled = false;
      }
    });
  })();
  // SearXNG row "Start" button — same /docker/start-searxng endpoint used by
  // the standalone SearXNG step pane, but inline on the System Check row so
  // users don't have to scroll back up to the Docker row to fix the failure.
  (function wireSearxngTryStart() {
    const btn = document.getElementById('searxngTryStartBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const sdn = window.SeekDeepNotify;
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '… starting';
      try {
        const r = await fetch(SEEKDEEP_BASE + '/docker/start-searxng', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(60_000),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok !== false) {
          btn.textContent = '✓ STARTED · WAIT 5-15s';
          btn.style.background = 'var(--good)';
          if (sdn) sdn.toast({ tone: 'good', title: 'SearXNG launching…', body: 'Container starting — re-probing in 8 seconds.', ttl: 6000 });
          setTimeout(runAllChecks, 8000);
        } else {
          btn.textContent = '✕ FAILED';
          btn.style.background = 'var(--bad)';
          const detail = (data.error || data.detail || '').slice(0, 200);
          if (sdn) sdn.toast({ tone: 'bad', title: 'SearXNG start failed', body: detail || 'See logs. Docker daemon needs to be running.', ttl: 8000 });
          console.warn('[SeekDeep installer] /docker/start-searxng:', data);
        }
      } catch (err) {
        btn.textContent = '✕ ERROR';
        btn.style.background = 'var(--bad)';
        if (sdn) sdn.toast({ tone: 'bad', title: 'SearXNG start error', body: String(err).slice(0, 200), ttl: 8000 });
        console.warn('[SeekDeep installer] /docker/start-searxng error:', err);
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = orig;
          btn.style.background = '';
        }, 8000);
      }
    });
  })();

  document.getElementById('resetChecks').addEventListener('click', () => {
    ['node','python','git','docker','gpu','disk','aiserver','searxng'].forEach(c => {
      setCheckState(c, null, '—');
    });
  });

  // ============ TOKEN VALIDATION ============
  const tokenInput = document.getElementById('discordToken');
  const tokenVal = document.getElementById('tokenValidation');
  tokenInput.value = state.token || '';
  tokenInput.addEventListener('input', () => {
    const v = tokenInput.value.trim();
    state.token = v;
    saveState();
    if (!v) {
      tokenVal.textContent = ''; tokenVal.className = 'validation';
    } else if (/^[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/.test(v)) {
      tokenVal.textContent = '▸ TOKEN SHAPE OK — value not transmitted, only stored locally.';
      tokenVal.className = 'validation ok';
    } else if (v.length < 50) {
      tokenVal.textContent = '▸ TOO SHORT — paste the full token (3 dot-separated blocks).';
      tokenVal.className = 'validation bad';
    } else {
      tokenVal.textContent = '▸ UNUSUAL SHAPE — Discord tokens start with M or N; double-check the value.';
      tokenVal.className = 'validation bad';
    }
    updateEnvPreview();
  });

  document.getElementById('adminIds').value = state.admin || '';
  document.getElementById('adminIds').addEventListener('input', e => {
    state.admin = e.target.value.trim();
    saveState();
    updateEnvPreview();
  });

  const clientIdInput = document.getElementById('discordClientId');
  const clientIdVal = document.getElementById('clientIdValidation');
  clientIdInput.value = state.clientId || '';
  clientIdInput.addEventListener('input', () => {
    const v = clientIdInput.value.trim();
    state.clientId = v;
    saveState();
    if (!v) {
      clientIdVal.textContent = ''; clientIdVal.className = 'validation';
    } else if (/^\d{17,20}$/.test(v)) {
      clientIdVal.textContent = '▸ SHAPE OK — Discord snowflake (17-20 digits).';
      clientIdVal.className = 'validation ok';
    } else {
      clientIdVal.textContent = '▸ EXPECTED 17-20 digits — copy the Application ID from the General Information tab.';
      clientIdVal.className = 'validation bad';
    }
    updateEnvPreview();
  });
  document.getElementById('hfToken').value = state.hf || '';
  document.getElementById('hfToken').addEventListener('input', e => {
    state.hf = e.target.value.trim();
    saveState();
    updateEnvPreview();
  });

  // ============ MODEL SELECTION ============
  function applySelections() {
    document.querySelectorAll('.selectable').forEach(card => {
      const role = card.dataset.role;
      card.classList.toggle('selected', card.dataset.id === state.selections[role]);
    });
    refreshVramBudget();
    updateEnvPreview();
  }
  // Event delegation on the three role grids so re-rendered cards from
  // renderModelCardsFromCatalog() still respond to clicks without
  // re-attaching N handlers on every refetch.
  ['chatModels', 'visionModels', 'imageModels'].forEach(gridId => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.selectable');
      if (!card || !grid.contains(card)) return;
      const role = card.dataset.role;
      if (!role) return;
      state.selections[role] = card.dataset.id;
      state.sizes[role] = parseFloat(card.dataset.size) || 0;
      saveState();
      applySelections();
    });
  });

  // Replace the hardcoded selectable cards with live data from
  // /models/catalog (HF + Ollama merged). Falls back silently to the
  // hardcoded list when the AI server is unreachable so first-run
  // wizard still works pre-spawn. Reads /config in parallel so the
  // current LOCAL_*_MODEL_ID values mark the right card as selected
  // even when the user reopens the wizard after a prior apply.
  async function renderModelCardsFromCatalog() {
    let catalog = null;
    let envCurrent = {};
    try {
      const [catRes, cfgRes] = await Promise.all([
        fetch(SEEKDEEP_BASE + '/models/catalog', { cache: 'no-store', signal: AbortSignal.timeout(5000) }),
        fetch(SEEKDEEP_BASE + '/config', { cache: 'no-store', signal: AbortSignal.timeout(5000) }),
      ]);
      if (catRes && catRes.ok) catalog = await catRes.json();
      if (cfgRes && cfgRes.ok) {
        const c = await cfgRes.json();
        envCurrent = (c && c.env) || {};
      }
    } catch (_) {
      return;  // server offline; hardcoded cards stay as fallback
    }
    if (!catalog || !catalog.ok) return;

    const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch]));
    const roles = [
      { id: 'chat',   gridId: 'chatModels',   entries: catalog.chat   || [], envKey: 'LOCAL_CHAT_MODEL_ID',   allowNone: false },
      { id: 'vision', gridId: 'visionModels', entries: catalog.vision || [], envKey: 'LOCAL_VISION_MODEL_ID', allowNone: true  },
      { id: 'image',  gridId: 'imageModels',  entries: catalog.image  || [], envKey: 'LOCAL_IMAGE_MODEL_ID',  allowNone: true  },
    ];

    // /config redacts secrets to "*****" when they're set — so any non-empty
    // value (including the literal "*****") means the user has saved a token.
    // Empty string means no token in .env. The catalog endpoint already
    // exposes `hf_token_set: true` for the same reason; either signal works.
    const hfTokenSet = !!(envCurrent.HF_TOKEN && envCurrent.HF_TOKEN.length)
                    || catalog.hf_token_set === true;

    for (const r of roles) {
      const grid = document.getElementById(r.gridId);
      if (!grid || !r.entries.length) continue;
      // Selection priority: existing localStorage state > current .env > first entry.
      // The fall-through means a fresh install with no localStorage AND no .env
      // value yet still picks something sensible (catalog's recommended top entry).
      const current = state.selections[r.id]
                   || envCurrent[r.envKey]
                   || r.entries[0]?.repo_id;
      grid.innerHTML = '';
      for (const e of r.entries) {
        const isSelected = e.repo_id === current;
        const backendTag = e.backend === 'ollama' ? '🦙 ollama' : 'hf';
        const sizeStr = (e.size_gb || 0) + ' GB';
        const shortName = String(e.repo_id || '').split('/').pop() || e.repo_id;
        const card = document.createElement('div');
        card.className = 'selectable' + (isSelected ? ' selected' : '');
        card.dataset.role = r.id;
        card.dataset.id = e.repo_id;
        card.dataset.size = String(e.size_gb || 0);
        card.dataset.backend = e.backend || 'hf';
        // Gated badge: if the user already has HF_TOKEN saved in .env, this
        // is just informational ("✓ token set"). Only show the warn-colored
        // "needs HF_TOKEN" pill when the token genuinely isn't set yet.
        let gatedBadge = '';
        if (e.gated) {
          gatedBadge = hfTokenSet
            ? '<div class="tiny" style="font-size:10px;color:var(--good);margin-top:2px;">🔑 gated · HF_TOKEN set ✓</div>'
            : '<div class="tiny" style="font-size:10px;color:var(--warn);margin-top:2px;">⚠ gated · needs HF_TOKEN</div>';
        }
        card.innerHTML =
          '<div class="check"></div>' +
          '<div class="head">' +
            '<span class="role">' + esc(e.tier || '—') + ' · ' + esc(backendTag) + '</span>' +
            '<span class="size">' + esc(sizeStr) + '</span>' +
          '</div>' +
          '<h4>' + esc(shortName) + '</h4>' +
          '<div class="id">' + esc(e.repo_id) + '</div>' +
          (e.why ? '<div class="tiny" style="font-size:10px;color:var(--hull-3);margin-top:4px;line-height:1.3;">' + esc(e.why) + '</div>' : '') +
          gatedBadge;
        grid.appendChild(card);
      }
      // Add a "Skip / none" card for vision + image (chat is required).
      if (r.allowNone) {
        const isNone = current === 'none';
        const noneCard = document.createElement('div');
        noneCard.className = 'selectable' + (isNone ? ' selected' : '');
        noneCard.dataset.role = r.id;
        noneCard.dataset.id = 'none';
        noneCard.dataset.size = '0';
        noneCard.dataset.backend = 'none';
        noneCard.innerHTML =
          '<div class="check"></div>' +
          '<div class="head"><span class="role">SKIP</span><span class="size">0 GB</span></div>' +
          '<h4>No ' + r.id + '</h4>' +
          '<div class="id">disables /' + r.id + ' + downstream pipelines</div>';
        grid.appendChild(noneCard);
      }
      // Sync state from the now-selected card so VRAM budget + env preview
      // reflect the live catalog values (e.g. a model's size_gb may differ
      // from the prior hardcoded HTML).
      if (current && current !== 'none') {
        state.selections[r.id] = current;
        const sel = r.entries.find(e => e.repo_id === current);
        state.sizes[r.id] = sel?.size_gb || 0;
      } else if (current === 'none') {
        state.selections[r.id] = 'none';
        state.sizes[r.id] = 0;
      }
    }
    saveState();
    applySelections();
  }
  // Kick off the dynamic render. If it fails (server offline, network
  // error), the hardcoded cards stay visible — wizard remains usable.
  renderModelCardsFromCatalog();

  // Detected GPU capacity + runtime quant/swap config from /gpu + /health.
  // Catalog sizes are FP16 download sizes — but with chat_quant_mode=4bit
  // (the default) Llama 8B occupies ~5 GB at runtime, not 16 GB. And with
  // keep_mode=task-lru-swap, the image model only occupies VRAM while the
  // image task is active (it swaps out when chat/vision become the LRU
  // active task). So naive sum was telling 5090 owners "34 / 24 GB · over
  // budget" when the actual peak is comfortable. Now we account for both.
  let vramCapacityGb = 24;
  let chatQuantMode = '4bit';                       // default per local_ai_server.py
  let keepResident = { chat: true, vision: true, image: false };
  async function refreshVramCapacity() {
    // Parallel fetch — /gpu has nvidia_smi.total_mb, /health has the
    // quant + keep_resident config that drives the math below.
    try {
      const [gRes, hRes] = await Promise.all([
        fetch(SEEKDEEP_BASE + '/gpu',    { cache: 'no-store', signal: AbortSignal.timeout(3000) }).catch(() => null),
        fetch(SEEKDEEP_BASE + '/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) }).catch(() => null),
      ]);
      if (gRes && gRes.ok) {
        const g = await gRes.json();
        const totalMb = g?.nvidia_smi?.total_mb || g?.total_mb;
        if (totalMb && totalMb > 0) {
          vramCapacityGb = Math.round(totalMb / 1024);
          const cap = document.getElementById('vramCapacity');
          if (cap) cap.textContent = String(vramCapacityGb);
        }
      }
      if (hRes && hRes.ok) {
        const h = await hRes.json();
        if (typeof h?.chat_quant_mode === 'string') chatQuantMode = h.chat_quant_mode;
        if (h?.keep_resident && typeof h.keep_resident === 'object') {
          keepResident = Object.assign(keepResident, h.keep_resident);
        }
      }
      refreshVramBudget();
    } catch {}
  }
  refreshVramCapacity();

  // FP16 → runtime size multiplier for the chat model. bitsandbytes 4-bit
  // (nf4 / int4) lands around 30% of FP16; 8-bit lands around 55%. Anything
  // else (full / bf16 / fp16) is 1.0×. Vision + image models aren't
  // currently quantized at load time, so their fp16 size IS the runtime size.
  function chatQuantFactor() {
    const m = String(chatQuantMode || '').toLowerCase();
    if (m === '4bit' || m === 'int4' || m === 'nf4')  return 0.30;
    if (m === '8bit' || m === 'int8')                 return 0.55;
    return 1.0;
  }

  function refreshVramBudget() {
    const chatRaw   = state.sizes.chat   || 0;       // FP16 download size
    const imageRaw  = state.sizes.image  || 0;
    const visionRaw = state.sizes.vision || 0;
    const chat   = chatRaw * chatQuantFactor();       // runtime resident size
    const image  = imageRaw;
    const vision = visionRaw;
    const sysReserve = 4.0;

    // Peak runtime resident VRAM under task-LRU swap:
    //   - keep_resident roles stay loaded
    //   - swappable roles only count toward peak while their task is active
    //     (one at a time)
    // The honest worst case is "chat+vision resident + largest swappable
    // role peaks during its task". For the typical default
    // {chat:true, vision:true, image:false}, peak = chat + vision + image
    // (because when image runs, chat+vision are still pinned). That happens
    // to equal the naive sum, but the chat-quant adjustment is what saves
    // the budget — 5090 owners running 8B int4 + 3B vision + SDXL fit fine.
    const residentChat   = keepResident.chat   ? chat   : 0;
    const residentVision = keepResident.vision ? vision : 0;
    const residentImage  = keepResident.image  ? image  : 0;
    const swapCandidates = [
      keepResident.chat   ? 0 : chat,
      keepResident.vision ? 0 : vision,
      keepResident.image  ? 0 : image,
    ];
    const peakSwap = Math.max(0, ...swapCandidates);
    const total = residentChat + residentVision + residentImage + peakSwap + sysReserve;

    document.getElementById('vramTotal').textContent = total.toFixed(1);
    document.getElementById('vbChat').textContent   = chat.toFixed(1);
    document.getElementById('vbImage').textContent  = image.toFixed(1);
    document.getElementById('vbVision').textContent = vision.toFixed(1);
    // total color flips red if it exceeds the user's actual capacity
    const totalEl = document.getElementById('vramTotal');
    totalEl.style.color = total > vramCapacityGb ? 'var(--bad)' : 'var(--cyan-1)';

    // Build the 20 cell bar — proportional to user's actual GPU capacity
    const stack = document.getElementById('vbStack');
    stack.innerHTML = '';
    const cellsPerGb = 20 / vramCapacityGb;
    function cells(n, cls) {
      const c = Math.round(n * cellsPerGb);
      for (let i = 0; i < c; i++) {
        const cell = document.createElement('i');
        cell.className = 'used ' + cls;
        stack.appendChild(cell);
      }
    }
    cells(chat, 'chat');
    cells(image, 'image');
    cells(vision, 'vision');
    cells(sysReserve, 'sys');
    // empty
    while (stack.children.length < 20) {
      const cell = document.createElement('i');
      stack.appendChild(cell);
    }
    // overflow indicator
    if (total > vramCapacityGb) {
      stack.querySelectorAll('i').forEach(c => c.classList.add('over'));
    }

    // Warmup row shows total ON-DISK download (no quant — bitsandbytes
    // quantizes at LOAD time, so the cached weights are still full size).
    document.getElementById('warmupSize').textContent = `~ ${(chatRaw + imageRaw + visionRaw).toFixed(0)} GB`;
  }

  // ============ SEARXNG / STACK PROBES ============
  document.getElementById('probeSearxng').addEventListener('click', async () => {
    setCheckState('sxLive', 'checking', 'probing…');
    const ok = await probeSearxng();
    setCheckState('sxLive', ok ? 'ok' : 'bad', ok ? 'live on :8080' : 'unreachable · start the container');
  });

  document.getElementById('probeStack').addEventListener('click', async () => {
    ['aiHealth','aiGpu','sxFinal','botProcess'].forEach(c => setCheckState(c, 'checking', 'probing…'));
    const [ai, sx] = await Promise.all([probeAiHealth(2000), probeSearxng()]);
    if (ai.up) {
      const m = ai.data && ai.data.model ? ai.data.model : 'unknown';
      setCheckState('aiHealth', 'ok', `loaded: ${m}`);
      const gpu = await probeAiGpu();
      if (gpu && gpu.total_mb) {
        setCheckState('aiGpu', 'ok', `${(gpu.used_mb/1024).toFixed(1)} / ${(gpu.total_mb/1024).toFixed(1)} GB`);
      } else {
        setCheckState('aiGpu', 'bad', 'no GPU data');
      }
    } else {
      setCheckState('aiHealth', 'bad', ai.reason);
      setCheckState('aiGpu', 'bad', 'AI server down');
    }
    setCheckState('sxFinal', sx ? 'ok' : 'bad', sx ? 'live on :8080' : 'unreachable');
    setCheckState('botProcess', state.flags.online ? 'ok' : 'bad',
      state.flags.online ? 'manually confirmed' : 'verify in Discord manually');
  });
  document.getElementById('resetStack').addEventListener('click', () => {
    ['aiHealth','aiGpu','sxFinal','botProcess'].forEach(c => setCheckState(c, null, '—'));
  });

  // ============ ENV PREVIEW (final step) ============
  function updateEnvPreview() {
    document.getElementById('envToken')   .textContent = state.token  || 'your_discord_bot_token';
    document.getElementById('envClientId').textContent = state.clientId || 'your_discord_application_id';
    document.getElementById('envAdmin')   .textContent = state.admin  || '';
    document.getElementById('envHf')      .textContent = state.hf     || '';
    document.getElementById('envChat')    .textContent = state.selections.chat   || '';
    document.getElementById('envVision')  .textContent = state.selections.vision || '';
    document.getElementById('envImage')   .textContent = state.selections.image  || '';
    document.getElementById('envQuant')   .textContent = state.flags.quant_4bit ? '4bit' : 'none';
    document.getElementById('envWebAuto') .textContent = state.flags.web_auto ? 'true' : 'false';
    document.getElementById('envWebFail') .textContent = state.flags.web_fail_open ? 'true' : 'false';
  }

  // ============ APPLY TO .env (final step — replaces the old paste-the-blob UX)
  // Builds an updates dict from wizard state, POSTs /config (token-gated +
  // newline-validated + key-format-validated server-side). Only sends keys
  // the user actually filled in — placeholders stay as-is in .env so we don't
  // overwrite the user's existing real values with literal "your_discord_bot_token".
  (function wireApplyEnv() {
    const btn = document.getElementById('applyEnvBtn');
    const toggleBtn = document.getElementById('togglePreviewBtn');
    const wrap = document.getElementById('envPreviewWrap');
    const status = document.getElementById('applyEnvStatus');
    if (!btn || !toggleBtn || !wrap || !status) return;

    toggleBtn.addEventListener('click', () => {
      const showing = wrap.style.display !== 'none';
      wrap.style.display = showing ? 'none' : '';
      toggleBtn.textContent = showing ? 'SHOW PREVIEW' : 'HIDE PREVIEW';
    });

    btn.addEventListener('click', async () => {
      const sdn = window.SeekDeepNotify;
      const updates = {};
      // Only send keys the user filled in — never overwrite with placeholders.
      if (state.token)               updates.DISCORD_TOKEN         = state.token;
      if (state.clientId)            updates.DISCORD_CLIENT_ID     = state.clientId;
      if (state.admin)               updates.SEEKDEEP_ADMIN_IDS    = state.admin;
      if (state.hf)                  updates.HF_TOKEN              = state.hf;
      if (state.selections?.chat)    updates.LOCAL_CHAT_MODEL_ID   = state.selections.chat;
      if (state.selections?.vision)  updates.LOCAL_VISION_MODEL_ID = state.selections.vision;
      if (state.selections?.image)   updates.LOCAL_IMAGE_MODEL_ID  = state.selections.image;
      // Flags + defaults always sent (idempotent).
      updates.LOCAL_CHAT_QUANT     = state.flags?.quant_4bit ? '4bit' : 'none';
      updates.MODEL_AUTO_FALLBACK  = 'true';
      updates.MODEL_KEEP_MODE      = 'task-lru';
      updates.SEARXNG_BASE_URL     = 'http://127.0.0.1:8080';
      updates.WEB_AUTO_SEARCH      = state.flags?.web_auto ? 'true' : 'false';
      updates.WEB_SEARCH_FAIL_OPEN = state.flags?.web_fail_open ? 'true' : 'false';
      updates.SEEKDEEP_MEMORY_SCOPE = 'user';
      updates.SEEKDEEP_MEMORY_MODE  = 'rolling';
      updates.MAX_CONTEXT_MESSAGES  = '80';
      updates.MAX_CONTEXT_CHARS     = '48000';

      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = '… writing';
      status.textContent = '';
      try {
        const r = await fetch(SEEKDEEP_BASE + '/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok !== false) {
          const n = Object.keys(updates).length;
          btn.textContent = '✓ APPLIED';
          btn.style.background = 'var(--good)';
          status.textContent = `Wrote ${n} keys to .env. Restart the AI server (Control Center → Quick Actions → Reload .env) to load the new values.`;
          if (sdn) sdn.toast({ tone: 'good', title: '.env updated', body: `${n} keys written. Restart AI server to apply.`, ttl: 6000 });
        } else if (r.status === 401) {
          btn.textContent = '✕ AUTH FAILED';
          btn.style.background = 'var(--bad)';
          status.textContent = 'AI server rejected the write (401). Open Control Center to refresh the token, then try again.';
          if (sdn) sdn.toast({ tone: 'bad', title: '.env write rejected (401)', body: 'Token expired or invalid. Refresh and retry.', ttl: 8000 });
        } else {
          btn.textContent = '✕ FAILED';
          btn.style.background = 'var(--bad)';
          const detail = (data.detail || data.error || `HTTP ${r.status}`).toString().slice(0, 200);
          status.textContent = `Failed: ${detail}. Use SHOW PREVIEW + manual paste as fallback.`;
          if (sdn) sdn.toast({ tone: 'bad', title: '.env write failed', body: detail, ttl: 8000 });
        }
      } catch (err) {
        btn.textContent = '✕ ERROR';
        btn.style.background = 'var(--bad)';
        const msg = String(err?.message || err).slice(0, 200);
        status.textContent = `Error: ${msg}. Is the AI server running? Use SHOW PREVIEW + manual paste as fallback.`;
        if (sdn) sdn.toast({ tone: 'bad', title: '.env write error', body: msg, ttl: 8000 });
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = orig;
          btn.style.background = '';
        }, 8000);
      }
    });
  })();

  // ============ INIT ============
  applySelections();
  updateEnvPreview();
  render();

  // Show the "you can skip this wizard" banner if we detect the Tauri shell.
  // The .msi-installed desktop app already performs steps 1-8; users landing
  // here are reading curiosity-mode, not running-the-commands-mode.
  //
  // Also auto-run the System Check probes on page load so red dots that
  // would falsely accuse the user of missing Node/Python flip green
  // immediately. Without this the page sits at "install + come back" for
  // every prereq until the user clicks "Run all checks" — actively
  // misleading for users who definitely have everything (they're running
  // SeekDeep right now).
  (function maybeShowTauriSkipBanner() {
    const isTauri = !!(window.__TAURI__) || (window.location.hostname || '') === 'tauri.localhost';
    if (!isTauri) return;
    const banner = document.getElementById('tauriSkipBanner');
    if (banner) banner.style.display = 'block';
    // Defer until the syscheck pane is in the DOM (it always is, but the
    // run handler may not be wired yet on a freshly-loaded page).
    setTimeout(() => {
      try {
        if (typeof runAllChecks === 'function') runAllChecks();
      } catch (_) { /* best-effort */ }
    }, 250);
  })();
