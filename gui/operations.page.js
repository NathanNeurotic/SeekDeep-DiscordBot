/* SeekDeep · operations.page.js — renders the shared window.SeekDeepOps registry
 * (defined in nav.js) as grouped action buttons on operations.html. Both this
 * page and the right-click context menu consume the SAME registry, so they can
 * never drift. Each button routes through SeekDeepOps.run(id) → sdContextAction,
 * which prefixes the loopback base, prompts requireConfirm on destructive ops,
 * prefers the Tauri command where available, and toasts the result.
 *
 * Self-gates: no-ops unless #ops-grid is present (i.e. only on operations.html).
 */
(function () {
  'use strict';
  const grid = document.getElementById('ops-grid');
  if (!grid) return;

  function render() {
    const ops = (window.SeekDeepOps && window.SeekDeepOps.actions) || [];
    if (!ops.length) return false; // nav.js (which defines SeekDeepOps) not ready yet
    grid.innerHTML = '';
    const groups = [];
    ops.forEach((op) => {
      let g = groups.filter((x) => x.name === op.group)[0];
      if (!g) { g = { name: op.group, items: [] }; groups.push(g); }
      g.items.push(op);
    });
    groups.forEach((g) => {
      const sec = document.createElement('section');
      sec.className = 'ops-group';
      const h = document.createElement('h2');
      h.textContent = g.name;
      sec.appendChild(h);
      const cards = document.createElement('div');
      cards.className = 'ops-cards';
      g.items.forEach((op) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'ops-card' + (op.danger ? ' danger' : '');
        const title = document.createElement('span');
        title.className = 'ops-card-title';
        title.textContent = (op.icon ? op.icon + '  ' : '') + op.label;
        const desc = document.createElement('span');
        desc.className = 'ops-card-desc';
        desc.textContent = op.desc || '';
        card.appendChild(title);
        card.appendChild(desc);
        // Disable while the (async) op is pending so a double-click can't fire
        // a heavy restart/kill twice. run() returns sdContextAction's promise.
        card.addEventListener('click', async () => {
          if (card.disabled) return;
          card.disabled = true;
          try { await window.SeekDeepOps.run(op.id); }
          catch (_) {}
          finally { card.disabled = false; }
        });
        cards.appendChild(card);
      });
      sec.appendChild(cards);
      grid.appendChild(sec);
    });
    return true;
  }

  function boot() {
    if (render()) return;
    // nav.js is deferred and defines window.SeekDeepOps; defer order should make
    // it available, but retry briefly in case of late mount, then show the
    // empty-state hint if it truly never arrives.
    let tries = 0;
    const iv = setInterval(() => {
      if (render() || ++tries > 40) {
        clearInterval(iv);
        if (!(window.SeekDeepOps && window.SeekDeepOps.actions && window.SeekDeepOps.actions.length)) {
          const empty = document.getElementById('ops-empty');
          if (empty) empty.classList.remove('ops-hidden');
        }
      }
    }, 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
