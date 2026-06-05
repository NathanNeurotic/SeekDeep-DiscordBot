(function () {
  const $ = (s) => document.querySelector(s);
  const BASE = (function () {
    if (typeof window === 'undefined') return 'http://127.0.0.1:7865';
    if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase();
    if (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    return (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
  })();

  const stepListEl = $('#stepList');
  const progBar    = $('#progBar');
  const logEl      = $('#installLog');
  const statusEl   = $('#ftStatus');
  const openBtn    = $('#ftOpenApp');
  const skipAllBtn = $('#ftSkipAll');
  let lastChecks = [];

  function appendLog(text, cls) {
    if (!logEl) return;
    logEl.classList.add('active');
    const line = document.createElement('div');
    line.className = 'line' + (cls ? ' ' + cls : '');
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStepClass(li, cls) {
    li.classList.remove('done', 'busy', 'bad', 'skip');
    if (cls) li.classList.add(cls);
  }

  function renderSteps(checks) {
    stepListEl.innerHTML = '';
    const failing = checks.filter(c => !c.ok);
    const passed  = checks.filter(c => c.ok).length;
    progBar.style.width = Math.round((passed / Math.max(checks.length, 1)) * 100) + '%';

    if (!failing.length) {
      statusEl.textContent = 'All set · everything is configured';
      openBtn.disabled = false;
      // Render passed steps for a feel-good summary
      checks.forEach(c => {
        const li = document.createElement('li');
        li.className = 'step done';
        li.innerHTML = `<span class="mark">✓</span><div><div class="label">${escapeHtml(c.label)}</div></div><div class="action"></div>`;
        stepListEl.appendChild(li);
      });
      return;
    }

    statusEl.textContent = failing.length + ' to set up · ' + passed + ' / ' + checks.length + ' ready';
    // Render only failing steps in order. Hide passed ones — the user
    // doesn't need to read what already works.
    checks.forEach(c => {
      const li = document.createElement('li');
      li.className = 'step ' + (c.ok ? 'done' : (c.blocking ? 'bad' : ''));
      const mark = c.ok ? '✓' : (c.blocking ? '✕' : '⚠');
      const detail = c.ok ? '' : (c.fix ? `<div class="detail">${escapeHtml(c.fix)}</div>` : '');
      // Three flavors of fix_action:
      //   prompt_for: render input(s), Save button POSTs /config etc
      //   navigate:   render a button that location.href's to a page
      //   plain:      render a button that POSTs the endpoint as-is
      const fa = c.fix_action;
      const hasPrompt   = fa && Array.isArray(fa.prompt_for) && fa.prompt_for.length;
      const hasNavigate = fa && typeof fa.navigate === 'string';
      const actionHtml = !c.ok && fa
        ? `<button class="primary" data-act="${hasNavigate ? 'navigate' : 'fix'}">${escapeHtml(fa.label || '▸ FIX')}</button>` +
          (c.blocking ? '' : `<button class="skip" data-act="skip">Skip</button>`)
        : (!c.ok ? `<button class="skip" data-act="skip">Skip</button>` : '');

      // Prompt rows: one per prompt_for entry, plus error slot.
      // The .prompt-err div is also reused by runFix() to show install /
      // fix failure reasons inline (so the user doesn't have to scroll
      // down to the log panel to learn WHY their pip install failed).
      let promptHtml = '';
      if (hasPrompt) {
        for (const p of fa.prompt_for) {
          promptHtml += `
            <div class="prompt-row" data-key="${escapeHtml(p.key)}">
              <span class="field-label">${escapeHtml(p.label || p.key)}</span>
              <input type="${p.secret ? 'password' : 'text'}"
                     placeholder="${escapeHtml(p.placeholder || '')}"
                     autocomplete="off" spellcheck="false" />
            </div>`;
        }
      }
      // Always emit an err slot so failure surfacing works on rows that
      // had no prompt_for (ml_deps, searxng, etc.).
      promptHtml += `<div class="prompt-err" style="display:none;"></div>`;

      li.innerHTML = `
        <span class="mark">${mark}</span>
        <div>
          <div class="label">${escapeHtml(c.label)}</div>
          ${detail}
        </div>
        <div class="action">${actionHtml}</div>
        ${promptHtml}`;
      const fixBtn  = li.querySelector('button[data-act="fix"]');
      const navBtn  = li.querySelector('button[data-act="navigate"]');
      const skipBtn = li.querySelector('button[data-act="skip"]');
      if (fixBtn)  fixBtn.addEventListener('click', () => runFix(li, c));
      if (navBtn)  navBtn.addEventListener('click', () => {
        sessionStorage.setItem('seekdeep:firstrun:wizard-skipped', '1');
        location.href = fa.navigate;
      });
      if (skipBtn) skipBtn.addEventListener('click', () => { setStepClass(li, 'skip'); li.querySelector('.mark').textContent = '–'; });
      stepListEl.appendChild(li);
    });
  }

  // Live progress for long-running fix-actions (pip installs, model
  // warmups, etc). Subscribes to deps.install.line / .complete / .failed
  // events from the AI server's WebSocket bus and streams a 'elapsed · N
  // lines · <last line>' indicator on the step row. Replaces the silent
  // 5-minute freeze users used to see between 'install started' and the
  // /system/firstrun re-probe.
  function runFixWithProgress(li, c, btn, origLabel, fa) {
    const startedAt = Date.now();
    let lineCount = 0;
    let lastLine  = '';
    let settled   = false;
    const progressLine = document.createElement('div');
    progressLine.style.fontFamily = 'var(--font-mono)';
    progressLine.style.fontSize   = '11px';
    progressLine.style.color      = 'var(--cyan-1)';
    progressLine.style.opacity    = '0.78';
    progressLine.style.marginTop  = '4px';
    progressLine.style.padding    = '4px 8px';
    progressLine.style.background = 'rgba(0, 200, 255, 0.04)';
    progressLine.style.border     = '1px solid rgba(0, 200, 255, 0.18)';
    progressLine.style.borderRadius = '3px';
    li.appendChild(progressLine);

    const esc = (s) => String(s || '').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
    const updateUI = () => {
      const sec = Math.round((Date.now() - startedAt) / 1000);
      const m = Math.floor(sec / 60), s = sec % 60;
      const elapsed = m > 0 ? `${m}m${String(s).padStart(2,'0')}s` : `${s}s`;
      const tail = lastLine.length > 80 ? '…' + lastLine.slice(-79) : lastLine;
      progressLine.innerHTML = `<span style="color: var(--good); margin-right: 6px;">⏳</span>`
        + `<strong style="color: var(--cyan-1);">${elapsed}</strong>`
        + ` · ${lineCount} log line${lineCount === 1 ? '' : 's'} · `
        + (tail ? `<span style="opacity:0.7;">${esc(tail)}</span>` : '<span style="opacity:0.5;">waiting for output…</span>');
      if (btn) btn.textContent = `… ${elapsed}`;
    };
    updateUI();
    const ticker = setInterval(updateUI, 1000);

    const offLine = window.SeekDeepEvents.on('deps.install.line', (data) => {
      lineCount += 1;
      if (data && typeof data.line === 'string') lastLine = data.line;
      updateUI();
    });

    const completeType = fa.watch_events.find(t => /\.complete$/.test(t)) || 'deps.install.complete';
    const failedType   = fa.watch_events.find(t => /\.failed$/.test(t))   || 'deps.install.failed';

    // Backup completion poll: every 30s re-query /system/firstrun and
    // check if THIS row's check has flipped to ok:true. Covers three
    // failure modes the event-bus path can't:
    //   (1) terminal event fired before our subscriber registered
    //       (microsecond race after POST returns)
    //   (2) WebSocket wasn't connected when user clicked the button
    //       so subscribers existed but no events were delivered
    //   (3) WS disconnect mid-install drops the terminal event entirely
    // The firstrun probe is authoritative — if the check goes green
    // there, the underlying fix succeeded regardless of event reception.
    const checkId = c.id;
    const firstrunPoll = setInterval(async () => {
      if (settled) { clearInterval(firstrunPoll); return; }
      try {
        const r = await fetch(BASE + '/system/firstrun', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const data = await r.json();
        const checks = (data && Array.isArray(data.checks)) ? data.checks : [];
        const match = checks.find(x => x && x.id === checkId);
        if (match && match.ok === true) {
          finish(true, 'fix complete (detected via /system/firstrun re-probe)');
        }
      } catch (_) { /* network blip; keep polling */ }
    }, 30_000);

    const finish = (ok, msg, payload) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      clearInterval(firstrunPoll);
      try { offLine(); } catch {}
      try { offComplete(); } catch {}
      try { offFailed(); } catch {}
      progressLine.remove();
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      if (ok) {
        appendLog(`✓ ${msg || 'install complete'} (${lineCount} log lines · ${elapsedSec}s)`, 'ok');
        setStepClass(li, 'done');
        li.querySelector('.mark').textContent = '✓';
        if (btn) { btn.textContent = '✓ DONE'; btn.style.background = 'var(--good)'; }
        setTimeout(probe, 1500);
      } else {
        appendLog(`✕ ${msg || 'install failed'} (after ${elapsedSec}s)`, 'err');
        // Surface server-supplied hint + tail of pip output. Without these
        // the user sees 'exit_code 1' and has no idea why. Backend
        // already classifies common Windows / Python pitfalls into a
        // hint string (see gui_endpoints.py post_deps_install).
        let hoverTip = '';
        if (payload && typeof payload === 'object') {
          if (payload.hint) { appendLog(`  → ${payload.hint}`, 'err'); hoverTip += payload.hint; }
          if (payload.cmd)  appendLog(`  $ ${payload.cmd}`);
          if (payload.detail) {
            const lines = String(payload.detail).split(/\r?\n/).filter(s => s.trim()).slice(-12);
            if (lines.length) {
              appendLog('  ─── last ' + lines.length + ' pip output line(s) ───');
              for (const ln of lines) appendLog('  ' + ln);
              // Last non-empty pip line goes in the tooltip too — gives
              // 'No matching distribution for torch' style context on hover
              // without making the user re-run to find out why.
              if (!hoverTip) hoverTip = lines[lines.length - 1].slice(0, 200);
            }
          }
        }
        setStepClass(li, 'bad');
        li.querySelector('.mark').textContent = '✕';
        if (btn) {
          btn.textContent = '✕ FAILED · retry';
          btn.style.background = 'var(--bad)';
          btn.disabled = false;
          if (hoverTip) btn.title = hoverTip + '\n\n(click retry, or scroll down for the full pip output)';
          btn.addEventListener('click', () => { btn.textContent = origLabel; btn.style.background = ''; btn.title = origLabel; runFix(li, c); }, { once: true });
        }
        // Surface the failure reason inline so the user doesn't have to
        // hunt for it in the log panel. Show hint first (already
        // human-friendly via gui_endpoints classifier), fall back to
        // raw error message + a pointer to the log.
        const inlineErr = li.querySelector('.prompt-err');
        if (inlineErr) {
          const reason = (payload && payload.hint) || msg || 'install failed';
          inlineErr.style.display = '';
          inlineErr.textContent = '✕ ' + reason + ' — see log below for full pip output.';
        }
      }
    };

    const offComplete = window.SeekDeepEvents.on(completeType, (data) => finish(true,  data?.note  || data?.detail, data));
    const offFailed   = window.SeekDeepEvents.on(failedType,   (data) => finish(false, data?.error || data?.exit_code ? `exit ${data.exit_code}` : 'install failed', data));

    // Hard timeout: 15 min covers the worst-case PyTorch download on a
    // slow connection. If no terminal event arrives by then, surface
    // 'install timed out — check Logs viewer' so the user isn't staring
    // at an indefinite spinner.
    setTimeout(() => finish(false, 'install timed out after 15 min — check Logs viewer for the pip output'), 15 * 60 * 1000);
  }

  async function runFix(li, c) {
    const fa = c.fix_action;
    if (!fa) return;
    const btn = li.querySelector('button[data-act="fix"]');
    const errEl = li.querySelector('.prompt-err');
    const origLabel = btn ? btn.textContent : 'FIX';
    // Clear any prior inline failure reason from a previous attempt so
    // the user sees a fresh slate on retry.
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    // Read prompt_for inputs (if any), validate, and merge into the
    // request body. body_template is the base shape; for /config the
    // server expects { updates: { KEY: value, ... } } so we deep-merge
    // into body_template.updates. For other endpoints we shallow-merge
    // at the top level.
    let body = null;
    if (fa.body) body = JSON.parse(JSON.stringify(fa.body));
    if (Array.isArray(fa.prompt_for) && fa.prompt_for.length) {
      body = fa.body_template ? JSON.parse(JSON.stringify(fa.body_template)) : (body || {});
      const errors = [];
      const collected = {};
      for (const p of fa.prompt_for) {
        const row = li.querySelector(`.prompt-row[data-key="${p.key}"] input`);
        const val = row ? row.value.trim() : '';
        if (!val) { errors.push(`${p.label || p.key} is required.`); continue; }
        if (p.validate_regex) {
          try {
            if (!new RegExp(p.validate_regex).test(val)) {
              errors.push(p.validate_error || `${p.label || p.key} format is invalid.`);
              continue;
            }
          } catch (re) { /* invalid server-supplied regex — skip */ }
        }
        collected[p.key] = val;
      }
      if (errors.length) {
        if (errEl) { errEl.style.display = ''; errEl.textContent = '✕ ' + errors.join(' '); }
        return;
      }
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      // For /config the updates go inside updates{}; otherwise shallow-merge.
      if (body && typeof body === 'object' && body.updates && typeof body.updates === 'object') {
        Object.assign(body.updates, collected);
      } else {
        body = Object.assign(body || {}, collected);
      }
    }

    if (btn) { btn.disabled = true; btn.textContent = '… running'; }
    setStepClass(li, 'busy');
    li.querySelector('.mark').textContent = '○';
    appendLog(`▸ ${fa.method || 'POST'} ${fa.endpoint} (${c.label})`);
    try {
      const init = { method: fa.method || 'POST', headers: { 'Content-Type': 'application/json' } };
      if (body) init.body = JSON.stringify(body);
      init.signal = AbortSignal.timeout(fa.long_running ? 600_000 : 60_000);
      const r = await fetch(BASE + fa.endpoint, init);
      const result = await r.json().catch(() => ({}));
      if (r.ok && result.ok !== false) {
        appendLog('✓ ' + (result.note || 'fix complete'), 'ok');
        // Long-running fix with watch_events: the POST returned 'install
        // started' instantly but the actual work (pip install ~2GB of
        // PyTorch wheels) takes 1-5 minutes. Without live progress the
        // user thinks the wizard froze. Subscribe to deps.install.line
        // events and stream a 'Xs · N log lines · <last line>' indicator
        // until the terminal event fires.
        if (Array.isArray(fa.watch_events) && fa.watch_events.length && window.SeekDeepEvents?.on) {
          runFixWithProgress(li, c, btn, origLabel, fa);
          return;
        }
        setStepClass(li, 'done');
        li.querySelector('.mark').textContent = '✓';
        if (btn) { btn.textContent = '✓ DONE'; btn.style.background = 'var(--good)'; }
        // Re-poll firstrun after a brief delay so neighboring checks
        // also update (e.g. fixing ml_deps may turn the chat_model
        // check green if the user already has an HF cache).
        setTimeout(probe, fa.long_running ? 5000 : 2500);
      } else {
        const err = result.error || result.detail || ('HTTP ' + r.status);
        appendLog('✕ ' + err, 'err');
        setStepClass(li, 'bad');
        li.querySelector('.mark').textContent = '✕';
        if (btn) {
          btn.textContent = '✕ FAILED · retry';
          btn.style.background = 'var(--bad)';
          btn.disabled = false;
          btn.title = String(err).slice(0, 240);
          btn.addEventListener('click', () => { btn.textContent = origLabel; btn.style.background = ''; btn.title = origLabel; runFix(li, c); }, { once: true });
        }
        const inlineErr = li.querySelector('.prompt-err');
        if (inlineErr) {
          inlineErr.style.display = '';
          inlineErr.textContent = '✕ ' + String(err).slice(0, 300);
        }
      }
    } catch (err) {
      appendLog('✕ ' + String(err.message || err), 'err');
      setStepClass(li, 'bad');
      li.querySelector('.mark').textContent = '✕';
      if (btn) {
        btn.textContent = '✕ ERROR · retry';
        btn.style.background = 'var(--bad)';
        btn.disabled = false;
        btn.title = String(err.message || err).slice(0, 240);
        btn.addEventListener('click', () => { btn.textContent = origLabel; btn.style.background = ''; btn.title = origLabel; runFix(li, c); }, { once: true });
      }
      const inlineErr = li.querySelector('.prompt-err');
      if (inlineErr) {
        inlineErr.style.display = '';
        inlineErr.textContent = '✕ ' + String(err.message || err).slice(0, 300);
      }
    }
  }

  async function probe() {
    try {
      const r = await fetch(BASE + '/system/firstrun', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        statusEl.textContent = 'server unreachable · open app to retry';
        openBtn.disabled = false;
        return;
      }
      const data = await r.json();
      lastChecks = Array.isArray(data.checks) ? data.checks : [];
      renderSteps(lastChecks);
      detectStaleServer(lastChecks);
    } catch (err) {
      statusEl.textContent = 'server unreachable · ' + (err.message || err);
      openBtn.disabled = false;
    }
  }

  // Stale-server detector. If checks come back WITHOUT fix_action on
  // anything where we expect it (ml_deps, searxng, discord_*), the
  // running server is older than this wizard's code. Show the
  // "Update SeekDeep" banner that hits /system/self-update.
  function detectStaleServer(checks) {
    const banner = document.getElementById('updateBanner');
    if (!banner) return;
    // If none of the checks have fix_action AND some are failing,
    // server is stale.
    const failing = checks.filter(c => !c.ok);
    const anyFixAction = checks.some(c => c.fix_action);
    if (failing.length && !anyFixAction) {
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  // Self-update click handler. Hits POST /system/self-update on the
  // running server which streams the latest files from GitHub raw and
  // writes them to its own working directory. After it returns we
  // tell the user to restart (their .bat launcher, or the system
  // tray's Restart-AI-server item — we can't restart it from here
  // without a Tauri command, and the bundle that lacks self-update
  // also lacks any new Tauri commands).
  document.getElementById('updateBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '… updating';
    appendLog('▸ POST /system/self-update');
    try {
      const r = await fetch(BASE + '/system/self-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main' }),
        signal: AbortSignal.timeout(180_000),
      });
      const result = await r.json().catch(() => ({}));
      if (r.ok && result.ok !== false) {
        const n = (result.downloaded || []).length;
        appendLog(`✓ updated ${n} file(s) from ${result.ref}`, 'ok');
        for (const f of (result.downloaded || []).slice(0, 12)) {
          appendLog(`  · ${f.path} (${f.bytes} bytes)`);
        }
        for (const err of (result.errors || []).slice(0, 6)) {
          appendLog(`  ✗ ${err}`, 'err');
        }
        btn.textContent = '✓ UPDATED · RESTART';
        btn.style.background = 'var(--good)';
        // Try to restart via Tauri command first (newer bundles
        // expose it). Falls back to telling the user.
        const tauri = window.__TAURI__;
        if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
          try {
            await tauri.core.invoke('restart_sidecar');
            appendLog('▸ Tauri sidecar restart requested · reload this page in ~10s', 'ok');
            setTimeout(() => location.reload(), 10_000);
            return;
          } catch (_) { /* fall through to manual restart */ }
        }
        appendLog('▸ Restart the AI server (Quick Actions → Reload .env) so the new code is in-memory.', 'ok');
      } else {
        // /system/self-update doesn't exist on the running server — it's
        // older than this wizard. We can't bootstrap the update from
        // here without writing files via the server. Surface the
        // honest path: either rebuild the .msi, or run the .bat
        // launcher (which uses live repo code).
        const errMsg = result.error || result.detail || ('HTTP ' + r.status);
        appendLog(`✕ self-update failed · ${errMsg}`, 'err');
        if (r.status === 404 || /Method Not Allowed|Not Found/i.test(errMsg)) {
          appendLog('  the running server doesn\'t have /system/self-update yet — it\'s older than this wizard. Workarounds:', 'err');
          appendLog('  1. quit Tauri, run seekdeep_launcher.bat option 4, relaunch Tauri (Tauri reuses the .bat server which has the latest code)', 'err');
          appendLog('  2. or rebuild the Tauri .msi: cargo tauri build (inside src-tauri/)', 'err');
        }
        btn.textContent = '✕ FAILED · see log';
        btn.style.background = 'var(--bad)';
        setTimeout(() => { btn.textContent = origLabel; btn.style.background = ''; btn.disabled = false; }, 6000);
      }
    } catch (err) {
      appendLog(`✕ network error · ${String(err.message || err)}`, 'err');
      btn.textContent = '✕ ERROR';
      btn.style.background = 'var(--bad)';
      setTimeout(() => { btn.textContent = origLabel; btn.style.background = ''; btn.disabled = false; }, 4000);
    }
  });

  openBtn.addEventListener('click', () => {
    sessionStorage.setItem('seekdeep:firstrun:wizard-completed', '1');
    location.href = 'app.html';
  });
  skipAllBtn.addEventListener('click', async () => {
    if (!await (window.SeekDeepConfirm || window.confirm)('Skip remaining setup and open SeekDeep?\nYou can return to the wizard later from Control Center.')) return;
    sessionStorage.setItem('seekdeep:firstrun:wizard-skipped', '1');
    location.href = 'app.html';
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  probe();
})();
