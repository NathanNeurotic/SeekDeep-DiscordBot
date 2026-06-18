/* SeekDeep · in-app notification primitive
 * ============================================
 * Shared "banner" + "modal" component used by:
 *   - ml-deps.js          (first-use pip-install nudge)
 *   - model-install.js    (first-use HF / Ollama weight download nudge)
 *   - seekdeep-loading.html (Tauri splash, in toast mode)
 *   - add-model.html      (wizard success / failure toasts)
 *   - any future page that wants a brand-consistent banner or modal
 *
 * Before this file existed, the three call-sites above each hand-rolled their
 * own UI. nav.js also ships its own sd-prompt-modal + sd-cpu-banner; those
 * are kept for the maintainer-owned setup flow (touching them risks breaking
 * preflight), but everything new on the designer side routes through here.
 *
 * Auto-loads: NO. Pages that want it include it explicitly:
 *   <script src="notify.js" defer></script>
 *
 * Public API (window.SeekDeepNotify):
 *   .banner({ id, tone, icon, title, body, primary, secondary, dismissible, sticky })
 *       → returns { close() }; same `id` replaces an existing banner instead of stacking
 *   .modal({ id, tone, icon, label, title, body, primary, secondary, dismissible, render })
 *       → returns a Promise that resolves to 'primary' | 'secondary' | 'dismiss' | null
 *   .toast({ tone, title, body, ttl })
 *       → bottom-right transient (4s default)
 *   .dismiss(id) — close any banner by id
 *
 * Tone vocabulary: 'info' (cyan, default), 'warn' (amber), 'bad' (red),
 * 'good' (green), 'neutral' (hull-3).
 */
(function () {
  'use strict';
  if (window.SeekDeepNotify) return;

  // Escape user/server-derived text before it lands in innerHTML. Titles are
  // always escaped; string bodies are escaped UNLESS the caller opts in with
  // html:true (and is then responsible for escaping its own interpolations).
  const sdnEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ============================================================
  // Single shared stylesheet — variables come from styles.css
  // ============================================================
  const css = `
    .sdn-banner-stack {
      position: fixed;
      top: var(--topnav-h, 80px);
      left: 0; right: 0;
      z-index: 9996;
      display: flex; flex-direction: column;
      pointer-events: none;
    }
    .sdn-banner {
      pointer-events: auto;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 14px;
      align-items: center;
      padding: 10px 22px;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      border-bottom: 1px solid var(--sdn-edge, rgba(45,212,255,0.45));
      background: var(--sdn-fill, linear-gradient(90deg, rgba(45,212,255,0.10), rgba(45,212,255,0.04)));
      color: var(--sdn-fg, var(--cyan-1, #2dd4ff));
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      animation: sdnBannerIn 0.22s ease-out;
    }
    @keyframes sdnBannerIn { from { transform: translateY(-100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .sdn-banner.tone-info { --sdn-fg: var(--cyan-1, #2dd4ff); --sdn-edge: color-mix(in oklab, var(--cyan-1, #2dd4ff) 45%, transparent); --sdn-fill: linear-gradient(90deg, rgba(45,212,255,0.14), rgba(45,212,255,0.04)); }
    .sdn-banner.tone-warn { --sdn-fg: var(--warn, #ffb84d); --sdn-edge: color-mix(in oklab, var(--warn, #ffb84d) 45%, transparent); --sdn-fill: linear-gradient(90deg, rgba(255,184,77,0.14), rgba(255,184,77,0.04)); }
    .sdn-banner.tone-bad  { --sdn-fg: var(--bad,  #ff6b6b); --sdn-edge: color-mix(in oklab, var(--bad,  #ff6b6b) 45%, transparent); --sdn-fill: linear-gradient(90deg, rgba(255,107,107,0.14), rgba(255,107,107,0.04)); }
    .sdn-banner.tone-good { --sdn-fg: var(--good, #58e6a1); --sdn-edge: color-mix(in oklab, var(--good, #58e6a1) 45%, transparent); --sdn-fill: linear-gradient(90deg, rgba(88,230,161,0.14), rgba(88,230,161,0.04)); }
    .sdn-banner.tone-neutral { --sdn-fg: var(--hull-2, #c7d6f0); --sdn-edge: color-mix(in oklab, var(--hull-3, #7d92b8) 45%, transparent); --sdn-fill: linear-gradient(90deg, rgba(125,146,184,0.10), rgba(125,146,184,0.02)); }

    .sdn-banner .sdn-icon { font-size: 14px; line-height: 1; color: var(--sdn-fg); filter: drop-shadow(0 0 6px currentColor); }
    .sdn-banner .sdn-msg {
      min-width: 0;
      display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline;
      letter-spacing: 0.12em;
    }
    .sdn-banner .sdn-title { font-weight: 700; color: var(--sdn-fg); }
    .sdn-banner .sdn-body {
      color: var(--hull-2, #c7d6f0);
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0.04em;
    }
    .sdn-banner .sdn-actions { display: flex; gap: 6px; align-items: center; }
    .sdn-banner button {
      font-family: inherit;
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      padding: 5px 12px;
      border-radius: var(--r-md, 2px);
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--sdn-edge);
      color: var(--sdn-fg);
      transition: background 0.12s ease, box-shadow 0.12s ease;
    }
    .sdn-banner button:hover { background: color-mix(in oklab, var(--sdn-fg) 12%, transparent); }
    .sdn-banner button.primary {
      background: var(--sdn-fg);
      color: var(--ink, #000a1f);
      border-color: var(--sdn-fg);
      font-weight: 700;
      box-shadow: 0 0 16px color-mix(in oklab, var(--sdn-fg) 35%, transparent);
    }
    .sdn-banner button.dismiss {
      padding: 2px 6px;
      border-color: transparent;
      color: var(--hull-3, #7d92b8);
      opacity: 0.7;
      font-size: 14px;
      letter-spacing: 0;
    }
    .sdn-banner button.dismiss:hover { opacity: 1; color: var(--sdn-fg); background: transparent; }

    /* ===== Modal ===== */
    .sdn-modal-back {
      position: fixed; inset: 0;
      z-index: 10005;
      background: radial-gradient(circle at 50% 50%, rgba(2,6,15,0.88), rgba(2,6,15,0.96));
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      animation: sdnFade 0.18s ease-out;
    }
    .sdn-modal {
      position: fixed;
      left: 50%; top: 50%;
      transform: translate(-50%, -50%);
      z-index: 10006;
      width: min(580px, calc(100vw - 36px));
      max-height: calc(100vh - 80px);
      display: flex; flex-direction: column;
      background: linear-gradient(180deg, rgba(10,26,48,0.97), rgba(6,18,31,0.99));
      border: 1px solid var(--sdn-edge, rgba(45,212,255,0.50));
      border-radius: var(--r-md, 2px);
      box-shadow: 0 30px 90px rgba(0,0,0,0.75), 0 0 60px color-mix(in oklab, var(--sdn-fg, #2dd4ff) 30%, transparent);
      font-family: var(--font-display, system-ui), sans-serif;
      overflow: hidden;
      animation: sdnPop 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1);
    }
    @keyframes sdnFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes sdnPop  { from { opacity: 0; transform: translate(-50%, -50%) scale(0.94); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
    .sdn-modal.tone-info { --sdn-fg: var(--cyan-1, #2dd4ff); --sdn-edge: color-mix(in oklab, var(--cyan-1, #2dd4ff) 50%, transparent); }
    .sdn-modal.tone-warn { --sdn-fg: var(--warn, #ffb84d); --sdn-edge: color-mix(in oklab, var(--warn, #ffb84d) 50%, transparent); }
    .sdn-modal.tone-bad  { --sdn-fg: var(--bad,  #ff6b6b); --sdn-edge: color-mix(in oklab, var(--bad,  #ff6b6b) 50%, transparent); }
    .sdn-modal.tone-good { --sdn-fg: var(--good, #58e6a1); --sdn-edge: color-mix(in oklab, var(--good, #58e6a1) 50%, transparent); }

    .sdn-modal::before {
      content: ""; position: absolute; inset: 8px; pointer-events: none;
      background:
        linear-gradient(var(--sdn-fg), var(--sdn-fg)) top left / 16px 1px no-repeat,
        linear-gradient(var(--sdn-fg), var(--sdn-fg)) top left / 1px 16px no-repeat,
        linear-gradient(var(--sdn-fg), var(--sdn-fg)) bottom right / 16px 1px no-repeat,
        linear-gradient(var(--sdn-fg), var(--sdn-fg)) bottom right / 1px 16px no-repeat;
      filter: drop-shadow(0 0 4px color-mix(in oklab, var(--sdn-fg) 60%, transparent));
      opacity: 0.7;
    }
    .sdn-modal-head {
      padding: 22px 26px 14px;
      border-bottom: 1px solid color-mix(in oklab, var(--sdn-fg) 25%, transparent);
      position: relative; z-index: 1;
    }
    .sdn-modal-head .sdn-label {
      display: flex; gap: 8px; align-items: center;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--sdn-fg);
      margin-bottom: 8px;
    }
    .sdn-modal-head .sdn-label .sdn-icon {
      font-size: 13px;
      filter: drop-shadow(0 0 6px currentColor);
    }
    .sdn-modal-head h3 {
      font-size: 21px;
      line-height: 1.2;
      letter-spacing: -0.01em;
      margin: 0 0 6px;
      color: var(--hull, #f4f8ff);
      font-weight: 500;
    }
    .sdn-modal-head p {
      font-size: 13px;
      color: var(--hull-3, #7d92b8);
      line-height: 1.55;
      margin: 0;
    }
    .sdn-modal-body {
      padding: 18px 26px;
      flex: 1;
      overflow-y: auto;
      position: relative; z-index: 1;
      color: var(--hull-2, #c7d6f0);
      font-size: 13px;
      line-height: 1.6;
    }
    .sdn-modal-body code {
      font-family: var(--font-mono, monospace);
      font-size: 11.5px;
      color: var(--sdn-fg);
      background: color-mix(in oklab, var(--sdn-fg) 10%, transparent);
      padding: 1px 5px;
      border-radius: 3px;
    }
    .sdn-modal-body pre {
      font-family: var(--font-mono, monospace);
      font-size: 11.5px;
      background: rgba(0,0,0,0.45);
      border: 1px solid color-mix(in oklab, var(--sdn-fg) 22%, transparent);
      border-radius: var(--r-md, 2px);
      padding: 12px 14px;
      overflow-x: auto;
      color: var(--hull-2);
      line-height: 1.5;
      margin: 10px 0;
    }
    .sdn-modal-body ul { padding-left: 18px; margin: 8px 0; }
    .sdn-modal-body li { margin: 4px 0; }
    .sdn-modal-foot {
      padding: 14px 26px;
      border-top: 1px solid color-mix(in oklab, var(--sdn-fg) 25%, transparent);
      display: flex; gap: 10px; justify-content: flex-end;
      position: relative; z-index: 1;
    }
    .sdn-modal-foot button {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 8px 16px;
      border-radius: var(--r-md, 2px);
      cursor: pointer;
      border: 1px solid color-mix(in oklab, var(--sdn-fg) 35%, transparent);
      background: transparent;
      color: var(--sdn-fg);
      transition: background 0.12s, box-shadow 0.12s;
    }
    .sdn-modal-foot button:hover {
      background: color-mix(in oklab, var(--sdn-fg) 10%, transparent);
      box-shadow: 0 0 14px color-mix(in oklab, var(--sdn-fg) 25%, transparent);
    }
    .sdn-modal-foot button.primary {
      background: linear-gradient(180deg, var(--sdn-fg), color-mix(in oklab, var(--sdn-fg) 70%, #000));
      color: var(--ink, #000a1f);
      font-weight: 700;
      border-color: color-mix(in oklab, var(--sdn-fg) 80%, white);
      box-shadow: 0 4px 14px color-mix(in oklab, var(--sdn-fg) 35%, transparent);
    }
    .sdn-modal-foot button:disabled { opacity: 0.5; cursor: wait; }

    /* ===== Toast ===== */
    .sdn-toast-stack {
      position: fixed;
      right: 22px;
      bottom: 90px; /* above sd-jump-btn */
      z-index: 9995;
      display: flex; flex-direction: column-reverse;
      gap: 8px;
      pointer-events: none;
      max-width: min(360px, calc(100vw - 36px));
    }
    .sdn-toast {
      pointer-events: auto;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 12px;
      align-items: start;
      padding: 12px 16px;
      background: linear-gradient(180deg, rgba(10,26,48,0.95), rgba(6,18,31,0.97));
      border: 1px solid var(--sdn-edge, rgba(45,212,255,0.45));
      border-radius: var(--r-md, 2px);
      box-shadow: 0 20px 50px rgba(0,0,0,0.55), 0 0 30px color-mix(in oklab, var(--sdn-fg, #2dd4ff) 22%, transparent);
      font-family: var(--font-display, system-ui), sans-serif;
      color: var(--hull, #f4f8ff);
      animation: sdnToastIn 0.22s ease-out;
    }
    @keyframes sdnToastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .sdn-toast.tone-info { --sdn-fg: var(--cyan-1, #2dd4ff); --sdn-edge: color-mix(in oklab, var(--cyan-1, #2dd4ff) 45%, transparent); }
    .sdn-toast.tone-warn { --sdn-fg: var(--warn, #ffb84d); --sdn-edge: color-mix(in oklab, var(--warn, #ffb84d) 45%, transparent); }
    .sdn-toast.tone-bad  { --sdn-fg: var(--bad,  #ff6b6b); --sdn-edge: color-mix(in oklab, var(--bad,  #ff6b6b) 45%, transparent); }
    .sdn-toast.tone-good { --sdn-fg: var(--good, #58e6a1); --sdn-edge: color-mix(in oklab, var(--good, #58e6a1) 45%, transparent); }
    .sdn-toast .sdn-icon { color: var(--sdn-fg); font-size: 14px; line-height: 1; filter: drop-shadow(0 0 6px currentColor); }
    .sdn-toast .sdn-t-title {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--sdn-fg);
      margin-bottom: 3px;
    }
    .sdn-toast .sdn-t-body {
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--hull-2, #c7d6f0);
    }

    /* Body padding when a banner stack is mounted — prevents the banner from
       occluding sticky/topnav-adjacent content. */
    body[data-sdn-banner-h] {
      padding-top: var(--sdn-banner-h, 0) !important;
      transition: padding-top 0.18s ease;
    }

    @media (max-width: 640px) {
      .sdn-banner {
        grid-template-columns: auto 1fr;
        padding: 10px 14px;
        font-size: 10px;
      }
      .sdn-banner .sdn-actions {
        grid-column: 1 / -1;
        justify-content: flex-end;
      }
      .sdn-modal-head { padding: 18px 18px 12px; }
      .sdn-modal-body { padding: 14px 18px; }
      .sdn-modal-foot { padding: 12px 18px; flex-wrap: wrap; }
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ============================================================
  // Banner stack — multiple banners stack vertically below topnav
  // ============================================================
  let bannerStack = null;
  function ensureBannerStack() {
    if (bannerStack && document.body.contains(bannerStack)) return bannerStack;
    bannerStack = document.createElement('div');
    bannerStack.className = 'sdn-banner-stack';
    bannerStack.id = 'sdn-banner-stack';
    document.body.appendChild(bannerStack);
    return bannerStack;
  }
  function syncBannerOffset() {
    const stack = ensureBannerStack();
    const h = stack.getBoundingClientRect().height;
    if (h > 0) {
      document.documentElement.style.setProperty('--sdn-banner-h', h + 'px');
      document.body.dataset.sdnBannerH = String(h);
    } else {
      document.documentElement.style.removeProperty('--sdn-banner-h');
      delete document.body.dataset.sdnBannerH;
    }
  }

  function banner(opts) {
    opts = opts || {};
    const stack = ensureBannerStack();
    const id = opts.id || ('sdn-b-' + Math.random().toString(36).slice(2, 8));
    // Replace existing banner with same id
    const existing = stack.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.className = 'sdn-banner tone-' + (opts.tone || 'info');
    el.dataset.id = id;

    const icon = opts.icon || ({ info: '▸', warn: '⚠', bad: '✕', good: '✓', neutral: '·' }[opts.tone || 'info']);
    const titleHtml = opts.title ? `<span class="sdn-title">${sdnEsc(opts.title)}</span>` : '';
    const bodyHtml  = opts.body  ? `<span class="sdn-body">${opts.html ? opts.body : sdnEsc(opts.body)}</span>` : '';

    el.innerHTML = `
      <span class="sdn-icon">${icon}</span>
      <span class="sdn-msg">${titleHtml}${bodyHtml}</span>
      <span class="sdn-actions"></span>
    `;
    const actions = el.querySelector('.sdn-actions');
    const close = () => { el.remove(); syncBannerOffset(); };

    if (opts.secondary) {
      const b = document.createElement('button');
      b.textContent = opts.secondary.label;
      b.addEventListener('click', () => { try { opts.secondary.onClick?.({ close }); } catch (e) { console.error(e); } });
      actions.appendChild(b);
    }
    if (opts.primary) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = opts.primary.label;
      b.addEventListener('click', () => { try { opts.primary.onClick?.({ close }); } catch (e) { console.error(e); } });
      actions.appendChild(b);
    }
    if (opts.dismissible !== false && !opts.sticky) {
      const x = document.createElement('button');
      x.className = 'dismiss';
      x.setAttribute('aria-label', 'Dismiss');
      x.innerHTML = '×';
      x.addEventListener('click', close);
      actions.appendChild(x);
    }

    stack.appendChild(el);
    syncBannerOffset();
    return { close, el };
  }
  function dismiss(id) {
    const stack = ensureBannerStack();
    const el = stack.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (el) { el.remove(); syncBannerOffset(); }
  }

  // ============================================================
  // Modal — promise-based, single instance
  // ============================================================
  function modal(opts) {
    opts = opts || {};
    // Close any existing modal first.
    document.querySelectorAll('.sdn-modal-back, .sdn-modal').forEach(n => n.remove());

    return new Promise(resolve => {
      const back = document.createElement('div');
      back.className = 'sdn-modal-back';
      const m = document.createElement('div');
      m.className = 'sdn-modal tone-' + (opts.tone || 'info');
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');

      // Resolve icon + label by tone. confirm() with destructive:true passes
      // tone:'danger' which wasn't in the lookup tables — the modal then
      // rendered "undefined undefined" as the chip text (CSS uppercases it
      // to "UNDEFINED UNDEFINED"). Map every tone we actually pass, with a
      // safe fallback for forward-compat.
      const TONE_ICON  = { info: '▸', warn: '⚠', bad: '✕', good: '✓', neutral: '·', danger: '↯' };
      const TONE_LABEL = {
        info:    '▸ NOTICE',
        warn:    '⚠ HEADS UP',
        bad:     '✕ ERROR',
        good:    '✓ OK',
        neutral: '· INFO',
        danger:  '↯ DESTRUCTIVE',
      };
      const tone = opts.tone || 'info';
      const icon  = opts.icon  || TONE_ICON[tone]  || TONE_ICON.info;
      const label = opts.label || TONE_LABEL[tone] || TONE_LABEL.info;

      // Don't render the body in the head template — it would also render
      // via bodyEl below, causing a visible double-paint. The head holds
      // ONLY the tone-chip + title; the body element holds the body.
      m.innerHTML = `
        <div class="sdn-modal-head">
          <div class="sdn-label"><span class="sdn-icon">${icon}</span>${label}</div>
          <h3>${sdnEsc(opts.title || '')}</h3>
        </div>
        <div class="sdn-modal-body" data-sdn-body></div>
        <div class="sdn-modal-foot"></div>
      `;
      const bodyEl = m.querySelector('[data-sdn-body]');
      const footEl = m.querySelector('.sdn-modal-foot');

      // Body can be: a string (HTML), an Element, or a render(bodyEl) callback.
      // Plain-text strings (no HTML markers) get textContent treatment so
      // they're escaped and visible — before this branch existed, a
      // plain-text body silently disappeared after I moved body rendering
      // out of the head template.
      if (typeof opts.render === 'function') {
        try { opts.render(bodyEl); } catch (e) { console.error('[notify] render error:', e); }
      } else if (opts.body instanceof Element) {
        bodyEl.appendChild(opts.body);
      } else if (typeof opts.body === 'string' && opts.html) {
        bodyEl.innerHTML = opts.body;   // caller opted into HTML + owns escaping
      } else if (typeof opts.body === 'string' && opts.body) {
        bodyEl.textContent = opts.body; // default: safe text (no HTML injection)
      } else if (!opts.body && opts.render == null) {
        bodyEl.remove();
      }

      function finish(verdict) {
        back.remove();
        m.remove();
        resolve(verdict);
      }
      if (opts.secondary) {
        const b = document.createElement('button');
        b.textContent = opts.secondary.label;
        b.addEventListener('click', async () => {
          if (opts.secondary.onClick) {
            try { const r = await opts.secondary.onClick({ close: () => finish('secondary'), modal: m }); if (r === false) return; } catch (e) { console.error(e); }
          }
          finish('secondary');
        });
        footEl.appendChild(b);
      }
      if (opts.primary) {
        const b = document.createElement('button');
        b.className = 'primary';
        b.textContent = opts.primary.label;
        b.addEventListener('click', async () => {
          if (opts.primary.onClick) {
            try { const r = await opts.primary.onClick({ close: () => finish('primary'), modal: m, setBusy: (busy) => { b.disabled = !!busy; b.textContent = busy ? '⋯ working…' : opts.primary.label; } }); if (r === false) return; } catch (e) { console.error(e); }
          }
          finish('primary');
        });
        footEl.appendChild(b);
      }
      if (!opts.primary && !opts.secondary) footEl.remove();

      if (opts.dismissible !== false) {
        back.addEventListener('click', () => finish('dismiss'));
        document.addEventListener('keydown', function escHandler(e) {
          if (e.key === 'Escape') {
            document.removeEventListener('keydown', escHandler);
            finish('dismiss');
          }
        });
      }

      document.body.appendChild(back);
      document.body.appendChild(m);
    });
  }

  // ============================================================
  // Toast — transient bottom-right
  // ============================================================
  let toastStack = null;
  function ensureToastStack() {
    if (toastStack && document.body.contains(toastStack)) return toastStack;
    toastStack = document.createElement('div');
    toastStack.className = 'sdn-toast-stack';
    document.body.appendChild(toastStack);
    return toastStack;
  }
  // TTL-by-tone defaults so the audit §4 cadence is consistent across the
  // ~50 call sites. Callers can still pass an explicit ttl to override.
  // Bad/warn linger longer so error context isn't lost; info disappears
  // quickly so the UI doesn't pile up while polling.
  const TTL_BY_TONE = { info: 4000, good: 5000, warn: 8000, bad: 10000, neutral: 4000 };

  // Dedupe window: identical title+body+tone within 800ms is suppressed.
  // The 5s /launchers/status poll could fire three OFFLINE toasts during
  // a single restart window before this; now they collapse to one.
  const recentToasts = new Map();
  const DEDUPE_WINDOW_MS = 800;
  function toastKey(opts) {
    return (opts.tone || 'info') + '\x00' + (opts.title || '') + '\x00' + (opts.body || '');
  }
  function isDuplicate(opts) {
    if (opts.allowDuplicate) return false;
    const key = toastKey(opts);
    const now = Date.now();
    const last = recentToasts.get(key);
    if (last && (now - last) < DEDUPE_WINDOW_MS) return true;
    recentToasts.set(key, now);
    // Prune entries older than the window so the map doesn't grow forever.
    if (recentToasts.size > 64) {
      for (const [k, ts] of recentToasts.entries()) {
        if (now - ts > DEDUPE_WINDOW_MS) recentToasts.delete(k);
      }
    }
    return false;
  }

  function toast(opts) {
    opts = opts || {};
    if (isDuplicate(opts)) return { close: () => {}, el: null, deduped: true };
    const stack = ensureToastStack();
    const el = document.createElement('div');
    el.className = 'sdn-toast tone-' + (opts.tone || 'info');
    const icon = opts.icon || ({ info: '▸', warn: '⚠', bad: '✕', good: '✓', neutral: '·' }[opts.tone || 'info']);
    el.innerHTML = `
      <span class="sdn-icon">${icon}</span>
      <div>
        ${opts.title ? `<div class="sdn-t-title">${sdnEsc(opts.title)}</div>` : ''}
        ${opts.body ? `<div class="sdn-t-body">${opts.html ? opts.body : sdnEsc(opts.body)}</div>` : ''}
      </div>
    `;
    stack.appendChild(el);
    // Tone-driven TTL when caller didn't specify. Explicit 0 still means
    // "sticky"; callers occasionally need that for long-running flows.
    const ttl = opts.ttl == null ? (TTL_BY_TONE[opts.tone || 'info'] || 4000) : opts.ttl;
    if (ttl > 0) setTimeout(() => { el.style.transition = 'opacity 0.25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, ttl);
    return { close: () => el.remove(), el };
  }

  // Paired start→end toast for "click button → fire op → show result"
  // workflows. Closes audit §4: previously every Quick Action either
  // toasted on click-then-silenced-on-success (so the user never knew
  // the operation finished) or toasted on failure only (so launcher.js's
  // 16-bad-6-good imbalance made it feel like the launcher only ever
  // failed). Now every operation announces start + outcome.
  //
  // Usage:
  //   SeekDeepNotify.operation({
  //     label: 'Restart AI server',
  //     successTitle: 'AI server back online',   // optional
  //     errorTitle:   'Restart failed',           // optional
  //     run: async () => { ... return resultBody?; }
  //   })
  //
  // The `run` thunk's resolved value (if a string) is used as the
  // success-toast body. Rejections become bad-tone toasts whose body is
  // the error message. Returns the same promise so callers can chain.
  function operation(opts) {
    opts = opts || {};
    const label = opts.label || 'Working';
    const successTitle = opts.successTitle || (label + ' · done');
    const errorTitle   = opts.errorTitle   || (label + ' · failed');
    // Start toast: short (info), can be force-closed when end-toast lands.
    const startToast = toast({
      tone: 'info',
      title: label + '…',
      body: opts.startBody || '',
      ttl: opts.startTtl == null ? 3000 : opts.startTtl,
      allowDuplicate: true, // pair-uniqueness handled below, not via dedupe
    });
    const run = typeof opts.run === 'function' ? opts.run : () => Promise.resolve();
    return Promise.resolve()
      .then(() => run())
      .then((result) => {
        if (startToast && typeof startToast.close === 'function') startToast.close();
        const body = (opts.successBody != null)
          ? opts.successBody
          : (typeof result === 'string' ? result : '');
        toast({ tone: 'good', title: successTitle, body });
        return result;
      })
      .catch((err) => {
        if (startToast && typeof startToast.close === 'function') startToast.close();
        const body = String(err?.message || err || 'unknown error').slice(0, 280);
        toast({ tone: 'bad', title: errorTitle, body });
        throw err;
      });
  }

  // Brand-styled drop-in replacement for window.confirm(). Returns a Promise
  // that resolves to true (primary clicked) or false (secondary / dismissed).
  // Use case: every `if (!confirm('...'))` in the codebase can become
  // `if (!await SeekDeepNotify.confirm('...'))`.
  //
  // Accepts EITHER calling convention:
  //   confirm("Are you sure?", { tone: 'warn' })       // window.confirm style
  //   confirm({ title: "...", body: "...", ... })       // options-only style
  // Passing an object as `message` used to render "[object Object]" in the
  // modal because the function `String()`'d it. Now we detect that case and
  // treat the object as opts.
  function confirm(message, opts) {
    // Options-only invocation: confirm({ title, body, ... })
    if (message && typeof message === 'object' && !opts) {
      opts = message;
      message = undefined;
    }
    opts = opts || {};
    // Resolve label aliases: callers sometimes pass confirmLabel / cancelLabel
    // (matching native dialog APIs) instead of okLabel.
    const okLabel     = opts.okLabel     || opts.confirmLabel;
    const cancelLabel = opts.cancelLabel || opts.dismissLabel;
    // `destructive: true` is a convenience that flips tone to 'danger' so the
    // primary button renders red — used by kill-all-bot-instances etc.
    const tone = opts.tone || (opts.destructive ? 'danger' : 'info');
    // Split first line as title, rest as body. Mirrors window.confirm() ergonomics.
    let title = opts.title;
    let body  = opts.body;
    if (!title && !body) {
      const lines = String(message || '').split('\n');
      title = lines[0] || 'Confirm';
      body  = lines.slice(1).join('\n').trim();
    } else if (!title) {
      title = String(message || 'Confirm');
    } else if (!body && message) {
      body = String(message);
    }
    return modal({
      tone,
      title,
      // The body is wrapped in a mono-styled <div> with the caller's text
      // HTML-escaped above, so it must render as HTML (innerHTML) — without
      // html:true the modal falls back to textContent and shows the raw
      // "<div style=...>" markup as literal text. Guard to !!body so an empty
      // body still hits modal()'s drop-the-body-element path.
      body: body ? `<div style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;line-height:1.55;color:var(--hull-2);">${String(body).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>` : '',
      html: !!body,
      primary:   opts.primary   || { label: okLabel     || 'OK',     tone },
      secondary: opts.secondary || { label: cancelLabel || 'Cancel', tone: 'neutral' },
      dismissible: true,
    }).then(r => r === 'primary');
  }

  window.SeekDeepNotify = {
    banner, dismiss, modal, toast, confirm, operation,
    // Allow tests / hosts to nudge the offset after layout shifts.
    _syncOffset: syncBannerOffset,
  };
  // Also expose a top-level alias so `await SeekDeepConfirm(...)` works.
  window.SeekDeepConfirm = confirm;
})();
