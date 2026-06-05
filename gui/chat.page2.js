  // Smart BASE — same-origin when served via /gui mount, else 127.0.0.1:7865.
  // Tauri 2 on Windows serves bundled pages from http://tauri.localhost, so
  // we must NOT use location.origin in that case (would point at the WebView
  // itself). nav.js stashes a shared resolver we prefer if loaded.
  const SEEKDEEP_BASE = (function () {
    if (typeof window === 'undefined') return 'http://127.0.0.1:7865';
    if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (window.__TAURI__ || (window.location.hostname || '') === 'tauri.localhost') {
      return 'http://127.0.0.1:7865';
    }
    const sameOrigin = window.location.protocol === 'http:' || window.location.protocol === 'https:';
    if (sameOrigin && window.location.host) return window.location.origin;
    return 'http://127.0.0.1:7865';
  })();

  // ===== LIVE PROBE — /health every 5s =====
  // Three-state machine: PROBING (initial / transient failures) → LIVE
  // (any successful probe) → OFFLINE (3+ consecutive failures). There is
  // NO mock mode — the page either shows real data or admits it can't
  // reach the server. "MOCK" was a legacy label from a demo-mode chat
  // path that no longer exists; saying it now misled users into thinking
  // their real /chat errors were synthetic.
  //
  // Timeout is 6s, not 2s, because /health calls ollama_available()
  // (up to OLLAMA_PROBE_TIMEOUT_SECS, default 2s) + iterates every chat
  // role to resolve backends. 2s was an aggressive ceiling that flipped
  // the page to "MOCK" on every cold start.
  const cLIVE = {
    timer: null,
    failures: 0,
    isLive: false,
    everSucceeded: false,
    async probe() {
      const t0 = performance.now();
      try {
        const r = await fetch(SEEKDEEP_BASE + '/health', { signal: AbortSignal.timeout(6000), cache: 'no-store' });
        if (!r.ok) throw new Error('http ' + r.status);
        const h = await r.json();
        const ms = Math.round(performance.now() - t0);
        this.failures = 0;
        this.everSucceeded = true;
        if (!this.isLive) this.setMode('live');
        this.apply(h, ms);
      } catch {
        this.failures++;
        // Stay in PROBING for the first 2 failures; only flip to OFFLINE
        // after 3+ consecutive misses or if we've never seen success and
        // 5+ tries failed (~25s of trying).
        if (this.isLive && this.failures >= 3) this.setMode('offline');
        else if (!this.everSucceeded && this.failures >= 5) this.setMode('offline');
      }
    },
    setMode(mode) {
      const wasLive = this.isLive;
      this.isLive = (mode === 'live');
      const st = document.getElementById('cBotStatus');
      const pp = document.getElementById('playgroundPill');
      const hr = document.getElementById('helperRoute');
      if (mode === 'live') {
        if (st) st.textContent = '● healthy · live';
        if (pp) { pp.innerHTML = '<span class="dot"></span>PLAYGROUND · LIVE'; pp.classList.add('cyan'); }
        // Kick refreshRoute now so the helper-row badge doesn't sit at
        // "PROBING …" for up to 8s while the periodic interval ticks over.
        if (!wasLive && typeof refreshRoute === 'function') {
          setTimeout(refreshRoute, 0);
        }
      } else if (mode === 'offline') {
        if (st) st.textContent = '● offline · server unreachable';
        if (pp) { pp.innerHTML = '<span class="dot"></span>PLAYGROUND · OFFLINE'; pp.classList.remove('cyan'); }
        if (hr) hr.textContent = 'OFFLINE · /health unreachable';
      }
    },
    apply(h, ms) {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('cBotLatency', ms + 'ms');
      // /health returns models: { chat, vision, image }; prefer the loaded
      // chat role label, fall back to the configured chat model id, then
      // legacy h.model field for older servers.
      const modelLabel = h.loaded_chat_model_id || (h.models && h.models.chat) || h.model;
      if (modelLabel) set('cBotModel', String(modelLabel).split('/').pop());
      const g = h.gpu || {};
      // Lift the diagnostic out of the bare "cpu · no gpu" string. Three
      // failure shapes the user actually hits:
      //   a) nvidia-smi detected GPU, torch CAN'T see it -> wheel/arch
      //      mismatch (cu121 wheel + Blackwell RTX 50-series is the
      //      current poster-child). Tell the user what wheel is loaded
      //      so they can match it against their card.
      //   b) torch isn't installed yet (pre-ML-deps state) -> tell them
      //      to click Install ML libraries.
      //   c) no GPU at all -> "cpu only" is honest.
      // Also drop a tooltip on the cell so hovering surfaces the link
      // to the Installer's GPU row which has the long-form fix.
      const cell = document.getElementById('cBotVram');
      function setVramCell(text, title) {
        if (!cell) return;
        cell.textContent = text;
        cell.style.cursor = '';
        cell.style.color = '';
        cell.onclick = null;
        if (title) cell.setAttribute('title', title);
        else cell.removeAttribute('title');
      }
      // When torch can't see the GPU because of a wheel/arch mismatch,
      // the fix is one pip command — and we have a Tauri command that
      // runs it for the user (kill sidecar -> pip uninstall + install
      // with cu124 index URL -> respawn). Attach that to the cell so
      // clicking "wrong wheel · RTX 5090" actually fixes it.
      function setVramCellClickableFix(text, title, gpuName, suggestedVariant) {
        if (!cell) return;
        cell.textContent = text + ' · click to fix';
        cell.title = title;
        cell.style.cursor = 'pointer';
        cell.style.color = 'var(--warn, #ffb84d)';
        cell.onclick = () => runTorchReinstallFlow(gpuName, suggestedVariant);
      }
      if (g.used_mb != null && g.total_mb != null) {
        setVramCell(`${(g.used_mb/1024).toFixed(1)} / ${(g.total_mb/1024).toFixed(0)} GB`);
      } else if (g.available === false) {
        const nv = g.nvidia_smi || {};
        if (nv.detected) {
          const gpuName = nv.name || 'NVIDIA GPU';
          // gpu_stats() now ships torch_cuda_built so we can tell the
          // four distinct failure modes apart instead of always blaming
          // the wheel. Saves users from a 2 GB re-download when the
          // real fix is "update your driver" or "this is a different
          // server than your .venv was".
          const builtArch = g.torch_cuda_built;   // e.g. "12.8" or null
          const torchVer  = g.torch_version || 'torch';
          if (g.torch_present === false) {
            setVramCell('no torch · ' + gpuName,
              `${gpuName} detected by driver but PyTorch isn't installed. Open the Installer or click Install ML libraries in Control Center.`);
          } else if (!builtArch) {
            // Wheel is CPU-only (no torch.version.cuda). Reinstall fixes it.
            setVramCellClickableFix(
              `cpu wheel · ${gpuName}`,
              `${gpuName} detected by driver, but the loaded torch (${torchVer}) is the CPU-only wheel. Click to reinstall with cu124 (~2 GB).`,
              gpuName, 'cu124');
          } else {
            // Wheel HAS a CUDA build (cu121 / cu124 / cu128 / etc.) but
            // torch.cuda.is_available() is still false. Three subcases:
            //   a) wheel too old for the GPU (cu121 + Blackwell)
            //   b) wheel newer than the driver (cu128 + an old driver)
            //   c) something else (DLLs missing, MIG mode, etc.)
            const looksBlackwell = /\bRTX\s*5\d{3}\b/i.test(gpuName);
            const major = Number(String(builtArch).split('.')[0]);
            const minor = Number(String(builtArch).split('.')[1] || 0);
            const cu = `cu${(major||12)*10 + (minor||0)}`;  // "12.8" -> "cu128"
            // Heuristic: if cu121 + Blackwell → wheel is too old (reinstall helps).
            // If wheel is already cu124+ → driver is more likely culprit.
            if (looksBlackwell && cu === 'cu121') {
              setVramCellClickableFix(
                `wrong wheel · ${gpuName}`,
                `${gpuName} (Blackwell) detected, but the loaded torch wheel is cu121 — cu121 doesn't support sm_120. Click to reinstall with cu124 (~2 GB).`,
                gpuName, 'cu124');
            } else {
              setVramCell(`driver mismatch · ${cu} loaded`,
                `${gpuName} detected by driver, torch ${torchVer} (${cu}) loaded, but torch.cuda.is_available()=False. The wheel IS CUDA-capable — most likely cause is a driver too old for ${cu}, or this AI server is running on a different Python than your .venv. Verify with: .venv\\Scripts\\python -c "import torch; print(torch.cuda.is_available())"`);
            }
          }
        } else {
          setVramCell('cpu only · no gpu',
            'No NVIDIA GPU detected by driver. Inference will run on CPU (slow). If you DO have a GPU, check that the driver is installed and nvidia-smi works in a shell.');
        }
      } else {
        setVramCell('—');
      }
      if (h.queue_depth != null) set('cBotQueue', String(h.queue_depth));
      else if (h.queue != null) set('cBotQueue', String(h.queue));
      else set('cBotQueue', '0');
    },
    start() { this.probe(); this.timer = setInterval(() => this.probe(), 5000); },
  };
  cLIVE.start();

  // ===== Torch reinstall flow — wired to the "wrong wheel" cell click =====
  // Two paths:
  //   Tauri context  -> invoke install_torch_variant (kills sidecar,
  //                     pip uninstall+install with cu124 index, respawns)
  //   Browser/.bat   -> show a copy-paste modal with the exact pip command
  //                     (we can't kill the .bat-launched .venv server from
  //                     here without bouncing the shell)
  async function runTorchReinstallFlow(gpuName, variant) {
    const sdn = window.SeekDeepNotify;
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
        + `Chat will be unavailable during the reinstall.`
      );
      if (!ok) return;
      sdn?.toast?.({ tone: 'warn', title: 'Torch reinstall starting', body: `Pulling ${variant} wheels for ${gpuName}…`, ttl: 6000 });
      try {
        const out = await window.__TAURI__.core.invoke('install_torch_variant', { variant });
        sdn?.toast?.({ tone: 'good', title: 'Torch reinstalled', body: `Sidecar restarting with ${variant} wheels. Refresh in ~10s if VRAM still shows CPU.`, ttl: 8000 });
        console.log('[SeekDeep torch reinstall] pip output:\n' + (out || ''));
      } catch (err) {
        sdn?.toast?.({ tone: 'bad', title: 'Torch reinstall failed', body: String(err).slice(0, 300), ttl: 10000 });
        console.error('[SeekDeep torch reinstall] failed:', err);
      }
      return;
    }
    // Non-Tauri fallback: show a modal with the exact command + copy button.
    // We can't kill the .bat-launched server from a browser, so the user
    // has to do this in the same shell their .bat is running.
    const cmd = `pip uninstall -y torch torchvision torchaudio\npip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/${variant}`;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:grid;place-items:center;';
    modal.innerHTML = `
      <div style="background:var(--substrate-2);border:1px solid var(--stroke);border-radius:var(--r-md);padding:24px;max-width:640px;color:var(--hull-2);font-family:var(--font-mono);">
        <h3 style="margin:0 0 8px 0;color:var(--cyan-1);">Torch reinstall · ${gpuName}</h3>
        <p style="color:var(--hull-3);font-size:13px;margin-bottom:12px;line-height:1.5;">
          Browser mode can't bounce the .bat-launched AI server. Stop the server
          (Ctrl+C in its PowerShell window), run these in the activated .venv,
          then restart with <code>seekdeep_launcher.bat</code> option 4.
        </p>
        <pre style="background:#000;border:1px solid var(--stroke);border-radius:var(--r-sm);padding:12px;color:var(--cyan-1);font-size:12px;overflow:auto;user-select:all;">${cmd}</pre>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button id="torchCopyBtn" style="background:var(--cyan-2);color:#000;border:0;padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Copy</button>
          <button id="torchCloseBtn" style="background:transparent;color:var(--hull-2);border:1px solid var(--stroke);padding:8px 14px;border-radius:var(--r-sm);cursor:pointer;font-family:var(--font-mono);">Close</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#torchCopyBtn').onclick = async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        sdn?.toast?.({ tone: 'good', title: 'Copied', body: 'Paste into the AI server PowerShell window.', ttl: 4000 });
      } catch {
        // Fallback: select-all on the <pre> already; user can Ctrl+C
      }
    };
    modal.querySelector('#torchCloseBtn').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  }

  // ===== /route/debug helper-row badge =====
  async function refreshRoute() {
    if (!cLIVE.isLive) return;
    const hr = document.getElementById('helperRoute');
    if (!hr) return;
    try {
      const r = await fetch(SEEKDEEP_BASE + '/route/debug?role=default_chat', {
        signal: AbortSignal.timeout(2000), cache: 'no-store'
      });
      if (!r.ok) throw 0;
      const d = await r.json();
      const backend = (d.backend || 'local').toLowerCase();
      const model = (d.model_id || d.model || 'default_chat').toString().split('/').pop();
      const web = d.web_mode || d.web || 'auto';
      hr.textContent = `${backend.toUpperCase()} ROUTED · ${model} · web ${web}`;
    } catch { /* keep last good label */ }
  }
  // Live-event path: backend emits route.changed on /config + /persona
  // writes, and a periodic health.tick for keep-alive. Subscribe to both;
  // each one re-pulls /route/debug. Falls back to a 30s safety poll so a
  // dropped WS still keeps the badge fresh.
  if (window.SeekDeepEvents && typeof window.SeekDeepEvents.on === 'function') {
    window.SeekDeepEvents.on('route.changed', () => refreshRoute());
    window.SeekDeepEvents.on('_open',         () => refreshRoute());
    setInterval(refreshRoute, 30000);
  } else {
    setInterval(refreshRoute, 8000);
  }
  setTimeout(refreshRoute, 800);

  // ===== Auto-grow textarea =====
  (function autoGrow() {
    const ta = document.getElementById('msgInput');
    if (!ta) return;
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
    };
    ta.addEventListener('input', grow);
    setTimeout(grow, 0);
  })();

  // ===== Slash-hint menu =====
  (function slashMenu() {
    const input = document.getElementById('msgInput');
    const menu = document.getElementById('slashMenu');
    if (!input || !menu) return;
    const update = () => {
      const v = input.value;
      if (v.startsWith('/') && !v.includes('\n')) menu.classList.add('open');
      else menu.classList.remove('open');
    };
    input.addEventListener('input', update);
    input.addEventListener('blur', () => setTimeout(() => menu.classList.remove('open'), 150));
    // Also collapse on Escape so users have a non-mouse exit, and on
    // submit (Enter without Shift) so the menu doesn't hang open over
    // the conversation while playground.js dispatches.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') menu.classList.remove('open');
      if (e.key === 'Enter' && !e.shiftKey) menu.classList.remove('open');
    });
    // Clicking a slash-item drops the leading "/" + command into the
    // input and closes the menu, so users can discover commands by clicking
    // (was: menu was a static help card — clicking did nothing).
    menu.querySelectorAll('.slash-item').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();  // don't blur the input before we update it
        const cmd = item.querySelector('.cmd')?.textContent?.trim();
        if (cmd) {
          input.value = cmd + ' ';
          input.focus();
          try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
        }
        menu.classList.remove('open');
      });
    });
  })();

  // ===== Close persona popover on send too =====
  // The persona popover (#personaPop) opens on personaBtn click and closes
  // only on outside-click or option-select. Pressing Enter to send a chat
  // message didn't close it, so it would hang open over the conversation.
  // Listen for the send-related events on msgInput.
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('msgInput');
    const pop = document.getElementById('personaPop');
    if (!input || !pop) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) pop.classList.remove('open');
    });
    document.querySelector('.composer .send-btn')?.addEventListener('click', () => pop.classList.remove('open'));
  }, { once: true });

  // ===== Paperclip → file picker → forward to playground.js's drop handler =====
  (function attachWiring() {
    const btn = document.getElementById('attachBtn');
    const picker = document.getElementById('filePicker');
    if (!btn || !picker) return;
    btn.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      const f = picker.files && picker.files[0];
      if (!f) return;
      try {
        const dt = new DataTransfer();
        dt.items.add(f);
        const evt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        document.dispatchEvent(evt);
      } catch (err) {
        console.warn('[SeekDeep] could not forward file via drop event:', err);
      }
      picker.value = '';
    });
  })();

  // ===== Persona pill — GET /persona on load, popover on click, POST on choose =====
  const Persona = {
    valid: ['neurotic', 'unsettling', 'clinical', 'chaotic'],
    fallback: 'neurotic',
    current: null,
    setUI(name) {
      this.current = name;
      const display = (name || this.fallback).toUpperCase();
      const lbl = document.getElementById('personaLabel');
      if (lbl) lbl.textContent = display;
      const bl = document.getElementById('bot-persona');
      if (bl) bl.textContent = (name || this.fallback);
      document.querySelectorAll('#personaPop .opt').forEach(o => {
        o.classList.toggle('active', o.dataset.persona === (name || this.fallback));
      });
      // Let Tweaks panel mirror the change.
      window.dispatchEvent(new CustomEvent('seekdeep:persona-changed', {
        detail: { persona: name || this.fallback },
      }));
    },
    async load() {
      try {
        const r = await fetch(SEEKDEEP_BASE + '/persona', {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) throw new Error('http ' + r.status);
        const d = await r.json();
        if (Array.isArray(d.valid_personas) && d.valid_personas.length) {
          this.valid = d.valid_personas.slice();
          // Append rows for any custom personas /persona returned that
          // aren't already in the static popover markup. Server returns
          // both built-ins (which already have rows) AND user-defined
          // slugs from data/custom-personas.json. Without this, custom
          // personas show up in `valid_personas` but the user can't
          // click them in the popover.
          const pop = document.getElementById('personaPop');
          if (pop) {
            const existing = new Set([...pop.querySelectorAll('.opt[data-persona]')].map(el => el.dataset.persona));
            const sep = pop.querySelector('.sep');
            for (const slug of this.valid) {
              if (existing.has(slug)) continue;
              const row = document.createElement('div');
              row.className = 'opt';
              row.setAttribute('data-persona', slug);
              row.setAttribute('role', 'menuitem');
              const label = document.createElement('span');
              label.textContent = slug.charAt(0).toUpperCase() + slug.slice(1);
              const meta = document.createElement('span');
              meta.className = 'meta';
              meta.textContent = 'custom';
              row.appendChild(label); row.appendChild(meta);
              row.addEventListener('click', (e) => {
                e.stopPropagation();
                this.choose(slug);
                pop.classList.remove('open');
              });
              // Insert before the .sep so "Clear override" stays at bottom
              if (sep && sep.parentNode === pop) pop.insertBefore(row, sep);
              else pop.appendChild(row);
            }
          }
        }
        if (d.env_default) this.fallback = String(d.env_default);
        this.setUI(d.effective_global || d.global || this.fallback);
      } catch {
        // /persona unreachable (server offline / restarting). Keep a sane
        // placeholder so the pill doesn't render empty.
        this.setUI('clinical');
      }
    },
    async post(body) {
      try {
        const r = await fetch(SEEKDEEP_BASE + '/persona', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          console.warn('[SeekDeep] /persona POST failed:', r.status);
          return null;
        }
        return await r.json();
      } catch (err) {
        console.warn('[SeekDeep] /persona POST error:', err);
        return null;
      }
    },
    async choose(name) {
      if (!this.valid.includes(name)) return;
      this.setUI(name);  // optimistic
      const r = await this.post({ scope: 'global', persona: name });
      if (r && r.persona) this.setUI(r.persona);
    },
    async clear() {
      await this.post({ scope: 'global', action: 'reset' });
      // After reset, re-fetch effective so we show whatever env / Discord override is in play.
      await this.load();
    },
  };
  window.Persona = Persona;
  Persona.load();

  // popover wiring
  (function personaPop() {
    const btn = document.getElementById('personaBtn');
    const pop = document.getElementById('personaPop');
    const clear = document.getElementById('personaClear');
    if (!btn || !pop) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!pop.classList.contains('open')) return;
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      pop.classList.remove('open');
    });
    pop.querySelectorAll('.opt').forEach(opt => {
      opt.addEventListener('click', () => {
        Persona.choose(opt.dataset.persona);
        pop.classList.remove('open');
      });
    });
    if (clear) clear.addEventListener('click', () => {
      Persona.clear();
      pop.classList.remove('open');
    });
  })();

  // Hide empty-state placard once playground.js paints a real message.
  (function hideEmptyOnFirstMessage() {
    const messages = document.getElementById('messages');
    const empty = document.getElementById('messagesEmpty');
    if (!messages || !empty) return;
    const mo = new MutationObserver(() => {
      if (messages.querySelector('.msg')) empty.style.display = 'none';
    });
    mo.observe(messages, { childList: true });
  })();
