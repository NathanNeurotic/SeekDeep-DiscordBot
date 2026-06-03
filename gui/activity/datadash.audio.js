/* ============================================================================
 *  SeekDeep's DATA DASH — AUDIO ENGINE
 *  Web-Audio playback that DECODES each clip, auto-detects and trims leading /
 *  trailing silence, and plays the trimmed region. One-shots spawn a fresh
 *  source each time (so they can overlap without cutting each other off);
 *  loops play seamlessly between their trimmed edges. Music ducks for bosses.
 * ========================================================================== */
(function () {
  "use strict";
  var CFG = (window.DATADASH && window.DATADASH.SOUNDS) || { base: "", files: {}, loops: [], volumes: {} };
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { window.DDAudio = stub(); return; }

  var ctx = new AC();
  var master = ctx.createGain(); master.gain.value = 1.0; master.connect(ctx.destination);
  var musicBus = ctx.createGain(); musicBus.gain.value = 1; musicBus.connect(master);
  var MUSIC = { menuMusic: 1, music: 1, bossMusic: 1 };
  var duckUntil = 0;
  var buffers = {};          // key -> { buffer, start, end }
  var loopNodes = {};        // key -> { src, gain }
  var ready = false;
  var SILENCE = 0.015;       // amplitude threshold for "silence" — tighter trim

  function vol(key) { return (CFG.volumes && CFG.volumes[key] != null) ? CFG.volumes[key] : 1; }

  function trimBounds(buf) {
    // Gemini: an empty/corrupt decode can yield 0 channels; getChannelData(0)
    // would throw IndexSizeError. Treat it as "nothing to trim".
    if (!buf.numberOfChannels) return { start: 0, end: buf.duration };
    var ch = buf.getChannelData(0);
    var n = ch.length, i, s = 0, e = n - 1;
    for (i = 0; i < n; i++) { if (Math.abs(ch[i]) > SILENCE) { s = i; break; } }
    for (i = n - 1; i > s; i--) { if (Math.abs(ch[i]) > SILENCE) { e = i; break; } }
    // pad a hair so we never clip the attack/tail
    var pad = Math.floor(buf.sampleRate * 0.003);
    s = Math.max(0, s - pad); e = Math.min(n - 1, e + pad);
    return { start: s / buf.sampleRate, end: e / buf.sampleRate };
  }

  function load(key, url) {
    return fetch(url).then(function (r) {
      // Gemini: fail fast on 404/etc. so an HTML error body never reaches
      // decodeAudioData (it would reject into the catch below anyway).
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.arrayBuffer();
    })
      .then(function (ab) { return ctx.decodeAudioData(ab); })
      .then(function (buf) { var b = trimBounds(buf); buffers[key] = { buffer: buf, start: b.start, end: b.end }; })
      .catch(function () { /* missing/undecodable — skip silently */ });
  }

  function loadAll() {
    var base = CFG.base || "", files = CFG.files || {}, ps = [];
    Object.keys(files).forEach(function (k) { ps.push(load(k, base + encodeURIComponent(files[k]))); });
    return Promise.all(ps).then(function () { ready = true; });
  }

  function play(key, opts) {
    opts = opts || {};
    var rec = buffers[key];
    if (!rec || ctx.state !== "running") return null;
    var src = ctx.createBufferSource();
    src.buffer = rec.buffer;
    var g = ctx.createGain();
    g.gain.value = (opts.volume != null ? opts.volume : vol(key)) * (opts.gain != null ? opts.gain : 1);
    src.connect(g); g.connect(MUSIC[key] ? musicBus : master);
    var dur = Math.max(0.02, rec.end - rec.start);
    if (opts.loop) { src.loop = true; src.loopStart = rec.start; src.loopEnd = rec.end; src.start(0, rec.start); }
    else { src.start(0, rec.start, dur); if (!MUSIC[key]) duck(opts.duck != null ? opts.duck : 0.32, dur); }
    return { src: src, gain: g };
  }

  // sidechain-style ducking: briefly dip the music bus while SFX play so they cut through
  function duck(amount, holdSec) {
    if (ctx.state !== "running") return;
    var now = ctx.currentTime, until = now + Math.min(0.9, 0.12 + (holdSec || 0.2));
    if (until <= duckUntil) return;   // a deeper/longer duck already in flight
    duckUntil = until;
    var lvl = Math.max(0.25, 1 - amount);
    try {
      musicBus.gain.cancelScheduledValues(now);
      musicBus.gain.setTargetAtTime(lvl, now, 0.04);          // dip fast
      musicBus.gain.setTargetAtTime(1, until, 0.22);          // recover smoothly
    } catch (e) {}
  }

  var DD = {
    init: function () {
      if (ctx.state !== "running") ctx.resume().then(applyWantMusic);
      if (!DD._loading) { DD._loading = loadAll().then(applyWantMusic); }
      return DD._loading;
    },
    resume: function () { if (ctx.state !== "running") ctx.resume().then(applyWantMusic); },
    ready: function () { return ready; },
    play: function (key, opts) { return play(key, opts); },
    // sustained loops — start once, stop by key
    startLoop: function (key, opts) {
      if (loopNodes[key]) return;
      var node = play(key, Object.assign({ loop: true }, opts || {}));
      if (node) loopNodes[key] = node;
    },
    stopLoop: function (key, fade) {
      var node = loopNodes[key]; if (!node) return;
      delete loopNodes[key];
      if (fade) { try { node.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15); } catch (e) {} setTimeout(function () { try { node.src.stop(); } catch (e) {} }, 400); }
      else { try { node.src.stop(); } catch (e) {} }
    },
    isLooping: function (key) { return !!loopNodes[key]; },
    // live-adjust a running loop's gain (used for proximity-based SFX)
    setLoopVolume: function (key, v) {
      var node = loopNodes[key]; if (!node) return;
      try { node.gain.gain.setTargetAtTime(Math.max(0, v), ctx.currentTime, 0.07); }
      catch (e) { try { node.gain.gain.value = Math.max(0, v); } catch (e2) {} }
    },
    // exclusive music track: stops the others, starts this one. Latches the
    // desired track so it (re)starts once buffers load / the context resumes.
    music: function (key) {
      DD._wantMusic = key;
      ["menuMusic", "music", "bossMusic"].forEach(function (m) { if (m !== key && loopNodes[m]) DD.stopLoop(m, true); });
      if (key && !loopNodes[key]) DD.startLoop(key);
    },
    stopAllMusic: function () { DD._wantMusic = null; ["menuMusic", "music", "bossMusic"].forEach(function (m) { DD.stopLoop(m, true); }); },
    muted: false,
    toggleMute: function () { DD.muted = !DD.muted; try { master.gain.setTargetAtTime(DD.muted ? 0 : 1.0, ctx.currentTime, 0.02); } catch (e) { master.gain.value = DD.muted ? 0 : 1.0; } return DD.muted; },
  };
  function applyWantMusic() {
    var key = DD._wantMusic;
    if (key && !loopNodes[key] && buffers[key] && ctx.state === "running") DD.startLoop(key);
  }
  window.DDAudio = DD;

  function stub() {
    var noop = function () {};
    return { init: noop, resume: noop, ready: function () { return false; }, play: noop, startLoop: noop, stopLoop: noop, setLoopVolume: noop, isLooping: function () { return false; }, music: noop, stopAllMusic: noop };
  }
})();
