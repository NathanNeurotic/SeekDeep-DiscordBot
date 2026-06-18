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

  // Tauri serves bundled pages from tauri.localhost — server calls must target
  // the loopback API base, not the page origin (a relative fetch never reaches
  // the Python server in the desktop app). Mirrors api.page.js / app.page2.js.
  const BASE = (function () {
    try { if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase(); } catch (_) {}
    if (window.__TAURI__ || (window.location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    return (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
  })();

  function setError(msg) {
    const e = $('bb-error');
    if (!e) return;
    if (!msg) { e.textContent = ''; show(e, false); return; }
    e.textContent = msg;
    show(e, true);
  }

  async function getJSON(url, opts) {
    const r = await fetch(BASE + url, opts || { headers: { 'Accept': 'application/json' } });
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

  // POST a JSON body to a REST endpoint (token auto-attached by nav.js). Used by
  // the persisted-setting controls (e.g. default vision mode) that write a config
  // file via Python rather than going over the WS command bridge — so they work
  // even when the bot isn't connected to the bus.
  async function postJSON(url, payload) {
    const r = await fetch(BASE + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload || {}),
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
    return body || {};
  }

  // POST /bot/command {action}. nav.js auto-attaches the GUI token. The server
  // wraps the bot reply in {ok, cid, result, error}; surface `error` on a
  // logical failure even when the HTTP status is 200.
  async function command(action, args) {
    const r = await fetch(BASE + '/bot/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(args ? { action, args } : { action }),
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

  // ----- Discord bindings (per-guild digest + auto-translate channels) -------
  // bindings.get returns each guild's current bindings + its text channels;
  // bindings.set writes one binding (live, no restart). Rendered as per-guild
  // rows with a <select> per binding; changing a select fires bindings.set.
  function mkChannelSelect(guild, kind, currentId) {
    const sel = document.createElement('select');
    const off = document.createElement('option');
    off.value = ''; off.textContent = '— off —';
    sel.appendChild(off);
    (guild.channels || []).forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = '#' + c.name;
      sel.appendChild(o);
    });
    sel.value = currentId || '';
    sel.addEventListener('change', () => setBinding(guild.id, kind, sel.value, sel));
    return sel;
  }

  function renderBindings(guilds) {
    const box = $('bb-bindings');
    if (!box) return;
    box.textContent = '';
    if (!guilds.length) {
      const none = document.createElement('div');
      none.className = 'sub'; none.textContent = 'No guilds.';
      box.appendChild(none); return;
    }
    guilds.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'bb-bind-row';
      const name = document.createElement('div');
      name.className = 'bb-bind-guild';
      name.textContent = g.name || g.id || '(unknown)';
      row.appendChild(name);
      const fields = document.createElement('div');
      fields.className = 'bb-bind-fields';
      [['digest', 'Daily digest', g.digestChannelId],
       ['translate', 'Auto-translate', g.translateChannelId]].forEach(function (spec) {
        const f = document.createElement('div');
        f.className = 'bb-bind-field';
        const l = document.createElement('span');
        l.className = 'lbl'; l.textContent = spec[1];
        f.appendChild(l);
        f.appendChild(mkChannelSelect(g, spec[0], spec[2]));
        fields.appendChild(f);
      });
      row.appendChild(fields);
      box.appendChild(row);
    });
  }

  async function loadBindings() {
    const btn = $('bb-bind-load');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    setError('');
    try {
      const body = await command('bindings.get');
      renderBindings((((body && body.result) || {}).guilds) || []);
    } catch (err) {
      setError('Could not load bindings: ' + explain(err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Load bindings'; }
    }
  }

  async function setBinding(guildId, kind, channelId, sel) {
    if (sel) sel.disabled = true;
    setError('');
    try {
      await command('bindings.set', { guildId: guildId, kind: kind, channelId: channelId });
      if (window.SeekDeepNotify && window.SeekDeepNotify.toast) {
        window.SeekDeepNotify.toast({
          tone: 'good',
          title: (kind === 'digest' ? 'Daily-digest' : 'Auto-translate') + ' channel ' + (channelId ? 'set' : 'cleared'),
          ttl: 3000,
        });
      }
    } catch (err) {
      setError('Could not update binding: ' + explain(err));
      loadBindings(); // re-sync the selects to server truth on failure
    } finally {
      if (sel) sel.disabled = false;
    }
  }

  // ----- Image queue (status + clear) ---------------------------------------
  // queue.status returns {active, pendingCount, pending:[…], completed, failed};
  // queue.clear drops the pending jobs (active keeps running) and returns
  // {cleared, activeKept}.
  function bbQueueJobLi(job, isActive) {
    const li = document.createElement('li');
    if (isActive) li.className = 'active';
    const b = document.createElement('b');
    b.textContent = (isActive ? '▶ ' : '') + (job.prompt || '(no prompt)');
    const sub = document.createElement('span');
    sub.className = 'sub';
    const dims = (job.width && job.height) ? (job.width + '×' + job.height) : '';
    sub.textContent = ' · ' + [job.source, dims, 'user ' + (job.userId || '?')].filter(Boolean).join(' · ');
    li.appendChild(b);
    li.appendChild(sub);
    return li;
  }

  function renderQueue(result) {
    const box = $('bb-queue');
    if (!box) return;
    box.textContent = '';
    const r = result || {};
    const pendingCount = r.pendingCount || 0;
    const stat = document.createElement('div');
    stat.className = 'bb-queue-stat';
    const mk = (label, val, warn) => {
      const s = document.createElement('div');
      s.className = 's' + (warn ? ' warn' : '');
      const b = document.createElement('b');
      b.textContent = String(val);
      s.appendChild(b);
      s.appendChild(document.createTextNode(' ' + label));
      return s;
    };
    stat.appendChild(mk('active', r.active ? 1 : 0));
    stat.appendChild(mk('pending', pendingCount, pendingCount > 0));
    stat.appendChild(mk('completed', r.completed || 0));
    stat.appendChild(mk('failed', r.failed || 0));
    box.appendChild(stat);

    const list = document.createElement('ul');
    list.className = 'bb-queue-list';
    if (r.active) list.appendChild(bbQueueJobLi(r.active, true));
    (r.pending || []).forEach((j) => list.appendChild(bbQueueJobLi(j, false)));
    if (!r.active && !(r.pending || []).length) {
      const li = document.createElement('li');
      li.className = 'sub';
      li.textContent = 'Queue is empty.';
      list.appendChild(li);
    }
    box.appendChild(list);
  }

  async function loadQueue() {
    const btn = $('bb-queue-load');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    setError('');
    try {
      const body = await command('queue.status');
      renderQueue((body && body.result) || {});
    } catch (err) {
      setError('Could not load the image queue: ' + explain(err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
    }
  }

  async function clearQueue() {
    const confirmFn = window.SeekDeepConfirm || window.confirm;
    const ok = await confirmFn('Clear all pending image jobs?\nThe job currently generating keeps running; waiting jobs are dropped and their requesters get a cancelled notice.');
    if (!ok) return;
    const btn = $('bb-queue-clear');
    if (btn) { btn.disabled = true; btn.textContent = 'Clearing…'; }
    setError('');
    try {
      const body = await command('queue.clear');
      const res = (body && body.result) || {};
      if (window.SeekDeepNotify && window.SeekDeepNotify.toast) {
        window.SeekDeepNotify.toast({
          tone: 'good',
          title: 'Image queue cleared',
          body: (res.cleared || 0) + ' pending job(s) dropped' + (res.activeKept ? ' · active job kept running' : ''),
          ttl: 3500,
        });
      }
      loadQueue();
    } catch (err) {
      setError('Could not clear the image queue: ' + explain(err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Clear pending'; }
    }
  }

  // ----- Say (operator send-to-channel) -------------------------------------
  // Reuses bindings.get for the guild+channel picker data (same {guilds:[{id,
  // name,channels:[…]}]} shape), then posts via the `say` action. The server
  // strips mentions, so a typed message can't ping the channel.
  let bbSayGuilds = [];

  function updateSayCount() {
    const txt = $('bb-say-text');
    const cnt = $('bb-say-count');
    if (txt && cnt) cnt.textContent = txt.value.length + ' / 2000';
  }

  function populateSayChannels() {
    const gSel = $('bb-say-guild');
    const cSel = $('bb-say-channel');
    if (!gSel || !cSel) return;
    const g = bbSayGuilds.find((x) => x.id === gSel.value);
    cSel.textContent = '';
    const chans = (g && g.channels) || [];
    if (!chans.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(no text channels)';
      cSel.appendChild(o);
      return;
    }
    chans.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = '#' + c.name;
      cSel.appendChild(o);
    });
  }

  async function loadSayTargets() {
    const btn = $('bb-say-load');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    setError('');
    try {
      const body = await command('bindings.get');
      bbSayGuilds = (((body && body.result) || {}).guilds) || [];
      const gSel = $('bb-say-guild');
      if (gSel) {
        gSel.textContent = '';
        if (!bbSayGuilds.length) {
          const o = document.createElement('option');
          o.value = ''; o.textContent = '(no servers)';
          gSel.appendChild(o);
        } else {
          bbSayGuilds.forEach((g) => {
            const o = document.createElement('option');
            o.value = g.id; o.textContent = g.name || g.id;
            gSel.appendChild(o);
          });
        }
      }
      populateSayChannels();
      show($('bb-say-form'), true);
    } catch (err) {
      setError('Could not load servers: ' + explain(err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Load servers'; }
    }
  }

  async function sendSay() {
    const gSel = $('bb-say-guild');
    const cSel = $('bb-say-channel');
    const txt = $('bb-say-text');
    const guildId = gSel ? gSel.value : '';
    const channelId = cSel ? cSel.value : '';
    const content = txt ? txt.value : '';
    if (!guildId || !channelId) { setError('Pick a server and channel first.'); return; }
    if (!content.trim()) { setError('Type a message to send.'); return; }
    const btn = $('bb-say-send');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    setError('');
    try {
      const body = await command('say', { guildId: guildId, channelId: channelId, content: content });
      const res = (body && body.result) || {};
      if (window.SeekDeepNotify && window.SeekDeepNotify.toast) {
        window.SeekDeepNotify.toast({ tone: 'good', title: 'Message sent', body: 'to #' + (res.channelName || channelId), ttl: 3000 });
      }
      if (txt) { txt.value = ''; updateSayCount(); }
    } catch (err) {
      setError('Could not send: ' + explain(err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
    }
  }

  // ----- Default vision mode (describe vs OCR) ------------------------------
  // GET/POST /bot/vision-mode persist the bot's DEFAULT @mention-image behavior
  // to data/vision-mode-config.json (Python writes; the bot live-reads). REST,
  // not the WS bridge, so it works even when the bot is offline. A per-message
  // cue always overrides this default — it only decides the ambiguous case.
  function renderVisionMode(mode) {
    const m = (mode === 'ocr') ? 'ocr' : 'describe';
    const dBtn = $('bb-vision-describe');
    const oBtn = $('bb-vision-ocr');
    if (dBtn) dBtn.classList.toggle('sel', m === 'describe');
    if (oBtn) oBtn.classList.toggle('sel', m === 'ocr');
    const pill = $('bb-vision-state');
    const label = $('bb-vision-state-text');
    if (label) label.textContent = (m === 'ocr') ? 'OCR · text extraction' : 'Describe · caption';
    if (pill) { pill.classList.remove('off'); pill.classList.add('on'); }
  }

  async function loadVisionMode() {
    try {
      const body = await getJSON('/bot/vision-mode');
      renderVisionMode(body && body.mode);
    } catch (err) {
      const label = $('bb-vision-state-text');
      if (label) label.textContent = 'unavailable';
      const pill = $('bb-vision-state');
      if (pill) { pill.classList.remove('on'); pill.classList.add('off'); }
      setError('Could not read the default vision mode: ' + explain(err));
    }
  }

  async function setVisionMode(mode) {
    const dBtn = $('bb-vision-describe');
    const oBtn = $('bb-vision-ocr');
    if (dBtn) dBtn.disabled = true;
    if (oBtn) oBtn.disabled = true;
    setError('');
    try {
      const body = await postJSON('/bot/vision-mode', { mode: mode });
      const applied = (body && body.mode) || mode;
      renderVisionMode(applied);
      if (window.SeekDeepNotify && window.SeekDeepNotify.toast) {
        window.SeekDeepNotify.toast({
          tone: 'good',
          title: 'Default vision mode set',
          body: (applied === 'ocr') ? 'OCR — text extraction' : 'Describe — caption / analyze',
          ttl: 3000,
        });
      }
    } catch (err) {
      setError('Could not set the default vision mode: ' + explain(err));
      loadVisionMode(); // re-sync the buttons to server truth on failure
    } finally {
      if (dBtn) dBtn.disabled = false;
      if (oBtn) oBtn.disabled = false;
    }
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
    const bindLoad = $('bb-bind-load');
    if (bindLoad) bindLoad.addEventListener('click', loadBindings);
    const queueLoad = $('bb-queue-load');
    if (queueLoad) queueLoad.addEventListener('click', loadQueue);
    const queueClear = $('bb-queue-clear');
    if (queueClear) queueClear.addEventListener('click', clearQueue);
    const sayLoad = $('bb-say-load');
    if (sayLoad) sayLoad.addEventListener('click', loadSayTargets);
    const sayGuild = $('bb-say-guild');
    if (sayGuild) sayGuild.addEventListener('change', populateSayChannels);
    const sayText = $('bb-say-text');
    if (sayText) sayText.addEventListener('input', updateSayCount);
    const saySend = $('bb-say-send');
    if (saySend) saySend.addEventListener('click', sendSay);
    const visDescribe = $('bb-vision-describe');
    if (visDescribe) visDescribe.addEventListener('click', () => setVisionMode('describe'));
    const visOcr = $('bb-vision-ocr');
    if (visOcr) visOcr.addEventListener('click', () => setVisionMode('ocr'));

    refreshStatus();
    loadVisionMode();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
