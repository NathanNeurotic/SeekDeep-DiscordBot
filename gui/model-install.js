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

  function showBanner(missing) {
    if (document.getElementById('sd-model-banner')) return;
    // If ml-deps banner is already showing, offset ours below it so they
    // don't overlap.
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

    const names = missing.map((m) => m.model_id.split('/').pop()).slice(0, 3).join(', ');
    const more = missing.length > 3 ? ` +${missing.length - 3} more` : '';

    const text = el('div', { style: { flex: '1', lineHeight: '1.5' } },
      el('strong', { style: { color: '#2dd4ff', marginRight: '8px' } }, '◐ Models not downloaded'),
      missing.length + ' role' + (missing.length === 1 ? '' : 's') + ' need weights: ',
      el('code', { style: { color: '#2dd4ff', background: 'rgba(45,212,255,0.12)', padding: '1px 5px', borderRadius: '3px' } }, names + more),
    );

    const dl = el('button', {
      style: {
        background: '#2dd4ff',
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
      onclick: () => openInstallModal(missing),
    }, 'Download');

    const dismiss = el('button', {
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
    }, 'Dismiss');

    banner.append(text, dl, dismiss);
    document.body.appendChild(banner);
  }

  // --- Install modal -------------------------------------------------------

  let modal = null;
  let rowEls = {};   // role -> { row, status, dot }

  function openInstallModal(missing) {
    if (modal) return;
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
    }, 'Each model can take 5-15 minutes depending on size + connection. Safe to leave this running.');

    const list = el('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' },
    });

    rowEls = {};
    for (const m of missing) {
      const dot = el('span', {
        style: {
          display: 'inline-block', width: '10px', height: '10px',
          borderRadius: '50%', background: '#7a8aa0', flexShrink: '0',
        },
      });
      const status = el('span', {
        style: { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '10px', color: '#7a8aa0', letterSpacing: '0.14em', textTransform: 'uppercase' },
      }, 'PENDING');
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
          el('div', { style: { fontFamily: 'Space Grotesk, system-ui, sans-serif', fontSize: '13px', color: '#e1eaf5' } }, m.role),
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

    runSequentialDownloads(missing);
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
      if (!r.ok) {
        const text = await r.text().catch(() => String(r.status));
        setRowStatus(m.role, 'FAILED · ' + r.status, '#ff6b6b');
        return false;
      }
      const data = await r.json();
      if (!data.ok) {
        setRowStatus(m.role, 'FAILED', '#ff6b6b');
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
      if (data.all_local_present) {
        // Clean up any lingering banner from a previous state
        const old = document.getElementById('sd-model-banner');
        if (old) old.remove();
        return;
      }
      if (Array.isArray(data.missing) && data.missing.length > 0) {
        showBanner(data.missing);
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
