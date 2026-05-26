/* SeekDeep Playground — turns the chat.html composer into a real local
   AI playground. Drives the same /chat / /image / /vision endpoints the
   Discord bot uses, so you can run everything SeekDeep can do without
   touching Discord.

   Auto-injected on chat.html by nav.js. Not a maintainer surface that
   designer ships — owned by Claude Code per MAINTAINER.md §1.

   Default mode: type → POST /chat. Slash commands:
     /image <prompt>          POST /image, render result inline
     /vision <prompt> + drop  drag-drop image into chat → POST /vision
     /remember <fact>         add a fact to web:owner memory
     /recall                  list current facts
     /forget #N | <text> | all  remove fact(s)
     /route <prompt>          show /route/debug payload
     /help                    short reference

   Single-owner mode: all memory is keyed to "web-owner" so this works
   without authentication. To run multi-user, we'd need auth, which is
   out of MVP scope.
*/
(function () {
  'use strict';

  // Only run on chat.html
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (!/^chat\.html?$/.test(here) && here !== '') return;
  if (window.__seekdeepPlaygroundLoaded) return;
  window.__seekdeepPlaygroundLoaded = true;

  const BASE = (function () {
    // Tauri 2 on Windows serves bundled pages from http://tauri.localhost,
    // so location.origin would be that instead of the AI server. Always
    // force 127.0.0.1:7865 in Tauri context. nav.js stashes a shared
    // resolver on window.SeekDeepResolveBase that we prefer if available.
    if (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') {
      return window.SeekDeepResolveBase();
    }
    if (typeof window !== 'undefined' && (window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')) {
      return 'http://127.0.0.1:7865';
    }
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'http://127.0.0.1:7865';
  })();

  const WEB_OWNER_ID = 'web-owner';  // 9 chars; not a valid Discord snowflake

  // Conversation history — sent with each /chat so the bot has context.
  // Trimmed to last N turns to keep payloads small.
  const MAX_HISTORY_TURNS = 24;
  const history = [];   // [{ role: 'user'|'assistant', content: '...' }]

  // ---- DOM helpers ----
  const $messages = document.getElementById('messages');
  const $input    = document.getElementById('msgInput');
  const $send     = document.querySelector('.composer .send-btn');
  if (!$messages || !$input || !$send) {
    console.warn('[SeekDeep Playground] missing composer/messages elements; aborting');
    return;
  }

  function hhmm() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function scrollToBottom() {
    requestAnimationFrame(() => {
      try { $messages.scrollTop = $messages.scrollHeight; } catch {}
    });
  }
  function clearMockChildren() {
    // First send removes the static day-headers + canned demo bubbles so
    // the live session has a clean slate.
    if (window.__seekdeepPlaygroundCleared) return;
    window.__seekdeepPlaygroundCleared = true;
    while ($messages.firstChild) $messages.removeChild($messages.firstChild);
    const day = document.createElement('div');
    day.className = 'day';
    day.innerHTML = '<span>' + hhmm() + ' · live · playground mode</span>';
    $messages.appendChild(day);
  }

  function renderMessage({ who, when, html, isBot, system }) {
    clearMockChildren();
    const row = document.createElement('div');
    row.className = 'msg' + (isBot ? ' bot' : '') + (system ? ' sys' : '');
    const av = document.createElement('div');
    av.className = 'av';
    if (isBot) {
      av.innerHTML = '<img src="assets/seekdeep-mark.webp" alt="" />';
    } else if (system) {
      av.textContent = '⌗';
    } else {
      av.textContent = (who || 'U').slice(0, 1).toUpperCase();
    }
    const body = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'who-line';
    head.innerHTML = '<span class="who">' + escapeHtml(who || 'you') + '</span>' +
                     '<span class="when">' + escapeHtml(when || hhmm()) + '</span>';
    const text = document.createElement('div');
    text.className = 'text';
    text.innerHTML = html || '';
    body.appendChild(head);
    body.appendChild(text);
    row.appendChild(av);
    row.appendChild(body);
    $messages.appendChild(row);
    scrollToBottom();
    return { row, text };
  }

  function renderTyping() {
    const slot = renderMessage({ who: 'SeekDeep', isBot: true, html: '<span class="typing">⋯ thinking</span>' });
    return slot;
  }

  // ---- HTTP helpers ----
  async function fetchJSON(path, init) {
    const url = BASE + path;
    const r = await fetch(url, init);
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  }
  async function postJSON(path, payload) {
    return fetchJSON(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  }

  // ---- Helper row updater (designer-shipped #helperRoute placeholder) ----
  function updateHelperRoute(modelRole, modelId, label) {
    const el = document.getElementById('helperRoute');
    if (!el) return;
    const role = modelRole || 'default_chat';
    const trail = label ? (' · ' + label) : '';
    if (modelId) {
      // Short-form model id (drop org prefix for readability in the helper)
      const short = String(modelId).split('/').pop() || modelId;
      el.textContent = 'ONLINE · ' + role + ' · ' + short + trail;
    } else {
      el.textContent = 'ROUTING … · ' + role + trail;
    }
  }

  // ---- Chat (default action) ----
  async function sendChat(prompt) {
    if (!prompt) return;
    renderMessage({ who: 'you', html: escapeHtml(prompt) });
    history.push({ role: 'user', content: prompt });
    if (history.length > MAX_HISTORY_TURNS) history.splice(0, history.length - MAX_HISTORY_TURNS);
    updateHelperRoute('default_chat', '', 'awaiting reply');

    const typing = renderTyping();
    try {
      const r = await postJSON('/chat', {
        prompt,
        messages: history,
        role: 'default_chat',
      });
      if (!r.ok) {
        typing.text.innerHTML = '<span class="err">[' + r.status + ']</span> ' +
          escapeHtml((r.body && (r.body.error || r.body.detail)) || 'chat request failed');
        updateHelperRoute('default_chat', '', '[' + r.status + ']');
        return;
      }
      const text = String((r.body && r.body.text) || '').trim() || '(empty response)';
      typing.text.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
      history.push({ role: 'assistant', content: text });
      updateHelperRoute((r.body && r.body.model_role) || 'default_chat', (r.body && r.body.model_id) || '');
    } catch (err) {
      typing.text.innerHTML = '<span class="err">offline</span> · ' + escapeHtml(String(err.message || err));
      updateHelperRoute('default_chat', '', 'offline');
    }
  }

  // ---- /image ----
  async function sendImage(prompt) {
    if (!prompt) {
      renderMessage({ who: '⌗', system: true, html: 'Usage: <code>/image &lt;your prompt&gt;</code>' });
      return;
    }
    renderMessage({ who: 'you', html: '<code>/image</code> ' + escapeHtml(prompt) });
    const typing = renderTyping();
    typing.text.innerHTML = '<span class="typing">⋯ generating image (this can take 10-30s)</span>';
    try {
      const r = await postJSON('/image', { prompt });
      if (!r.ok) {
        typing.text.innerHTML = '<span class="err">[' + r.status + ']</span> ' +
          escapeHtml((r.body && (r.body.error || r.body.detail)) || 'image request failed');
        return;
      }
      const b64 = r.body && r.body.image_b64;
      if (!b64) {
        typing.text.innerHTML = '<span class="err">no image_b64 in response</span>';
        return;
      }
      typing.text.innerHTML =
        '<img src="data:image/png;base64,' + b64 + '" alt="" ' +
        'style="max-width: min(560px, 100%); border-radius: 6px; display: block;" />' +
        '<div style="font-size: 11px; opacity: 0.6; margin-top: 6px;">' +
        escapeHtml(prompt) + '</div>';
    } catch (err) {
      typing.text.innerHTML = '<span class="err">offline</span> · ' + escapeHtml(String(err.message || err));
    }
  }

  // ---- /vision (drag-drop or paste an image, then optionally a prompt) ----
  let pendingVisionFile = null;
  async function sendVision(prompt, file) {
    if (!file) {
      renderMessage({ who: '⌗', system: true, html: 'Drag-drop or paste an image first, then send a prompt (or use <code>/vision &lt;prompt&gt;</code>).' });
      return;
    }
    const promptText = prompt || 'Describe this image.';
    renderMessage({
      who: 'you',
      html: '<code>/vision</code> ' + escapeHtml(promptText) +
            '<br><span style="font-size: 11px; opacity: 0.6;">attached: ' + escapeHtml(file.name) + ' (' + (file.size / 1024).toFixed(1) + ' KB)</span>',
    });
    const typing = renderTyping();
    typing.text.innerHTML = '<span class="typing">⋯ looking at the image</span>';
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          const comma = result.indexOf(',');
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('file read failed'));
        reader.readAsDataURL(file);
      });
      const r = await postJSON('/vision', {
        prompt: promptText,
        media_b64: b64,
        filename: file.name || 'upload.png',
        media_kind: 'auto',
      });
      if (!r.ok) {
        typing.text.innerHTML = '<span class="err">[' + r.status + ']</span> ' +
          escapeHtml((r.body && (r.body.error || r.body.detail)) || 'vision request failed');
        return;
      }
      const text = String((r.body && r.body.text) || '').trim() || '(empty response)';
      typing.text.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
      pendingVisionFile = null;
    } catch (err) {
      typing.text.innerHTML = '<span class="err">offline</span> · ' + escapeHtml(String(err.message || err));
    }
  }

  // ---- /remember /recall /forget (web-owner memory) ----
  async function rememberFact(text) {
    renderMessage({ who: 'you', html: '<code>/remember</code> ' + escapeHtml(text) });
    const r = await postJSON('/memory/user/' + WEB_OWNER_ID + '/fact', { text });
    if (r.ok) {
      renderMessage({ who: '⌗', system: true, html: 'Remembered. (fact #' + (r.body && r.body.index) + ')' });
    } else {
      renderMessage({ who: '⌗', system: true, html: '<span class="err">[' + r.status + ']</span> ' + escapeHtml((r.body && (r.body.error || r.body.detail)) || 'failed') });
    }
  }
  async function recallFacts() {
    renderMessage({ who: 'you', html: '<code>/recall</code>' });
    const r = await fetchJSON('/memory/user/' + WEB_OWNER_ID);
    if (r.status === 404) {
      renderMessage({ who: '⌗', system: true, html: 'No facts remembered yet. Use <code>/remember &lt;fact&gt;</code> to add one.' });
      return;
    }
    if (!r.ok) {
      renderMessage({ who: '⌗', system: true, html: '<span class="err">[' + r.status + ']</span> recall failed' });
      return;
    }
    const facts = (r.body && r.body.facts) || [];
    if (!facts.length) {
      renderMessage({ who: '⌗', system: true, html: 'No facts remembered yet.' });
      return;
    }
    const lines = facts.map((f, i) => (i + 1) + '. ' + escapeHtml(f.text || ''));
    renderMessage({ who: '⌗', system: true, html: 'Facts I remember:<br>' + lines.join('<br>') });
  }
  async function forgetFact(target) {
    renderMessage({ who: 'you', html: '<code>/forget</code> ' + escapeHtml(target) });
    if (/^all$/i.test(target)) {
      const r = await fetchJSON('/memory/user/' + WEB_OWNER_ID, { method: 'DELETE' });
      const msg = r.ok ? ('Cleared ' + ((r.body && r.body.removed_facts) || 0) + ' fact(s).') : ('Failed [' + r.status + ']');
      renderMessage({ who: '⌗', system: true, html: msg });
      return;
    }
    const m = /^#?(\d+)$/.exec(target);
    if (m) {
      const r = await fetchJSON('/memory/user/' + WEB_OWNER_ID + '/fact/' + m[1], { method: 'DELETE' });
      if (r.ok) {
        renderMessage({ who: '⌗', system: true, html: 'Forgot: "' + escapeHtml((r.body && r.body.removed && r.body.removed.text) || '') + '"' });
      } else {
        renderMessage({ who: '⌗', system: true, html: '<span class="err">[' + r.status + ']</span> no fact at index ' + m[1] });
      }
      return;
    }
    // Substring match — fetch all, find matching indices, delete in reverse so indices stay valid
    const all = await fetchJSON('/memory/user/' + WEB_OWNER_ID);
    if (!all.ok) {
      renderMessage({ who: '⌗', system: true, html: '<span class="err">recall failed</span>' });
      return;
    }
    const needle = target.toLowerCase();
    const facts = (all.body && all.body.facts) || [];
    const matches = [];
    for (let i = facts.length - 1; i >= 0; i--) {
      if (String(facts[i].text || '').toLowerCase().includes(needle)) matches.push(i + 1);
    }
    if (!matches.length) {
      renderMessage({ who: '⌗', system: true, html: 'No facts matched "<code>' + escapeHtml(target) + '</code>".' });
      return;
    }
    for (const n of matches) {
      await fetchJSON('/memory/user/' + WEB_OWNER_ID + '/fact/' + n, { method: 'DELETE' });
    }
    renderMessage({ who: '⌗', system: true, html: 'Forgot ' + matches.length + ' fact(s) matching "<code>' + escapeHtml(target) + '</code>".' });
  }

  // ---- /route (debug) ----
  async function showRoute(prompt) {
    renderMessage({ who: 'you', html: '<code>/route</code> ' + escapeHtml(prompt || '(no prompt)') });
    const params = new URLSearchParams({ role: 'default_chat', prompt: prompt || '' });
    const r = await fetchJSON('/route/debug?' + params.toString());
    if (!r.ok) {
      renderMessage({ who: '⌗', system: true, html: '<span class="err">[' + r.status + ']</span> route/debug failed' });
      return;
    }
    const j = r.body || {};
    const lines = [
      '<b>backend</b>: ' + escapeHtml(j.backend || '?'),
      '<b>model</b>: <code>' + escapeHtml(j.model_id || '?') + '</code>',
      '<b>role</b>: ' + escapeHtml(j.role_resolved || '?') + (j.role_resolved !== j.role_requested ? ' (fell through from ' + escapeHtml(j.role_requested || '') + ')' : ''),
    ];
    if (j.fallback_chain && j.fallback_chain.length) {
      lines.push('<b>fallback chain</b>: ' + j.fallback_chain.map(f =>
        escapeHtml(f.role) + ' → ' + escapeHtml(f.model_id)
      ).join(' · '));
    }
    if (j.endpoint && j.endpoint.external) lines.push('<span class="err">⚠ external — prompts leave the box</span>');
    renderMessage({ who: '⌗', system: true, html: lines.join('<br>') });
  }

  // ---- /help ----
  function showHelp() {
    renderMessage({
      who: '⌗',
      system: true,
      html:
        '<b>Playground commands</b><br>' +
        '<code>/image &lt;prompt&gt;</code> — generate an image inline<br>' +
        '<code>/vision &lt;prompt&gt;</code> — describe a dropped/pasted image<br>' +
        '<code>/remember &lt;fact&gt;</code> — store a persistent fact about you<br>' +
        '<code>/recall</code> — list remembered facts<br>' +
        '<code>/forget #N | text | all</code> — remove fact(s)<br>' +
        '<code>/route &lt;prompt&gt;</code> — show the routing decision<br>' +
        '<code>/help</code> — this list<br>' +
        '<br>Anything else just goes to <code>/chat</code> with conversation memory.',
    });
  }

  // ---- Dispatcher ----
  function dispatch(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    if (text[0] !== '/') return sendChat(text);

    const m = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(text);
    if (!m) return sendChat(text);
    const cmd = m[1].toLowerCase();
    const args = (m[2] || '').trim();

    if (cmd === 'image' || cmd === 'img' || cmd === 'gen') return sendImage(args);
    if (cmd === 'vision' || cmd === 'see' || cmd === 'look') {
      if (!pendingVisionFile) {
        return renderMessage({ who: '⌗', system: true, html: 'Drop or paste an image first, then run <code>/vision &lt;prompt&gt;</code>.' });
      }
      return sendVision(args, pendingVisionFile);
    }
    if (cmd === 'remember' || cmd === 'remem') {
      if (!args) return renderMessage({ who: '⌗', system: true, html: 'Usage: <code>/remember &lt;fact about you&gt;</code>' });
      return rememberFact(args);
    }
    if (cmd === 'recall' || cmd === 'memories' || cmd === 'facts') return recallFacts();
    if (cmd === 'forget') {
      if (!args) return renderMessage({ who: '⌗', system: true, html: 'Usage: <code>/forget #N</code> or <code>/forget text</code> or <code>/forget all</code>' });
      return forgetFact(args);
    }
    // /memory list|add|forget — matches designer's slash-menu copy in chat.html
    if (cmd === 'memory' || cmd === 'mem') {
      const sub = args.split(/\s+/)[0] || '';
      const rest = args.slice(sub.length).trim();
      if (/^(?:list|show|all|facts|memories)$/i.test(sub) || !sub) return recallFacts();
      if (/^(?:add|remember|new)$/i.test(sub)) {
        if (!rest) return renderMessage({ who: '⌗', system: true, html: 'Usage: <code>/memory add &lt;fact&gt;</code>' });
        return rememberFact(rest);
      }
      if (/^(?:forget|del|delete|remove|rm)$/i.test(sub)) {
        if (!rest) return renderMessage({ who: '⌗', system: true, html: 'Usage: <code>/memory forget #N</code> or <code>/memory forget &lt;text&gt;</code> or <code>/memory forget all</code>' });
        return forgetFact(rest);
      }
      return renderMessage({ who: '⌗', system: true, html: 'Unknown <code>/memory</code> subcommand. Try <code>list</code>, <code>add</code>, or <code>forget</code>.' });
    }
    if (cmd === 'route' || cmd === 'debug') return showRoute(args);
    if (cmd === 'help' || cmd === '?') return showHelp();
    // Unknown — pass through to /chat verbatim
    return sendChat(text);
  }

  // ---- Wire send button + Enter key + Shift+Enter (newline) ----
  function trySend() {
    const v = $input.value.trim();
    if (!v) return;
    $input.value = '';
    dispatch(v);
  }
  $send.addEventListener('click', (e) => { e.preventDefault(); trySend(); });
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  });

  // ---- File drop / paste for /vision ----
  function captureFile(file) {
    if (!file) return;
    if (!String(file.type || '').startsWith('image/')) {
      renderMessage({ who: '⌗', system: true, html: '<span class="err">only image attachments supported</span> (got ' + escapeHtml(file.type || 'unknown') + ')' });
      return;
    }
    pendingVisionFile = file;
    renderMessage({
      who: '⌗',
      system: true,
      html: '📎 attached <b>' + escapeHtml(file.name || 'image') + '</b> (' + (file.size / 1024).toFixed(1) + ' KB). Run <code>/vision &lt;prompt&gt;</code> to describe it.',
    });
  }
  // Drop anywhere on the chat surface
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    captureFile(e.dataTransfer.files[0]);
  });
  // Paste from clipboard
  document.addEventListener('paste', (e) => {
    if (!e.clipboardData || !e.clipboardData.items) return;
    for (const item of e.clipboardData.items) {
      if (String(item.type || '').startsWith('image/')) {
        const f = item.getAsFile();
        if (f) {
          captureFile(f);
          e.preventDefault();
          break;
        }
      }
    }
  });

  // ---- Subtle styling for the typing indicator + err + sys variants ----
  const css = document.createElement('style');
  css.textContent = `
    .msg.sys .av { background: rgba(45,212,255,0.08); color: var(--cyan-1, #2dd4ff); font-family: var(--font-mono, monospace); font-size: 14px; }
    .msg.sys .text { background: transparent; color: var(--hull-2, #c8d6ed); font-size: 13px; }
    .msg .text .err { color: #ff6b6b; font-family: var(--font-mono, monospace); font-size: 11px; }
    .msg .text .typing { opacity: 0.6; font-style: italic; }
    .msg .text code { background: rgba(45,212,255,0.08); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono, monospace); font-size: 12px; }
  `;
  document.head.appendChild(css);

  // First-load: drop a one-time system message explaining the mode
  setTimeout(() => {
    // Don't clobber if user has already typed something
    if (window.__seekdeepPlaygroundCleared) return;
    // Just signal in-place without clearing the mocks — that happens on first send
  }, 0);

  console.log('[SeekDeep Playground] live — type a message or /help for commands');
})();
