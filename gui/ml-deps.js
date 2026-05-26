/* SeekDeep · ml-deps.js
   ====================
   First-use ML dependency downloader. Auto-loaded by nav.js's autoLoadSiblings.

   Flow:
     1. On load, probe GET /ml_deps. If available=true, do nothing.
     2. If available=false, inject a topnav banner that names the missing
        modules and offers "Install ML libraries (~2 GB)".
     3. On click, POST /deps/install (token-protected; the nav.js token
        interceptor adds X-SeekDeep-Token automatically). The endpoint
        returns immediately and pip runs in a background thread on the
        server, emitting deps.install.line events on the /events WebSocket.
     4. We open a progress modal that consumes those events and shows
        the live pip output. On deps.install.complete, the modal flips
        to a "Restart server to load libraries" prompt — torch can't be
        hot-loaded into an already-running Python process.

   Self-gates against double-loads via window.__seekdeepMlDepsLoaded.
*/
(function () {
  'use strict';
  if (window.__seekdeepMlDepsLoaded) return;
  window.__seekdeepMlDepsLoaded = true;

  const BASE = (function () {
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  })();

  // --- DOM helpers ---------------------------------------------------------

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
    if (document.getElementById('sd-ml-deps-banner')) return;
    const banner = el('div', {
      id: 'sd-ml-deps-banner',
      style: {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        zIndex: '9990',
        padding: '10px 18px',
        background: 'rgba(255, 184, 77, 0.06)',
        borderBottom: '1px dashed rgba(255, 184, 77, 0.35)',
        color: '#ffb84d',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: '12px',
        letterSpacing: '0.04em',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        backdropFilter: 'blur(6px)',
      },
    });

    const text = el('div', { style: { flex: '1', lineHeight: '1.5' } },
      el('strong', { style: { color: '#ffb84d', marginRight: '8px' } }, '⚠ ML libraries not installed'),
      'Local /chat, /image, and /vision will return errors until installed. Missing: ',
      el('code', { style: { color: '#ffb84d', background: 'rgba(255,184,77,0.12)', padding: '1px 5px', borderRadius: '3px' } }, missing.join(', ')),
    );

    const install = el('button', {
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
      onclick: openInstallModal,
    }, 'Install (~2 GB)');

    const dismiss = el('button', {
      style: {
        background: 'transparent',
        color: '#ffb84d',
        border: '1px solid rgba(255,184,77,0.35)',
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

    banner.append(text, install, dismiss);
    document.body.appendChild(banner);
  }

  // --- Install modal -------------------------------------------------------

  let modal = null;
  let modalLog = null;
  let modalStatus = null;
  let modalActions = null;

  function openInstallModal() {
    if (modal) return;
    const overlay = el('div', {
      id: 'sd-ml-deps-modal',
      style: {
        position: 'fixed',
        inset: '0',
        zIndex: '9999',
        background: 'rgba(2, 6, 15, 0.75)',
        display: 'grid',
        placeItems: 'center',
        backdropFilter: 'blur(4px)',
      },
    });

    const card = el('div', {
      style: {
        width: 'min(720px, 92vw)',
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
      style: {
        fontFamily: 'Space Grotesk, system-ui, sans-serif',
        fontSize: '18px',
        color: '#e1eaf5',
      },
    }, 'Installing ML libraries');

    modalStatus = el('div', {
      style: {
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: '11px',
        color: '#2dd4ff',
        letterSpacing: '0.08em',
      },
    }, 'Starting…');

    modalLog = el('pre', {
      style: {
        flex: '1',
        overflow: 'auto',
        background: 'rgba(2, 6, 15, 0.9)',
        border: '1px solid rgba(45, 212, 255, 0.18)',
        borderRadius: '6px',
        padding: '12px',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: '11px',
        color: '#b6c4d4',
        lineHeight: '1.5',
        margin: '0',
        whiteSpace: 'pre-wrap',
        maxHeight: '50vh',
        minHeight: '180px',
      },
    });

    modalActions = el('div', {
      style: { display: 'flex', gap: '10px', justifyContent: 'flex-end' },
    },
      el('button', {
        id: 'sd-ml-deps-close',
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

    card.append(title, modalStatus, modalLog, modalActions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    modal = overlay;

    // Kick off the install
    triggerInstall();
  }

  function closeInstallModal() {
    if (!modal) return;
    modal.remove();
    modal = null;
    modalLog = null;
    modalStatus = null;
    modalActions = null;
  }

  function appendLogLine(line) {
    if (!modalLog) return;
    modalLog.textContent += line + '\n';
    modalLog.scrollTop = modalLog.scrollHeight;
  }

  // --- Install kick-off + WS subscription ---------------------------------

  let bus = null;
  let unsubscribers = [];

  function ensureSubscriptions() {
    if (bus) return;
    bus = window.SeekDeepEvents;
    if (!bus) return; // events.js hasn't loaded yet — try again on next event

    unsubscribers.push(bus.on('deps.install.started', (data) => {
      if (modalStatus) modalStatus.textContent = 'PIP INSTALL STARTED · ' + (data.requirements_file || 'requirements-ml.txt');
    }));
    unsubscribers.push(bus.on('deps.install.line', (data) => {
      appendLogLine(data.line || '');
    }));
    unsubscribers.push(bus.on('deps.install.complete', (data) => {
      if (modalStatus) modalStatus.textContent = '✓ INSTALL COMPLETE · restart the AI server to load the new libraries';
      if (modalStatus) modalStatus.style.color = '#6df0ff';
      appendLogLine('');
      appendLogLine('--- Install finished. Restart the SeekDeep AI server to load torch/transformers/diffusers ---');
    }));
    unsubscribers.push(bus.on('deps.install.failed', (data) => {
      if (modalStatus) modalStatus.textContent = '⚠ INSTALL FAILED · exit code ' + (data.exit_code != null ? data.exit_code : '?');
      if (modalStatus) modalStatus.style.color = '#ff6b6b';
      appendLogLine('');
      appendLogLine('--- Install failed. See output above. ---');
      if (data.error) appendLogLine('Error: ' + data.error);
    }));
  }

  async function triggerInstall() {
    ensureSubscriptions();
    if (!bus) {
      // Retry hookup once events.js has had a tick to load
      setTimeout(() => {
        ensureSubscriptions();
        if (!bus && modalStatus) {
          modalStatus.textContent = '⚠ Event bus unavailable — install progress won\'t stream. The install is still running server-side.';
        }
      }, 750);
    }

    try {
      const r = await fetch(BASE + '/deps/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirements_file: 'requirements-ml.txt' }),
      });
      if (!r.ok) {
        const text = await r.text();
        appendLogLine('POST /deps/install -> ' + r.status);
        appendLogLine(text);
        if (modalStatus) {
          modalStatus.textContent = '⚠ FAILED TO START · ' + r.status;
          modalStatus.style.color = '#ff6b6b';
        }
        return;
      }
      const data = await r.json();
      appendLogLine('POST /deps/install OK');
      appendLogLine('  requirements_file: ' + (data.requirements_file || '?'));
      appendLogLine('  ' + (data.note || ''));
    } catch (err) {
      appendLogLine('POST /deps/install error: ' + err);
      if (modalStatus) {
        modalStatus.textContent = '⚠ NETWORK ERROR';
        modalStatus.style.color = '#ff6b6b';
      }
    }
  }

  // --- Boot probe ----------------------------------------------------------

  async function probe() {
    try {
      const r = await fetch(BASE + '/ml_deps', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      if (!r.ok) return;
      const data = await r.json();
      if (data.available === false && Array.isArray(data.missing) && data.missing.length > 0) {
        showBanner(data.missing);
      }
    } catch {
      // /ml_deps unreachable — server probably not up yet. The seekdeep-loading
      // page handles that case; we just stay silent.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', probe, { once: true });
  } else {
    probe();
  }
})();
