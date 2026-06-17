/* SeekDeep · tts.js
   Live wiring for gui/tts.html — the Text-to-Speech setup + tester page.
   Self-service flow: list curated Piper voices, one-click download, auto-configure
   + enable, then Speak to test. Talks to the Python AI server:
     • GET  /health             → health.tts {enabled, engine, voice} (open)
     • GET  /tts/voices         → curated catalog + which are downloaded/active (open)
     • POST /tts/voices/download → download a voice's .onnx/.onnx.json + activate live
     • POST /config            → persist SEEKDEEP_TTS_* to .env (survives restart)
     • POST /tts                → {text, voice, rate} → {ok, audio_b64 (WAV)}
   nav.js monkey-patches fetch to attach X-SeekDeep-Token to same-origin POSTs, so
   we never set that header here. External + addEventListener-only (CSP-clean).
   Self-gates: no-ops unless #ttsPage is present. */
(function () {
  'use strict';
  if (!document.getElementById('ttsPage')) return;
  if (window.__seekdeepTtsLoaded) return;
  window.__seekdeepTtsLoaded = true;

  const $ = (id) => document.getElementById(id);

  // ----- status pill ---------------------------------------------------------
  function setStatus(state, label) {
    const el = $('ttsStatus');
    if (!el) return;
    el.dataset.state = state;
    el.textContent = '';
    const tag = document.createElement('strong');
    tag.textContent = '● TTS';
    el.appendChild(tag);
    el.appendChild(document.createTextNode(' · ' + label));
  }

  async function getJSON(url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
    let body = null; try { body = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error((body && (body.detail || body.error)) || ('HTTP ' + r.status)); e.status = r.status; e.body = body; throw e; }
    return body || {};
  }
  async function postJSON(url, payload) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    let body = null; try { body = await r.json(); } catch (_) {}
    if (!r.ok || (body && body.ok === false)) {
      const e = new Error((body && (body.error || body.detail)) || ('HTTP ' + r.status)); e.status = r.status; e.body = body; throw e;
    }
    return body || {};
  }

  function b64ToBytes(b64) {
    const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ----- state ---------------------------------------------------------------
  let ttsEnabled = false;     // a voice is configured (server can synthesize)
  let activeVoiceKey = '';    // catalog key of the configured voice, if any
  let busy = false;           // a download/use op is in flight

  function selectedVoice() {
    // Piper synthesis uses the engine's *configured* voice (the one you
    // downloaded/activated); the /tts route ignores a per-call voice for Piper.
    // Send empty so the server uses + echoes whatever voice is configured.
    return '';
  }

  function readRate() {
    const inp = $('ttsRate'); const v = inp ? parseFloat(inp.value) : NaN;
    if (!isFinite(v)) return 1.0;
    return Math.min(2.0, Math.max(0.5, v));
  }

  // ----- voice catalog (GET /tts/voices → render #voiceGrid) -----------------
  async function loadVoices() {
    const grid = $('voiceGrid');
    if (!grid) return;
    grid.textContent = 'Loading voices…';
    let data;
    try { data = await getJSON('/tts/voices'); }
    catch (err) { grid.textContent = ''; const p = document.createElement('div'); p.className = 'meta'; p.textContent = 'Could not load voice catalog: ' + (err && err.message ? err.message : err); grid.appendChild(p); return; }
    renderVoices(data);
  }

  function renderVoices(data) {
    const grid = $('voiceGrid');
    if (!grid) return;
    grid.textContent = '';
    activeVoiceKey = '';
    const voices = (data && Array.isArray(data.voices)) ? data.voices : [];
    if (!voices.length) { const p = document.createElement('div'); p.className = 'meta'; p.textContent = 'No voices in the catalog.'; grid.appendChild(p); return; }

    voices.forEach((v) => {
      if (v.active) activeVoiceKey = v.key;
      const tile = document.createElement('div');
      tile.className = 'voice' + (v.active ? ' active' : '');
      tile.setAttribute('data-v', v.key);

      const av = document.createElement('div'); av.className = 'av';
      av.textContent = (v.label || v.key || '?').slice(0, 1).toUpperCase();

      const mid = document.createElement('div');
      const name = document.createElement('div'); name.textContent = v.label || v.key;
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = [v.gender, v.lang, (v.size_mb ? v.size_mb + ' MB' : '')].filter(Boolean).join(' · ');
      mid.appendChild(name); mid.appendChild(meta);

      const btn = document.createElement('button');
      btn.className = 'preview-btn';
      btn.setAttribute('data-key', v.key);
      if (v.active) { btn.textContent = '✓ ACTIVE'; btn.disabled = true; }
      else if (v.downloaded) { btn.textContent = '▸ USE'; }
      else { btn.textContent = '▼ ' + (v.size_mb || '') + 'MB'; btn.title = 'Download + use this voice'; }
      btn.addEventListener('click', (e) => { e.stopPropagation(); onVoiceAction(v, btn); });

      tile.appendChild(av); tile.appendChild(mid); tile.appendChild(btn);
      grid.appendChild(tile);
    });
  }

  // ----- download / use a voice ----------------------------------------------
  async function onVoiceAction(v, btn) {
    if (busy) return;
    busy = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = v.downloaded ? '▸ Switching…' : '▼ Downloading…';
    setStatus('checking', v.downloaded ? ('Activating ' + v.label + '…') : ('Downloading ' + v.label + ' (' + (v.size_mb || '?') + ' MB)…'));
    try {
      // Download (idempotent — cached if already present) + activate live.
      const res = await postJSON('/tts/voices/download', { key: v.key });
      // Persist to .env so it survives a restart + enable the Discord bot reader.
      try {
        await postJSON('/config', { updates: {
          SEEKDEEP_TTS_ENGINE: 'piper',
          SEEKDEEP_TTS_PIPER_VOICE: res.voice_path || '',
          SEEKDEEP_FEATURE_TTS_VOICE: 'on',
        } });
      } catch (cfgErr) {
        // The voice IS active live; persistence just failed (e.g. token). Warn but continue.
        setStatus('ready', 'Active (not saved to .env: ' + (cfgErr && cfgErr.message ? cfgErr.message : cfgErr) + ')');
      }
      await loadVoices();
      try { const h = await getJSON('/health'); applyEnabled((h.tts || {}).enabled, (h.tts || {}).voice, (h.tts || {}).engine); } catch (_) {}
      setStatus('ready', v.label + ' ready — type text and hit Speak to test.');
    } catch (err) {
      setStatus('error', 'Voice setup failed: ' + (err && err.message ? err.message : err));
      btn.textContent = label; btn.disabled = false;
    } finally {
      busy = false;
    }
  }

  // ----- audio playback ------------------------------------------------------
  let objectUrl = null;
  function revokeUrl() { if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (_) {} objectUrl = null; } }
  function reflectPlaying(p) { const pp = $('pp'); const w = $('wave'); if (pp) pp.textContent = p ? '▮▮' : '▶'; if (w) w.style.filter = p ? '' : 'grayscale(1) brightness(0.6)'; }
  function wireAudioEl() {
    const a = $('ttsAudio'); if (!a) return;
    a.addEventListener('play', () => reflectPlaying(true));
    a.addEventListener('pause', () => reflectPlaying(false));
    a.addEventListener('ended', () => { reflectPlaying(false); revokeUrl(); });
    a.addEventListener('error', () => { reflectPlaying(false); revokeUrl(); setStatus('error', 'Audio playback failed.'); });
  }

  // ----- POST /tts (test) ----------------------------------------------------
  let speaking = false;
  async function speak() {
    if (speaking) return;
    if (!ttsEnabled) { setStatus('off', 'Download a voice first (right panel) to enable TTS.'); return; }
    const btn = $('ttsSpeak'); const audio = $('ttsAudio');
    const text = ($('ttsText') && $('ttsText').value || '').trim();
    if (!text) { setStatus('error', 'Type some text first.'); return; }
    speaking = true;
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '▸ Synthesizing…'; }
    setStatus('checking', 'Synthesizing…');
    try {
      const r = await fetch('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ text: text, voice: selectedVoice(), rate: readRate() }) });
      let body = null; try { body = await r.json(); } catch (_) {}
      if (!r.ok || !body || body.ok === false) { setStatus(r.status === 503 ? 'off' : 'error', (body && (body.error || body.detail)) || ('HTTP ' + r.status)); return; }
      if (!body.audio_b64) { setStatus('error', 'Server returned no audio.'); return; }
      revokeUrl();
      objectUrl = URL.createObjectURL(new Blob([b64ToBytes(body.audio_b64)], { type: 'audio/wav' }));
      if (audio) { audio.src = objectUrl; try { await audio.play(); } catch (_) {} }
      const nt = $('nowText'); if (nt) nt.textContent = text;
      setStatus('ready', 'Speaking · ' + (body.voice || selectedVoice() || '') + (body.engine ? ' · ' + body.engine : ''));
    } catch (err) {
      setStatus('error', 'Request failed: ' + (err && err.message ? err.message : err));
    } finally {
      speaking = false; if (btn) { btn.disabled = !ttsEnabled; btn.textContent = label || '▸ Speak'; }
    }
  }

  function applyEnabled(enabled, voice, engine) {
    ttsEnabled = !!enabled;
    const btn = $('ttsSpeak');
    if (ttsEnabled) {
      setStatus('ready', 'Ready' + (voice ? ' · ' + voice.split(/[\\/]/).pop() : (engine ? ' · ' + engine : '')));
      if (btn) { btn.disabled = false; btn.title = ''; }
    } else {
      setStatus('off', 'No voice yet — pick one on the right and hit download.');
      if (btn) { btn.disabled = true; btn.title = 'Download a Piper voice first'; }
    }
  }

  async function init() {
    wireAudioEl();
    const btn = $('ttsSpeak');
    if (btn) { btn.disabled = true; btn.addEventListener('click', speak); }
    const text = $('ttsText');
    if (text) text.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); speak(); } });
    const pp = $('pp');
    if (pp) pp.addEventListener('click', () => { const a = $('ttsAudio'); if (!a || !a.src) return; if (a.paused) a.play().catch(() => {}); else a.pause(); });

    setStatus('checking', 'Checking…');
    try {
      const health = await getJSON('/health');
      applyEnabled((health.tts || {}).enabled, (health.tts || {}).voice, (health.tts || {}).engine);
    } catch (err) {
      setStatus('error', 'Could not reach server: ' + (err && err.message ? err.message : err));
    }
    await loadVoices();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
