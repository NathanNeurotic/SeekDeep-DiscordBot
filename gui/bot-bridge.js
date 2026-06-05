/* SeekDeep · bot-bridge.js
   Logic for gui/bot-bridge.html — the read-only Bot Bridge page. Surfaces the
   GUI -> bot command bridge: GET /events/status for connection state and
   POST /bot/command {action} for the whitelisted ping/status/guilds actions
   (Python relays to the Discord bot). External (not inline) so it adds nothing
   to the script-src 'unsafe-inline' debt, and uses addEventListener (no inline
   on*= handlers) so it stays CSP-clean. Self-gates: no-ops unless the page
   markup is present. nav.js's fetch interceptor auto-attaches X-SeekDeep-Token
   to the POST. */
(function () {
  'use strict';
  if (!document.getElementById('bb-main')) return;
  if (window.__seekdeepBotBridgeLoaded) return;
  window.__seekdeepBotBridgeLoaded = true;

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.classList.toggle('bb-hidden', !on); };

  function setError(msg) {
    const e = $('bb-error');
    if (!e) return;
    if (!msg) { e.textContent = ''; show(e, false); return; }
    e.textContent = msg;
    show(e, true);
  }

  async function getJSON(url, opts) {
    const r = await fetch(url, opts || { headers: { 'Accept': 'application/json' } });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok) {
      const detail = (body && (body.detail || body.error)) || ('HTTP ' + r.status);
      const err = new Error(detail);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body || {};
  }

  // POST /bot/command {action}. nav.js auto-attaches the GUI token. The server
  // wraps the bot reply in {ok, cid, result, error}; surface `error` on a
  // logical failure even when the HTTP status is 200.
  async function command(action) {
    const r = await fetch('/bot/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ action }),
    });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok) {
      const detail = (body && (body.detail || body.error)) || ('HTTP ' + r.status);
      const err = new Error(detail);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    if (body && body.ok === false) {
      const err = new Error(body.error || 'Command failed');
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body || {};
  }

  // Map a thrown command/getJSON error to an on-brand, human message. The
  // backend contract: 404 = bridge disabled, 503 = bot not connected, 504 =
  // timeout; anything else falls back to the server-supplied detail.
  function explain(err) {
    switch (err && err.status) {
      case 404: return 'bridge disabled';
      case 503: return "the bot isn't connected (enable SEEKDEEP_FEATURE_BOT_BRIDGE and restart the bot)";
      case 504: return 'the bot didn\'t respond in time';
      default: return (err && err.message) || 'request failed';
    }
  }

  // Format a millisecond duration as a compact h/m/s string.
  function fmtDuration(ms) {
    if (ms == null) return '—';
    const n = Number(ms);
    if (!isFinite(n) || n < 0) return '—';
    let s = Math.floor(n / 1000);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const parts = [];
    if (h) parts.push(h + 'h');
    if (m || h) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
  }

  function setOut(node) {
    const out = $('bb-out');
    if (!out) return;
    out.textContent = '';
    if (typeof node === 'string') out.textContent = node;
    else if (node) out.appendChild(node);
  }

  function setPill(connected, text) {
    const pill = $('bb-pill');
    const label = $('bb-pill-text');
    if (label) label.textContent = text;
    if (!pill) return;
    pill.classList.remove('on', 'off');
    pill.classList.add(connected ? 'on' : 'off');
  }

  async function refreshStatus() {
    const btn = $('bb-refresh');
    if (btn) btn.disabled = true;
    setError('');
    try {
      const s = await getJSON('/events/status');
      const connected = !!(s && s.bot_bridge);
      setPill(
        connected,
        connected
          ? 'Bot connected'
          : 'Bot not connected — enable SEEKDEEP_FEATURE_BOT_BRIDGE and (re)start the bot'
      );
    } catch (err) {
      setPill(false, 'Status unavailable');
      setError('Could not read bridge status: ' + explain(err));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runAction(btnId, action, render) {
    const btn = $(btnId);
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    setError('');
    try {
      const body = await command(action);
      render((body && body.result) || {});
    } catch (err) {
      setOut('');
      setError(explain(err));
    } finally {
      if (btn) { btn.textContent = label || action; btn.disabled = false; }
    }
  }

  function renderPing(result) {
    const wrap = document.createElement('div');
    const ws = document.createElement('div');
    ws.innerHTML = '<span class="k">WebSocket ping:</span> <strong></strong>';
    ws.querySelector('strong').textContent =
      (result.wsPing == null ? '—' : (Math.round(result.wsPing) + ' ms'));
    const up = document.createElement('div');
    up.innerHTML = '<span class="k">Uptime:</span> <strong></strong>';
    up.querySelector('strong').textContent = fmtDuration(result.uptimeMs);
    wrap.appendChild(ws);
    wrap.appendChild(up);
    setOut(wrap);
  }

  function renderStatus(result) {
    const pre = document.createElement('pre');
    pre.className = 'bb-pre';
    pre.textContent = (result && result.text) ? String(result.text) : '(no status text returned)';
    setOut(pre);
  }

  function renderGuilds(result) {
    const guilds = (result && Array.isArray(result.guilds)) ? result.guilds : [];
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    const count = (result && result.count != null) ? result.count : guilds.length;
    head.innerHTML = '<span class="k">Guilds:</span> <strong></strong>';
    head.querySelector('strong').textContent = String(count);
    wrap.appendChild(head);
    if (!guilds.length) {
      const none = document.createElement('div');
      none.className = 'sub';
      none.textContent = 'No guilds.';
      wrap.appendChild(none);
      setOut(wrap);
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'bb-guilds';
    guilds.forEach((g) => {
      const li = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = g.name || g.id || '(unknown)';
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = ' · ' + (g.members != null ? g.members : 0) + ' members · '
        + (g.channels != null ? g.channels : 0) + ' channels';
      li.appendChild(name);
      li.appendChild(sub);
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    setOut(wrap);
  }

  async function init() {
    // Feature gate — defensive: the nav hides the link, but the URL can be
    // opened directly. GET /config/features is open (no token).
    let enabled = false;
    try {
      const feats = await getJSON('/config/features');
      enabled = !!(feats && feats.features && feats.features.SEEKDEEP_FEATURE_BOT_BRIDGE);
    } catch (_) { enabled = false; }

    if (!enabled) {
      show($('bb-disabled'), true);
      show($('bb-main'), false);
      return;
    }
    show($('bb-disabled'), false);
    show($('bb-main'), true);

    const refresh = $('bb-refresh');
    if (refresh) refresh.addEventListener('click', refreshStatus);
    const ping = $('bb-ping');
    if (ping) ping.addEventListener('click', () => runAction('bb-ping', 'ping', renderPing));
    const status = $('bb-status');
    if (status) status.addEventListener('click', () => runAction('bb-status', 'status', renderStatus));
    const guilds = $('bb-guilds');
    if (guilds) guilds.addEventListener('click', () => runAction('bb-guilds', 'guilds', renderGuilds));

    refreshStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
