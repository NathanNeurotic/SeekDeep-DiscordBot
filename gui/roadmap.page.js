// ===========================================================
// ROADMAP DATA — audit 2026-06-04 against v10.38.31
// ===========================================================
const PHASES = [
  {
    id: 'tauri-shell',
    title: 'Tauri 2 desktop shell',
    status: 'shipped',
    meta: 'v10.35.x · Windows MSI + macOS DMG',
    note: 'SeekDeep ships as a native desktop app — no terminal, no .bat files. Tauri Rust spawns the Python sidecar, kills stale servers, and survives MSI overwrites without losing the user.',
    items: [
      { title: 'Sidecar + boot sequence', desc: 'Rust shell extracts bundled resources to <span class="mono">%APPDATA%\\com.nathanneurotic.seekdeep\\app</span>, finds Python, validates deps, spawns <span class="mono">local_ai_server.py</span>. Version-aware: kills any stale :7865 server (different version OR same-version after pip install) before re-spawning so newly-installed deps load.', cat: 'features', version: 'v10.35.x' },
      { title: 'Fresh-boot remnant cleanup', desc: 'Tauri sets <span class="mono">SEEKDEEP_FRESH_BOOT=1</span> on the FIRST sidecar spawn of each launch. Python startup reaps any leftover <span class="mono">node index.js</span> bot processes from previous sessions. Mid-session respawns (ML install, crash watchdog) skip this so your running bot survives.', cat: 'features', version: 'v10.35.6' },
      { title: 'System tray + minimize', desc: 'Right-click tray menu: Open, Restart sidecar, Self-update, Quit. Closing the window minimizes to tray instead of killing the AI server.', cat: 'features', version: 'v10.35.x' },
      { title: 'Self-update from GitHub', desc: 'POST <span class="mono">/system/self-update</span> pulls the latest <span class="mono">local_ai_server.py</span>, <span class="mono">gui/</span>, and <span class="mono">scripts/</span> from <span class="mono">main</span> and auto-restarts the sidecar so changes take effect immediately.', cat: 'features', version: 'v10.35.x' },
      { title: 'Nightly Windows MSI builds', desc: 'GitHub Actions builds and publishes a signed MSI on every push to main. Release notes embed SmartScreen guidance images (<em>"More info" → "Run anyway"</em>) so first-run users aren\'t blocked.', cat: 'features', version: 'v10.35.x' },
      { title: 'Always-fresh sidecar respawn', desc: 'Previously matched-version sidecars were reused on relaunch — which trapped users behind stale <span class="mono">sys.modules</span> after a pip install. Now every Tauri launch kills+respawns. Set <span class="mono">SEEKDEEP_TAURI_REUSE_SIDECAR=1</span> to opt out.', cat: 'features', version: 'v10.35.x' },
    ]
  },
  {
    id: 'live-events',
    title: 'Live events bus — push instead of poll',
    status: 'shipped',
    meta: 'v10.35.6 · 7 event families',
    note: 'A single /events WebSocket replaces ~80% of the per-pane HTTP polling. Server emits ticks on a timer; clients subscribe and update UI on each event. Polling stays in place as a 30s safety net for when the WS is down.',
    items: [
      { title: 'WebSocket event bus', desc: '<span class="mono">/events</span> WS with token query-param auth, exponential reconnect, hello/heartbeat keepalives. Client API: <span class="mono">window.SeekDeepEvents.on(topic, cb)</span>.', cat: 'features', version: 'v10.35.x' },
      { title: 'Live status ticks', desc: 'Server-side <span class="mono">_tick_loop</span> publishes <span class="mono">gpu.tick</span> (3s), <span class="mono">health.tick</span> (5s), <span class="mono">launchers.tick</span> (5s). Fast-paths to no-op when zero subscribers — idle box pays nothing.', cat: 'perf', version: 'v10.35.6' },
      { title: 'Event-driven route badge', desc: 'POST <span class="mono">/config</span> and <span class="mono">/persona</span> emit <span class="mono">route.changed</span>. Chat playground re-fetches <span class="mono">/route/debug</span> only on changes, not every 8s.', cat: 'perf', version: 'v10.35.6' },
      { title: 'Service state events', desc: '<span class="mono">service.state.changed</span> fires whenever a launcher transitions. Launcher cards update instantly without waiting for the next poll cycle.', cat: 'features', version: 'v10.35.x' },
      { title: 'Long-task progress banner', desc: 'Page-wide <span class="mono">long-task.js</span> banner subscribes to <span class="mono">deps.install.*</span>, <span class="mono">doctor.*</span>, <span class="mono">self-update.*</span>. Shows elapsed time + line count + last log line on every page, not just the wizard.', cat: 'features', version: 'v10.35.x' },
      { title: 'Streaming logs', desc: '<span class="mono">/logs/stream</span> SSE replaces the 3s <span class="mono">/logs/tail</span> poll loop in the Logs Viewer.', cat: 'perf', version: 'v10.35.x' },
    ]
  },
  {
    id: 'ml-deps-installer',
    title: 'ML deps installer + model wizard',
    status: 'shipped',
    meta: 'v10.35.x · pip + HF cache',
    note: 'Heavy ML libraries (torch, transformers, diffusers) are NOT bundled with the .exe — they install on first use via an in-app flow. HF model weights download progressively with live progress.',
    items: [
      { title: 'Split requirements', desc: '<span class="mono">requirements-local.txt</span> is the FastAPI boot stack (~25 MB). <span class="mono">requirements-ml.txt</span> is the heavy GPU stack (~2 GB torch+transformers+diffusers+tiktoken+sentencepiece, pinned to <span class="mono">torch==2.11.0+cu128</span>).', cat: 'features', version: 'v10.35.x' },
      { title: 'POST /deps/install', desc: 'Endpoint streams pip output via <span class="mono">deps.install.line</span> events. Auto-kills the sidecar first so dep installs don\'t race with running imports. Classifier branches for known failure modes (ResolutionImpossible, tokenizer-load-failure, Python-too-new, etc.).', cat: 'features', version: 'v10.35.x' },
      { title: 'Inline INSTALL TOKENIZER DEPS button', desc: 'Chat 503 with <span class="mono">tokenizer-load-failure</span> shows a one-click fix button right in the conversation. Calls Tauri\'s <span class="mono">install_ml_deps</span> or POSTs <span class="mono">/deps/install</span>, then auto-restarts.', cat: 'features', version: 'v10.35.6' },
      { title: 'HF model picker + cache scan', desc: 'Quick Model Picker on Bot Config + Models pane. Lists curated catalog + locally-cached repos. WinError 448 (HF symlink failure) detected with one-click fix. Ollama-aware "cached" badge.', cat: 'features', version: 'v10.35.x' },
      { title: 'Streaming HF download', desc: 'First-use model download shows live progress (MB / total MB, %, ETA) via <span class="mono">model.download.line</span> events. Resumable.', cat: 'features', version: 'v10.35.x' },
      { title: 'PyTorch sm_120 + cu128 detect', desc: 'RTX 50-series (Blackwell sm_120) needs cu128 wheels. Detected automatically; one-click "Install cu128 variant" button on Installer page.', cat: 'features', version: 'v10.35.x' },
    ]
  },
  {
    id: 'gui-surface',
    title: 'Control Center — full GUI surface',
    status: 'shipped',
    meta: 'v10.35.x · 16 panes',
    note: 'Every Discord-side feature is now driveable from the desktop GUI: chat, image, vision, archive, memory, prompts, doctor, logs, launchers, stats. No-Discord (Standalone) mode runs without Discord at all.',
    items: [
      { title: 'Chat / image / vision playgrounds', desc: 'Full local playground for <span class="mono">/chat</span>, <span class="mono">/image</span> (txt2img / img2img / pix2pix / inpaint / upscale), <span class="mono">/vision</span>. Slash commands (<span class="mono">/remember</span>, <span class="mono">/recall</span>, <span class="mono">/route</span>, <span class="mono">/help</span>) work locally too.', cat: 'features', version: 'v10.35.x' },
      { title: 'Memory + persona endpoints', desc: '9 <span class="mono">/memory/*</span> routes + <span class="mono">/persona</span> with scope=channel|server|global. Same atomic-write semantics as the Discord-side handlers; data flows are identical.', cat: 'features', version: 'v10.35.x' },
      { title: 'Universal Archive surface', desc: 'Context-menu "Archive this" works on any message. Reply-with-archive surface; 📥 reaction notifies the author. Edit-in-place updates the published copy; deletion writes a tombstone.', cat: 'features', version: 'v10.35.x' },
      { title: 'Prompts marketplace', desc: '<span class="mono">#prompts</span> channel becomes a browsable library on the Prompts pane. Editable in-place; deletes tombstone the published copy. 14-day reshare logic prevents spam.', cat: 'features', version: 'v10.35.x' },
      { title: 'Launcher card lifecycle', desc: 'Single source of truth — <span class="mono">_service_state()</span>. Reports running / exited / transitioning / not-running with PID + count + uptime + last_error tail. Stale yesterday-old err.log guard against false-crash banners.', cat: 'features', version: 'v10.35.x' },
      { title: 'Doctor + stats + cache prune', desc: '<span class="mono">/system/doctor</span> preflight (Python/Git/Docker/HF probes), <span class="mono">/stats/snapshot</span> (per-user activity over 30d), <span class="mono">/cache/prune</span> (HF cache eviction).', cat: 'features', version: 'v10.35.x' },
      { title: 'Kill-all-bot-instances', desc: 'Right-click action on the bot launcher card. Enumerates every <span class="mono">node index.js</span> process scoped to the repo cwd and force-kills. Solves the "bot instances pile up" symptom that earlier auto-restart loops created.', cat: 'features', version: 'v10.35.6' },
      { title: 'Standalone (no-Discord) boot mode', desc: 'Run the AI server + GUI without a Discord token — full playgrounds, no bot login required. <span class="mono">--no-discord</span> launcher flag.', cat: 'features', version: 'v10.35.x' },
    ]
  },
  {
    id: 'resilience',
    title: 'Resilience + polish',
    status: 'shipped',
    meta: 'v10.35.x · 12 papercuts',
    note: 'The "feels broken" papercuts — silent failures, console flashes, false-positive banners, stale state — all hunted down and either fixed or surfaced inline with a one-click recovery button.',
    items: [
      { title: 'Subprocess CREATE_NO_WINDOW', desc: 'Module-local subprocess shim auto-injects <span class="mono">creationflags=CREATE_NO_WINDOW</span> on Windows. Every periodic probe (nvidia-smi, where, doctor) no longer flashes a black terminal on focus.', cat: 'qol', version: 'v10.35.6' },
      { title: 'Chat input click no longer hangs', desc: 'Spellcheck off on every textarea/input + synchronous warm-up textarea at nav.js entry. Webview2 TSF / spellcheck-COM cold-start happens during page load, not on first click.', cat: 'qol', version: 'v10.35.6' },
      { title: 'Suppressed transient errors during restart', desc: 'Global restart-window flag silences <span class="mono">/health</span>, <span class="mono">/logs/tail</span>, <span class="mono">/launchers/status</span> error toasts during a known sidecar bounce so users don\'t see panic banners during a planned 5s gap.', cat: 'qol', version: 'v10.35.x' },
      { title: 'Resilient HF cache scan', desc: 'WinError 448 (HF symlinks across drives) surfaces inline with a "Fix cache" button that switches HF_HOME to a same-drive path.', cat: 'features', version: 'v10.35.x' },
      { title: 'CPU-only banner truth', desc: 'Was crying "CPU ONLY" any time torch wasn\'t imported. Now gated on <span class="mono">gpu.torch_present === true && cuda_available === false</span> so missing-deps is reported as missing-deps, not as no-GPU.', cat: 'qol', version: 'v10.35.6' },
      { title: 'SmartScreen guidance everywhere', desc: 'README + every GitHub release description embeds the SmartScreen "More info → Run anyway" screenshots. Backfill script for past releases.', cat: 'features', version: 'v10.35.x' },
    ]
  },
  {
    id: 'hardening-parity',
    title: 'Hardening + GUI⇄Discord parity',
    status: 'shipped',
    meta: 'v10.36–v10.38 · CSP · parity · supply-chain',
    note: 'The v10.36–v10.38 wave: a browser/WebView content-security policy, one shared config renderer so the two settings surfaces can\'t drift, the first read/write GUI⇄Discord parity pages, the DataDash Activity game, and a supply-chain + runtime safety pass.',
    items: [
      { title: 'CSP Phase A', desc: 'Content-Security-Policy + security headers on the Tauri WebView (<span class="mono">tauri.conf.json</span>) mirrored on the loopback browser path (<span class="mono">_SEEKDEEP_GUI_CSP</span> in <span class="mono">local_ai_server.py</span>). <span class="mono">connect-src</span> locks token egress to loopback; the Discord Activity (<span class="mono">gui/activity/*</span>) is exempt. <span class="mono">script-src</span> still allows <span class="mono">\'unsafe-inline\'</span> — tightening is parked below.', cat: 'features', version: 'v10.38' },
      { title: 'Config-renderer unification', desc: 'Control Center + All Settings now render every schema-backed SELECT / TOGGLE row through one shared <span class="mono">config-render.js</span>, so a new enum value or boolean vocab can\'t drift between the two surfaces. Curated rich controls (model picker, token fields) intentionally kept bespoke.', cat: 'features', version: 'v10.38' },
      { title: 'GUI⇄Discord parity — Emoji Vault', desc: 'Read-only <span class="mono">Emoji Vault</span> page bridges Python → Discord REST to browse application + guild emojis from the GUI. Feature-gated. Writes (import/delete) are Phase 2 — see below.', cat: 'features', version: 'v10.38.28' },
      { title: 'GUI⇄Discord parity — Force React', desc: 'Force React config page + per-guild cumulative cap, feature-gated. Second parity surface, this one read/write on reaction-rule config.', cat: 'features', version: 'v10.38.30' },
      { title: 'DataDash Discord Activity game', desc: 'Replaced the mockup with the real DataDash game embedded as a Discord Activity and wired into the GUI nav.', cat: 'features', version: 'v10.38' },
      { title: 'Security / supply-chain hardening', desc: 'CodeQL security-extended + Dependabot + secret scanning; bounded image queue with output caps; a cross-process advisory lock through every shared-file writer; atomic-write quarantine on corruption; SHA-pinned GitHub Actions.', cat: 'features', version: 'v10.36–v10.38' },
    ]
  },
  {
    id: 'next-up',
    title: 'Next up',
    status: 'flight',
    meta: '6 priorities',
    note: 'Actively on the radar — scaffolded or scoped, but blocked on an external lift, a model download, or a go-ahead.',
    items: [
      { title: 'Drop \'unsafe-inline\' from script-src', desc: 'CSP Phase B, defense-in-depth (not a fix for any known issue). Requires externalizing the 35 inline <span class="mono">&lt;script&gt;</span> blocks across 24 files + converting the ~28 inline <span class="mono">on*=</span> handlers to <span class="mono">addEventListener</span>, then flipping the CSP. Auto-hashing is a dead end; extraction is the path. Parked, no date.', cat: 'features' },
      { title: 'Split the index.js monolith', desc: '<span class="mono">index.js</span> is ~24.5k lines. Split into <span class="mono">lib/</span> modules (image-pipeline, archive, persona, router, commands, reactrules, presence). High-touch; needs a go. Only <span class="mono">lib/url-fetch-policy.js</span> extracted so far.', cat: 'qol' },
      { title: 'Emoji Vault writes (Phase 2)', desc: 'Import / delete on the Emoji Vault page — touches real server emojis via Discord REST. Follows the read-only v10.38.28 page.', cat: 'features' },
      { title: 'Bot command-bridge', desc: 'The foundation for full GUI⇄Discord parity on bot-state-dependent features — a channel for the GUI to drive live bot state, not just config + REST reads.', cat: 'features' },
      { title: 'Real-ESRGAN upscale model', desc: 'Right-click "Upscale 2x" path is wired; needs the model weights cached + a first-run consent prompt. Gated behind <span class="mono">SEEKDEEP_FEATURE_UPSCALE_REALESRGAN=on</span>.', cat: 'image' },
      { title: 'Live-events for /stats/snapshot', desc: '<span class="mono">/stats/snapshot</span> is the last 30s poll we haven\'t pushed onto the event bus. Could fire <span class="mono">stats.tick</span> on the same loop. Low priority — 30s is fine.', cat: 'perf' },
    ]
  },
  {
    id: 'optional',
    title: 'Optional features (scaffolded, off by default)',
    status: 'parked',
    meta: '2 flags',
    note: 'Behaviour gated behind <span class="mono">SEEKDEEP_FEATURE_*</span> flags. Default off; flip to <span class="mono">on</span> in <span class="mono">.env</span> + restart to enable.',
    items: [
      { title: 'SEEKDEEP_FEATURE_NSFW_GATE', desc: 'CLIP-based NSFW scorer on generated images. Needs model, scoring step, thresholds, <span class="mono">.env</span> knobs for refuse-vs-spoiler-wrap.', cat: 'features' },
      { title: 'SEEKDEEP_FEATURE_TTS_VOICE', desc: 'Voice-channel TTS reader (Piper or XTTS). Voice connection, model setup, per-channel opt-in.', cat: 'features' },
    ]
  },
  {
    id: 'qol',
    title: 'Quality-of-life wishlist',
    status: 'parked',
    meta: '3 items',
    note: 'Small ergonomics that aren\'t blocking anyone right now but would smooth specific workflows.',
    items: [
      { title: 'GPU logging', desc: 'Optional background sampler controlled by <span class="mono">SEEKDEEP_GPU_LOGGING=on</span>. Mirrors <span class="mono">/gpu</span> snapshots to <span class="mono">logs/seekdeep-vram.log</span> at a configurable cadence.', cat: 'qol' },
      { title: 'VRAM budget table', desc: 'Document which model combinations fit a 24 GB card — chat + image + vision sizes at 4bit/fp16 with task-LRU swap math.', cat: 'qol' },
      { title: 'Latin-script language detection', desc: 'Extend the auto-translate channel to detect French, Spanish, Portuguese, etc. — not just non-Latin scripts. Needs a small detector model or langid heuristic.', cat: 'qol' },
    ]
  },
  {
    id: 'deferred',
    title: 'Deferred',
    status: 'parked',
    meta: '2 items',
    note: 'Things worth doing only if another consumer of the same logic appears, or only after manual migration tooling exists.',
    items: [
      { title: '<span class="mono">shouldAutoSearch</span> refactor', desc: 'Only worth doing if a second consumer needs the same lists. Currently scoped to web routing only.', cat: 'qol' },
      { title: '<span class="mono">seekdeepLegacyArchiveUserThreadName</span> migration', desc: 'Needs a one-time migration tool to rename pre-v10 archive threads. Backwards-compat shim is intentional.', cat: 'qol' },
    ]
  },
  {
    id: 'wont',
    title: "Won't do",
    status: 'wont',
    meta: '3 items',
    note: 'Explicit non-goals — features from demonbot we skipped, and refactors that no longer pay off.',
    items: [
      { title: 'Quote Cards (from demonbot)', desc: 'Explicitly skipped during the v10.3 demonbot-inspired feature pass.', cat: 'features' },
      { title: 'Game Lookup (from demonbot)', desc: 'Explicitly skipped during the v10.3 demonbot-inspired feature pass.', cat: 'features' },
      { title: 'Further <span class="mono">messageCreate</span> handler extraction', desc: 'Remaining 112 lines in the handler ARE orchestration. Splitting further would just trade clarity for indirection.', cat: 'qol' },
    ]
  },
];

// ===========================================================
// STATS
// ===========================================================
const stats = { shipped: 0, flight: 0, parked: 0, wont: 0, total: 0 };
PHASES.forEach(p => {
  stats[p.status] += p.items.length;
  stats.total += p.items.length;
});
const statBar = document.getElementById('statBar');
statBar.innerHTML = `
  <div class="stat-tile shipped"><div class="lbl">SHIPPED</div><div class="val">${stats.shipped}</div><div class="delta">through v10.38 wave</div></div>
  <div class="stat-tile flight"><div class="lbl">IN FLIGHT</div><div class="val">${stats.flight}</div><div class="delta">scaffolded · awaiting</div></div>
  <div class="stat-tile parked"><div class="lbl">PARKED</div><div class="val">${stats.parked}</div><div class="delta">scoped · deferred</div></div>
  <div class="stat-tile wont"><div class="lbl">WON'T DO</div><div class="val">${stats.wont}</div><div class="delta">non-goals</div></div>
  <div class="stat-tile total"><div class="lbl">ROADMAP TOTAL</div><div class="val">${stats.total}</div><div class="delta">PLANNED.md items</div></div>
`;

// ===========================================================
// RENDER PHASES
// ===========================================================
const phasesEl = document.getElementById('phases');
const statusLabels = { shipped: 'SHIPPED', flight: 'IN FLIGHT', parked: 'PARKED', wont: "WON'T DO" };

PHASES.forEach(phase => {
  const sec = document.createElement('section');
  sec.className = 'phase';
  sec.id = 'phase-' + phase.id;
  sec.dataset.status = phase.status;
  sec.innerHTML = `
    <div class="phase-head">
      <h2 class="${phase.status}"><span class="dot"></span>${phase.title}</h2>
      <span class="meta">▸ <em>${phase.items.length}</em> · ${phase.meta}</span>
    </div>
    ${phase.note ? `<p class="phase-note">${phase.note}</p>` : ''}
    <div class="item-grid"></div>
  `;
  const grid = sec.querySelector('.item-grid');
  phase.items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'item';
    card.dataset.status = phase.status;
    card.innerHTML = `
      <div class="item-head">
        <div class="item-title">${item.title}</div>
        <div class="item-badges">
          <span class="badge c-${item.cat}">${item.cat}</span>
          <span class="badge s-${phase.status}">${statusLabels[phase.status]}</span>
        </div>
      </div>
      <div class="item-desc">${item.desc}</div>
      ${item.version ? `<div class="item-version">▸ ${item.version}</div>` : ''}
    `;
    grid.appendChild(card);
  });
  phasesEl.appendChild(sec);
});

// ===========================================================
// FILTER
// ===========================================================
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const f = chip.dataset.filter;
    document.querySelectorAll('.phase').forEach(sec => {
      const status = sec.dataset.status;
      if (!status) { sec.style.display = (f === 'all') ? '' : 'none'; return; }
      sec.style.display = (f === 'all' || status === f) ? '' : 'none';
    });
    document.querySelectorAll('#phase-segmentation, #phase-memory').forEach(sec => {
      const status = sec.querySelector('.phase-head h2').className.replace(/[^a-z]/g, '');
      sec.style.display = (f === 'all' || status === f) ? '' : 'none';
    });
  });
});
