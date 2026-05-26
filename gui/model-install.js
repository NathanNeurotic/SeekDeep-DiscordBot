/* SeekDeep · model-install.js
   ===========================
   First-use HF / Ollama model downloader. Auto-loaded by nav.js's
   autoLoadSiblings AFTER notify.js (whose SeekDeepNotify banner/modal
   primitive this file consumes for the visible UX).

   Flow:
     1. On load, probe GET /models/installed (which itself depends on
        the ML libraries being present — if they aren't, ml-deps.js
        owns the banner and we stay silent).
     2. If all_local_present:false, show a banner naming the missing
        model_ids. Backend chips per row tell users where each weight
        is coming from (HuggingFace / Ollama / remote provider).
     3. When ollama_required && !ollama_available, banner copy flips
        warn-tone with a "Get Ollama ↗" button instead of Download.
     4. Click Download opens a modal that walks each missing model
        sequentially via POST /model/install. Per-row PENDING →
        DOWNLOADING → DONE / FAILED.
     5. Chat-role rows have a clickable backend chip → mini popover
        that lets user swap backend (HF ↔ Ollama) with model_id.
     6. WS subscription to model.install.* surfaces installs kicked
        off in other tabs.

   Self-gated via window.__seekdeepModelInstallLoaded.
*/
(function () {
  'use strict';
  if (window.__seekdeepModelInstallLoaded) return;
  window.__seekdeepModelInstallLoaded = true;

  const BASE = (function () {
    // Tauri 2 on Windows serves bundled pages from http://tauri.localhost.
    // Force 127.0.0.1:7865 when running inside Tauri; nav.js stashes a
    // shared resolver we prefer if available.
    if (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') {
      return window.SeekDeepResolveBase();
    }
    if (typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')) {
      return 'http://127.0.0.1:7865';
    }
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  })();

  function notify() { return window.SeekDeepNotify || null; }

  // --- DOM helpers ---------------------------------------------------------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v != null) node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function openExternal(url) {
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      tauri.core.invoke('open_external', { url }).catch(() => window.open(url, '_blank'));
    } else {
      window.open(url, '_blank');
    }
  }

  // --- Banner --------------------------------------------------------------

  const BANNER_ID = 'sd-model-install-banner';

  // Persistent dismiss survives reload. Keyed by missing-set hash so a new
  // missing model still surfaces a fresh banner.
  const DISMISS_KEY = 'sd-model-install-dismiss';
  function missingHash(state) {
    return ((state.missing || []).map((m) => m.role + ':' + m.model_id).sort().join('|'))
      + '#ollamaDown=' + (!!(state.ollama_required && !state.ollama_available));
  }
  function isDismissed(state) {
    try { return localStorage.getItem(DISMISS_KEY) === missingHash(state); }
    catch { return false; }
  }
  function markDismissed(state) {
    try { localStorage.setItem(DISMISS_KEY, missingHash(state)); } catch {}
  }

  function clearBanner() {
    const sdn = notify();
    if (sdn) sdn.dismiss(BANNER_ID);
  }

  function showBanner(state) {
    if (isDismissed(state)) return; // user said "stop nagging me about this set"
    const sdn = notify();
    if (!sdn) {
      console.warn('[SeekDeep model-install] notify.js not loaded; state:', state);
      return;
    }
    const missing = state.missing || [];
    const ollamaDown = state.ollama_required && !state.ollama_available;
    const hfMissing = missing.filter((m) => m.backend === 'hf');
    const ollamaMissing = missing.filter((m) => m.backend === 'ollama');

    // Friendly source list — flips between huggingface.co / Ollama daemon /
    // both, depending on which backends have missing weights.
    const backendSet = new Set(missing.map((m) => m.backend));
    const sources = (() => {
      if (backendSet.has('hf') && backendSet.has('ollama')) return 'huggingface.co + Ollama daemon';
      if (backendSet.has('hf')) return 'huggingface.co';
      if (backendSet.has('ollama')) return 'Ollama daemon';
      return 'multiple sources';
    })();
    const fmt = (m) => '<code>' + m.model_id.split('/').pop() + '</code> [' + m.backend + ']';
    const names = missing.map(fmt).slice(0, 3).join(', ');
    const more = missing.length > 3 ? (' +' + (missing.length - 3) + ' more') : '';

    const here = (location.pathname.split('/').pop() || '').toLowerCase();
    const wizardLink = here === 'add-model.html'
      ? ''
      : ' &nbsp;·&nbsp; <a href="add-model.html" style="color:inherit; text-decoration:underline;">Full wizard →</a>';

    let title, body, tone, primary;
    if (ollamaDown) {
      title = 'Ollama daemon not running';
      body = ollamaMissing.length + ' role' + (ollamaMissing.length === 1 ? '' : 's')
        + ' need the Ollama daemon. Install + start Ollama, then return here.'
        + wizardLink;
      tone = 'warn';
      primary = { label: 'Get Ollama ↗', onClick: ({ close }) => { openExternal(state.ollama_install_url || 'https://ollama.com/download'); } };
    } else {
      title = 'Models not downloaded';
      body = missing.length + ' role' + (missing.length === 1 ? '' : 's') + ' need weights from <em style="color:var(--hull); font-style:normal;">'
        + sources + '</em>: ' + names + more + wizardLink;
      tone = 'info';
      const canDownloadNow = hfMissing.length > 0 || (ollamaMissing.length > 0 && state.ollama_available);
      if (canDownloadNow) {
        primary = { label: 'Download', onClick: ({ close }) => { openInstallModal(state); /* leave banner up; modal owns the next step */ } };
      } else {
        primary = null;
      }
    }

    sdn.banner({
      id: BANNER_ID,
      tone,
      title,
      body,
      primary,
      secondary: { label: 'Dismiss', onClick: ({ close }) => { markDismissed(state); close(); } },
      dismissible: false,
      sticky: true,
    });
  }

  // --- Install modal -------------------------------------------------------

  let modalOpen = false;
  let rowEls = {}; // role -> { row, statusEl, dotEl }
  let modalEl = null;

  function setRowStatus(role, label, color) {
    const r = rowEls[role];
    if (!r) return;
    r.statusEl.textContent = label;
    r.statusEl.style.color = color;
    r.dotEl.style.background = color;
    r.dotEl.style.boxShadow = '0 0 6px ' + color;
  }

  function openInstallModal(state) {
    if (modalOpen) return;
    const sdn = notify();
    if (!sdn) {
      console.warn('[SeekDeep model-install] notify.js not loaded; cannot open modal.');
      return;
    }
    const missing = state.missing || [];
    const downloadable = (state.ollama_required && !state.ollama_available)
      ? missing.filter((m) => m.backend !== 'ollama')
      : missing;

    modalOpen = true;
    sdn.modal({
      tone: 'info',
      label: '◐ DOWNLOAD MODEL WEIGHTS',
      title: 'Downloading model weights',
      dismissible: true,
      render: (bodyEl) => {
        modalEl = bodyEl;
        const sub = document.createElement('div');
        sub.style.cssText = 'font-family: var(--font-mono, monospace); font-size: 11px; color: var(--hull-3, #7a8aa0); line-height: 1.5; margin-bottom: 12px;';
        sub.innerHTML = 'HuggingFace pulls from huggingface.co · Ollama pulls from your local daemon (registry.ollama.ai). Each model can take 5-15 minutes depending on size + connection. Safe to leave this running.';

        const list = document.createElement('div');
        list.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin-top: 4px;';

        rowEls = {};
        for (const m of downloadable) {
          const dot = document.createElement('span');
          dot.style.cssText = 'display:inline-block; width:10px; height:10px; border-radius:50%; background:#7a8aa0; flex-shrink:0;';

          const status = document.createElement('span');
          status.style.cssText = 'font-family: var(--font-mono, monospace); font-size: 10px; color: #7a8aa0; letter-spacing: 0.14em; text-transform: uppercase;';
          status.textContent = 'PENDING';

          // Backend chip — colored by source. Chat roles with HF/Ollama
          // backends are clickable: opens the swap mini-editor popover.
          const backendColors = {
            hf:               { bg: 'rgba(45, 212, 255, 0.15)', fg: 'var(--cyan-1, #2dd4ff)' },
            ollama:           { bg: 'rgba(89, 220, 132, 0.15)', fg: '#59dc84' },
            'openai-compat':  { bg: 'rgba(255, 184, 77, 0.15)', fg: 'var(--warn, #ffb84d)' },
            anthropic:        { bg: 'rgba(255, 184, 77, 0.15)', fg: 'var(--warn, #ffb84d)' },
            gemini:           { bg: 'rgba(255, 184, 77, 0.15)', fg: 'var(--warn, #ffb84d)' },
          };
          const bc = backendColors[m.backend] || { bg: 'rgba(122,138,160,0.15)', fg: '#7a8aa0' };
          const chatRoleMatch = m.role.match(/^chat\.(.+)$/);
          const canSwap = !!chatRoleMatch && (m.backend === 'hf' || m.backend === 'ollama');
          const chip = document.createElement('span');
          chip.dataset.sdBackendChip = canSwap ? 'swappable' : 'fixed';
          chip.style.cssText = 'font-family: var(--font-mono, monospace); font-size: 9.5px; padding: 2px 7px; background:' + bc.bg + '; color:' + bc.fg + '; border-radius: 3px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 600; margin-left: 8px; vertical-align: middle; cursor:' + (canSwap ? 'pointer' : 'default') + '; user-select: none;';
          chip.title = canSwap ? 'Click to change backend (HF ↔ Ollama)' : 'This role\'s backend is fixed';
          chip.textContent = (m.backend === 'hf' ? 'HuggingFace' : m.backend) + (canSwap ? ' ▾' : '');
          if (canSwap) {
            chip.addEventListener('click', (ev) => openSwapEditor(ev.target, m, chatRoleMatch[1]));
          }

          const titleRow = document.createElement('div');
          titleRow.style.cssText = 'font-family: var(--font-display, system-ui), system-ui, sans-serif; font-size: 13px; color: var(--hull, #e1eaf5); display: flex; align-items: center; flex-wrap: wrap;';
          const roleName = document.createElement('span');
          roleName.textContent = m.role;
          titleRow.appendChild(roleName);
          titleRow.appendChild(chip);

          const modelId = document.createElement('div');
          modelId.style.cssText = 'font-family: var(--font-mono, monospace); font-size: 11px; color: var(--hull-3, #7a8aa0); margin-top: 2px;';
          modelId.textContent = m.model_id;

          const meta = document.createElement('div');
          meta.appendChild(titleRow);
          meta.appendChild(modelId);

          const row = document.createElement('div');
          row.style.cssText = 'display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 10px 14px; background: rgba(2,6,15,0.6); border: 1px solid rgba(45,212,255,0.15); border-radius: 6px;';
          row.appendChild(dot);
          row.appendChild(meta);
          row.appendChild(status);

          rowEls[m.role] = { row, statusEl: status, dotEl: dot };
          list.appendChild(row);
        }

        bodyEl.appendChild(sub);
        bodyEl.appendChild(list);
      },
      primary: { label: 'Close', onClick: () => { /* falls through to close */ } },
    }).then(() => {
      // Modal closed — drop refs, close any orphaned swap popover.
      modalOpen = false;
      rowEls = {};
      modalEl = null;
      closeSwapPopover();
    });

    // Subscribe to cross-tab events so installs kicked off elsewhere drive
    // these rows too. Retried after 1s for fresh-page WS hookup race.
    subscribeToInstallEvents();
    setTimeout(subscribeToInstallEvents, 1000);

    runSequentialDownloads(downloadable);
  }

  // --- Sequential downloader ----------------------------------------------

  async function downloadOne(m) {
    setRowStatus(m.role, 'DOWNLOADING…', 'var(--warn, #ffb84d)');
    try {
      const r = await fetch(BASE + '/model/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: m.model_id, backend: m.backend, auto_pull: true }),
      });
      let data = null;
      try { data = await r.json(); } catch {}
      if (!r.ok || !data || !data.ok) {
        const note = (data && (data.note || data.error)) ? (data.note || data.error) : ('HTTP ' + r.status);
        setRowStatus(m.role, 'FAILED · ' + String(note).slice(0, 60), 'var(--bad, #ff6b6b)');
        const row = rowEls[m.role];
        if (row && row.statusEl) row.statusEl.title = (data && (data.note || data.error)) || ('HTTP ' + r.status);
        return false;
      }
      setRowStatus(m.role, 'DONE', 'var(--good, #6df0ff)');
      return true;
    } catch (err) {
      setRowStatus(m.role, 'NETWORK ERROR', 'var(--bad, #ff6b6b)');
      return false;
    }
  }

  async function runSequentialDownloads(missing) {
    // Sequential not parallel — concurrent HF cache writes on the same host
    // churn disk + waste bandwidth.
    for (const m of missing) {
      await downloadOne(m);
    }
  }

  // --- Swap mini-editor popover -------------------------------------------
  // Inline popover next to a clicked backend chip; lets user flip a chat
  // role between HF and Ollama. Remote backends (openai-compat / anthropic
  // / gemini) need the full add-model.html wizard (API URL + key inputs).

  let swapPopover = null;

  function closeSwapPopover() {
    if (swapPopover) { swapPopover.remove(); swapPopover = null; }
    document.removeEventListener('click', onDocClickToClose, true);
  }

  function onDocClickToClose(ev) {
    if (swapPopover && !swapPopover.contains(ev.target)) {
      const isChip = ev.target.closest && ev.target.closest('[data-sd-backend-chip]');
      if (!isChip) closeSwapPopover();
    }
  }

  function openSwapEditor(anchor, modelRow, roleNoPrefix) {
    closeSwapPopover();
    const rect = anchor.getBoundingClientRect();
    swapPopover = el('div', {
      style: {
        position: 'fixed',
        top: (rect.bottom + 6) + 'px',
        left: rect.left + 'px',
        zIndex: '10000',
        width: '320px',
        background: 'var(--ink, #050b1a)',
        border: '1px solid rgba(45, 212, 255, 0.4)',
        borderRadius: '8px',
        padding: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: '11px',
        color: 'var(--hull, #e1eaf5)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
    });
    swapPopover.appendChild(el('div', {
      style: { fontSize: '10px', letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--hull-3, #7a8aa0)' },
    }, 'Change backend · ' + modelRow.role));

    const backendSel = el('select', {
      style: {
        background: 'rgba(2,6,15,0.6)',
        color: 'var(--hull, #e1eaf5)',
        border: '1px solid rgba(45,212,255,0.25)',
        borderRadius: '4px',
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: '11px',
      },
    },
      el('option', { value: 'hf', selected: modelRow.backend === 'hf' ? 'selected' : null }, 'HuggingFace (hf)'),
      el('option', { value: 'ollama', selected: modelRow.backend === 'ollama' ? 'selected' : null }, 'Ollama (local daemon)'),
    );

    const modelInput = el('input', {
      type: 'text',
      value: modelRow.model_id || '',
      placeholder: 'e.g. Qwen/Qwen2.5-7B-Instruct or llama3.1:8b',
      style: {
        background: 'rgba(2,6,15,0.6)',
        color: 'var(--hull, #e1eaf5)',
        border: '1px solid rgba(45,212,255,0.25)',
        borderRadius: '4px',
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: '11px',
      },
    });

    const hint = el('div', { style: { color: 'var(--hull-3, #7a8aa0)', lineHeight: '1.55' } },
      'HF: ',
      el('code', { style: { color: 'var(--cyan-1, #2dd4ff)' } }, 'owner/repo-name'),
      ' (huggingface.co)',
      el('br', null),
      'Ollama: ',
      el('code', { style: { color: '#59dc84' } }, 'name:tag'),
      ' (registry.ollama.ai)',
    );

    const saveStatus = el('div', { style: { fontSize: '10px', minHeight: '1.3em' } });

    const buttons = el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
      el('button', {
        style: {
          background: 'transparent',
          color: 'var(--hull-3, #7a8aa0)',
          border: '1px solid rgba(45,212,255,0.18)',
          padding: '6px 10px',
          borderRadius: '4px',
          fontFamily: 'inherit',
          fontSize: '10px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        },
        onclick: closeSwapPopover,
      }, 'Cancel'),
      el('button', {
        style: {
          background: 'var(--cyan-1, #2dd4ff)',
          color: 'var(--ink, #02060f)',
          border: 'none',
          padding: '6px 12px',
          borderRadius: '4px',
          fontFamily: 'inherit',
          fontSize: '10px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontWeight: '600',
          cursor: 'pointer',
        },
        onclick: async () => {
          const newBackend = backendSel.value;
          const newModelId = (modelInput.value || '').trim();
          if (!newModelId) {
            saveStatus.textContent = '⚠ model_id required';
            saveStatus.style.color = 'var(--bad, #ff6b6b)';
            return;
          }
          saveStatus.textContent = 'Saving + downloading…';
          saveStatus.style.color = 'var(--warn, #ffb84d)';
          try {
            const r = await fetch(BASE + '/model/install', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                backend: newBackend,
                model_id: newModelId,
                role: roleNoPrefix,
                auto_pull: true,
              }),
            });
            let data = null;
            try { data = await r.json(); } catch {}
            if (!r.ok || !data || !data.ok) {
              const note = (data && (data.note || data.error || data.detail)) || ('HTTP ' + r.status);
              saveStatus.textContent = '⚠ ' + String(note).slice(0, 80);
              saveStatus.style.color = 'var(--bad, #ff6b6b)';
              return;
            }
            saveStatus.textContent = '✓ Backend + model_id saved. Restart server to load.';
            saveStatus.style.color = 'var(--good, #6df0ff)';
            setTimeout(() => { closeSwapPopover(); probe(); }, 1500);
          } catch (err) {
            saveStatus.textContent = '⚠ ' + String(err);
            saveStatus.style.color = 'var(--bad, #ff6b6b)';
          }
        },
      }, 'Save'),
    );

    swapPopover.append(backendSel, modelInput, hint, saveStatus, buttons);
    document.body.appendChild(swapPopover);
    setTimeout(() => document.addEventListener('click', onDocClickToClose, true), 0);
  }

  // --- Cross-tab event subscription ---------------------------------------

  let installBusWired = false;
  function subscribeToInstallEvents() {
    const bus = window.SeekDeepEvents;
    if (!bus || installBusWired) return;
    installBusWired = true;

    function matchRow(data) {
      for (const role of Object.keys(rowEls)) {
        if (data.role && (data.role === role || data.role === role.replace(/^chat\./, ''))) return role;
      }
      return null;
    }

    bus.on('model.install.started', (data) => {
      const role = matchRow(data);
      if (role) setRowStatus(role, 'DOWNLOADING…', 'var(--warn, #ffb84d)');
    });
    bus.on('model.install.complete', (data) => {
      const role = matchRow(data);
      if (role) setRowStatus(role, 'DONE', 'var(--good, #6df0ff)');
    });
    bus.on('model.install.failed', (data) => {
      const role = matchRow(data);
      if (role) {
        const msg = (data && data.error) ? String(data.error).slice(0, 60) : 'FAILED';
        setRowStatus(role, 'FAILED · ' + msg, 'var(--bad, #ff6b6b)');
      }
    });
  }

  // --- Boot probe ----------------------------------------------------------

  async function probe() {
    try {
      const r = await fetch(BASE + '/models/installed', {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return;
      const data = await r.json();
      if (data.ml_deps_missing) return; // ml-deps.js owns this case

      const ollamaDown = data.ollama_required && !data.ollama_available;

      if (data.all_local_present && !ollamaDown) {
        clearBanner();
        return;
      }

      const hasWork = (Array.isArray(data.missing) && data.missing.length > 0) || ollamaDown;
      if (hasWork) {
        showBanner({
          missing: data.missing || [],
          ollama_required: !!data.ollama_required,
          ollama_available: !!data.ollama_available,
          ollama_install_url: data.ollama_install_url || 'https://ollama.com/download',
        });
      }
    } catch {
      // /models/installed unreachable — server probably not up yet.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', probe, { once: true });
  } else {
    probe();
  }
})();
