/* SeekDeep · tts.js
   Logic for gui/tts.html — the Text-to-Speech page. Was a design-time mock
   (pointer-events lock + visual-only inline handlers); this is the live wiring.
   Talks to the Python AI server:
     • GET  /health  → reads health.tts {enabled, engine, voice} (open, no token)
     • POST /tts     → {text, voice, rate} → {ok, audio_b64 (base64 WAV), ...}
   nav.js monkey-patches window.fetch to attach X-SeekDeep-Token to same-origin
   POSTs, so we never set that header here. External (not inline) so it adds
   nothing to the script-src 'unsafe-inline' debt, and uses addEventListener
   only (no inline on*= handlers) so it stays CSP-clean. media-src 'self' data:
   blob: already allows the <audio> blob playback. Self-gates: no-ops unless the
   TTS page markup (#ttsPage) is present. */
(function () {
  'use strict';
  if (!document.getElementById('ttsPage')) return;
  if (window.__seekdeepTtsLoaded) return;
  window.__seekdeepTtsLoaded = true;

  const $ = (id) => document.getElementById(id);

  // ----- status pill ---------------------------------------------------------
  // The mock's amber "preview-banner" is reused as a live status pill; we drive
  // its text + a data-state attr (checking | ready | off | error) so styling can
  // hook in later without changing markup.
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

  // ----- helpers -------------------------------------------------------------
  async function getJSON(url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
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

  // base64 → Uint8Array (atob yields a binary string; copy charCodes into bytes)
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ----- selection state (carried over from the mock's visual handlers) ------
  // Selected voice = the active .voice tile's data-v. Default to whatever tile
  // ships marked .active, else the first tile.
  function selectedVoice() {
    const active = document.querySelector('.voice.active');
    const el = active || document.querySelector('.voice');
    return el ? (el.getAttribute('data-v') || '') : '';
  }

  function readRate() {
    const inp = $('ttsRate');
    const v = inp ? parseFloat(inp.value) : NaN;
    if (!isFinite(v)) return 1.0;
    // clamp to the input's advertised 0.5–2.0 range
    return Math.min(2.0, Math.max(0.5, v));
  }

  // ----- audio playback ------------------------------------------------------
  let objectUrl = null;
  function revokeUrl() {
    if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (_) {} objectUrl = null; }
  }

  function reflectPlaying(isPlaying) {
    const pp = $('pp');
    const wave = $('wave');
    if (pp) pp.textContent = isPlaying ? '▮▮' : '▶';
    if (wave) wave.style.filter = isPlaying ? '' : 'grayscale(1) brightness(0.6)';
  }

  function wireAudioEl() {
    const a = $('ttsAudio');
    if (!a) return;
    a.addEventListener('play', () => reflectPlaying(true));
    a.addEventListener('pause', () => reflectPlaying(false));
    a.addEventListener('ended', () => { reflectPlaying(false); revokeUrl(); });
    a.addEventListener('error', () => {
      reflectPlaying(false);
      revokeUrl();
      setStatus('error', 'Audio playback failed.');
    });
  }

  // ----- POST /tts -----------------------------------------------------------
  let speaking = false;
  async function speak() {
    if (speaking) return;
    const btn = $('ttsSpeak');
    const audio = $('ttsAudio');
    const text = ($('ttsText') && $('ttsText').value || '').trim();
    if (!text) { setStatus('error', 'Type some text first.'); return; }
    const voice = selectedVoice();
    const rate = readRate();

    speaking = true;
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '▸ Synthesizing…'; }
    setStatus('checking', 'Synthesizing…');

    try {
      // nav.js attaches X-SeekDeep-Token to this same-origin POST.
      const r = await fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ text: text, voice: voice, rate: rate })
      });
      let body = null;
      try { body = await r.json(); } catch (_) {}
      if (!r.ok || !body || body.ok === false) {
        // 503 (tts-not-configured) / 501 (tts-deps-missing) / network-ish: surface
        // the server's human-readable error verbatim.
        const msg = (body && (body.error || body.detail)) || ('HTTP ' + r.status);
        setStatus(r.status === 503 ? 'off' : 'error', msg);
        return;
      }
      if (!body.audio_b64) { setStatus('error', 'Server returned no audio.'); return; }

      revokeUrl();
      const bytes = b64ToBytes(body.audio_b64);
      const blob = new Blob([bytes], { type: 'audio/wav' });
      objectUrl = URL.createObjectURL(blob);
      if (audio) {
        audio.src = objectUrl;
        try { await audio.play(); } catch (_) { /* autoplay block — user can hit ▶ */ }
      }
      const v = body.voice || voice || '';
      const eng = body.engine ? (' · ' + body.engine) : '';
      setStatus('ready', 'Speaking' + (v ? ' · ' + v : '') + eng);
    } catch (err) {
      setStatus('error', 'Request failed: ' + (err && err.message ? err.message : err));
    } finally {
      speaking = false;
      if (btn) { btn.disabled = !ttsEnabled; btn.textContent = label || '▸ Speak'; }
    }
  }

  // ----- visual handlers (carried over from the mock's inline <script>) ------
  function wireVisuals() {
    // Play/pause toggle — now drives the real <audio> element.
    const pp = $('pp');
    const audio = $('ttsAudio');
    if (pp) {
      pp.addEventListener('click', () => {
        if (!audio || !audio.src) return;            // nothing synthesized yet
        if (audio.paused) { audio.play().catch(() => {}); } else { audio.pause(); }
      });
    }

    // Voice tile selection (ignore clicks on the inner TEST button).
    document.querySelectorAll('.voice').forEach((v) => v.addEventListener('click', (e) => {
      if (e.target && e.target.tagName === 'BUTTON') return;
      document.querySelectorAll('.voice').forEach((x) => x.classList.remove('active'));
      v.classList.add('active');
    }));

    // Per-voice TEST buttons speak that voice's sample.
    document.querySelectorAll('.voice .preview-btn').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const tile = b.closest('.voice');
      if (tile) {
        document.querySelectorAll('.voice').forEach((x) => x.classList.remove('active'));
        tile.classList.add('active');
      }
      if (!ttsEnabled) { setStatus('off', 'No TTS voice configured — set SEEKDEEP_TTS_PIPER_VOICE'); return; }
      const t = $('ttsText');
      if (t && !t.value.trim()) t.value = 'The quick brown fox jumps over the lazy dog.';
      speak();
    }));

    // Voice-channel selection — purely visual; VC playback is a Discord command
    // (@SeekDeep tts join), which the browser cannot drive.
    document.querySelectorAll('.vc').forEach((vc) => vc.addEventListener('click', () => {
      if (vc.classList.contains('locked')) return;
      document.querySelectorAll('.vc').forEach((x) => x.classList.remove('active'));
      vc.classList.add('active');
    }));

    // Pref-row toggle pills (local visual state only).
    document.querySelectorAll('.pref-row .toggle').forEach((t) =>
      t.addEventListener('click', () => t.classList.toggle('on')));
  }

  // ----- init ----------------------------------------------------------------
  let ttsEnabled = false;

  function applyEnabled(enabled, voice, engine) {
    ttsEnabled = !!enabled;
    const btn = $('ttsSpeak');
    if (ttsEnabled) {
      const v = voice || (engine ? engine : '');
      setStatus('ready', 'Ready' + (v ? ' · ' + v : ''));
      if (btn) { btn.disabled = false; btn.title = ''; }
    } else {
      setStatus('off', 'No TTS voice configured — set SEEKDEEP_TTS_PIPER_VOICE');
      if (btn) { btn.disabled = true; btn.title = 'TTS is not configured on the server'; }
    }
  }

  async function init() {
    wireVisuals();
    wireAudioEl();

    const btn = $('ttsSpeak');
    if (btn) {
      btn.disabled = true;                 // stays disabled until /health confirms
      btn.addEventListener('click', speak);
    }
    const text = $('ttsText');
    if (text) {
      // Ctrl/Cmd+Enter to speak from the textarea.
      text.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); speak(); }
      });
    }

    setStatus('checking', 'Checking…');
    try {
      const health = await getJSON('/health');
      const tts = (health && health.tts) || {};
      applyEnabled(tts.enabled, tts.voice, tts.engine);
    } catch (err) {
      // /health unreachable: don't claim "off" (which implies a config answer) —
      // report the probe failure and leave the button disabled.
      setStatus('error', 'Could not reach server: ' + (err && err.message ? err.message : err));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
