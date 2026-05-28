/* SeekDeep · long-task.js
   ========================
   Page-wide live progress banner for long-running async tasks. Subscribes
   to the WS event bus families that emit .started → N×.line → .complete /
   .failed, and renders a sticky notify.banner that updates in place with
   elapsed time + line count + last-line preview.

   Before this existed: user clicks "Install ML libraries", banner says
   "install started", then... silence. They wonder if it's frozen. The
   actual pip subprocess is streaming output via deps.install.line events
   on the bus — nothing was consuming them globally, only the wizard panel
   if the user happened to be on it.

   Now: every page (Control Center, Chat playground, Image playground,
   wherever) shows the same live banner. User clicks the chat playground's
   "INSTALL TOKENIZER DEPS" button, navigates to any other pane, the banner
   keeps showing "Installing ML libraries · 42s · 87 log lines · …
   downloading torch-2.11.0+cu128 (1.2 GB) …" right at the top.

   Auto-loaded as a sibling by nav.js. Self-gates against double-load.

   Event families consumed (extensible — add to TASK_DEFS):
     - deps.install         (pip install -r requirements-ml.txt)
     - doctor               (POST /system/doctor — preflight)
     - self-update          (POST /system/self-update — pull from main)
*/
(function () {
  'use strict';
  if (window.__seekdeepLongTaskLoaded) return;
  window.__seekdeepLongTaskLoaded = true;

  // Each task family: how to render the banner, the event-name prefix on
  // the bus. The runtime tracks per-prefix state independently so two
  // tasks can run concurrently (e.g. doctor while ml-deps install).
  const TASK_DEFS = [
    { prefix: 'deps.install', label: 'Installing ML libraries',
      hint: 'pip install -r requirements-ml.txt · streams to Logs Viewer too' },
    { prefix: 'doctor',       label: 'Running doctor',
      hint: 'preflight checks · Node/Python/Git/Docker/HF probes' },
    { prefix: 'self-update',  label: 'Self-updating from GitHub',
      hint: 'pulling latest local_ai_server.py + gui/ + scripts/ from main' },
  ];

  function notify() { return window.SeekDeepNotify || null; }

  // Per-prefix runtime: started_at, line_count, last_line, terminal_seen.
  const STATE = new Map();

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rem = s - m * 60;
    if (m < 60) return m + 'm ' + rem + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m - h * 60) + 'm';
  }

  function trimLine(s) {
    if (typeof s !== 'string') return '';
    // Strip ANSI escapes, control chars, surrounding whitespace.
    s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\r\n\t]+/g, ' ').trim();
    if (s.length > 140) s = s.slice(0, 137) + '…';
    return s;
  }

  function renderBanner(def, st) {
    const sdn = notify();
    if (!sdn) return;
    const id = 'sd-long-task-' + def.prefix;
    const elapsed = fmtElapsed(Date.now() - st.startedAt);
    const linesBit = st.lineCount > 0 ? ` · ${st.lineCount} log line${st.lineCount === 1 ? '' : 's'}` : '';
    const lastBit  = st.lastLine ? `<br><span style="opacity:0.75;font-family:var(--font-mono);font-size:11px;">…${st.lastLine.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</span>` : '';
    const hint     = st.terminal ? '' : `<br><span style="opacity:0.55;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;">${def.hint}</span>`;
    let tone = 'info', title = def.label, primary, secondary;
    if (st.terminal === 'complete') {
      tone = 'good'; title = '✓ ' + def.label + ' · complete';
      primary = { label: 'Dismiss', onClick: ({ close }) => close() };
    } else if (st.terminal === 'failed') {
      tone = 'bad';  title = '✕ ' + def.label + ' · failed';
      primary = { label: 'View logs', onClick: ({ close }) => {
        try { location.href = 'app.html#logs'; } catch {}
        close();
      }};
      secondary = { label: 'Dismiss', onClick: ({ close }) => close() };
    }
    sdn.banner({
      id, tone, title,
      body: `<span style="font-family:var(--font-mono);font-size:12px;">${elapsed}${linesBit}</span>${lastBit}${hint}`,
      primary, secondary,
      dismissible: !!st.terminal,
      sticky: !st.terminal,
    });
    // Auto-dismiss success banners after 8s so the page doesn't accumulate them.
    if (st.terminal === 'complete' && !st.autoDismissTimer) {
      st.autoDismissTimer = setTimeout(() => sdn.dismiss(id), 8000);
    }
  }

  function ensureState(prefix) {
    let st = STATE.get(prefix);
    if (!st) {
      st = { startedAt: Date.now(), lineCount: 0, lastLine: '', terminal: null, autoDismissTimer: null };
      STATE.set(prefix, st);
    }
    return st;
  }

  function bind() {
    if (!window.SeekDeepEvents?.on) {
      // events.js not loaded yet; retry shortly.
      setTimeout(bind, 250);
      return;
    }
    for (const def of TASK_DEFS) {
      // .started — kick off banner. Backend doesn't always emit a
      // started event (some endpoints jump straight to .line); for those
      // the first .line below auto-creates the state.
      window.SeekDeepEvents.on(def.prefix + '.started', (data) => {
        const st = ensureState(def.prefix);
        st.startedAt = Date.now();
        st.lineCount = 0;
        st.lastLine = trimLine((data && (data.note || data.cmd || data.variant)) || '');
        st.terminal = null;
        if (st.autoDismissTimer) { clearTimeout(st.autoDismissTimer); st.autoDismissTimer = null; }
        renderBanner(def, st);
      });
      // .line — append. Bump tick once a second so elapsed time advances
      // even when output is silent (e.g. torch download mid-chunk).
      window.SeekDeepEvents.on(def.prefix + '.line', (data) => {
        const st = ensureState(def.prefix);
        if (st.terminal) return;  // ignore stragglers after terminal event
        st.lineCount++;
        const line = trimLine((data && (data.line || data.text)) || '');
        if (line) st.lastLine = line;
        renderBanner(def, st);
      });
      // .complete — flash ✓, auto-dismiss in 8s.
      window.SeekDeepEvents.on(def.prefix + '.complete', (data) => {
        const st = ensureState(def.prefix);
        st.terminal = 'complete';
        const note = trimLine((data && (data.note || data.detail)) || '');
        if (note) st.lastLine = note;
        renderBanner(def, st);
      });
      // .failed / .error — flash ✕, keep until user dismisses.
      const failedHandler = (data) => {
        const st = ensureState(def.prefix);
        st.terminal = 'failed';
        const errLine = trimLine((data && (data.hint || data.error || data.detail
                              || (data.exit_code != null ? `exit ${data.exit_code}` : ''))) || '');
        if (errLine) st.lastLine = errLine;
        renderBanner(def, st);
      };
      window.SeekDeepEvents.on(def.prefix + '.failed', failedHandler);
      window.SeekDeepEvents.on(def.prefix + '.error',  failedHandler);
    }
    // Elapsed-time ticker: re-render any non-terminal banner once per second
    // so the "42s · …" counter advances even with no incoming lines.
    setInterval(() => {
      for (const def of TASK_DEFS) {
        const st = STATE.get(def.prefix);
        if (st && !st.terminal) renderBanner(def, st);
      }
    }, 1000);
  }
  bind();
})();
