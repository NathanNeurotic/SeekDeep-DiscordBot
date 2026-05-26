/* SeekDeep · model-install.js
   ===========================
   First-use HF model downloader. Auto-loaded by nav.js's autoLoadSiblings.

   Flow:
     1. On load, probe GET /models/installed (which itself depends on the
        ML libraries being present — if they aren't, ml-deps.js handles the
        banner and we stay silent).
     2. If `all_local_present: false`, show a topnav banner naming the
        missing roles + a "Download all" button.
     3. On click, open a modal that walks each missing model and POSTs
        /model/install sequentially. Per-model status flips from PENDING →
        DOWNLOADING (spinner) → DONE / FAILED.
     4. On all-done, the modal closes; the banner disappears once the next
        /models/installed probe returns all_local_present:true.

   POST /model/install is synchronous and blocks until snapshot_download
   completes (5-15 minutes per model for SDXL / 7B-class). We don't have
   per-byte progress events from huggingface_hub here, so we show "this
   takes minutes; safe to leave it running" copy and trust the user.

   Self-gates via window.__seekdeepModelInstallLoaded.
*/
(function () {
  'use strict';
  if (window.__seekdeepModelInstallLoaded) return;
  window.__seekdeepModelInstallLoaded = true;

  const BASE = (function () {
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  })();

  // --- DOM helpers (mirrored from ml-deps.js style) ------------------------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // --- Banner --------------------------------------------------------------

  function showBanner(state) {
    // state = { missing[], ollama_required, ollama_available, ollama_install_url }
    if (document.getElementById('sd-model-banner')) return;
    const offsetTop = document.getElementById('sd-ml-deps-banner') ? '50px' : '0';
    const banner = el('div', {
      id: 'sd-model-banner',
      style: {
        position: 'fixed',
        top: offsetTop,
        left: '0',
        right: '0',
        zIndex: '9989',
        padding: '10px 18px',
        background: 'rgba(45, 212, 255, 0.05)',
        borderBottom: '1px dashed rgba(45, 212, 255, 0.35)',
        color: '#2dd4ff',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: '12px',
        letterSpacing: '0.04em',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        backdropFilter: 'blur(6px)',
      },
    });

    const missing = state.missing || [];
    const ollamaDown = state.ollama_required && !state.ollama_available;

    // Split missing by backend so the user gets accurate copy. HF pulls from
    // huggingface.co; Ollama pulls from the user's local daemon (which must
    // be running). If daemon is down AND any role needs ollama, surface that
    // distinctly — clicking Download with no daemon would just fail.
    const hfMissing = missing.filter((m) => m.backend === 'hf');
    const ollamaMissing = missing.filter((m) => m.backend === 'ollama');

    // Show "<model_id> [backend]" so the user can see at a glance whether
    // each row comes from HF, Ollama, or a remote provider. With a mixed
    // setup the source becomes important — Ollama tags pull from the
    // user's daemon, HF repos pull from huggingface.co, remotes don't
    // download anything.
    const fmt = (m) => m.model_id.split('/').pop() + ' [' + m.backend + ']';
    const names = missing.map(fmt).slice(0, 3).join(', ');
    const more = missing.length > 3 ? ` +${missing.length - 3} more` : '';

    // Are the missing models a mix of backends? Banner copy adapts.
    const backendSet = new Set(missing.map((m) => m.backend));
    const mixed = backendSet.size > 1;
    const sources = (() => {
      if (backendSet.has('hf') && backendSet.has('ollama')) return 'huggingface.co + Ollama daemon';
      if (backendSet.has('hf')) return 'huggingface.co';
      if (backendSet.has('ollama')) return 'Ollama daemon';
      return 'multiple sources';
    })();

    const text = el('div', { style: { flex: '1', lineHeight: '1.5' } });
    if (ollamaDown) {
      text.append(
        el('strong', { style: { color: '#ffb84d', marginRight: '8px' } }, '⚠ Ollama daemon not running'),
        ollamaMissing.length + ' role' + (ollamaMissing.length === 1 ? '' : 's') + ' need the Ollama daemon. Install + start Ollama, then return here.',
      );
    } else {
      text.append(
        el('strong', { style: { color: '#2dd4ff', marginRight: '8px' } }, '◐ Models not downloaded'),
        missing.length + ' role' + (missing.length === 1 ? '' : 's') + ' need weights from ',
        el('em', { style: { color: '#e1eaf5', fontStyle: 'normal' } }, sources),
        ': ',
        el('code', { style: { color: '#2dd4ff', background: 'rgba(45,212,255,0.12)', padding: '1px 5px', borderRadius: '3px' } }, names + more),
      );
    }

    banner.appendChild(text);

    // "Get Ollama ↗" button if daemon down + any role needs it
    if (ollamaDown) {
      banner.appendChild(el('button', {
        style: {
          background: '#ffb84d',
          color: '#02060f',
          border: 'none',
          padding: '6px 14px',
          borderRadius: '4px',
          fontFamily: 'inherit',
          fontSize: '11px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontWeight: '600',
          cursor: 'pointer',
        },
        onclick: () => openExternal(state.ollama_install_url || 'https://ollama.com/download'),
      }, 'Get Ollama ↗'));
    }

    // Download button — disabled (visually) if Ollama is required + missing
    // AND there are no HF-backed missing models to download right now.
    const canDownloadNow = hfMissing.length > 0 || (ollamaMissing.length > 0 && state.ollama_available);
    banner.appendChild(el('button', {
      style: {
        background: canDownloadNow ? '#2dd4ff' : 'rgba(45,212,255,0.25)',
        color: canDownloadNow ? '#02060f' : '#7a8aa0',
        border: 'none',
        padding: '6px 14px',
        borderRadius: '4px',
        fontFamily: 'inherit',
        fontSize: '11px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: '600',
        cursor: canDownloadNow ? 'pointer' : 'not-allowed',
      },
      onclick: canDownloadNow
        ? () => openInstallModal(state)
        : () => {},
    }, 'Download'));

    // "Full wizard" link — for users who want to ADD a new model rather
    // than just download what's configured. Deep-links to add-model.html
    // (designer-shipped 4-step wizard in zip 43). Skipped on the wizard
    // page itself to avoid a banner-on-the-wizard loop.
    const here = (location.pathname.split('/').pop() || '').toLowerCase();
    if (here !== 'add-model.html') {
      banner.appendChild(el('a', {
        href: 'add-model.html',
        style: {
          color: '#2dd4ff',
          textDecoration: 'underline',
          fontFamily: 'inherit',
          fontSize: '11px',
          letterSpacing: '0.06em',
          padding: '6px 4px',
        },
        title: 'Full backend / model wizard with HF, Ollama, OpenAI-compat, Anthropic, Gemini',
      }, 'Full wizard →'));
    }

    banner.appendChild(el('button', {
      style: {
        background: 'transparent',
        color: '#2dd4ff',
        border: '1px solid rgba(45,212,255,0.35)',
        padding: '6px 10px',
        borderRadius: '4px',
        fontFamily: 'inherit',
        fontSize: '11px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        cursor: 'pointer',
      },
      onclick: () => banner.remove(),
    }, 'Dismiss'));

    document.body.appendChild(banner);
  }

  function openExternal(url) {
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      tauri.core.invoke('open_external', { url }).catch(() => window.open(url, '_blank'));
    } else {
      window.open(url, '_blank');
    }
  }

  // --- Backend swap mini-editor -------------------------------------------
  // Opens an inline popover next to a clicked backend chip. Lets the user
  // flip a chat role between HF and Ollama (the two local backends) without
  // editing .env by hand. Remote backends (openai-compat / anthropic /
  // gemini) need API URL + key + persona vocab handling — that's the full
  // 'Add a Model' wizard which lives on designer's plate.

  let swapPopover = null;

  function closeSwapPopover() {
    if (swapPopover) { swapPopover.remove(); swapPopover = null; }
    document.removeEventListener('click', onDocClickToClose, true);
  }

  function onDocClickToClose(ev) {
    if (swapPopover && !swapPopover.contains(ev.target)) {
      // Don't close on chip-clicks; openSwapEditor handles those
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
        background: '#050b1a',
        border: '1px solid rgba(45, 212, 255, 0.4)',
        borderRadius: '8px',
        padding: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: '11px',
        color: '#e1eaf5',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
    });
    swapPopover.appendChild(el('div', {
      style: { fontSize: '10px', letterSpacing: '0.16em', textTransform: 'uppercase', color: '#7a8aa0' },
    }, 'Change backend · ' + modelRow.role));

    const backendSel = el('select', {
      style: {
        background: 'rgba(2,6,15,0.6)',
        color: '#e1eaf5',
        border: '1px solid rgba(45,212,255,0.25)',
        borderRadius: '4px',
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: '11px',
      },
    },
      el('option', { value: 'hf', ...(modelRow.backend === 'hf' ? { selected: 'selected' } : {}) }, 'HuggingFace (hf)'),
      el('option', { value: 'ollama', ...(modelRow.backend === 'ollama' ? { selected: 'selected' } : {}) }, 'Ollama (local daemon)'),
    );

    const modelInput = el('input', {
      type: 'text',
      value: modelRow.model_id || '',
      placeholder: 'e.g. Qwen/Qwen2.5-7B-Instruct or llama3.1:8b',
      style: {
        background: 'rgba(2,6,15,0.6)',
        color: '#e1eaf5',
        border: '1px solid rgba(45,212,255,0.25)',
        borderRadius: '4px',
        padding: '6px 8px',
        fontFamily: 'inherit',
        fontSize: '11px',
      },
    });

    // Helper text reminds users that HF uses repo IDs, Ollama uses tags
    const hint = el('div', { style: { color: '#7a8aa0', lineHeight: '1.55' } },
      'HF: ',
      el('code', { style: { color: '#2dd4ff' } }, 'owner/repo-name'),
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
          color: '#7a8aa0',
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
          background: '#2dd4ff',
          color: '#02060f',
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
            saveStatus.style.color = '#ff6b6b';
            return;
          }
          saveStatus.textContent = 'Saving + downloading…';
          saveStatus.style.color = '#ffb84d';
          try {
            // POST /model/install with role= triggers .env patch AND pull.
            // For ollama with daemon-down, the call will error fast and we
            // surface that. For hf, this downloads ~5-15 minutes worth of
            // weights — the existing modal row status will reflect that
            // via the WS event subscription wired below.
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
              saveStatus.style.color = '#ff6b6b';
              return;
            }
            saveStatus.textContent = '✓ Backend + model_id saved. Restart server to load.';
            saveStatus.style.color = '#6df0ff';
            // Re-probe to refresh the parent banner/modal state
            setTimeout(() => { closeSwapPopover(); probe(); }, 1500);
          } catch (err) {
            saveStatus.textContent = '⚠ ' + String(err);
            saveStatus.style.color = '#ff6b6b';
          }
        },
      }, 'Save'),
    );

    swapPopover.append(backendSel, modelInput, hint, saveStatus, buttons);
    document.body.appendChild(swapPopover);
    // Defer the doc-click listener attachment so the current click event
    // (which opened the popover) doesn't immediately close it.
    setTimeout(() => document.addEventListener('click', onDocClickToClose, true), 0);
  }

  // --- Cross-tab event subscription ---------------------------------------
  // /model/install emits model.install.{started,complete,failed} on the
  // /events WebSocket. Subscribing makes the modal track installs kicked
  // off by OTHER browser tabs (e.g. user opens chat.html in a second tab
  // mid-download). The bus is set up by events.js (auto-loaded by nav.js).

  function subscribeToInstallEvents() {
    const bus = window.SeekDeepEvents;
    if (!bus || subscribeToInstallEvents._wired) return;
    subscribeToInstallEvents._wired = true;

    function matchRow(data) {
      // Match by model_id + backend — the role might be absent on cross-tab
      // installs that didn't pass role=. We iterate rowEls and find the
      // first matching row.
      for (const role of Object.keys(rowEls)) {
        const r = rowEls[role];
        if (!r || !r.row) continue;
        // The model row's `m` reference isn't stored — but the role string
        // matches `chat.<X>` or `image` / `vision` and rowEls is keyed by
        // it. We re-look up via the banner's last state if needed.
        if (data.role && (data.role === role || data.role === role.replace(/^chat\./, ''))) return role;
      }
      return null;
    }

    bus.on('model.install.started', (data) => {
      const role = matchRow(data);
      if (role) setRowStatus(role, 'DOWNLOADING…', '#ffb84d');
    });
    bus.on('model.install.complete', (data) => {
      const role = matchRow(data);
      if (role) setRowStatus(role, 'DONE', '#6df0ff');
    });
    bus.on('model.install.failed', (data) => {
      const role = matchRow(data);
      if (role) {
        const msg = (data && data.error) ? String(data.error).slice(0, 60) : 'FAILED';
        setRowStatus(role, 'FAILED · ' + msg, '#ff6b6b');
      }
    });
  }

  // --- Install modal -------------------------------------------------------

  let modal = null;
  let rowEls = {};   // role -> { row, status, dot }

  function openInstallModal(state) {
    if (modal) return;
    const missing = state.missing || [];
    // If Ollama is needed but daemon is down, skip ollama-backed rows in the
    // modal — they'd fail-fast with "daemon not reachable" anyway. The banner
    // already tells the user to install Ollama.
    const downloadable = (state.ollama_required && !state.ollama_available)
      ? missing.filter((m) => m.backend !== 'ollama')
      : missing;
    const overlay = el('div', {
      id: 'sd-model-modal',
      style: {
        position: 'fixed',
        inset: '0',
        zIndex: '9998',
        background: 'rgba(2, 6, 15, 0.75)',
        display: 'grid',
        placeItems: 'center',
        backdropFilter: 'blur(4px)',
      },
    });

    const card = el('div', {
      style: {
        width: 'min(640px, 92vw)',
        maxHeight: '80vh',
        background: '#050b1a',
        border: '1px solid rgba(45, 212, 255, 0.25)',
        borderRadius: '10px',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        boxShadow: '0 30px 80px rgba(0, 0, 0, 0.5)',
      },
    });

    const title = el('div', {
      style: { fontFamily: 'Space Grotesk, system-ui, sans-serif', fontSize: '18px', color: '#e1eaf5' },
    }, 'Downloading model weights');

    const sub = el('div', {
      style: { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '11px', color: '#7a8aa0', lineHeight: '1.5' },
    }, 'HuggingFace pulls from huggingface.co · Ollama pulls from your local daemon (registry.ollama.ai). Each model can take 5-15 minutes depending on size + connection. Safe to leave this running.');

    const list = el('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' },
    });

    rowEls = {};
    for (const m of downloadable) {
      const dot = el('span', {
        style: {
          display: 'inline-block', width: '10px', height: '10px',
          borderRadius: '50%', background: '#7a8aa0', flexShrink: '0',
        },
      });
      const status = el('span', {
        style: { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '10px', color: '#7a8aa0', letterSpacing: '0.14em', textTransform: 'uppercase' },
      }, 'PENDING');
      // Backend chip — colors hint at the source so the user knows where
      // each weight is coming from. HF = cyan (huggingface.co), Ollama =
      // green (local daemon), remotes = amber (network).
      const backendColors = {
        hf:               { bg: 'rgba(45, 212, 255, 0.15)', fg: '#2dd4ff' },
        ollama:           { bg: 'rgba(89, 220, 132, 0.15)', fg: '#59dc84' },
        'openai-compat':  { bg: 'rgba(255, 184, 77, 0.15)', fg: '#ffb84d' },
        anthropic:        { bg: 'rgba(255, 184, 77, 0.15)', fg: '#ffb84d' },
        gemini:           { bg: 'rgba(255, 184, 77, 0.15)', fg: '#ffb84d' },
      };
      const bc = backendColors[m.backend] || { bg: 'rgba(122, 138, 160, 0.15)', fg: '#7a8aa0' };
      // Chat roles can have their backend swapped via the mini-editor popover
      // (.env patch through POST /model/install with role=). Image + vision
      // are always hf with a fixed model_id — no swap UI for those rows.
      const chatRoleMatch = m.role.match(/^chat\.(.+)$/);
      const canSwap = !!chatRoleMatch && (m.backend === 'hf' || m.backend === 'ollama');
      const backendChip = el('span', {
        'data-sd-backend-chip': canSwap ? 'swappable' : 'fixed',
        style: {
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: '9.5px',
          padding: '2px 7px',
          background: bc.bg,
          color: bc.fg,
          borderRadius: '3px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontWeight: '600',
          marginLeft: '8px',
          verticalAlign: 'middle',
          cursor: canSwap ? 'pointer' : 'default',
          userSelect: 'none',
        },
        title: canSwap ? 'Click to change backend (HF ↔ Ollama)' : 'This role\'s backend is fixed',
        onclick: canSwap ? (ev) => openSwapEditor(ev.target, m, chatRoleMatch[1]) : null,
      }, (m.backend === 'hf' ? 'HuggingFace' : m.backend) + (canSwap ? ' ▾' : ''));

      const row = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          gap: '12px',
          alignItems: 'center',
          padding: '10px 14px',
          background: 'rgba(2, 6, 15, 0.6)',
          border: '1px solid rgba(45, 212, 255, 0.15)',
          borderRadius: '6px',
        },
      },
        dot,
        el('div', null,
          el('div', { style: { fontFamily: 'Space Grotesk, system-ui, sans-serif', fontSize: '13px', color: '#e1eaf5', display: 'flex', alignItems: 'center', flexWrap: 'wrap' } },
            el('span', null, m.role),
            backendChip,
          ),
          el('div', { style: { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '11px', color: '#7a8aa0', marginTop: '2px' } }, m.model_id),
        ),
        status,
      );
      rowEls[m.role] = { row, status, dot };
      list.appendChild(row);
    }

    const actions = el('div', {
      style: { display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '4px' },
    },
      el('button', {
        id: 'sd-model-modal-close',
        style: {
          background: 'transparent',
          color: '#7a8aa0',
          border: '1px solid rgba(45, 212, 255, 0.18)',
          padding: '8px 16px',
          borderRadius: '5px',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        },
        onclick: closeInstallModal,
      }, 'Close'),
    );

    card.append(title, sub, list, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    modal = overlay;

    // Subscribe to cross-tab events so the modal reflects installs kicked
    // off elsewhere. Retried after a short delay because events.js / the
    // WS connection may not be ready at modal-open time on a fresh page.
    subscribeToInstallEvents();
    setTimeout(subscribeToInstallEvents, 1000);

    runSequentialDownloads(downloadable);
  }

  function closeInstallModal() {
    if (!modal) return;
    modal.remove();
    modal = null;
    rowEls = {};
    // Re-probe — banner stays if anything failed
    setTimeout(probe, 500);
  }

  function setRowStatus(role, label, color) {
    const r = rowEls[role];
    if (!r) return;
    r.status.textContent = label;
    r.status.style.color = color;
    r.dot.style.background = color;
    r.dot.style.boxShadow = '0 0 6px ' + color;
  }

  async function downloadOne(m) {
    setRowStatus(m.role, 'DOWNLOADING…', '#ffb84d');
    try {
      const r = await fetch(BASE + '/model/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No `role` field — we're downloading weights for an EXISTING role
        // assignment, not creating one. /model/install with role= would patch
        // .env to reassign, which we don't want here.
        body: JSON.stringify({ model_id: m.model_id, backend: m.backend, auto_pull: true }),
      });
      // /model/install returns JSON even on 500 (when install_result.ok is
      // false the server JSONResponse wraps it). We try to parse first; if
      // that fails fall back to status code text.
      let data = null;
      try { data = await r.json(); } catch {}
      if (!r.ok || !data || !data.ok) {
        // Surface the server's diagnostic note when present — e.g.
        // 'Ollama daemon not reachable at http://127.0.0.1:11434' or
        // 'hf download failed: ...'. Falls back to raw status for the
        // edge case where the server died entirely.
        const note = (data && (data.note || data.error)) ? (data.note || data.error) : ('HTTP ' + r.status);
        setRowStatus(m.role, 'FAILED · ' + note.slice(0, 60), '#ff6b6b');
        const tooltip = (data && (data.note || data.error)) || ('HTTP ' + r.status);
        const row = rowEls[m.role];
        if (row && row.status) row.status.title = tooltip;
        return false;
      }
      setRowStatus(m.role, 'DONE', '#6df0ff');
      return true;
    } catch (err) {
      setRowStatus(m.role, 'NETWORK ERROR', '#ff6b6b');
      return false;
    }
  }

  async function runSequentialDownloads(missing) {
    // Sequential not parallel — HF cache concurrent writes on the same
    // host can churn the disk + waste bandwidth. Walk the list one at a time.
    for (const m of missing) {
      await downloadOne(m);
    }
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

      // If everything's installed AND Ollama is fine (or not needed), clear
      // any lingering banner and bail.
      if (data.all_local_present && !ollamaDown) {
        const old = document.getElementById('sd-model-banner');
        if (old) old.remove();
        return;
      }

      // Show banner when EITHER any local model is missing OR Ollama is
      // needed but the daemon is down (so the user gets the "Get Ollama"
      // call-to-action even if no model rows are pending).
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
      // /models/installed unreachable — server probably not up. Stay silent;
      // the seekdeep-loading page handles that case.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', probe, { once: true });
  } else {
    probe();
  }
})();
