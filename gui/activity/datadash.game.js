/* ============================================================================
 *  SeekDeep's DATA DASH — ENGINE
 *  Reskinnable helicopter-style runner. Config lives in datadash.config.js.
 *  This file is the plumbing; you shouldn't need to touch it to retheme.
 * ========================================================================== */
(function () {
  "use strict";

  const CFG = window.DATADASH;
  const { TEXT, SPRITES, COLORS: C, FONTS, TUNING: T } = CFG;

  // ---- canvas / scaling ----------------------------------------------------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1;

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;   // layout not ready yet — frame() will retry (fixes first-launch white screen)
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    // worldScale > 1 "zooms out": the logical play-field is larger than the
    // viewport, so more of the course is visible and the ball is smaller
    // relative to it — more room to read and navigate obstacles.
    const Z = T.worldScale || 1;
    canvas.width = Math.round(r.width * DPR);
    canvas.height = Math.round(r.height * DPR);
    W = Math.round(r.width * Z);
    H = Math.round(r.height * Z);
    const s = DPR / Z;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (game) game.px = W * T.playerX;   // keep the player anchored across resizes
    buildTiles();
  }
  window.addEventListener("resize", resize);

  // ---- sprites -------------------------------------------------------------
  function loadImg(src) { if (!src) return null; const i = new Image(); i.src = src; return i; }
  const imgPlayer = loadImg(SPRITES.player.src);
  const imgBoss = loadImg(SPRITES.boss.src);
  // pixel-DeepSeek animation frames (flight + overdrive flight)
  const flyFrames = ["assets/seekdeep/fly1.png"].map(loadImg);
  const odFrames  = ["assets/seekdeep/od1.png"].map(loadImg);
  const imgPower  = loadImg("assets/seekdeep/power.png");   // electric power-pose (transform)
  const imgPepe   = loadImg("assets/seekdeep/pepe.png");    // pepe coin art
  const imgShield = loadImg("assets/seekdeep/shieldpepe.png"); // shield pickup icon
  // main-menu power-up / power-down loop frames — PRE-ALIGNED sprite sheet
  // (body pixel-locked across every frame; aligned_01 = full electric aura → aligned_10 = calm)
  const menuFrames = [];
  for (let i = 1; i <= 10; i++) menuFrames.push(loadImg("assets/seekdeep/menu/aligned_" + String(i).padStart(2, "0") + ".png"));
  const SPR_AR = 602 / 413;   // source frame aspect ratio (fly1)
  const OD_AR  = 718 / 540;   // overdrive frame aspect ratio (od1)
  const POW_AR = 346 / 361;   // power pose aspect ratio

  // ---- HUD elements --------------------------------------------------------
  const hud = {
    dist:  document.getElementById("hud-dist"),
    best:  document.getElementById("hud-best"),
    lives: document.getElementById("hud-lives"),
    timerWrap: document.getElementById("hud-timer"),
    timerVal:  document.getElementById("hud-timer-val"),
    timerFill: document.getElementById("hud-timer-fill"),
    timerLabel:document.getElementById("hud-timer-label"),
    fx:        document.getElementById("hud-fx"),
    banner:    document.getElementById("banner"),
    overlay:   document.getElementById("overlay"),
    ovTitle:   document.getElementById("ov-title"),
    ovSub:     document.getElementById("ov-sub"),
    ovBtn:     document.getElementById("ov-btn"),
    ovBest:    document.getElementById("ov-best"),
    ovControls:document.getElementById("ov-controls"),
    pause:     document.getElementById("pause"),
    controls:  document.getElementById("controls-modal"),
    scores:    document.getElementById("scoreboard"),
    scoreEntry:document.getElementById("score-entry"),
    scoreName: document.getElementById("score-name"),
    menuSprite:document.getElementById("menu-sprite"),
  };

  // ---- state ---------------------------------------------------------------
  const STATE = { MENU: "menu", PLAY: "play", DEAD: "dead" };
  const SFX = function (k, o) { if (window.DDAudio) window.DDAudio.play(k, o); };
  let state = STATE.MENU;
  let best = +(localStorage.getItem("datadash.best") || 0);

  let game = null;
  function newGame() {
    game = {
      t: 0,
      dist: 0,                 // world px traveled
      bytes: 0,
      streamed: 0,             // monotonic bytes-ever-streamed → drives spawns
      gross: 0,                // total gross accumulation (distance + collected) → Pepe
      nextPepe: 0,
      nextPepeT: T.pepeEverySec + Math.random() * T.pepeRandSec,   // first Pepe window (seconds)
      nextElementalT: 42,      // first DATA LOSS / RECOVERY event window (seconds); then ≥ elementalEvery apart
      invincible: 0,           // Pepe invincibility timer
      flashT: 0,               // full-screen flash intensity
      floaters: [],            // tiny "+kb" pickup texts
      lives: T.startLives,
      invuln: 0,
      shield: false,           // SHIELD pickup state — absorbs the next hit
      scroll: T.scrollStart,
      // player
      px: 0, py: 0, vy: 0, vx: 0,
      // terrain
      cols: [],                // {ceil, floor, blocks:[{y,h}]}
      genX: 0,                 // world-x of next column to generate
      baseCenter: 0.5, baseCenterTarget: 0.5, feat: { type: "open", amt: 0 },
      cTop: 0.18, cBot: 0.82,
      featCol: 0, featLen: T.featMax,
      holdCols: 0, obsCooldown: 8,
      laneY: 0.5, laneTarget: 0.5, laneCol: 0,
      // progression
      nextCheckpoint: T.checkpointEvery,
      nextBonus: 0,            // emergency packs (spawn while at 1 kernel)
      bossClock: 0,            // seconds of boss-free survival → triggers the next boss
      nextMystery: T.mysteryEvery * (0.6 + Math.random() * 0.8),
      nextPacket: T.packetEvery,
      nextBossPacket: 0,       // boss-fight ammo-relief packet strips (when DATA is low)
      botTimer: T.botSpawnSeconds,   // independent mini-malware respawn clock
      nextUpgrade: T.upgradeEvery,
      freeAmmo: false,
      odHits: 0, poweringDown: 0,
      transform: 0,
      bombs: [],
      pickups: [],             // {x,y,grabbed,kind}
      bots: [],
      scrollFx: null,          // { kind:'fast'|'slow'|'reverse', t }
      // boss
      boss: null,
      boss2: null,             // second daemon during a Double Boss event
      _bossesActive: false,
      event: null,             // active random event { kind, dist, length, ... }
      nextEventT: 50 + Math.random() * 40,   // first random-event window (seconds)
      bullets: [],
      bars: [],
      playerBullets: [],
      playerFire: 0,
      shooting: false,
      tapFire: false,          // one-shot request from the touch FIRE button
      charging: false, chargeT: 0,
      particles: [],
      shake: 0,
      // banners
      bannerT: 0,
    };
    game.px = W * T.playerX;
    game.py = H * 0.5;
    seedTerrain();
  }

  // ---- terrain generation : continuous safe corridor -----------------------
  function curScroll() {
    const k = Math.min(1, game.bytes / T.scrollRampBytes);
    return T.scrollStart + (T.scrollMax - T.scrollStart) * k;
  }

  function pickFeature() {
    const em = T.edgeMargin;
    const openHalf = T.maxGapFrac / 2;
    const slopeFrac = T.wallSlopePx / H;
    const diff = Math.min(1, game.bytes / T.corridorRampBytes);
    const r = Math.random();
    let type, amt = 0, len;
    if (r < 0.22) type = "open";
    else if (r < 0.46) type = "floorTower";
    else if (r < 0.70) type = "ceilTower";
    else if (r < 0.85) type = "pinch";
    else type = "ramp";

    if (type === "floorTower" || type === "ceilTower") {
      amt = (T.towerMin + Math.random() * (T.towerMax - T.towerMin)) * (1 + diff * 0.15);
    } else if (type === "pinch") {
      amt = T.pinchAmt * (0.7 + Math.random() * 0.4) * (1 + diff * 0.12);
    }
    // cap amt so a tower always leaves the minimum channel
    amt = Math.min(amt, openHalf * 2 - T.minGapFrac - 0.02);

    if (amt > 0) {
      const rampCols = Math.max(3, Math.ceil(amt / slopeFrac));
      len = Math.round(rampCols / T.rampFrac);
    } else {
      len = T.featMin + (Math.random() * (T.featMax - T.featMin) | 0);
    }
    // open/ramp stretches meander the base channel
    if (type === "open" || type === "ramp") {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const step = T.centerStepMin + Math.random() * (T.centerStepMax - T.centerStepMin);
      const lo = em + openHalf, hi = 1 - em - openHalf;
      let c = game.baseCenter + dir * step;
      if (c < lo || c > hi) c = game.baseCenter - dir * step;
      game.baseCenterTarget = Math.max(lo, Math.min(hi, c));
    }
    game.feat = { type, amt };
    game.featLen = Math.max(6, len);
  }

  function makeColumn() {
    // straight wide hallway during a boss fight (either daemon) OR a random event
    const inBoss = (game.boss && game.boss.phase !== "crash") || (game.boss2 && game.boss2.phase !== "crash");
    if (inBoss || game.event) {
      const gapFrac = game.event ? T.eventGap : T.bossArenaGap;
      const h = H * gapFrac / 2;
      game.cTop = 0.5 - gapFrac / 2; game.cBot = 0.5 + gapFrac / 2;
      game.baseCenter = 0.5; game.baseCenterTarget = 0.5;
      return { ceil: Math.max(0, H * 0.5 - h), floor: Math.max(0, H - (H * 0.5 + h)), blocks: [] };
    }
    const em = T.edgeMargin, mg = T.minGapFrac, openHalf = T.maxGapFrac / 2;
    const slopeFrac = T.wallSlopePx / H;
    const fast = game.scrollFx && game.scrollFx.kind === "fast";

    // while a chip obstacle occupies the channel, hold the walls flat through it
    if (game.holdCols > 0) {
      game.holdCols--;
      return { ceil: game.cTop * H, floor: H - game.cBot * H, blocks: [] };
    }

    game.featCol++;
    if (game.featCol >= game.featLen) { game.featCol = 0; pickFeature(); }

    // gentle base-channel meander (slope-limited)
    game.baseCenter += Math.max(-slopeFrac * 0.5, Math.min(slopeFrac * 0.5, game.baseCenterTarget - game.baseCenter));

    // trapezoid envelope → ziggurat (ramp up, flat top, ramp down)
    const p = game.featLen > 0 ? game.featCol / game.featLen : 0;
    const env = Math.max(0, Math.min(1, Math.min(p, 1 - p) / T.rampFrac));
    const amt = game.feat.amt * (fast ? 0.6 : 1);

    let cTop = game.baseCenter - openHalf;
    let cBot = game.baseCenter + openHalf;
    if (game.feat.type === "floorTower") cBot -= amt * env;
    else if (game.feat.type === "ceilTower") cTop += amt * env;
    else if (game.feat.type === "pinch") { cTop += amt * 0.55 * env; cBot -= amt * 0.55 * env; }

    // bounds + guaranteed min channel
    cTop = Math.max(em, cTop); cBot = Math.min(1 - em, cBot);
    if (cBot - cTop < mg) { const m = (cTop + cBot) / 2; cTop = m - mg / 2; cBot = m + mg / 2; }
    cTop = Math.max(em, Math.min(1 - em - mg, cTop));
    cBot = Math.max(cTop + mg, Math.min(1 - em, cBot));
    // snap walls to a vertical grid → blocky chip-tower silhouette (flat tops, vertical sides)
    const st = T.wallStepFrac;
    if (st > 0) {
      let qT = Math.round(cTop / st) * st;
      let qB = Math.round(cBot / st) * st;
      if (qB - qT >= mg && qT >= em && qB <= 1 - em) { cTop = qT; cBot = qB; }
    }
    game.cTop = cTop; game.cBot = cBot;

    // ---- guaranteed flyable lane: walls & chips may never cross it ----
    const lm = T.laneMargin;
    game.laneCol = (game.laneCol || 0) - 1;
    if (game.laneCol <= 0) {
      game.laneCol = T.laneRetargetMin + (Math.random() * (T.laneRetargetMax - T.laneRetargetMin) | 0);
      const lo = em + lm + 0.02, hi = 1 - em - lm - 0.02;
      game.laneTarget = lo + Math.random() * (hi - lo);
    }
    const ls = T.laneSlopePx / H;
    game.laneY += Math.max(-ls, Math.min(ls, game.laneTarget - game.laneY));
    game.laneY = Math.max(em + lm, Math.min(1 - em - lm, game.laneY));
    cTop = Math.max(em, Math.min(cTop, game.laneY - lm));
    cBot = Math.min(1 - em, Math.max(cBot, game.laneY + lm));
    game.cTop = cTop; game.cBot = cBot;

    // discrete chip obstacles — jut from a wall toward (but never across) the lane
    let blocks = [];
    if (!fast) {
      game.obsCooldown = (game.obsCooldown || 0) - 1;
      if (game.obsCooldown <= 0 && Math.random() < T.obsChance) {
        game.obsCooldown = T.obsEveryMin + (Math.random() * (T.obsEveryMax - T.obsEveryMin) | 0);
        const span = T.obsSpanMin + (Math.random() * (T.obsSpanMax - T.obsSpanMin + 1) | 0);
        const ceilRoom = (game.laneY - lm) - cTop;   // space above the lane
        const floorRoom = cBot - (game.laneY + lm);  // space below the lane
        const doDouble = Math.random() < (T.obsDoubleChance || 0) && ceilRoom > T.obsMinHeight && floorRoom > T.obsMinHeight;
        const OV = 12; // bury the base into the wall so chips are always connected
        if (doDouble) {
          const ht = Math.min(ceilRoom, T.obsMinHeight + Math.random() * 0.12) * H;
          const hb = Math.min(floorRoom, T.obsMinHeight + Math.random() * 0.12) * H;
          blocks = [
            { from: "top", y: cTop * H - OV, h: ht + OV, span },
            { from: "bottom", y: cBot * H - hb, h: hb + OV, span },
          ];
          game.holdCols = span - 1;
        } else {
          const fromTop = ceilRoom >= floorRoom;
          const room = fromTop ? ceilRoom : floorRoom;
          if (room > T.obsMinHeight) {
            const h = Math.min(room, T.obsMinHeight + Math.random() * (T.obsMaxHeight - T.obsMinHeight)) * H;
            blocks = [fromTop
              ? { from: "top", y: cTop * H - OV, h: h + OV, span }
              : { from: "bottom", y: cBot * H - h, h: h + OV, span }];
            game.holdCols = span - 1;
          }
        }
      }
    }

    return { ceil: Math.max(0, cTop * H), floor: Math.max(0, H - cBot * H), blocks };
  }

  function seedTerrain() {
    const openHalf = T.maxGapFrac / 2;
    game.baseCenter = 0.5; game.baseCenterTarget = 0.5;
    game.feat = { type: "open", amt: 0 };
    game.featCol = 0; game.featLen = T.featMax;
    game.laneY = 0.5; game.laneTarget = 0.5; game.laneCol = 0;
    game.holdCols = 0; game.obsCooldown = 8;
    game.cTop = 0.5 - openHalf; game.cBot = 0.5 + openHalf;
    game.cols = [];
    const n = Math.ceil(W / T.colW) + 4;
    for (let i = 0; i < n; i++) game.cols.push({ ceil: game.cTop * H, floor: H - game.cBot * H, blocks: [] });
  }

  // worldX of column index 0 = game.scrollOffset accumulates; we shift array
  let scrollAcc = 0;
  function advanceTerrain(dx) {
    scrollAcc += dx;
    while (scrollAcc >= T.colW) {
      scrollAcc -= T.colW;
      game.cols.shift();
      game.cols.push(makeColumn());
    }
    // reverse scroll: generate fresh terrain on the left as we move backwards
    while (scrollAcc < 0) {
      scrollAcc += T.colW;
      game.cols.pop();
      game.cols.unshift(makeColumn());
    }
  }

  // ---- input / controls / pause -------------------------------------------
  // Directional scheme: WASD or arrow keys drive thrusters (up/down/left/right),
  // mouse aims, left-click fires. Gravity is always on; UP fights it, DOWN dives.
  let paused = false;
  const keys = { up: false, down: false, left: false, right: false };
  let aimX = 0, aimY = 0, aimSet = false;

  const KEYMAP = {
    up:    ["KeyW", "ArrowUp"],
    down:  ["KeyS", "ArrowDown"],
    left:  ["KeyA", "ArrowLeft"],
    right: ["KeyD", "ArrowRight"],
  };
  function keyDir(code) { for (const d in KEYMAP) if (KEYMAP[d].indexOf(code) !== -1) return d; return null; }
  function clearKeys() { keys.up = keys.down = keys.left = keys.right = false; }

  function togglePause() {
    if (state !== STATE.PLAY) return;
    paused = !paused;
    if (game) { clearKeys(); game.shooting = false; }
    hud.pause.classList.toggle("hidden", !paused);
    if (window.DDAudio) { if (paused) window.DDAudio.stopLoop("chargeLoop"); }
    refreshMuteLabels();
  }

  // keyboard — movement
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    if (e.code === "KeyP") { if (!e.repeat) togglePause(); return; }
    if (e.code === "KeyM") { if (!e.repeat && window.DDAudio) { window.DDAudio.toggleMute(); refreshMuteLabels(); } return; }
    const d = keyDir(e.code);
    if (!d) return;
    if (state === STATE.MENU) { start(); return; }
    if (state === STATE.DEAD) { restart(); return; }
    if (!paused) keys[d] = true;
  });
  window.addEventListener("keyup", (e) => {
    const d = keyDir(e.code);
    if (d) keys[d] = false;
  });
  window.addEventListener("blur", () => { clearKeys(); if (game) game.shooting = false; });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { clearKeys(); if (game) { game.shooting = false; game.charging = false; } } });

  // mouse — aim with movement, left-click to fire
  function updateAim(e) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    aimX = (e.clientX - r.left) / r.width * W;
    aimY = (e.clientY - r.top) / r.height * H;
    aimSet = true;
  }
  // touch detection: only when the PRIMARY pointer is coarse (phones/tablets).
  // A touchscreen laptop with a mouse stays in full desktop mouse+keyboard mode.
  const touchMode = window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : ("ontouchstart" in window);
  let touchUI = null;

  canvas.addEventListener("pointermove", updateAim);
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { if (document.activeElement && document.activeElement !== canvas && document.activeElement.blur) document.activeElement.blur(); } catch (err) {}
    if (canvas.focus) try { canvas.focus(); } catch (err) {}
    updateAim(e);
    if (state === STATE.MENU) { start(); return; }
    if (state === STATE.DEAD) { restart(); return; }
    if (e.pointerType === "touch") return;   // in-play: touch fires via the on-screen buttons
    if (e.button === 0 && !paused && game) game.shooting = true;
    if (e.button === 2 && !paused && game) { game.charging = true; if (window.DDAudio) window.DDAudio.startLoop("chargeLoop"); }
  });
  window.addEventListener("pointerup", (e) => {
    if (e.button === 0 && game) game.shooting = false;
    if (e.button === 2 && game && game.charging) { game.charging = false; if (window.DDAudio) window.DDAudio.stopLoop("chargeLoop"); releaseCharge(); }
  });
  window.addEventListener("pointercancel", () => { if (game) { game.shooting = false; game.charging = false; } if (window.DDAudio) window.DDAudio.stopLoop("chargeLoop"); });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  hud.ovBtn.addEventListener("click", () => {
    if (state === STATE.MENU) start();
    else restart();
  });

  // ---- controls menu (informational reference) ------------------------------
  function openControls() { hud.controls.classList.remove("hidden"); }
  function closeControls() { hud.controls.classList.add("hidden"); }

  function start() {
    newGame();
    state = STATE.PLAY;
    paused = false;
    clearKeys();
    if (window.DDAudio) { window.DDAudio.init(); window.DDAudio.play("jackIn"); window.DDAudio.music("music"); }
    // release any element (e.g. the score field) that grabbed keyboard focus
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
    if (canvas.focus) try { canvas.focus(); } catch (e) {}
    hud.pause.classList.add("hidden");
    hud.controls.classList.add("hidden");
    if (hud.scoreEntry) hud.scoreEntry.classList.add("hidden");
    hud.overlay.classList.add("hidden");
    hud.timerWrap.classList.add("hidden");
  }
  function restart() { start(); }

  // ---- helpers -------------------------------------------------------------
  function formatBytes(b) {
    b = Math.floor(b);
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " G" + TEXT.unit;
    if (b >= 1e6) return (b / 1e6).toFixed(2) + " M" + TEXT.unit;
    if (b >= 1e3) return (b / 1e3).toFixed(1) + " K" + TEXT.unit;
    return b + " " + TEXT.unit;
  }
  function rectsHit(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }
  function showBanner(title, sub, color, dur) {
    hud.banner.innerHTML =
      `<div class="banner-title" style="color:${color}">${title}</div>` +
      (sub ? `<div class="banner-sub">${sub}</div>` : "");
    hud.banner.classList.remove("hidden", "banner-pop");
    void hud.banner.offsetWidth;
    hud.banner.classList.add("banner-pop");
    // auto-hide on a real timer so it can't get stuck if the loop pauses/ends
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => hud.banner.classList.add("hidden"), (dur || 2.0) * 1000);
  }
  function spawnParticles(x, y, color, n, spd) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = spd * (0.3 + Math.random() * 0.7);
      game.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.6 + Math.random() * 0.4, max: 1, color, r: 2 + Math.random() * 3 });
    }
  }

  // ---- player size ---------------------------------------------------------
  const PW = SPRITES.player.w, PH = SPRITES.player.h;
  // collision box a bit tighter than sprite
  const HBX = PW * 0.62, HBY = PH * 0.62;

  function playerHitbox() {
    return { x: game.px - HBX / 2, y: game.py - HBY / 2, w: HBX, h: HBY };
  }

  function loseLife(reason) {
    if (game.invuln > 0) return;
    if (game.invincible > 0) return;   // Pepe jackpot: untouchable
    // SHIELD pickup absorbs one hit, then drops
    if (game.shield) {
      game.shield = false;
      game.invuln = T.invulnTime;
      game.shake = 14;
      game.flashT = Math.max(game.flashT, 0.45);
      spawnParticles(game.px, game.py, C.accentSoft, 30, 380);
      SFX("shieldHeld");
      showBanner("🛡 SHIELD ABSORBED", "shield down", C.accentSoft, 1.2);
      return;
    }
    // OVER CLOCKED absorbs TWO hits; the 2nd powers it down (and costs the +2 buffer)
    if (game.freeAmmo) {
      game.odHits = (game.odHits || 0) + 1;
      game.invuln = T.invulnTime;
      game.shake = 16;
      if (game.odHits < 2) {
        // first hit — shrug it off, shield flares
        game.flashT = Math.max(game.flashT, 0.5);
        spawnParticles(game.px, game.py, C.accentSoft, 24, 360);
        SFX("shieldHeld");
        showBanner("⚡ SHIELD HELD", "1 more hit ends Over Clocked", C.accent, 1.2);
        return;
      }
      // second hit — power down
      game.freeAmmo = false;
      game.poweringDown = 0.5;   // brief power-down flash
      game.lives = Math.max(0, game.lives - 2);
      spawnParticles(game.px, game.py, "#ffffff", 34, 420);
      SFX("powerDown");
      if (game.lives <= 0) { die(); return; }
      showBanner("POWER DOWN", TEXT.livesLabel + " ×" + game.lives, C.warn, 1.3);
      return;
    }
    game.lives--;
    game.shake = 16;
    SFX("damage");
    spawnParticles(game.px, game.py, C.danger, 26, 360);
    if (game.lives <= 0) {
      die();
    } else {
      showBanner(TEXT.hit, TEXT.livesLabel + " ×" + game.lives, C.danger, 1.3);
      game.invuln = T.invulnTime;
    }
  }

  // Solid terrain: push the player out of walls/blocks and bump velocity.
  // Returns true if the player is in contact with terrain this frame.
  function resolveTerrain() {
    const hb = playerHitbox();
    const i0 = colIndexAt(hb.x), i1 = colIndexAt(hb.x + hb.w);
    let topLimit = 0;     // lowest-hanging solid ceiling (y)
    let botLimit = H;     // highest solid floor (y)
    for (let i = i0; i <= i1; i++) {
      const col = game.cols[i];
      if (!col) continue;
      if (col.ceil > topLimit) topLimit = col.ceil;
      const ft = H - col.floor;
      if (ft < botLimit) botLimit = ft;
      const bx = i * T.colW - scrollAcc;
      for (const b of col.blocks) {
        if (b.smashed) continue;
        const bw = T.colW * (b.span || 1);
        if (hb.x < bx + bw && hb.x + hb.w > bx) {
          const top = b.from === "top";
          const bTop = top ? col.ceil : (H - col.floor) - b.h;
          const bBot = top ? col.ceil + b.h : (H - col.floor);
          // OVERDRIVE / PEPE: smash straight through the jutting tower/chip — shatter it
          if ((game.freeAmmo || game.invincible > 0) && hb.y < bBot && hb.y + hb.h > bTop) {
            b.smashed = true; game.shake = 12;
            SFX("firewallSmash");
            spawnParticles(bx + bw / 2, (bTop + bBot) / 2, "#ffffff", 26, 420);
            spawnParticles(game.px, game.py, C.accent, 14, 300);
            continue;
          }
          // base derives from THIS column's wall, so chips are always grounded
          if (top) { if (bBot > topLimit) topLimit = bBot; }
          else { if (bTop < botLimit) botLimit = bTop; }
        }
      }
    }
    let touched = false;
    // ceiling — stop upward motion and apply a small, consistent rebound
    if (game.py - HBY / 2 < topLimit) {
      game.py = topLimit + HBY / 2;
      game.vy = T.bumpBounce;
      touched = true;
    }
    // floor — stop downward motion and apply the same small rebound
    if (game.py + HBY / 2 > botLimit) {
      game.py = botLimit - HBY / 2;
      game.vy = -T.bumpBounce;
      touched = true;
    }
    return touched;
  }

  // ---- scoreboard ----------------------------------------------------------
  const SCORE_KEY = "datadash.scores";
  let scores = loadScores();
  let lastScoreEntry = null;
  function loadScores() { try { const a = JSON.parse(localStorage.getItem(SCORE_KEY)); if (Array.isArray(a)) return a; } catch (e) {} return []; }
  function saveScores() { localStorage.setItem(SCORE_KEY, JSON.stringify(scores)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function recordScore(bytes) {
    lastScoreEntry = { name: "—", bytes: Math.floor(bytes), ts: Date.now() };
    scores.push(lastScoreEntry);
    scores.sort((a, b) => b.bytes - a.bytes);
    scores = scores.slice(0, T.scoreMax);
    saveScores();
  }
  function renderScores() {
    if (!hud.scores) return;
    if (!scores.length) { hud.scores.innerHTML = `<div class="score-empty">${TEXT.scoreEmpty}</div>`; return; }
    hud.scores.innerHTML = `<div class="score-head">${TEXT.scoreTitle}</div>` + scores.map((s, i) => {
      const me = s === lastScoreEntry ? " me" : "";
      return `<div class="score-row${me}"><span class="rank">${String(i + 1).padStart(2, "0")}</span>` +
        `<span class="who">${escapeHtml(s.name || "—")}</span>` +
        `<span class="val">${formatBytes(s.bytes)}</span></div>`;
    }).join("");
  }

  function die() {
    state = STATE.DEAD;
    clearKeys();
    game.shooting = false;
    if (window.DDAudio) { window.DDAudio.stopLoop("malwareLoop"); if (game._invSfx) { try { game._invSfx.src.stop(); } catch (e) {} game._invSfx = null; }window.DDAudio.stopLoop("chargeLoop"); window.DDAudio.play("gameOver"); window.DDAudio.music("menuMusic"); }
    spawnParticles(game.px, game.py, C.danger, 40, 460);
    const beat = game.bytes > best;
    if (beat) { best = Math.floor(game.bytes); localStorage.setItem("datadash.best", best); }
    recordScore(game.bytes);
    hud.ovTitle.textContent = TEXT.gameOver;
    hud.ovSub.textContent = TEXT.gameOverSub.replace("{n}", formatBytes(game.bytes));
    hud.ovBtn.textContent = TEXT.retry;
    hud.ovBest.innerHTML = beat
      ? `<span style="color:${C.ok}">${TEXT.newBest}</span> · ${formatBytes(best)}`
      : `${TEXT.bestLabel}: ${formatBytes(best)}`;
    if (hud.scoreEntry) {
      hud.scoreEntry.classList.remove("hidden");
      if (hud.scoreName) { hud.scoreName.value = ""; }
    }
    renderScores();
    hud.overlay.classList.remove("hidden");
    hud.timerWrap.classList.add("hidden");
    refreshMuteLabels();
    if (hud.scoreName) setTimeout(() => hud.scoreName.focus(), 30);
  }

  function colIndexAt(x) {
    return Math.floor((x + scrollAcc) / T.colW);
  }
  function colAtPlayer() {
    const i = colIndexAt(game.px);
    return game.cols[i] || null;
  }

  // ---- update --------------------------------------------------------------
  function update(dt) {
    game.t += dt;

    // transform freeze: world holds while the OVER CLOCKED transformation plays out
    if (game.transform > 0) {
      game.transform -= dt;
      if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 30);
      // repeated screen flashes + lightning bursts for emphasis
      game.flashT = 0.35 + 0.4 * Math.abs(Math.sin(game.transform * 12));
      game.shake = Math.max(game.shake, 8);
      // charging energy implosion around the bot
      for (let n = 0; n < 3; n++) {
        const a = Math.random() * 6.28, rr = PH * (1.8 + Math.random() * 1.5);
        game.particles.push({ x: game.px + Math.cos(a) * rr, y: game.py + Math.sin(a) * rr,
          vx: -Math.cos(a) * 320, vy: -Math.sin(a) * 320,
          life: 0.25 + Math.random() * 0.2, max: 0.45, color: Math.random() < 0.5 ? "#ffffff" : C.accentSoft, r: 2 + Math.random() * 3 });
      }
      updateParticles(dt);
      return;   // everything else frozen
    }

    // scroll speed, warped by an active mystery effect
    let base = curScroll();
    if (game.scrollFx) {
      game.scrollFx.t -= dt;
      if (game.scrollFx.t <= 0) game.scrollFx = null;
      else if (game.scrollFx.kind === "fast") base *= T.mysteryFastMult;
      else if (game.scrollFx.kind === "slow") base *= T.mysterySlowMult;
      else if (game.scrollFx.kind === "reverse") base *= T.mysteryReverseMult;
    }
    game.scroll = base;
    const dx = game.scroll * dt;
    game.dist += dx;
    // streamed = total bytes ever streamed (monotonic) — drives spawn cadence so
    // features stay persistent forever even when you spend DATA on shooting.
    game.streamed += Math.max(0, dx) * T.bytesPerPx;
    game.gross += Math.max(0, dx) * T.bytesPerPx;   // gross accumulation drives Pepe
    // bytes = spendable DATA / score: rewind un-streams it, shooting spends it.
    game.bytes = Math.max(0, game.bytes + dx * T.bytesPerPx);
    if (game.invincible > 0) { game.invincible -= dt; if (game.invincible <= 0) { if (game._invSfx) { try { game._invSfx.src.stop(); } catch (e) {} game._invSfx = null; } } }
    if (game.flashT > 0) game.flashT = Math.max(0, game.flashT - dt * 2.5);

    advanceTerrain(dx);
    if (!game.boss && !game.boss2 && !game.event) game.bossClock += dt;  // count boss-free survival time

    // player physics — DRIFT (no gravity): thrusters add momentum, damping bleeds it off
    let ay = 0;
    if (keys.up) ay -= T.driftThrust;
    if (keys.down) ay += T.driftThrust;
    game.vy += ay * dt;
    game.vy *= Math.pow(T.driftDamp, dt * 60);
    game.vy = Math.max(-T.vMax, Math.min(T.vMax, game.vy));
    game.py += game.vy * dt;

    // horizontal: left/right thrusters with a spring back to the anchor lane
    const anchor = W * T.playerX;
    let ax = (anchor - game.px) * T.hSpring;
    if (keys.left) ax -= T.hThrust;
    if (keys.right) ax += T.hThrust;
    game.vx += ax * dt;
    game.vx *= Math.pow(T.hDamp, dt * 60);
    game.vx = Math.max(-T.hMax, Math.min(T.hMax, game.vx));
    game.px += game.vx * dt;
    // trailing data-streamers off the bot so he feels alive (not during rewind)
    const rewinding = game.scrollFx && game.scrollFx.kind === "reverse";
    if (state === STATE.PLAY && !paused && !rewinding && Math.random() < 0.9) {
      const col = game.freeAmmo ? "#ffffff" : C.accentSoft;
      game.particles.push({ x: game.px - PW * 0.5, y: game.py + (Math.random() - 0.5) * PH * 0.5,
        vx: -120 - Math.random() * 80 - game.scroll * 0.15, vy: (Math.random() - 0.5) * 30,
        life: 0.4 + Math.random() * 0.3, max: 0.7, color: col, r: 1.5 + Math.random() * 2 });
    }
    const xmin = W * T.hMargin, xmax = W * (1 - T.hMargin);
    if (game.px < xmin) { game.px = xmin; game.vx = Math.max(0, game.vx); }
    if (game.px > xmax) { game.px = xmax; game.vx = Math.min(0, game.vx); }

    // ambient environmental motes drifting through the data-stream for immersion
    if (!paused && Math.random() < 0.5) {
      game.particles.push({ x: W + 10, y: Math.random() * H,
        vx: -(game.scroll * 0.5 + 40 + Math.random() * 60), vy: (Math.random() - 0.5) * 12,
        life: 1.2 + Math.random() * 1.2, max: 2.4, color: Math.random() < 0.3 ? C.ok : C.accentSoft, r: 0.8 + Math.random() * 1.4 });
    }

    if (game.invuln > 0) game.invuln -= dt;
    if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 60);

    // solid terrain — resolve position every frame; damage only on a fresh impact
    const touching = resolveTerrain();
    if (touching && game.invuln <= 0) loseLife("wall");

    updateProgression();
    updateEvent(dt);
    updatePickups(dt);
    updateMalwareSpawn(dt);
    maybeSpawnShield(dt);
    updateBots(dt);
    updateBombs(dt);
    updateBoss(dt);
    updateBullets(dt);
    updatePlayerFire(dt);
    updateParticles(dt);
    updateHud();
  }

  function releaseCharge() {
    if (!game || state !== STATE.PLAY) return;
    if (game.chargeT < T.chargeMin) { game.chargeT = 0; return; }   // not held long enough
    if (!game.freeAmmo && game.bytes < T.chargeCost) { game.chargeT = 0; return; }
    SFX("chargeFire");   // fire the release SFX FIRST — tight, in-sync with the trigger
    if (!game.freeAmmo) game.bytes = Math.max(0, game.bytes - T.chargeCost);
    const tx = aimSet ? aimX : game.px + 200, ty = aimSet ? aimY : game.py;
    const ang = Math.atan2(ty - game.py, tx - game.px);
    const sp = T.playerBulletSpeed * 0.8;
    game.playerBullets.push({ x: game.px + Math.cos(ang) * PW * 0.6, y: game.py + Math.sin(ang) * PW * 0.6,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, big: true });
    spawnParticles(game.px, game.py, "#ffffff", 20, 300);
    game.shake = 8;
    game.chargeT = 0;
  }

  function fireNormalShot() {
    if (state !== STATE.PLAY || game.playerFire > 0) return false;
    if (!game.freeAmmo && game.bytes < T.shotCost) return false;
    game.playerFire = game.freeAmmo ? T.playerFireEvery / 3 : T.playerFireEvery;
    if (!game.freeAmmo) game.bytes = Math.max(0, game.bytes - T.shotCost);
    const tx = aimSet ? aimX : game.px + 200;
    const ty = aimSet ? aimY : game.py;
    const ang = Math.atan2(ty - game.py, tx - game.px);
    const sp = T.playerBulletSpeed;
    const mx = game.px + Math.cos(ang) * PW * 0.5, my = game.py + Math.sin(ang) * PW * 0.5;
    game.playerBullets.push({ x: mx, y: my, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp });
    SFX("shot");
    spawnParticles(mx, my, C.accentSoft, 4, 120);
    return true;
  }

  // touch: auto-aim removed — the twin-stick provides full manual aim.

  function updatePlayerFire(dt) {
    if (game.charging) game.chargeT += dt;
    if (game.playerFire > 0) game.playerFire -= dt;
    if (game.tapFire) { game.tapFire = false; if (!paused) fireNormalShot(); }   // single tap = one precise shot
    if (game.shooting && !paused) fireNormalShot();                              // hold = rapid stream
    for (const pb of game.playerBullets) {
      pb.x += pb.vx * dt;
      pb.y += (pb.vy || 0) * dt;
      const sz = pb.big ? T.chargeBulletSize : T.playerBulletSize;
      for (const b of [game.boss, game.boss2]) {
        if (!b || b.phase !== "fight" || pb.dead) continue;
        const bw = SPRITES.boss.w * 0.62, bh = SPRITES.boss.h * 0.62;
        if (rectsHit(pb.x - sz / 2, pb.y - sz / 2, sz, sz, b.x - bw / 2, b.y - bh / 2, bw, bh)) {
          if (!pb.big) pb.dead = true;   // big shots pierce
          b.timer = Math.max(0, b.timer - (pb.big ? T.chargeBossReduce : T.bossHitReduce));
          b.hitFlash = 0.12;
          spawnParticles(pb.x, pb.y, pb.big ? "#ffffff" : C.warn, pb.big ? 18 : 8, 260);
        }
      }
      // CHARGE shots SLAM the environment — screen shake + shatter on impact
      if (pb.big && !pb.dead) {
        const ci = colIndexAt(pb.x);
        const col = game.cols[ci];
        if (col) {
          let hit = pb.y < col.ceil || pb.y > (H - col.floor);
          if (!hit) {
            const bx2 = ci * T.colW - scrollAcc;
            for (const bl of col.blocks) {
              if (bl.smashed) continue;
              const bw2 = T.colW * (bl.span || 1);
              if (pb.x >= bx2 && pb.x <= bx2 + bw2) {
                const top = bl.from === "top";
                const bTop = top ? col.ceil : (H - col.floor) - bl.h;
                const bBot = top ? col.ceil + bl.h : (H - col.floor);
                if (pb.y >= bTop && pb.y <= bBot) { hit = true; bl.smashed = true; break; }
              }
            }
          }
          if (hit) {
            pb.dead = true;
            game.shake = Math.max(game.shake, 16);
            SFX("firewallSmash");
            spawnParticles(pb.x, pb.y, "#ffffff", 24, 400);
            spawnParticles(pb.x, pb.y, C.accent, 12, 280);
          }
        }
      }
    }
    game.playerBullets = game.playerBullets.filter((pb) => !pb.dead && pb.x > -40 && pb.x < W + 40 && pb.y > -40 && pb.y < H + 40);
  }

  // health-pack cadence — a smooth sliding scale of need: very frequent when you're
  // hurting, steadily rarer the more kernels you hold.
  function checkpointInterval() {
    const l = Math.max(1, game.lives);
    return T.checkpointEvery * (0.45 + 0.85 * (l - 1));
  }

  // pickups must never spawn on top of each other — keep a clear gap
  function pickupLaneClear() {
    return !game.pickups.some((p) => !p.grabbed && p.x > W - 360);
  }

  function updateProgression() {
    const S = game.streamed;
    const busy = game.boss || game.boss2 || game.event;   // no normal spawns during a boss/event
    // RANDOM EVENT trigger — fires at unpredictable intervals, never while already busy
    if (!busy && game.t >= game.nextEventT) { triggerRandomEvent(); return; }
    // checkpoint backups (+1) — cadence scales with kernels held
    if (!busy && S >= game.nextCheckpoint && pickupLaneClear()) {
      game.nextCheckpoint = S + checkpointInterval();
      const col = colAtSpawn();
      const cy = col ? (col.ceil + (H - col.floor)) / 2 : H / 2;
      game.pickups.push({ x: W + 80, y: cy, grabbed: false, bob: Math.random() * 6, kind: "normal" });
    }
    // emergency packs (+2) — only while down to the last kernel, one at a time
    if (!busy && game.lives <= 1 && S >= game.nextBonus && pickupLaneClear() &&
        !game.pickups.some((p) => p.kind === "bonus" && !p.grabbed)) {
      game.nextBonus = S + T.bonusEvery;
      const col = colAtSpawn();
      const cy = col ? (col.ceil + (H - col.floor)) / 2 : H / 2;
      game.pickups.push({ x: W + 80, y: cy, grabbed: false, bob: Math.random() * 6, kind: "bonus" });
    }
    // boss trigger — time-based (every N seconds of boss-free survival)
    if (!busy && game.bossClock >= T.bossEverySeconds) {
      game.bossClock = 0;
      spawnBoss();
    }
    // mystery (?) pickup — random scroll warp (suppressed while one is already active)
    if (!busy && !game.scrollFx && S >= game.nextMystery && pickupLaneClear() &&
        !game.pickups.some((p) => p.kind === "mystery" && !p.grabbed)) {
      game.nextMystery = S + T.mysteryEvery * (0.6 + Math.random() * 0.8);
      const col = colAtSpawn();
      const cy = col ? (col.ceil + (H - col.floor)) / 2 : H / 2;
      game.pickups.push({ x: W + 80, y: cy, grabbed: false, bob: Math.random() * 6, kind: "mystery" });
    }
    // DATA PACKETS — tiny streamed-data collectibles, sometimes in flowing strings
    if (!busy && S >= game.nextPacket && pickupLaneClear()) {
      game.nextPacket = S + T.packetEvery * (0.7 + Math.random() * 0.6);
      const col = colAtSpawn();
      const cy = col ? (col.ceil + (H - col.floor)) / 2 + (Math.random() - 0.5) * 50 : H / 2;
      const n = Math.random() < T.packetStringChance ? 2 + (Math.random() * (T.packetStringMax - 1) | 0) : 1;
      const amp = 26 + Math.random() * 40, ph = Math.random() * 6.28;
      for (let k = 0; k < n; k++) {
        game.pickups.push({ x: W + 60 + k * 64, y: cy + Math.sin(ph + k * 0.7) * amp, grabbed: false, bob: Math.random() * 6, kind: "packet" });
      }
    }
    // MINI-MALWARE BOTS now spawn on an independent timer (updateMalwareSpawn),
    // so they appear during any event — including boss battles.

    // BOSS AMMO RELIEF — while fighting a boss with low reserves (< 1 MB), feed
    // spaced-out but consistent kb packet strips so the player can always refuel
    // and keep firing. Outside bosses, packets stay scarce so saving up matters.
    if (game.boss && (game.boss.phase === "fight" || game.boss.phase === "enter") &&
        game.bytes < T.bossPacketLowKB && S >= game.nextBossPacket && pickupLaneClear()) {
      game.nextBossPacket = S + T.bossPacketEvery;
      const gap = (game.cBot - game.cTop) * H;
      const cy = game.cTop * H + gap * (0.28 + Math.random() * 0.44);   // within the boss arena
      for (let k = 0; k < T.bossPacketCount; k++) {
        game.pickups.push({ x: W + 60 + k * 58, y: cy, grabbed: false, bob: Math.random() * 6, kind: "packet" });
      }
    }
    // rare UPGRADE bolt — no magnet, must be flown into
    if (!busy && !game.freeAmmo && S >= game.nextUpgrade &&
        !game.pickups.some((p) => p.kind === "upgrade" && !p.grabbed)) {
      game.nextUpgrade = S + T.upgradeEvery;
      const col = colAtSpawn();
      const cy = col ? (col.ceil + (H - col.floor)) / 2 + (Math.random() - 0.5) * 80 : H / 2;
      game.pickups.push({ x: W + 60, y: cy, grabbed: false, bob: Math.random() * 6, kind: "upgrade" });
    }
    // PEPE COIN — jackpot: spawns on the timer every pepeEverySec(+random) seconds,
    // UNCONDITIONALLY (per Nathan). If the player can't grab it (busy / invincible /
    // whatever), it just flies by — too bad, the next one comes on schedule.
    if (game.t >= game.nextPepeT) {
      game.nextPepeT = game.t + T.pepeEverySec + Math.random() * T.pepeRandSec;
      const col = colAtSpawn();
      const cy = col ? (col.ceil + (H - col.floor)) / 2 : H / 2;
      game.pickups.push({ x: W + 70, y: cy, grabbed: false, bob: Math.random() * 6, kind: "pepe" });
    }
    // ELEMENTAL EVENT — shared pool: spawn EITHER a DATA LOSS skull or a DATA
    // RECOVERY drive (coin-flip), never both, and no more than once a minute.
    if (!busy && game.t >= game.nextElementalT && pickupLaneClear() &&
        !game.pickups.some((p) => (p.kind === "dataloss" || p.kind === "recovery") && !p.grabbed)) {
      game.nextElementalT = game.t + T.elementalEvery * (1 + Math.random() * 0.45);   // ≥ 60s apart
      const kind = Math.random() < 0.5 ? "dataloss" : "recovery";
      const col = colAtSpawn();
      const cy = col ? (col.ceil + (H - col.floor)) / 2 : H / 2;
      game.pickups.push({ x: W + 80, y: cy, grabbed: false, bob: Math.random() * 6, kind });
    }
  }
  function colAtSpawn() {
    const i = colIndexAt(W + 80);
    return game.cols[i] || game.cols[game.cols.length - 1] || null;
  }

  // ---- RANDOM EVENTS -------------------------------------------------------
  // Fire at unpredictable intervals. One of: Double Boss (rarest), DATA Base (wavy
  // kb stream), DDoS (stationary-malware maze), Pepe Packets (collectible grid).
  function triggerRandomEvent() {
    game.nextEventT = game.t + T.eventEveryMin + Math.random() * (T.eventEveryMax - T.eventEveryMin);
    const r = Math.random();
    // doubleboss -15% (0.10 -> 0.085); Overclock Cache (kind "pepe") occurrence halved
    // (0.28 -> 0.14) with DDoS taking up the slack.
    let kind = r < 0.085 ? "doubleboss" : (r < 0.40 ? "database" : (r < 0.86 ? "ddos" : "pepe"));
    if (kind === "doubleboss") {
      // Never a double daemon within 10s of ANY boss fight — active, imminent, or just-ended.
      const bossNear = game._bossesActive
        || (T.bossEverySeconds - game.bossClock) < 10
        || (game.t - (game.lastBossEndT != null ? game.lastBossEndT : -999)) < 10;
      if (bossNear) { kind = Math.random() < 0.5 ? "ddos" : "database"; }
      else { spawnDoubleBoss(); return; }
    }
    const spacing = kind === "database" ? T.colW * T.dbSpacingCols
                  : kind === "ddos" ? T.colW * T.ddosSpacingCols
                  : T.colW * T.pepeGridCols;
    game.event = { kind, dist: 0, length: T.eventCols * T.colW, spawnAcc: spacing, step: 0, spot: 0, spacing, gapY: 1 + Math.random() * (T.ddosSlots - 3), gapV: (Math.random() - 0.5) * 0.4 };
    const meta = {
      database: ["🗄  DATA BASE FOUND", "ride the stream — bank the bits", C.accentSoft],
      ddos:     ["🌐  DDoS ATTACK", "punch or weave through the swarm", C.danger],
      pepe:     ["⚡  OVERCLOCK CACHE", "grab the packs + overclocks — go fast", "#72ffcf"],
    }[kind];
    showBanner(meta[0], meta[1], meta[2], 2.4);
    SFX(kind === "ddos" ? "malwareSpawn" : (kind === "pepe" ? "powerUp" : "packet"));
    if (kind === "ddos" && window.DDAudio) window.DDAudio.startLoop("malwareLoop");
  }

  function updateEvent(dt) {
    const ev = game.event;
    if (!ev) return;
    const dx = game.scroll * dt;
    ev.dist += dx; ev.spawnAcc += dx;
    while (ev.spawnAcc >= ev.spacing) { ev.spawnAcc -= ev.spacing; ev.step++; spawnEventColumn(ev); }
    if (ev.dist >= ev.length) { game.event = null; showBanner("STREAM CLEAR", "", C.accentSoft, 1.1); }
  }

  function spawnEventColumn(ev) {
    const top = (0.5 - T.eventGap / 2) * H, bot = (0.5 + T.eventGap / 2) * H, span = bot - top;
    const x = W + 40;
    if (ev.kind === "database") {
      const y = H * 0.5 + Math.sin(ev.step * 0.5) * T.dbWaveAmp * H;   // smooth wavy kb stream
      game.pickups.push({ x, y, grabbed: false, bob: Math.random() * 6, kind: "packet" });
    } else if (ev.kind === "ddos") {
      const slots = T.ddosSlots;
      // gentle, FOLLOWABLE drift — small bounded slope so SeekDeep can always track the gap
      ev.gapV += (Math.random() - 0.5) * 0.32;
      ev.gapV = Math.max(-0.38, Math.min(0.38, ev.gapV));
      ev.gapY = Math.max(1, Math.min(slots - 3, ev.gapY + ev.gapV));
      const gapSlot = Math.round(ev.gapY);
      const wide = Math.random() < 0.28 ? 1 : 0;   // sometimes a roomier 3-slot gap (variety)
      for (let sI = 0; sI < slots; sI++) {
        if (sI >= gapSlot && sI <= gapSlot + 1 + wide) continue;   // navigable gap that meanders
        const y = top + span * ((sI + 0.5) / slots);
        game.bots.push({ x: x + 30, y, vy: 0, pulse: Math.random() * 6, hp: 2, dead: false, spawnStreamed: game.streamed, static: true });
      }
    } else if (ev.kind === "pepe") {
      // OVERCLOCK CACHE: lots of KB/MB DATA packs + sprinkled overclock power-ups —
      // NO Pepe jackpots here (those stay on their own rare timer).
      const rows = T.pepeGridRows;
      for (let rI = 0; rI < rows; rI++) {
        if ((rI + ev.step) % 2 !== 0) continue;   // checkerboard
        ev.spot++;
        const y = top + span * ((rI + 0.5) / rows);
        const od = (ev.spot % 6 === 0);   // overclock power-up sprinkled in among the packs
        game.pickups.push({ x, y, grabbed: false, bob: Math.random() * 6, kind: od ? "upgrade" : "packet", eventGift: true });
      }
    }
  }


  // clear vertical span [top,bottom] at a world-x, accounting for walls AND towers,
  // so collectibles can be kept out of solid geometry
  function freeSpanAt(px) {
    const i = colIndexAt(px);
    const col = game.cols[i];
    if (!col) return [0, H];
    let top = col.ceil, bot = H - col.floor;
    const bx = i * T.colW - scrollAcc;
    for (const b of col.blocks) {
      if (b.smashed) continue;
      const bw = T.colW * (b.span || 1);
      if (px >= bx && px <= bx + bw) {
        if (b.from === "top") top = Math.max(top, col.ceil + b.h);
        else bot = Math.min(bot, (H - col.floor) - b.h);
      }
    }
    return [top, bot];
  }

  function triggerMystery() {
    const roll = Math.random();
    const kind = roll < 0.4 ? "fast" : (roll < 0.72 ? "slow" : "reverse");
    let dur = T.mysteryDurMin + Math.random() * (T.mysteryDurMax - T.mysteryDurMin);
    if (kind === "slow") dur = Math.min(dur, T.mysterySlowDurMax);
    game.scrollFx = { kind, t: dur };
    const label = kind === "fast" ? TEXT.mysteryFast : (kind === "slow" ? TEXT.mysterySlow : TEXT.mysteryReverse);
    spawnParticles(game.px, game.py, C.mystery, 28, 320);
    SFX(kind === "fast" ? "speedUp" : (kind === "slow" ? "slowDown" : "mystery"));
    showBanner(label, TEXT.mysterySub.replace("{s}", Math.round(dur)), C.mystery);
  }

  function updatePickups(dt) {
    const hb = playerHitbox();
    for (const p of game.pickups) {
      if (p.grabbed) continue;
      p.x -= game.scroll * dt;
      // magnet: gravitate toward the player when nearby — EXCEPT the upgrade bolt
      // and the DATA LOSS skull (you want to be able to DODGE that one).
      if (p.kind !== "upgrade" && p.kind !== "dataloss") {
        const dxp = game.px - p.x, dyp = game.py - p.y;
        const d = Math.hypot(dxp, dyp);
        if (d < T.pickupPull && d > 0.001) {
          const f = (1 - d / T.pickupPull) * T.pickupPullForce * dt;
          p.x += (dxp / d) * f;
          p.y += (dyp / d) * f;
        }
      }
      const psz = p.kind === "upgrade" ? T.upgradeSize : (p.kind === "pepe" ? T.pepeSize : (p.kind === "shield" ? T.shieldSize : ((p.kind === "dataloss" || p.kind === "recovery") ? T.pickupSize * 1.3 : T.pickupSize)));
      // never let a collectible sit inside/touching a tower — clamp into clear span
      const span = freeSpanAt(p.x);
      const pad = psz / 2 + 6;
      if (span[1] - span[0] > pad * 2) p.y = Math.max(span[0] + pad, Math.min(span[1] - pad, p.y));
      else p.y = (span[0] + span[1]) / 2;
      if (rectsHit(hb.x, hb.y, HBX, HBY, p.x - psz / 2, p.y - psz / 2, psz, psz)) {
        p.grabbed = true;
        if (p.kind === "bonus") {
          game.lives += T.bonusValue;
          spawnParticles(p.x, p.y, C.ok, 32, 360);
          SFX("kernel");
          showBanner(TEXT.bonus, TEXT.bonusSub.replace("{v}", T.bonusValue).replace("{n}", game.lives), C.ok);
        } else if (p.kind === "mystery") {
          triggerMystery();
        } else if (p.kind === "packet") {
          game.bytes += T.packetValue;
          game.gross += T.packetValue;   // collected DATA counts toward Pepe
          spawnParticles(p.x, p.y, C.accentSoft, 18, 300);
          SFX("packet");
          game.floaters.push({ x: p.x, y: p.y, t: 0, txt: "+10KB", col: C.accentSoft });
        } else if (p.kind === "pepe") {
          const wasInv = game.invincible > 0;
          // Invincibility lasts EXACTLY as long as the music clip (which fades in/out);
          // each grab restarts the clip so audio + timer never drift apart.
          let invDur = T.pepeInvincible;
          if (window.DDAudio && window.DDAudio.clipDuration) { const d = window.DDAudio.clipDuration("invincibleLoop"); if (d > 0.5) invDur = d; }
          game.invincible = invDur;
          if (window.DDAudio) {
            if (game._invSfx) { try { game._invSfx.src.stop(); } catch (e) {} game._invSfx = null; }
            game._invSfx = window.DDAudio.play("invincibleLoop", { fadeIn: 0.3, fadeOut: Math.min(0.7, invDur * 0.25) });
          }
          if (!wasInv) {
            game.flashT = 1; game.shake = 22;
            SFX("pepe");
            showBanner("💰 PEPE JACKPOT", Math.round(invDur) + "s INVINCIBLE — SMASH EVERYTHING", "#ffe66b");
          } else {
            game.flashT = Math.max(game.flashT, 0.35);
          }
          spawnParticles(p.x, p.y, "#ffe66b", wasInv ? 16 : 70, wasInv ? 300 : 620);
        } else if (p.kind === "upgrade") {
          const wasOD = game.freeAmmo;
          game.freeAmmo = true;
          game.odHits = 0;                       // absorbs 2 hits before power-down
          if (!p.eventGift) {
            game.lives += 2;                     // +2 kernels buffer (rare standalone bolt only)
            game.transform = T.transformTime;    // world-freeze transform sequence
            showBanner("⚡ OVER CLOCKED!", "+2 kernels · 3× fire · smash through", C.accent);
          } else if (!wasOD) {
            showBanner("⚡ OVER CLOCKED!", "3× fire · smash through", C.accent, 1.2);
          }
          game.flashT = Math.max(game.flashT, p.eventGift ? 0.4 : 1);
          game.shake = Math.max(game.shake, p.eventGift ? 8 : 18);
          spawnParticles(p.x, p.y, "#ffffff", p.eventGift ? 24 : 60, p.eventGift ? 360 : 560);
          SFX("powerUp");
        } else if (p.kind === "dataloss") {
          // DATA LOSS — corrupted skull: 30% drains ALL, 40% HALF, 30% 10% of DATA streamed
          const r = Math.random();
          const frac = r < 0.30 ? 1.0 : (r < 0.70 ? 0.5 : 0.10);
          const lost = Math.floor(game.bytes * frac);
          game.bytes = Math.max(0, game.bytes - lost);
          game.flashT = Math.max(game.flashT, 0.85); game.shake = 22;
          spawnParticles(p.x, p.y, C.danger, 54, 480);
          SFX("damage");
          const pct = frac === 1 ? "ALL DATA STREAMED" : (frac === 0.5 ? "HALF DATA STREAMED" : "10% DATA STREAMED");
          showBanner("☠ −" + formatBytes(lost) + " LOST!!", "DATA LOSS · " + pct, C.danger, 2.4);
        } else if (p.kind === "recovery") {
          // DATA RECOVERY — hard-drive doctor: instantly grants 5× current DATA streamed
          const gain = Math.floor(game.bytes * T.dataRecoveryMult);
          game.bytes += gain; game.gross += gain;
          game.flashT = Math.max(game.flashT, 0.85); game.shake = 16;
          spawnParticles(p.x, p.y, C.ok, 54, 480);
          SFX("powerUp");
          showBanner("🖥 +" + formatBytes(gain) + " RECOVERED!!", "DATA RECOVERY · 5× restored", C.ok, 2.4);
        } else if (p.kind === "shield") {
          game.shield = true;
          game.flashT = Math.max(game.flashT, 0.4);
          spawnParticles(p.x, p.y, C.accentSoft, 34, 380);
          SFX("shieldHeld");
          showBanner("🛡 SHIELD ONLINE", "absorbs the next hit", C.accentSoft);
        } else {
          game.lives++;
          spawnParticles(p.x, p.y, C.ok, 22, 280);
          SFX("kernel");
          showBanner(TEXT.checkpoint, TEXT.checkpointSub.replace("{n}", game.lives), C.ok);
        }
      }
    }
    game.pickups = game.pickups.filter((p) => !p.grabbed && p.x > -100);
  }

  // MINI-MALWARE spawns on a strict independent clock: every botSpawnSeconds it
  // releases botBatch bots, but never more than botMax on screen. While at the cap
  // the clock simply parks at zero (no back-queue) and only rearms once there's room.
  function updateMalwareSpawn(dt) {
    if (game.event) return;   // the hallway events run their own content; no chasing malware
    game.botTimer -= dt;
    if (game.botTimer > 0) return;
    if (game.bots.length >= T.botMax) return;   // full screen — hold the clock until space frees
    const room = T.botMax - game.bots.length;
    const n = Math.min(T.botBatch, room);
    const S = game.streamed;
    for (let i = 0; i < n; i++) {
      let cy;
      if (game.boss) {
        cy = H * (0.18 + Math.random() * 0.64);   // boss arena is open — drop them anywhere
      } else {
        const col = colAtSpawn();
        cy = col ? (col.ceil + (H - col.floor)) / 2 + (Math.random() - 0.5) * 90 : H / 2;
      }
      game.bots.push({ x: W + 60 + i * 74, y: cy, vy: 0, pulse: Math.random() * 6, hp: 2, dead: false, spawnStreamed: S });
    }
    SFX("malwareSpawn");
    if (window.DDAudio) window.DDAudio.startLoop("malwareLoop");
    game.botTimer = T.botSpawnSeconds;            // rearm the 30s clock only after a successful spawn
  }

  // SHIELD — its own independent entity. Memoryless random spawn: no timer, cycle,
  // or event triggers or prevents it. Only guard is one-on-screen-at-a-time.
  function maybeSpawnShield(dt) {
    if (game.event) return;    // events run their own content
    if (game.shield) return;   // already shielded — don't spawn another (no stacking, no queue)
    if (game.pickups.some((p) => p.kind === "shield" && !p.grabbed)) return;
    if (Math.random() < dt / T.shieldMeanSec) {
      const col = colAtSpawn();
      const cy = col ? (col.ceil + (H - col.floor)) / 2 + (Math.random() - 0.5) * 70 : H / 2;
      game.pickups.push({ x: W + 70, y: cy, grabbed: false, bob: Math.random() * 6, kind: "shield" });
    }
  }

  function updateBots(dt) {
    const hb = playerHitbox();
    for (const b of game.bots) {
      b.pulse += dt;
      if (b.static) {
        b.x -= game.scroll * dt;   // DDoS maze bot: rides the world like terrain, never chases
        if (b.x < -80) { b.dead = true; continue; }
      } else {
        // chase the player (tails you) until shot down or it expires
        const dx = game.px - b.x, dy = game.py - b.y, d = Math.hypot(dx, dy) || 1;
        b.x += (dx / d) * T.botSpeed * dt;
        b.y += (dy / d) * T.botSpeed * dt;
        // self-crash after tailing you for botCrashKB of distance
        if (game.streamed - b.spawnStreamed > T.botCrashKB) { b.dead = true; spawnParticles(b.x, b.y, C.warn, 26, 320); continue; }
      }
      // player bullets damage bots
      for (const pb of game.playerBullets) {
        if (b.dead) break;   // bot already destroyed this frame — stop, so later bullets don't "hit" the corpse (dupe particles/SFX)
        if (pb.dead) continue;
        if (Math.hypot(pb.x - b.x, pb.y - b.y) < T.botSize / 2 + (pb.big ? 18 : 6)) { if (!pb.big) pb.dead = true; b.hp -= pb.big ? 5 : 1; spawnParticles(pb.x, pb.y, C.warn, 10, 240); if (b.hp <= 0) { b.dead = true; SFX("malwareDie"); spawnParticles(b.x, b.y, C.danger, 30, 360); } }
      }
      // body contact costs a kernel
      if (!b.dead && game.invuln <= 0 && Math.hypot(game.px - b.x, game.py - b.y) < T.botSize / 2 + HBX / 2) {
        b.dead = true; SFX("malwareDie"); spawnParticles(b.x, b.y, C.danger, 24, 320); loseLife("bot");
      }
    }
    game.bots = game.bots.filter((b) => !b.dead);
    // PROXIMITY AUDIO: the presence loop stays near-silent until a bot is right on
    // top of you, then swells — quiet at distance, loud only when extremely close.
    if (window.DDAudio && window.DDAudio.isLooping("malwareLoop")) {
      if (!game.bots.length) {
        window.DDAudio.stopLoop("malwareLoop", true);
      } else {
        let nd = Infinity;
        for (const b of game.bots) {
          const d = Math.hypot(game.px - b.x, game.py - b.y);
          if (d < nd) nd = d;
        }
        let k = (T.botLoudFar - nd) / (T.botLoudFar - T.botLoudNear);
        k = Math.max(0, Math.min(1, k));
        if (window.DDAudio.setLoopVolume) window.DDAudio.setLoopVolume("malwareLoop", T.botLoudPeak * k * k);
      }
    }
  }

  function updateBombs(dt) {
    for (const bm of game.bombs) {
      bm.t += dt;
      if (!bm.exploded) {
        bm.x += bm.vx * dt; bm.y += bm.vy * dt;
        bm.fuse -= dt;
        if (bm.fuse <= 0) {
          bm.exploded = true; bm.t = 0; game.shake = 18;
          spawnParticles(bm.x, bm.y, C.danger, 44, 520);
          // stray orb shrapnel flung in all directions
          for (let k = 0; k < T.bombShrapnel; k++) {
            const a = (k / T.bombShrapnel) * Math.PI * 2 + Math.random() * 0.2;
            game.bullets.push({ x: bm.x, y: bm.y, vx: Math.cos(a) * T.bulletSpeed * 0.9, vy: Math.sin(a) * T.bulletSpeed * 0.9 });
          }
          if (game.invuln <= 0 && Math.hypot(game.px - bm.x, game.py - bm.y) < T.bombRadius + HBX / 2) loseLife("bomb");
        }
      }
    }
    game.bombs = game.bombs.filter((bm) => !(bm.exploded && bm.t > 0.4));
  }

  // ---- boss : vicious malware daemon ---------------------------------------
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  function makeBoss(homeX, homeY) {
    // each daemon gets a randomized personality: movement style, a shuffled
    // attack playlist, fire cadence, and spin — never the same fight twice
    const playlist = shuffle([0, 1, 2, 3, 4]).slice(0, 3 + Math.floor(Math.random() * 3));
    const ARCH = [
      { kind: "spike",  c1: C.danger,  c2: C.mystery },
      { kind: "ring",   c1: "#ff9e4d", c2: C.danger  },
      { kind: "cube",   c1: C.mystery, c2: C.accent   },
      { kind: "eye",    c1: "#ff5d73", c2: "#ffd166"  },
    ];
    const arch = ARCH[Math.floor(Math.random() * ARCH.length)];
    return {
      phase: "enter",
      x: W + SPRITES.boss.w,
      y: homeY,
      homeX: homeX, homeY: homeY,
      tx: homeX, ty: homeY, moveT: 0,
      timer: T.bossDuration,
      enter: T.bossEnterTime,
      arch,
      patterns: playlist, pIdx: 0, pattern: playlist[0],
      patternT: 1.2, patternDur: T.bossPatternEvery * (0.7 + Math.random() * 0.7),
      fireT: 0.6, fireRate: 0.62 + Math.random() * 0.4,
      spiralA: Math.random() * 6.28, spiralDir: Math.random() < 0.5 ? 1 : -1,
      moveStyle: Math.floor(Math.random() * 3),
      moveSpeed: T.bossMoveSpeed * (0.75 + Math.random() * 0.7),
      orbA: Math.random() * 6.28, orbR: H * (0.18 + Math.random() * 0.14), orbDir: Math.random() < 0.5 ? 1 : -1,
      crashVy: 0, rot: 0, hitFlash: 0, pulse: 0, bombFired: false,
    };
  }

  function spawnBoss() {
    game.boss = makeBoss(W * 0.78, H / 2);
    game._bossesActive = true;
    showBanner(TEXT.bossIncoming, "", C.danger);
    game.nextBossPacket = game.streamed + T.bossPacketEvery * 0.35;   // first relief strip soon after engage
    SFX("bossIncoming");
    if (window.DDAudio) window.DDAudio.music("bossMusic");
  }

  function spawnDoubleBoss() {
    game.boss = makeBoss(W * 0.72, H * 0.30);
    game.boss2 = makeBoss(W * 0.82, H * 0.70);
    game._bossesActive = true;
    showBanner("⚠⚠  DOUBLE DAEMON BREACH", "two daemons at once — survive!", C.danger, 2.6);
    game.nextBossPacket = game.streamed + T.bossPacketEvery * 0.35;
    SFX("bossIncoming");
    if (window.DDAudio) window.DDAudio.music("bossMusic");
  }

  function bossPickTarget(b) {
    if (b.moveStyle === 1) {           // strafe: sweep across, full vertical range
      b.tx = W * (0.3 + Math.random() * 0.6);
      b.ty = H * (0.1 + Math.random() * 0.8);
      b.moveT = 0.3 + Math.random() * 0.4;
    } else {                           // dart ANYWHERE on screen
      b.tx = W * (0.16 + Math.random() * 0.74);
      b.ty = H * (0.1 + Math.random() * 0.8);
      b.moveT = 0.4 + Math.random() * 0.6;
    }
  }

  function updateBoss(dt) {
    if (game.boss) updateOneBoss(game.boss, dt, true);
    if (game.boss2) updateOneBoss(game.boss2, dt, false);
    if (game.boss && game.boss._dead) game.boss = null;
    if (game.boss2 && game.boss2._dead) game.boss2 = null;
    if (game._bossesActive && !game.boss && !game.boss2) {
      game._bossesActive = false;
      game.lastBossEndT = game.t;   // "no double-boss within 10s of a boss fight" rule
      game.bullets = []; game.bars = []; game.bombs = [];
      game.bossClock = 0;
      hud.timerWrap.classList.add("hidden");
      if (window.DDAudio) window.DDAudio.music("music");
    }
  }

  function updateOneBoss(b, dt, primary) {
    if (!b) return;
    if (b.hitFlash > 0) b.hitFlash -= dt;
    b.pulse += dt;

    if (b.phase === "enter") {
      b.enter -= dt;
      b.x += (b.homeX - b.x) * Math.min(1, dt * 4);
      b.y += (b.homeY - b.y) * Math.min(1, dt * 3);
      if (b.enter <= 0) { b.phase = "fight"; if (primary) hud.timerWrap.classList.remove("hidden"); bossPickTarget(b); }
    } else if (b.phase === "fight") {
      // movement by personality
      b.moveT -= dt;
      if (b.moveStyle === 2) {                 // orbit — roams the whole arena
        b.orbA += b.orbDir * dt * b.moveSpeed * 0.5;
        b.orbCx = (b.orbCx || W * 0.5) + ((W * (0.3 + 0.4 * Math.sin(b.pulse * 0.3))) - (b.orbCx || W * 0.5)) * dt;
        b.tx = b.orbCx + Math.cos(b.orbA) * b.orbR;
        b.ty = H * 0.5 + Math.sin(b.orbA) * b.orbR;
      } else if (b.moveT <= 0) bossPickTarget(b);
      const k = Math.min(1, dt * b.moveSpeed);
      b.x += (b.tx - b.x) * k;
      b.y += (b.ty - b.y) * k;
      b.y += Math.sin(b.pulse * 9) * 1.2;       // menace jitter
      // ambient energy embers shed during the fight
      if (Math.random() < 0.5) spawnParticles(b.x + (Math.random() - 0.5) * SPRITES.boss.w, b.y + (Math.random() - 0.5) * SPRITES.boss.w, b.arch ? b.arch.c2 : C.danger, 1, 120);

      b.timer -= dt;
      b.patternT -= dt;
      b.fireT -= dt;
      b.fire2T = (b.fire2T || 0) - dt;
      // enrage: the lower its health bar, the faster it switches & fires
      const rage = 1 - 0.5 * (1 - b.timer / T.bossDuration);
      if (b.patternT <= 0) {
        b.pIdx = (b.pIdx + 1) % b.patterns.length;
        b.pattern = b.patterns[b.pIdx];
        b.pattern2 = b.patterns[(b.pIdx + 2) % b.patterns.length];   // a second simultaneous pattern
        b.patternT = b.patternDur * rage;
        b.fireT = 0.15;
      }
      bossFire(b, dt);
      // CHAOS: fire a second overlapping pattern on its own cadence
      if (b.fire2T <= 0 && b.pattern2 != null) {
        b.fire2T = (0.9 + Math.random() * 0.6) * rage;
        const save = b.pattern; b.pattern = b.pattern2; b.fireT = 0; bossFire(b, dt); b.pattern = save;
      }
      // one big bomb toward the end of the life bar — blinks, then splash-detonates
      if (!b.bombFired && b.timer < T.bossDuration * 0.4) {
        b.bombFired = true;
        game.bombs.push({ x: b.x, y: b.y, vx: -T.bombSpeed, vy: 0, fuse: T.bombFuse, exploded: false, t: 0 });
        SFX("bossBomb");
      }

      if (b.timer <= 0) {
        b.phase = "crash";
        SFX("bossDead");
        showBanner(TEXT.bossSurvive, TEXT.bossSurviveSub, C.ok);
      }
      // body collision (gentle — costs a kernel)
      const hb = playerHitbox();
      const bw = SPRITES.boss.w * 0.6, bh = SPRITES.boss.h * 0.6;
      if (game.invuln <= 0 && rectsHit(hb.x, hb.y, hb.w, hb.h, b.x - bw / 2, b.y - bh / 2, bw, bh)) loseLife("boss");
    } else if (b.phase === "crash") {
      b.crashVy += T.crashGravity * 0.6 * dt;
      b.y += b.crashVy * dt;
      b.x += 30 * dt;
      b.rot += dt * 9;
      if ((b.pulse * 60) % 3 < 1) spawnParticles(b.x + (Math.random() - 0.5) * 60, b.y + (Math.random() - 0.5) * 60, C.danger, 2, 160);
      if (b.y - SPRITES.boss.h / 2 > H + 40) {
        spawnParticles(b.x, H, C.danger, 36, 360);
        game.shake = 14;
        b._dead = true;
      }
    }
  }

  function spawnBullet(b, ang, spd) {
    var now = (game ? game.t : 0);
    if (now - (game._lastBossShot || -1) > 0.12) { game._lastBossShot = now; SFX("bossShot"); }
    game.bullets.push({
      x: b.x, y: b.y,
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
    });
  }

  // attack patterns — varied but all dodgeable in the wide arena
  function bossFire(b, dt) {
    if (b.fireT > 0) return;
    const toPlayer = Math.atan2(game.py - b.y, game.px - b.x);
    const s = T.bulletSpeed;
    const fr = b.fireRate;
    // muzzle flash for activity
    spawnParticles(b.x, b.y, b.arch ? b.arch.c1 : C.danger, 6, 260);
    switch (b.pattern) {
      case 0: // aimed burst (3–5 shots depending on the daemon)
        b.fireT = 0.7 * fr;
        { const n = b.spiralDir > 0 ? 2 : 1; for (let i = -n; i <= n; i++) spawnBullet(b, toPlayer + i * 0.16, s * 1.05); }
        break;
      case 1: // radial ring
        b.fireT = 1.15 * fr;
        { const n = 10, off = Math.random() * Math.PI; for (let i = 0; i < n; i++) spawnBullet(b, off + (i / n) * Math.PI * 2, s * 0.8); }
        break;
      case 2: // rotating spiral (direction varies per daemon)
        b.fireT = 0.13 * fr;
        b.spiralA += 0.5 * b.spiralDir;
        spawnBullet(b, b.spiralA, s * 0.9);
        spawnBullet(b, b.spiralA + Math.PI, s * 0.9);
        break;
      case 3: // wall with a gap aimed away from the player
        b.fireT = 1.5 * fr;
        { const gapAng = toPlayer; for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; if (Math.abs(((a - gapAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.5) continue; spawnBullet(b, a, s * 0.78); } }
        break;
      case 4: // FIREWALL — a full-height energy wall sweeps in; fly through the gap
        b.fireT = 2.0 * fr;
        { const gapH = H * T.barGap;
          const gy = Math.max(gapH / 2 + 24, Math.min(H - gapH / 2 - 24, game.py + (Math.random() - 0.5) * H * 0.18));
          game.bars.push({ x: b.x - 30, vx: -T.barSpeed, w: T.barThickness, gapY: gy, gapH, life: 0, warn: T.barWarn }); }
        break;
    }
  }
  function updateBullets(dt) {
    for (const bl of game.bullets) {
      bl.x += bl.vx * dt; bl.y += bl.vy * dt;
      if (game.invuln <= 0) {
        const hb = playerHitbox();
        if (rectsHit(hb.x, hb.y, hb.w, hb.h, bl.x - T.bulletSize / 2, bl.y - T.bulletSize / 2, T.bulletSize, T.bulletSize)) {
          bl.dead = true;
          loseLife("bullet");
        }
      }
    }
    game.bullets = game.bullets.filter((bl) => !bl.dead && bl.x > -40 && bl.x < W + 40 && bl.y > -40 && bl.y < H + 40);
    // firewall walls (full-height with a gap)
    for (const bar of game.bars) {
      bar.life += dt;
      if (bar.breaking) { bar.breakT = (bar.breakT || 0) + dt; continue; }
      if (bar.life > bar.warn) bar.x += bar.vx * dt;
      if (bar.life > bar.warn && game.invuln <= 0) {
        const hb = playerHitbox();
        const inX = hb.x < bar.x + bar.w / 2 && hb.x + hb.w > bar.x - bar.w / 2;
        const inGap = hb.y > bar.gapY - bar.gapH / 2 && hb.y + hb.h < bar.gapY + bar.gapH / 2;
        if (inX && !inGap) {
          if (game.freeAmmo || game.invincible > 0) {
            // OVERDRIVE: smash straight through — the firewall shatters, no penalty
            bar.breaking = true; bar.breakT = 0; game.shake = 14;
            SFX("firewallSmash");
            spawnParticles(game.px, game.py, "#ffffff", 30, 420);
            spawnParticles(bar.x, game.py, C.danger, 24, 380);
          } else {
            loseLife("firewall"); game.invuln = Math.max(game.invuln, 0.5);
          }
        }
      }
    }
    game.bars = game.bars.filter((bar) => bar.x > -60 && bar.life < 14 && !(bar.breaking && bar.breakT > 0.35));
  }

  function updateParticles(dt) {
    for (const p of game.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      p.life -= dt;
    }
    game.particles = game.particles.filter((p) => p.life > 0);
    // floating "+kb" pickup texts
    for (const f of game.floaters) { f.t += dt; f.y -= 26 * dt; }
    game.floaters = game.floaters.filter((f) => f.t < 0.9);
  }

  // ---- HUD -----------------------------------------------------------------
  function updateHud() {
    hud.dist.textContent = formatBytes(game.bytes);
    hud.best.textContent = formatBytes(best);
    // lives icons
    if (hud.lives.childElementCount !== game.lives) {
      hud.lives.innerHTML = "";
      for (let i = 0; i < game.lives; i++) {
        const d = document.createElement("span");
        d.className = "life";
        hud.lives.appendChild(d);
      }
    }
    const bossT = (game.boss && game.boss.phase === "fight") ? game.boss : ((game.boss2 && game.boss2.phase === "fight") ? game.boss2 : null);
    if (bossT) {
      const f = Math.max(0, bossT.timer / T.bossDuration);
      hud.timerVal.textContent = Math.ceil(bossT.timer) + "s";
      hud.timerFill.style.transform = `scaleX(${f})`;
    }
    // mystery scroll-effect status pill
    if (hud.fx) {
      if (game.scrollFx) {
        const fx = game.scrollFx;
        const label = fx.kind === "fast" ? "OVERCLOCK ⏩" : (fx.kind === "slow" ? "THROTTLED ⏸" : "REVERTING ⏪");
        const fxCol = fx.kind === "reverse" ? C.danger : C.ok;
        hud.fx.textContent = label + "  " + Math.ceil(fx.t) + "s";
        hud.fx.style.color = fxCol;
        hud.fx.style.borderColor = fxCol;
        hud.fx.classList.remove("hidden");
      } else {
        hud.fx.classList.add("hidden");
      }
    }
  }

  // ---- render --------------------------------------------------------------
  function render() {
    ctx.clearRect(0, 0, W, H);
    let sx = 0, sy = 0;
    if (game && game.shake > 0) {
      sx = (Math.random() - 0.5) * game.shake;
      sy = (Math.random() - 0.5) * game.shake;
    }
    ctx.save();
    ctx.translate(sx, sy);

    drawBackground();
    if (game) {
      drawStreaks();
      drawTerrain();
      drawPickups();
      drawBots();
      drawBombs();
      drawBoss();
      drawBullets();
      drawBars();
      drawPlayerBullets();
      drawAimReticle();
      drawPlayer();
      drawParticles();
      drawFloaters();
    }
    ctx.restore();
    if (game && game.scrollFx) drawFxVignette();
    if (game && game.invincible > 0) drawInvincibleOverlay();
    if (game && game.transform > 0) drawTransformLightning();
    if (game && game.flashT > 0) { ctx.save(); ctx.globalAlpha = Math.min(0.85, game.flashT); ctx.fillStyle = "#dff4ff"; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  }

  function drawFloaters() {
    if (!game.floaters.length) return;
    ctx.textAlign = "center";
    for (const f of game.floaters) {
      ctx.globalAlpha = Math.max(0, 1 - f.t / 0.9);
      ctx.fillStyle = f.col || C.accentSoft;
      ctx.shadowColor = f.col || C.accent; ctx.shadowBlur = 8;
      ctx.font = `700 14px ${FONTS.mono}`;
      ctx.fillText(f.txt, f.x, f.y);
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.textAlign = "left";
  }

  // golden invincibility vignette + sweeping shimmer
  function drawInvincibleOverlay() {
    const grd = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.65);
    grd.addColorStop(0, "transparent");
    grd.addColorStop(1, hexA("#ffd23f", 0.28 + 0.12 * Math.sin(game.t * 8)));
    ctx.save(); ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
    // countdown bar
    const f = Math.max(0, game.invincible / T.pepeInvincible);
    ctx.fillStyle = hexA("#ffe66b", 0.9); ctx.fillRect(0, 0, W * f, 4);
    ctx.restore();
  }

  // crackling lightning forking across the whole screen during the transform
  function drawTransformLightning() {
    ctx.save();
    ctx.strokeStyle = "#ffffff"; ctx.shadowColor = C.accent; ctx.shadowBlur = 16; ctx.lineWidth = 2;
    for (let k = 0; k < 5; k++) {
      const x0 = Math.random() * W;
      ctx.beginPath(); ctx.moveTo(x0, 0);
      let x = x0, y = 0;
      while (y < H) { y += 30 + Math.random() * 50; x += (Math.random() - 0.5) * 90; ctx.lineTo(x, y); }
      ctx.globalAlpha = 0.4 + Math.random() * 0.4; ctx.stroke();
    }
    ctx.restore();
  }

  // pulsing edge glow while a scroll-warp is active: green = faster/slower, red = rewind
  function drawFxVignette() {
    const fx = game.scrollFx;
    const col = fx.kind === "reverse" ? C.danger : C.ok;
    const pulse = 0.35 + 0.35 * Math.abs(Math.sin(game.t * 6));
    const grd = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.62);
    grd.addColorStop(0, "transparent");
    grd.addColorStop(1, col);
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  let bgScroll = 0;
  // speed streaks — fixed set, recycled, draw faster as speed ramps
  const STREAKS = [];
  for (let i = 0; i < 26; i++) {
    STREAKS.push({ y: Math.random(), x: Math.random(), len: 40 + Math.random() * 120, z: 0.4 + Math.random() * 0.9 });
  }
  function drawStreaks() {
    const spd = game ? game.scroll : 0;
    const norm = Math.min(1, (spd - T.scrollStart) / Math.max(1, T.scrollMax - T.scrollStart));
    ctx.lineCap = "round";
    for (const s of STREAKS) {
      const len = s.len * (0.5 + norm) * s.z;
      const travel = (game ? game.dist : 0) * (0.9 + s.z * 1.4);
      let x = (s.x * (W + 300) - (travel % (W + 300)));
      const y = s.y * H;
      ctx.strokeStyle = `rgba(109,240,255,${0.07 + norm * 0.18 * s.z})`;
      ctx.lineWidth = s.z * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }
  // ---- circuit textures: pre-rendered once to offscreen tiles, then blitted ----
  let pcbTile = null, wallTile = null, tileW = 0;
  function makeCircuitCanvas(w, h, o) {
    const cv = document.createElement("canvas");
    cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR);
    const c = cv.getContext("2d"); c.scale(DPR, DPR);
    if (o.glow) { c.shadowColor = o.line; c.shadowBlur = o.glow; }
    const cell = o.cell, P = o.period, B = o.bold;
    const hash = (a, b) => (((a * 73856093) ^ (b * 19349663)) >>> 0);
    const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell) + 1;
    const line = o.line, pad = o.pad, chip = o.chip;
    for (let cx = 0; cx < cols; cx++) for (let cy = 0; cy < rows; cy++) {
      const x = cx * cell, y = cy * cell, hv = hash(cx % P, cy), m = hv % 12;
      c.strokeStyle = line; c.fillStyle = pad; c.lineWidth = B; c.lineCap = "round"; c.lineJoin = "round";
      const cxp = x + cell / 2, cyp = y + cell / 2, r = cell * 0.32;
      const L = [x, cyp], R = [x + cell, cyp], TP = [cxp, y], BT = [cxp, y + cell];
      // rounded corner trace between two edge-midpoints (flowing PCB look)
      const corner = (a, b) => { c.beginPath(); c.moveTo(a[0], a[1]); c.arcTo(cxp, cyp, b[0], b[1], r); c.lineTo(b[0], b[1]); c.stroke(); };
      const dot = (px, py, rr) => { c.fillStyle = pad; c.beginPath(); c.arc(px, py, rr, 0, 6.3); c.fill(); };
      if (m === 0) {                                // rare IC CHIP with pin rows
        const s = cell * 0.4;
        c.strokeStyle = chip; c.strokeRect(cxp - s / 2, cyp - s / 2, s, s);
        c.fillStyle = pad;
        for (let p = 0; p < 4; p++) { const o2 = -s / 2 + s * (p + 0.5) / 4; c.fillRect(cxp + o2 - 1, cyp - s / 2 - 5, B, 5); c.fillRect(cxp + o2 - 1, cyp + s / 2, B, 5); }
      } else if (m === 1) {                         // via: concentric ring + trace stub
        c.beginPath(); c.arc(cxp, cyp, cell * 0.15, 0, 6.3); c.stroke();
        dot(cxp, cyp, B * 1.5);
        c.strokeStyle = line; c.beginPath(); c.moveTo(x, cyp); c.lineTo(cxp - cell * 0.15, cyp); c.stroke();
      } else if (m < 4) {                           // rounded corner traces (flowing bends)
        corner(L, BT); dot(L[0] + 3, L[1], B * 1.1);
      } else if (m < 6) {
        corner(TP, R); dot(R[0] - 3, R[1], B * 1.1);
      } else if (m < 8) {                           // straight bus with junction pad
        c.beginPath(); c.moveTo(x, cyp); c.lineTo(x + cell, cyp); c.stroke(); dot(cxp, cyp, B * 1.4);
      } else if (m === 8) {                         // vertical run + SMD component pair
        c.beginPath(); c.moveTo(cxp, y); c.lineTo(cxp, y + cell); c.stroke();
        c.fillStyle = pad; c.fillRect(cxp - 8, y + cell * 0.4, 5, 9); c.fillRect(cxp + 3, y + cell * 0.4, 5, 9);
      } else if (m === 9) {                         // T-junction
        c.beginPath(); c.moveTo(x, cyp); c.lineTo(x + cell, cyp); c.moveTo(cxp, cyp); c.lineTo(cxp, y + cell); c.stroke(); dot(cxp, cyp, B * 1.4);
      } else {                                      // diagonal 45° run + node
        c.beginPath(); c.moveTo(x, y + cell); c.lineTo(x + cell, y); c.stroke(); dot(cxp, cyp, B * 1.2);
      }
    }
    c.shadowBlur = 0;
    return cv;
  }
  function buildTiles() {
    tileW = 1500;
    // background: faint, small, sparse — recedes
    pcbTile = makeCircuitCanvas(tileW, H, { cell: 60, period: 24, bold: 1, line: "rgba(45,212,255,0.08)", pad: "rgba(109,240,255,0.1)", chip: "rgba(120,222,255,0.09)" });
    // foreground walls: BOLD, glowing white-blue — reads as a lit circuit board
    wallTile = makeCircuitCanvas(tileW, H, { cell: 96, period: 16, bold: 2.4, glow: 6, line: "rgba(150,235,255,0.62)", pad: "rgba(235,252,255,0.92)", chip: "rgba(190,242,255,0.6)" });
  }

  function blitTile(tile, parallax) {
    if (!tile) return;
    const scroll = game ? game.dist * parallax : 0;
    for (let dx = -(scroll % tileW); dx < W; dx += tileW) ctx.drawImage(tile, dx, 0, tileW, H);
  }

  function drawWallCircuits() {
    if (!game || !wallTile) return;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(-T.colW, 0);
    for (let i = 0; i < game.cols.length; i++) ctx.lineTo(i * T.colW - scrollAcc, game.cols[i].ceil);
    ctx.lineTo(W + T.colW, 0); ctx.closePath(); ctx.clip();
    blitTile(wallTile, 1.0);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.moveTo(-T.colW, H);
    for (let i = 0; i < game.cols.length; i++) ctx.lineTo(i * T.colW - scrollAcc, H - game.cols[i].floor);
    ctx.lineTo(W + T.colW, H); ctx.closePath(); ctx.clip();
    blitTile(wallTile, 1.0);
    ctx.restore();
  }

  function drawPCB() { blitTile(pcbTile, 0.5); }

  // Vex-style network: slow rotating sacred-geometry hex lattices with pulsing
  // nodes + floating wireframe cubes drifting through the deep background
  function drawVexNetwork() {
    const t = game ? game.t : 0;
    const scroll = (game ? game.dist : 0) * 0.18;
    ctx.save();
    ctx.globalAlpha = 0.5;
    // two big concentric rotating hex rings of nodes
    const cx = W * 0.5, cy = H * 0.5;
    for (let ring = 0; ring < 2; ring++) {
      const rad = Math.min(W, H) * (0.26 + ring * 0.16);
      const dir = ring % 2 ? -1 : 1;
      const rot = t * 0.12 * dir;
      ctx.strokeStyle = hexA(C.accent, 0.16); ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) { const a = rot + i / 6 * Math.PI * 2; const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      // spokes + pulsing nodes
      for (let i = 0; i < 6; i++) {
        const a = rot + i / 6 * Math.PI * 2, x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
        ctx.strokeStyle = hexA(C.accent, 0.1); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
        const pp = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 3 + i + ring));
        ctx.fillStyle = hexA(C.accentSoft, 0.5 * pp); ctx.shadowColor = C.accent; ctx.shadowBlur = 10 * pp;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      }
    }
    // floating wireframe cubes drifting right→left, parallax
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 5; k++) {
      const seed = k * 97.13;
      const bx = (W + 120) - ((scroll * (0.5 + k * 0.12) + seed * 11) % (W + 240));
      const by = (Math.sin(seed) * 0.5 + 0.5) * H;
      const sz = 16 + (k % 3) * 10;
      const rot = t * (0.3 + k * 0.1) * (k % 2 ? -1 : 1);
      ctx.save(); ctx.translate(bx, by); ctx.rotate(rot);
      ctx.strokeStyle = hexA(C.accentSoft, 0.22);
      ctx.strokeRect(-sz / 2, -sz / 2, sz, sz);
      const o = sz * 0.32;
      ctx.strokeStyle = hexA(C.accent, 0.18);
      ctx.strokeRect(-sz / 2 + o, -sz / 2 - o, sz, sz);
      // connect the two squares (cube projection)
      ctx.beginPath();
      ctx.moveTo(-sz/2, -sz/2); ctx.lineTo(-sz/2 + o, -sz/2 - o);
      ctx.moveTo(sz/2, -sz/2); ctx.lineTo(sz/2 + o, -sz/2 - o);
      ctx.moveTo(sz/2, sz/2); ctx.lineTo(sz/2 + o, sz/2 - o);
      ctx.moveTo(-sz/2, sz/2); ctx.lineTo(-sz/2 + o, sz/2 - o);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawBackground() {
    ctx.fillStyle = C.bg;
    ctx.fillRect(-40, -40, W + 80, H + 80);
    // glow top
    const g = ctx.createRadialGradient(W * 0.5, -H * 0.2, 0, W * 0.5, -H * 0.2, H * 1.1);
    g.addColorStop(0, C.bgGlow);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fillRect(-40, -40, W + 80, H + 80);
    // moving grid
    if (game) bgScroll = (bgScroll + game.scroll * 0.4 * (1 / 60)) % 56;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -((game ? game.dist * 0.4 : 0) % 56); x < W; x += 56) {
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let y = 0; y < H; y += 56) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    drawPCB();
    drawVexNetwork();

    // deep fiber-optic data bus: faint horizontal lines with travelling light packets
    const buses = 5;
    for (let b = 0; b < buses; b++) {
      const by = (b + 0.5) / buses * H;
      ctx.strokeStyle = "rgba(45,212,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(W, by); ctx.stroke();
      const t = game ? game.t : 0;
      const speed = 90 + b * 28;
      for (let k = 0; k < 3; k++) {
        const px = (((t * speed + b * 140 + k * (W / 3)) % (W + 80)) - 40);
        const grd = ctx.createLinearGradient(px - 40, 0, px, 0);
        grd.addColorStop(0, "transparent");
        grd.addColorStop(1, b % 2 ? "rgba(114,255,207,0.5)" : "rgba(109,240,255,0.5)");
        ctx.strokeStyle = grd; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(px - 40, by); ctx.lineTo(px, by); ctx.stroke();
      }
    }
  }

  function drawTerrain() {
    const edge = 3;
    // ceiling fill
    ctx.fillStyle = C.terrain;
    ctx.beginPath();
    ctx.moveTo(-T.colW, 0);
    for (let i = 0; i < game.cols.length; i++) {
      const x = i * T.colW - scrollAcc;
      ctx.lineTo(x, game.cols[i].ceil);
    }
    ctx.lineTo(W + T.colW, 0);
    ctx.closePath();
    ctx.fill();
    // ceiling edge
    ctx.strokeStyle = C.terrainEdge;
    ctx.lineWidth = edge;
    ctx.shadowColor = C.terrainEdge;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    for (let i = 0; i < game.cols.length; i++) {
      const x = i * T.colW - scrollAcc;
      i === 0 ? ctx.moveTo(x, game.cols[i].ceil) : ctx.lineTo(x, game.cols[i].ceil);
    }
    ctx.stroke();

    // floor fill
    ctx.shadowBlur = 0;
    ctx.fillStyle = C.terrain;
    ctx.beginPath();
    ctx.moveTo(-T.colW, H);
    for (let i = 0; i < game.cols.length; i++) {
      const x = i * T.colW - scrollAcc;
      ctx.lineTo(x, H - game.cols[i].floor);
    }
    ctx.lineTo(W + T.colW, H);
    ctx.closePath();
    ctx.fill();
    // floor edge
    ctx.strokeStyle = C.terrainEdge;
    ctx.lineWidth = edge;
    ctx.shadowColor = C.terrainEdge;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    for (let i = 0; i < game.cols.length; i++) {
      const x = i * T.colW - scrollAcc;
      i === 0 ? ctx.moveTo(x, H - game.cols[i].floor) : ctx.lineTo(x, H - game.cols[i].floor);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    drawWallCircuits();

    ctx.fillStyle = "rgba(109,240,255,0.22)";
    for (let i = 0; i < game.cols.length; i += 4) {
      const x = i * T.colW - scrollAcc;
      const cyl = game.cols[i].ceil, fyl = H - game.cols[i].floor;
      // perpendicular trace stub + solder pad + IC tab (motherboard texture)
      ctx.fillRect(x - 1, cyl, 2, 11); ctx.fillRect(x - 3, cyl + 11, 6, 3);
      ctx.fillRect(x - 1, fyl - 11, 2, 11); ctx.fillRect(x - 3, fyl - 14, 6, 3);
      if (i % 8 === 0) {
        // horizontal trace run between pads + a little IC block
        ctx.fillRect(x, cyl + 13, T.colW * 4, 2);
        ctx.fillRect(x, fyl - 15, T.colW * 4, 2);
        ctx.strokeStyle = "rgba(120,222,255,0.3)"; ctx.lineWidth = 1;
        ctx.strokeRect(x + T.colW * 1.4, cyl + 16, 22, 12);
        ctx.strokeRect(x + T.colW * 1.4, fyl - 28, 22, 12);
        ctx.fillStyle = "rgba(109,240,255,0.22)";
      }
    }

    // inner fiber traces hugging each wall (dim parallel line)
    const inset = 9;
    ctx.strokeStyle = "rgba(45,212,255,0.28)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < game.cols.length; i++) {
      const x = i * T.colW - scrollAcc, y = game.cols[i].ceil + inset;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < game.cols.length; i++) {
      const x = i * T.colW - scrollAcc, y = H - game.cols[i].floor - inset;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // fiber-optic data packets streaming along the walls
    const NP = 14, ncols = game.cols.length;
    for (let k = 0; k < NP; k++) {
      // ceiling packets flow one way, floor the other
      const pc = ((k / NP) + game.t * 0.16) % 1;
      const ci = Math.min(ncols - 1, Math.max(0, Math.floor(pc * (ncols - 1))));
      const cx = ci * T.colW - scrollAcc, cyy = game.cols[ci].ceil + inset;
      ctx.fillStyle = "#bfefff"; ctx.shadowColor = C.accentSoft; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(cx, cyy, 2.4, 0, Math.PI * 2); ctx.fill();
      const pf = ((k / NP) - game.t * 0.13 + 1) % 1;
      const fi = Math.min(ncols - 1, Math.max(0, Math.floor(pf * (ncols - 1))));
      const fx = fi * T.colW - scrollAcc, fyy = H - game.cols[fi].floor - inset;
      ctx.beginPath(); ctx.arc(fx, fyy, 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;

    // blocks — extrusions of the wall, detailed like chips on a board
    for (let i = 0; i < game.cols.length; i++) {
      const col = game.cols[i];
      if (!col.blocks.length) continue;
      const x = i * T.colW - scrollAcc;
      for (const blk of col.blocks) {
        if (blk.smashed) continue;
        const bw = T.colW * (blk.span || 1);
        const top = blk.from === "top";
        const OV = 14;
        // base derives from THIS column's wall → chip is ALWAYS grounded
        const by = top ? col.ceil - OV : (H - col.floor) - blk.h;
        const bh = blk.h + OV;
        const bg = ctx.createLinearGradient(0, by, 0, by + bh);
        bg.addColorStop(0, top ? "#0b2b42" : "#06182e");
        bg.addColorStop(1, top ? "#06182e" : "#0b2b42");
        ctx.fillStyle = bg;
        ctx.fillRect(x, by, bw, bh);
        ctx.strokeStyle = C.obstacleEdge; ctx.lineWidth = 2.5;
        ctx.shadowColor = C.obstacleEdge; ctx.shadowBlur = 11;
        ctx.beginPath();
        if (top) { ctx.moveTo(x, by); ctx.lineTo(x, by + bh); ctx.lineTo(x + bw, by + bh); ctx.lineTo(x + bw, by); }
        else { ctx.moveTo(x, by + bh); ctx.lineTo(x, by); ctx.lineTo(x + bw, by); ctx.lineTo(x + bw, by + bh); }
        ctx.stroke();
        ctx.shadowBlur = 0;
        // contact pads near the exposed tip + circuit detail
        const tipY = top ? by + bh : by;
        const pads = Math.max(2, Math.round(bw / 14));
        ctx.fillStyle = "rgba(109,240,255,0.7)";
        for (let p = 0; p < pads; p++) {
          const px = x + (p + 0.5) * (bw / pads) - 2;
          ctx.fillRect(px, top ? tipY - 8 : tipY + 4, 4, 4);
        }
        ctx.strokeStyle = "rgba(109,240,255,0.3)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + bw / 2, by + 4); ctx.lineTo(x + bw / 2, by + bh - 4); ctx.stroke();
        // little IC tick rungs
        for (let yy = by + 10; yy < by + bh - 6; yy += 12) { ctx.beginPath(); ctx.moveTo(x + 4, yy); ctx.lineTo(x + bw - 4, yy); ctx.stroke(); }
      }
    }
  }

  function hexA(hex, a) {
    if (!hex || hex[0] !== "#") return hex;
    return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  }
  function lerpHex(a, b, t) {
    const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
    const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
    const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function drawBombs() {
    for (const bm of game.bombs) {
      if (!bm.exploded) {
        const blink = 0.5 + 0.5 * Math.sin(bm.t * (10 + (T.bombFuse - bm.fuse) * 10));
        const r = 22;
        const g = ctx.createRadialGradient(bm.x, bm.y, 0, bm.x, bm.y, r * 2);
        g.addColorStop(0, "#ffffff"); g.addColorStop(0.4, C.danger); g.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.55 + 0.45 * blink;
        ctx.fillStyle = g; ctx.shadowColor = C.danger; ctx.shadowBlur = 28;
        ctx.beginPath(); ctx.arc(bm.x, bm.y, r * 2, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
        // blast-radius telegraph ring
        ctx.strokeStyle = hexA(C.danger, 0.3 + 0.3 * blink); ctx.lineWidth = 2; ctx.setLineDash([10, 10]);
        ctx.beginPath(); ctx.arc(bm.x, bm.y, T.bombRadius, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      } else {
        const k = Math.min(1, bm.t / 0.4);
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = hexA("#ffffff", 0.8);
        ctx.shadowColor = C.danger; ctx.shadowBlur = 40;
        ctx.beginPath(); ctx.arc(bm.x, bm.y, T.bombRadius * (0.3 + k), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      }
    }
  }

  function drawBots() {
    for (const b of game.bots) {
      const r = T.botSize / 2, p = 0.5 + 0.5 * Math.sin(b.pulse * 8);
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.pulse * 2);
      // glitchy malware mite — spiky body, red/violet, angry eye
      ctx.shadowColor = C.danger; ctx.shadowBlur = 16;
      starPath(6, r * (1 + 0.12 * p), r * 0.5, b.pulse * 3);
      ctx.fillStyle = "rgba(30,8,22,0.95)"; ctx.fill();
      ctx.strokeStyle = p > 0.5 ? C.danger : C.mystery; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      // eye
      ctx.shadowBlur = 12; ctx.shadowColor = C.danger;
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(b.x, b.y, r * 0.26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.danger; ctx.beginPath(); ctx.arc(b.x, b.y, r * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function drawPickups() {
    for (const p of game.pickups) {
      if (p.grabbed) continue;
      const s = T.pickupSize;
      const bob = Math.sin(game.t * 3 + p.bob) * 5;
      const y = p.y + bob;

      if (p.kind === "pepe") {
        // PEPE COIN — shimmering jewelry-store jackpot (real art)
        const sz = T.pepeSize, gp = 0.5 + 0.5 * Math.sin(game.t * 6 + p.bob);
        ctx.save(); ctx.translate(p.x, y);
        // radiant gold halo
        const ha = ctx.createRadialGradient(0, 0, 0, 0, 0, sz * 1.5);
        ha.addColorStop(0, hexA("#fff6c8", 0.5 + 0.25 * gp)); ha.addColorStop(0.4, hexA("#ffd23f", 0.32)); ha.addColorStop(1, "transparent");
        ctx.fillStyle = ha; ctx.beginPath(); ctx.arc(0, 0, sz * 1.5, 0, Math.PI * 2); ctx.fill();
        // gentle bob-spin shimmer on the medallion
        const tilt = Math.cos(game.t * 2);
        ctx.shadowColor = "#ffe66b"; ctx.shadowBlur = 18 + 10 * gp;
        if (imgPepe && imgPepe.complete && imgPepe.naturalWidth) {
          const dw = sz * (0.85 + 0.15 * Math.abs(tilt)), dh = sz;
          ctx.drawImage(imgPepe, -dw / 2, -dh / 2, dw, dh);
        }
        ctx.restore();
        // sweeping sparkle glints
        for (let k = 0; k < 4; k++) {
          const a = game.t * 2.5 + k * 1.6, prog2 = (game.t * 1.5 + k * 0.25) % 1, gr = sz * (0.5 + 0.55 * prog2);
          ctx.globalAlpha = Math.max(0, 1 - prog2);
          ctx.fillStyle = "#ffffff"; ctx.shadowColor = "#fff6c8"; ctx.shadowBlur = 8;
          ctx.beginPath(); ctx.arc(p.x + Math.cos(a) * gr, y + Math.sin(a) * gr, 2.6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
        continue;
      }

      if (p.kind === "upgrade") {
        // electric lightning bolt — pulsing blue/white, no magnet (fly into it)
        const tt = 0.5 + 0.5 * Math.sin(game.t * 10 + p.bob);
        const us = T.upgradeSize;
        ctx.save(); ctx.translate(p.x, y);
        // aura
        const ha = ctx.createRadialGradient(0, 0, 0, 0, 0, us * 1.4);
        ha.addColorStop(0, hexA("#ffffff", 0.5 + 0.3 * tt)); ha.addColorStop(0.5, hexA(C.accent, 0.25)); ha.addColorStop(1, "transparent");
        ctx.fillStyle = ha; ctx.beginPath(); ctx.arc(0, 0, us * 1.4, 0, Math.PI * 2); ctx.fill();
        // bolt
        ctx.shadowColor = C.accent; ctx.shadowBlur = 22;
        ctx.fillStyle = "#ffffff"; ctx.strokeStyle = C.accentSoft; ctx.lineWidth = 2;
        ctx.beginPath();
        const u = us * 0.5;
        ctx.moveTo(-u * 0.2, -u); ctx.lineTo(u * 0.45, -u * 0.15); ctx.lineTo(u * 0.05, -u * 0.05);
        ctx.lineTo(u * 0.5, u); ctx.lineTo(-u * 0.45, u * 0.1); ctx.lineTo(-u * 0.02, 0); ctx.closePath();
        ctx.fill(); ctx.stroke();
        // crackle
        ctx.strokeStyle = hexA("#ffffff", 0.7); ctx.lineWidth = 1.3;
        for (let k = 0; k < 3; k++) { const a = Math.random() * 6.3; ctx.beginPath(); ctx.moveTo(Math.cos(a) * u, Math.sin(a) * u); ctx.lineTo(Math.cos(a) * us * (0.9 + Math.random() * 0.4), Math.sin(a) * us * (0.9 + Math.random() * 0.4)); ctx.stroke(); }
        ctx.restore(); ctx.shadowBlur = 0;
        ctx.fillStyle = C.accentSoft; ctx.font = `700 9px ${FONTS.mono}`; ctx.textAlign = "center";
        ctx.fillText("⚡ UPGRADE", p.x, y + us * 0.7 + 12); ctx.textAlign = "left";
        continue;
      }

      if (p.kind === "packet") {
        // DATA PACKET — flashy little data-cube zipping through, white-blue
        const tt = 0.5 + 0.5 * Math.sin(game.t * 9 + p.bob);
        const ps = s * 0.34;
        ctx.save(); ctx.translate(p.x, y); ctx.rotate(game.t * 2.2);
        ctx.shadowColor = C.accent; ctx.shadowBlur = 16 + 10 * tt;
        ctx.fillStyle = hexA("#dff6ff", 0.85); ctx.strokeStyle = C.accentSoft; ctx.lineWidth = 1.6;
        ctx.fillRect(-ps, -ps, ps * 2, ps * 2); ctx.strokeRect(-ps, -ps, ps * 2, ps * 2);
        ctx.restore();
        // trailing data streak
        ctx.strokeStyle = hexA(C.accentSoft, 0.5); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x + 8, y); ctx.lineTo(p.x + 26, y); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = C.accentSoft; ctx.font = `700 9px ${FONTS.mono}`; ctx.textAlign = "center";
        ctx.fillText("+10KB", p.x, y + ps + 14); ctx.textAlign = "left";
        continue;
      }

      if (p.kind === "mystery") {
        // AGGRESSIVE hard red/green strobe — might be good, might be bad
        const phase = Math.sin(game.t * 16 + p.bob);
        const good = phase > 0;
        const col = good ? C.ok : C.danger;
        const glow = 22 + 18 * Math.abs(phase);
        ctx.save();
        ctx.translate(p.x, y);
        ctx.rotate(Math.sin(game.t * 8) * 0.12);   // nervous jitter
        // erratic electric halo
        const ha = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.5);
        ha.addColorStop(0, hexA(col, 0.55)); ha.addColorStop(0.5, hexA(col, 0.2)); ha.addColorStop(1, "transparent");
        ctx.fillStyle = ha; ctx.beginPath(); ctx.arc(0, 0, s * 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.shadowColor = col; ctx.shadowBlur = glow;
        ctx.fillStyle = hexA(col, 0.3);
        polyPath(6, s * 0.52, Math.PI / 6); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = "#ffffff";
        polyPath(6, s * 0.52, Math.PI / 6); ctx.stroke();
        ctx.lineWidth = 2; ctx.strokeStyle = col;
        polyPath(6, s * 0.42, Math.PI / 6); ctx.stroke();
        // sparking arcs
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.3;
        for (let k = 0; k < 3; k++) { const a = Math.random() * 6.28; ctx.beginPath(); ctx.moveTo(Math.cos(a) * s * 0.5, Math.sin(a) * s * 0.5); ctx.lineTo(Math.cos(a) * s * (0.8 + Math.random() * 0.5), Math.sin(a) * s * (0.8 + Math.random() * 0.5)); ctx.stroke(); }
        ctx.fillStyle = "#ffffff";
        ctx.font = `900 ${Math.round(s * 0.66)}px ${FONTS.ui}`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("?", 0, 1);
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        ctx.restore();
        ctx.shadowBlur = 0;
        continue;
      }

      if (p.kind === "dataloss") {
        // DATA LOSS — pulsing RED skull ensnared in violent black corruption goop
        const ds = s * 1.3, pp = 0.5 + 0.5 * Math.sin(game.t * 7 + p.bob);
        ctx.save(); ctx.translate(p.x, y);
        // menacing red halo
        const ha = ctx.createRadialGradient(0, 0, 0, 0, 0, ds * 1.5);
        ha.addColorStop(0, hexA("#ff5d73", 0.5 + 0.3 * pp)); ha.addColorStop(0.5, hexA("#b3001b", 0.28)); ha.addColorStop(1, "transparent");
        ctx.fillStyle = ha; ctx.beginPath(); ctx.arc(0, 0, ds * 1.5, 0, Math.PI * 2); ctx.fill();
        // black corruption goop — jagged static tendrils whipping around the skull
        ctx.strokeStyle = "#05010a"; ctx.lineWidth = 3.4; ctx.lineCap = "round"; ctx.shadowColor = "#000"; ctx.shadowBlur = 6;
        for (let k = 0; k < 9; k++) {
          const a = (k / 9) * 6.28 + game.t * 1.3;
          ctx.beginPath(); let rx = Math.cos(a) * ds * 0.42, ry = Math.sin(a) * ds * 0.42; ctx.moveTo(rx, ry);
          for (let j = 0; j < 3; j++) { rx += Math.cos(a) * ds * 0.22 + (Math.random() - 0.5) * 12; ry += Math.sin(a) * ds * 0.22 + (Math.random() - 0.5) * 12; ctx.lineTo(rx, ry); }
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        // skull — red dome + tapered jaw
        const rr = ds * 0.46;
        ctx.fillStyle = lerpHex("#ff5d73", "#ff2740", pp); ctx.strokeStyle = "#3a0008"; ctx.lineWidth = 2;
        ctx.shadowColor = "#ff2740"; ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(0, -rr * 0.2, rr, Math.PI, 0); // cranium
        ctx.lineTo(rr * 0.7, rr * 0.5); ctx.lineTo(rr * 0.34, rr * 0.5); ctx.lineTo(rr * 0.28, rr * 0.95);
        ctx.lineTo(-rr * 0.28, rr * 0.95); ctx.lineTo(-rr * 0.34, rr * 0.5); ctx.lineTo(-rr * 0.7, rr * 0.5);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
        // hollow eye sockets + nasal cavity (black)
        ctx.fillStyle = "#05010a";
        ctx.beginPath(); ctx.ellipse(-rr * 0.42, -rr * 0.15, rr * 0.27, rr * 0.32, 0, 0, 6.3); ctx.fill();
        ctx.beginPath(); ctx.ellipse(rr * 0.42, -rr * 0.15, rr * 0.27, rr * 0.32, 0, 0, 6.3); ctx.fill();
        ctx.beginPath(); ctx.moveTo(0, rr * 0.05); ctx.lineTo(rr * 0.14, rr * 0.4); ctx.lineTo(-rr * 0.14, rr * 0.4); ctx.closePath(); ctx.fill();
        // angry red eye glints
        ctx.fillStyle = "#ff6b7e"; ctx.shadowColor = "#ff2740"; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(-rr * 0.42, -rr * 0.12, rr * 0.09 * (0.7 + 0.5 * pp), 0, 6.3); ctx.fill();
        ctx.beginPath(); ctx.arc(rr * 0.42, -rr * 0.12, rr * 0.09 * (0.7 + 0.5 * pp), 0, 6.3); ctx.fill();
        ctx.shadowBlur = 0;
        // teeth
        ctx.strokeStyle = "#3a0008"; ctx.lineWidth = 1.4;
        for (let k = -2; k <= 2; k++) { ctx.beginPath(); ctx.moveTo(k * rr * 0.13, rr * 0.5); ctx.lineTo(k * rr * 0.13, rr * 0.92); ctx.stroke(); }
        ctx.restore();
        ctx.fillStyle = C.danger; ctx.font = `800 9px ${FONTS.mono}`; ctx.textAlign = "center";
        ctx.fillText("☠ DATA LOSS", p.x, y + ds * 0.62 + 12); ctx.textAlign = "left";
        continue;
      }

      if (p.kind === "recovery") {
        // DATA RECOVERY — hard-drive "doctor": metallic drive w/ spinning platter + green medical cross
        const ds = s * 1.3, pp = 0.5 + 0.5 * Math.sin(game.t * 6 + p.bob);
        ctx.save(); ctx.translate(p.x, y);
        // healing green halo
        const ha = ctx.createRadialGradient(0, 0, 0, 0, 0, ds * 1.45);
        ha.addColorStop(0, hexA("#72ffcf", 0.5 + 0.3 * pp)); ha.addColorStop(0.5, hexA("#1f8a5b", 0.25)); ha.addColorStop(1, "transparent");
        ctx.fillStyle = ha; ctx.beginPath(); ctx.arc(0, 0, ds * 1.45, 0, Math.PI * 2); ctx.fill();
        // drive body (metallic rounded rect)
        const bw = ds * 0.92, bh = ds * 0.72, rad = 6;
        ctx.shadowColor = C.ok; ctx.shadowBlur = 16;
        const bg = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
        bg.addColorStop(0, "#e9f6ff"); bg.addColorStop(0.5, "#9fb6c8"); bg.addColorStop(1, "#5d7184");
        ctx.fillStyle = bg; ctx.strokeStyle = "#2b3a47"; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-bw / 2 + rad, -bh / 2); ctx.arcTo(bw / 2, -bh / 2, bw / 2, bh / 2, rad);
        ctx.arcTo(bw / 2, bh / 2, -bw / 2, bh / 2, rad); ctx.arcTo(-bw / 2, bh / 2, -bw / 2, -bh / 2, rad);
        ctx.arcTo(-bw / 2, -bh / 2, bw / 2, -bh / 2, rad); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
        // spinning platter disc (left)
        ctx.save(); ctx.translate(-bw * 0.2, 0); ctx.rotate(game.t * 3);
        const pl = ctx.createRadialGradient(0, 0, 1, 0, 0, bh * 0.34);
        pl.addColorStop(0, "#cfe0ee"); pl.addColorStop(0.7, "#7d93a6"); pl.addColorStop(1, "#3c4c5a");
        ctx.fillStyle = pl; ctx.beginPath(); ctx.arc(0, 0, bh * 0.34, 0, 6.3); ctx.fill();
        ctx.strokeStyle = "#cfe9ff"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(bh * 0.3, 0); ctx.stroke();
        ctx.fillStyle = "#2b3a47"; ctx.beginPath(); ctx.arc(0, 0, bh * 0.06, 0, 6.3); ctx.fill();
        ctx.restore();
        // green medical "doctor" cross (right)
        const cx2 = bw * 0.22, cw2 = bh * 0.13, cl = bh * 0.3;
        ctx.fillStyle = lerpHex("#72ffcf", "#1f8a5b", 1 - pp); ctx.shadowColor = C.ok; ctx.shadowBlur = 12;
        ctx.fillRect(cx2 - cw2, -cl, cw2 * 2, cl * 2);
        ctx.fillRect(cx2 - cl, -cw2, cl * 2, cw2 * 2);
        ctx.shadowBlur = 0;
        ctx.restore();
        ctx.fillStyle = C.ok; ctx.font = `800 9px ${FONTS.mono}`; ctx.textAlign = "center";
        ctx.fillText("🖥 RECOVERY", p.x, y + ds * 0.55 + 12); ctx.textAlign = "left";
        continue;
      }

      if (p.kind === "shield") {
        // SHIELD — circular tactical-pepe icon ringed by a protective energy barrier
        const ss = T.shieldSize, pp = 0.5 + 0.5 * Math.sin(game.t * 5 + p.bob);
        ctx.save(); ctx.translate(p.x, y);
        const ha = ctx.createRadialGradient(0, 0, 0, 0, 0, ss * 0.92);
        ha.addColorStop(0, hexA("#6df0ff", 0.4 + 0.25 * pp)); ha.addColorStop(0.6, hexA("#2dd4ff", 0.16)); ha.addColorStop(1, "transparent");
        ctx.fillStyle = ha; ctx.beginPath(); ctx.arc(0, 0, ss * 0.92, 0, 6.283); ctx.fill();
        ctx.shadowColor = C.accent; ctx.shadowBlur = 16;
        if (imgShield && imgShield.complete && imgShield.naturalWidth) {
          ctx.save(); ctx.beginPath(); ctx.arc(0, 0, ss * 0.5, 0, 6.283); ctx.clip();
          ctx.drawImage(imgShield, -ss * 0.5, -ss * 0.5, ss, ss); ctx.restore();
        }
        ctx.shadowBlur = 0;
        // solid rim + rotating dashed barrier
        ctx.strokeStyle = hexA("#bdf3ff", 0.85); ctx.lineWidth = 2.5; ctx.shadowColor = C.accent; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(0, 0, ss * 0.53, 0, 6.283); ctx.stroke();
        ctx.shadowBlur = 0; ctx.setLineDash([7, 7]); ctx.lineWidth = 1.6; ctx.strokeStyle = hexA("#6df0ff", 0.7);
        ctx.save(); ctx.rotate(game.t * 1.4); ctx.beginPath(); ctx.arc(0, 0, ss * 0.63, 0, 6.283); ctx.stroke(); ctx.restore();
        ctx.setLineDash([]);
        ctx.restore();
        ctx.fillStyle = C.accentSoft; ctx.font = `800 9px ${FONTS.mono}`; ctx.textAlign = "center";
        ctx.fillText("🛡 SHIELD", p.x, y + ss * 0.5 + 13); ctx.textAlign = "left";
        continue;
      }

      // kernel — electrified UPDATE TESSERACT: nested cubes each spinning their own
      // way, high contrast, crackling aura
      const bonus = p.kind === "bonus";
      const tt = 0.5 + 0.5 * Math.sin(game.t * 6 + p.bob);
      const col = lerpHex(C.ok, C.accent, tt);
      const sz = bonus ? s * 0.62 : s * 0.48;
      const rot = game.t * 1.6;          // outer cube spin
      const rotI = -game.t * 2.6;        // inner cube spins opposite, faster
      const rotM = game.t * 3.4;         // core diamond spins fastest
      ctx.save();
      ctx.translate(p.x, y);
      // radiant + electric halo
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, sz * 2.6);
      halo.addColorStop(0, hexA("#ffffff", 0.45 + 0.3 * tt));
      halo.addColorStop(0.4, hexA(col, 0.28));
      halo.addColorStop(1, "transparent");
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(0, 0, sz * 2.6, 0, Math.PI * 2); ctx.fill();
      // crackling electric arcs around it
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.3; ctx.shadowColor = C.accent; ctx.shadowBlur = 12;
      for (let k = 0; k < 3; k++) { const a = Math.random() * 6.28; ctx.beginPath(); ctx.moveTo(Math.cos(a) * sz * 1.1, Math.sin(a) * sz * 1.1); ctx.lineTo(Math.cos(a) * sz * (1.7 + Math.random() * 0.5), Math.sin(a) * sz * (1.7 + Math.random() * 0.5)); ctx.stroke(); }
      // outer cube (bright white, high contrast)
      ctx.shadowColor = C.accent; ctx.shadowBlur = 16 + 12 * tt;
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = bonus ? 3 : 2.4;
      ctx.save(); ctx.rotate(rot); ctx.strokeRect(-sz, -sz, sz * 2, sz * 2); ctx.restore();
      // mid cube, counter-rotating, colored
      const msz = sz * 0.7;
      ctx.strokeStyle = col; ctx.lineWidth = bonus ? 2.4 : 2;
      ctx.save(); ctx.rotate(rotI); ctx.strokeRect(-msz, -msz, msz * 2, msz * 2); ctx.restore();
      // connecting struts between outer & mid (tesseract projection)
      ctx.globalAlpha = 0.6; ctx.strokeStyle = hexA("#bfeaff", 0.9); ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const ao = rot + Math.PI / 4 + k * Math.PI / 2, ai = rotI + Math.PI / 4 + k * Math.PI / 2;
        ctx.moveTo(Math.cos(ao) * sz * 1.414, Math.sin(ao) * sz * 1.414);
        ctx.lineTo(Math.cos(ai) * msz * 1.414, Math.sin(ai) * msz * 1.414);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
      // inner diamond core, spinning fastest
      ctx.save(); ctx.rotate(rotM);
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.8;
      const dsz = sz * 0.34;
      ctx.beginPath(); ctx.moveTo(0, -dsz); ctx.lineTo(dsz, 0); ctx.lineTo(0, dsz); ctx.lineTo(-dsz, 0); ctx.closePath(); ctx.stroke();
      ctx.restore();
      // luminous core
      ctx.shadowBlur = 0;
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, sz * 0.55);
      core.addColorStop(0, "#ffffff"); core.addColorStop(0.5, col); core.addColorStop(1, "transparent");
      ctx.fillStyle = core; ctx.globalAlpha = 0.6 + 0.4 * tt;
      ctx.beginPath(); ctx.arc(0, 0, sz * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
      // label
      ctx.fillStyle = col;
      ctx.font = `600 13px ${FONTS.mono}`;
      ctx.textAlign = "center";
      ctx.shadowBlur = 0;
      ctx.fillText(bonus ? "+2 KERNELS" : "+1 KERNEL", p.x, y + sz + 20);
      ctx.textAlign = "left";
    }
  }

  function polyPath(n, r, rot) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  function starPath(spikes, outer, inner, rot) {
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = rot + (i / (spikes * 2)) * Math.PI * 2;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  function drawBoss() {
    if (game.boss) drawOneBoss(game.boss);
    if (game.boss2) drawOneBoss(game.boss2);
  }
  function drawOneBoss(b) {
    if (!b) return;
    const w = SPRITES.boss.w;
    const crashing = b.phase === "crash";
    const flash = b.hitFlash > 0;
    const mix = Math.sin(b.pulse * 6);                 // angry red <-> violet throb
    const coreCol = flash ? "#ffffff" : (crashing ? C.danger : (mix > 0 ? C.danger : C.mystery));

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(crashing ? b.rot : Math.sin(b.pulse * 3) * 0.08);

    // reskin hook: a custom boss image overrides the procedural art
    if (imgBoss && imgBoss.complete && imgBoss.naturalWidth) {
      const h = SPRITES.boss.h;
      ctx.drawImage(imgBoss, -w / 2, -h / 2, w, h);
      ctx.restore();
      return;
    }

    const arch = b.arch || { kind: "spike", c1: C.danger, c2: C.mystery };
    const c1 = flash ? "#ffffff" : (crashing ? C.danger : arch.c1);
    const c2 = arch.c2;

    // seething aura (tinted to the species)
    const aura = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.98);
    aura.addColorStop(0, crashing ? "rgba(255,93,115,0.5)" : hexA(c2, 0.42));
    aura.addColorStop(0.5, hexA(c1, 0.16));
    aura.addColorStop(1, "transparent");
    ctx.fillStyle = aura;
    ctx.beginPath(); ctx.arc(0, 0, w * 0.98, 0, Math.PI * 2); ctx.fill();

    // outer containment ring + crackling energy arcs (overwhelming presence)
    ctx.save();
    ctx.rotate(b.pulse * 0.7 * (b.orbDir || 1));
    ctx.strokeStyle = hexA(c2, 0.85); ctx.lineWidth = 2.5;
    ctx.setLineDash([w * 0.22, w * 0.14]);
    ctx.shadowColor = c2; ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(0, 0, w * 0.82, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    // lightning arcs flicking off the body
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.4; ctx.shadowColor = c1; ctx.shadowBlur = 12;
    for (let k = 0; k < 3; k++) {
      const a0 = Math.random() * Math.PI * 2, r0 = w * 0.55, r1 = w * (0.78 + Math.random() * 0.18);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0);
      const am = a0 + (Math.random() - 0.5) * 0.5;
      ctx.lineTo(Math.cos(am) * (r0 + r1) / 2 + (Math.random() - 0.5) * 8, Math.sin(am) * (r0 + r1) / 2 + (Math.random() - 0.5) * 8);
      ctx.lineTo(Math.cos(a0) * r1, Math.sin(a0) * r1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    const spin = b.pulse * (crashing ? 5 : 1.5);
    ctx.shadowColor = c1; ctx.shadowBlur = 22;
    const body = ctx.createLinearGradient(0, -w * 0.5, 0, w * 0.5);
    body.addColorStop(0, "rgba(28,8,24,0.97)");
    body.addColorStop(1, "rgba(8,4,16,0.97)");

    if (arch.kind === "ring") {
      // segmented worm: concentric rotating dashed rings + nodes
      for (let r = 0; r < 3; r++) {
        const rad = w * (0.5 - r * 0.13);
        ctx.save(); ctx.rotate(spin * (r % 2 ? -1 : 1) * (1 + r * 0.3));
        ctx.strokeStyle = r === 1 ? c2 : c1; ctx.lineWidth = 5 - r;
        ctx.setLineDash([rad * 0.5, rad * 0.32]);
        ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      ctx.setLineDash([]);
      for (let k = 0; k < 8; k++) { const a = spin + k / 8 * Math.PI * 2; ctx.fillStyle = c1; ctx.beginPath(); ctx.arc(Math.cos(a) * w * 0.5, Math.sin(a) * w * 0.5, 3.5, 0, Math.PI * 2); ctx.fill(); }
    } else if (arch.kind === "cube") {
      // glitch trojan: rotating nested squares with hard offset glitch copies
      for (let g = 0; g < 3; g++) {
        ctx.save();
        ctx.translate((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
        ctx.rotate(spin * 0.6 + g * 0.2);
        const s2 = w * (0.46 - g * 0.12);
        ctx.strokeStyle = g === 0 ? c1 : (g === 1 ? c2 : C.accentSoft);
        ctx.lineWidth = 3 - g * 0.6;
        ctx.fillStyle = g === 0 ? body : "transparent";
        ctx.beginPath(); ctx.rect(-s2, -s2, s2 * 2, s2 * 2); if (g === 0) ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    } else if (arch.kind === "eye") {
      // rootkit: pulsing iris with radiating lashes
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(0, 0, w * 0.46, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = c1; ctx.lineWidth = 3; ctx.stroke();
      for (let k = 0; k < 16; k++) { const a = spin * 0.4 + k / 16 * Math.PI * 2; ctx.strokeStyle = c2; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(Math.cos(a) * w * 0.46, Math.sin(a) * w * 0.46); ctx.lineTo(Math.cos(a) * w * (0.5 + 0.06 * Math.sin(b.pulse * 6 + k)), Math.sin(a) * w * (0.5 + 0.06 * Math.sin(b.pulse * 6 + k))); ctx.stroke(); }
    } else {
      // jagged virus: rotating spike-star + counter spikes
      starPath(9, w * 0.52 * (1 + 0.07 * Math.sin(b.pulse * 8)), w * 0.3, spin);
      ctx.fillStyle = body; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = c1; ctx.stroke();
      starPath(6, w * 0.34, w * 0.16, -spin * 1.7);
      ctx.lineWidth = 2; ctx.strokeStyle = c2; ctx.stroke();
    }

    // glitch slices — shared corrupted-data shimmer
    ctx.shadowBlur = 0;
    for (let i = 0; i < 3; i++) {
      const gy = (Math.random() - 0.5) * w * 0.72, gh = 2 + Math.random() * 5, gw = w * (0.3 + Math.random() * 0.5);
      ctx.globalAlpha = 0.5; ctx.fillStyle = Math.random() < 0.5 ? c1 : C.accentSoft;
      ctx.fillRect(-gw / 2 + (Math.random() - 0.5) * 12, gy, gw, gh);
    }
    ctx.globalAlpha = 1;

    // angry core eye (all species)
    const eyeR = w * 0.2;
    const eye = ctx.createRadialGradient(0, 0, 0, 0, 0, eyeR);
    eye.addColorStop(0, "#ffffff"); eye.addColorStop(0.4, c1); eye.addColorStop(1, "transparent");
    ctx.shadowColor = c1; ctx.shadowBlur = 26; ctx.fillStyle = eye;
    ctx.beginPath(); ctx.arc(0, 0, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = "#15040f";
    ctx.beginPath(); ctx.ellipse(0, 0, eyeR * 0.26, eyeR * 0.72, 0, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
    ctx.shadowBlur = 0;
  }

  function drawBullets() {
    for (const bl of game.bullets) {
      const r = T.bulletSize / 2;
      // motion trail
      ctx.strokeStyle = hexA(C.danger, 0.35); ctx.lineWidth = r * 1.4; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(bl.x - bl.vx * 0.03, bl.y - bl.vy * 0.03); ctx.lineTo(bl.x, bl.y); ctx.stroke();
      ctx.lineCap = "butt";
      // outer glow
      const g = ctx.createRadialGradient(bl.x, bl.y, 0, bl.x, bl.y, r * 2.6);
      g.addColorStop(0, "rgba(255,255,255,0.95)");
      g.addColorStop(0.35, C.danger);
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.shadowColor = C.danger; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(bl.x, bl.y, r * 2.6, 0, Math.PI * 2); ctx.fill();
      // hot core
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(bl.x, bl.y, r * 0.55, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawBars() {
    for (const bar of game.bars) {
      const x = bar.x, hw = bar.w / 2;
      const warn = bar.life <= bar.warn;
      const g1 = bar.gapY - bar.gapH / 2, g2 = bar.gapY + bar.gapH / 2;
      if (bar.breaking) {
        // shattered by overdrive — fragments fly apart
        const k = Math.min(1, bar.breakT / 0.35);
        ctx.globalAlpha = 1 - k;
        const segs = 9;
        for (let s = 0; s < segs; s++) {
          const sh = H / segs, sy = s * sh;
          if (sy + sh > g1 && sy < g2) continue;
          const dir = (s % 2 ? 1 : -1);
          ctx.fillStyle = hexA(C.danger, 0.9);
          ctx.shadowColor = C.danger; ctx.shadowBlur = 18;
          ctx.fillRect(x - hw + dir * k * 60, sy + 2, bar.w, sh - 4);
        }
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
        continue;
      }
      if (warn) {
        // telegraph: dashed outline + gap markers, not yet lethal
        const a = 0.3 + 0.4 * Math.abs(Math.sin(bar.life * 18));
        ctx.strokeStyle = hexA(C.danger, a); ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
        ctx.strokeRect(x - hw, 0, bar.w, H); ctx.setLineDash([]);
        ctx.fillStyle = hexA(C.ok, 0.5);
        ctx.fillRect(x - hw - 4, g1, bar.w + 8, 3); ctx.fillRect(x - hw - 4, g2 - 3, bar.w + 8, 3);
        continue;
      }
      // lethal energy wall — two glowing slabs above & below the gap
      const slab = (yA, yB) => {
        const grd = ctx.createLinearGradient(x - hw, 0, x + hw, 0);
        grd.addColorStop(0, "transparent"); grd.addColorStop(0.5, hexA(C.danger, 0.96)); grd.addColorStop(1, "transparent");
        ctx.fillStyle = grd; ctx.shadowColor = C.danger; ctx.shadowBlur = 26;
        ctx.fillRect(x - hw, yA, bar.w, yB - yA);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "#ffe0e6"; ctx.lineWidth = 2;
        ctx.strokeRect(x - hw, yA, bar.w, yB - yA);
        // animated energy scanlines
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        const off = (bar.life * 120) % 14;
        for (let yy = yA + off; yy < yB; yy += 14) ctx.fillRect(x - hw, yy, bar.w, 2);
      };
      slab(0, g1); slab(g2, H);
      // hot gap rim
      ctx.fillStyle = hexA(C.accentSoft, 0.9); ctx.shadowColor = C.accent; ctx.shadowBlur = 16;
      ctx.fillRect(x - hw - 3, g1 - 3, bar.w + 6, 3); ctx.fillRect(x - hw - 3, g2, bar.w + 6, 3);
      ctx.shadowBlur = 0;
    }
  }

  function drawPlayerBullets() {
    for (const pb of game.playerBullets) {
      const r = (pb.big ? T.chargeBulletSize : T.playerBulletSize) / 2;
      const g = ctx.createRadialGradient(pb.x, pb.y, 0, pb.x, pb.y, r * 2.4);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.4, C.accentSoft);
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.shadowColor = C.accent; ctx.shadowBlur = pb.big ? 26 : 14;
      ctx.beginPath(); ctx.arc(pb.x, pb.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = C.accentSoft; ctx.lineWidth = pb.big ? 4 : 2;
      ctx.beginPath(); ctx.moveTo(pb.x - r * (pb.big ? 2 : 3), pb.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      if (pb.big) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pb.x, pb.y, r, 0, Math.PI * 2); ctx.stroke(); }
      ctx.shadowBlur = 0;
    }
  }

  // faint aim line from SeekDeep to the cursor + a rotating holographic scanner reticle
  function drawAimReticle() {
    if (!aimSet || state !== STATE.PLAY || paused) return;
    // aim line
    ctx.save();
    ctx.strokeStyle = hexA(C.accentSoft, 0.22); ctx.lineWidth = 1.5; ctx.setLineDash([6, 8]);
    ctx.beginPath(); ctx.moveTo(game.px, game.py); ctx.lineTo(aimX, aimY); ctx.stroke();
    ctx.setLineDash([]);
    // scanner reticle (SeekDeep's mask optic) — translucent blue rotating hologram
    ctx.translate(aimX, aimY);
    const r = 18, rot = game.t * 1.6;
    ctx.shadowColor = C.accent; ctx.shadowBlur = 10;
    ctx.strokeStyle = hexA(C.accentSoft, 0.8); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(0, 0, r, -0.6, 1.6); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r, Math.PI - 0.6, Math.PI + 1.6); ctx.stroke();
    ctx.save(); ctx.rotate(rot);
    ctx.strokeStyle = hexA(C.accent, 0.6); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // crosshair ticks + dot
    ctx.strokeStyle = hexA(C.accentSoft, 0.7);
    ctx.beginPath();
    ctx.moveTo(-r - 4, 0); ctx.lineTo(-r + 4, 0); ctx.moveTo(r - 4, 0); ctx.lineTo(r + 4, 0);
    ctx.moveTo(0, -r - 4); ctx.lineTo(0, -r + 4); ctx.moveTo(0, r - 4); ctx.lineTo(0, r + 4);
    ctx.stroke();
    ctx.fillStyle = hexA("#bfeaff", 0.5 + 0.4 * Math.sin(game.t * 8));
    ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function drawPlayer() {
    const blink = game.invuln > 0 && Math.floor(game.t * 18) % 2 === 0;
    ctx.save();
    ctx.translate(game.px, game.py);
    const od = game.freeAmmo;
    const rew = game.scrollFx && game.scrollFx.kind === "reverse";

    // ⚡ OVER CLOCKED transformation — bot holds straight & powers up (Saiyan-style)
    if (game.transform > 0) {
      const prog = 1 - game.transform / T.transformTime;   // 0 → 1
      // imploding energy rings
      ctx.strokeStyle = "#ffffff"; ctx.shadowColor = C.accent; ctx.shadowBlur = 24; ctx.lineWidth = 3;
      for (let k = 0; k < 4; k++) {
        const rr = PH * (3.2 - prog * 2) * (0.5 + (k + ((game.t * 2) % 1)) / 4 % 1);
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.arc(0, 0, Math.max(4, rr), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // converging lightning bolts striking the bot
      ctx.lineWidth = 2;
      for (let k = 0; k < 6; k++) {
        const a = game.t * 4 + k / 6 * 6.28, r0 = PH * (3.5 - prog * 2);
        ctx.strokeStyle = k % 2 ? "#ffffff" : C.accentSoft;
        ctx.beginPath(); let x = Math.cos(a) * r0, y = Math.sin(a) * r0; ctx.moveTo(x, y);
        for (let s = 0; s < 3; s++) { x *= 0.6; y *= 0.6; ctx.lineTo(x + (Math.random() - 0.5) * 10, y + (Math.random() - 0.5) * 10); }
        ctx.stroke();
      }
      // building aura
      const ar2 = PH * (1.4 + prog * 1.4);
      const ag = ctx.createRadialGradient(0, 0, 0, 0, 0, ar2);
      ag.addColorStop(0, hexA("#ffffff", 0.5 + 0.4 * prog)); ag.addColorStop(0.5, hexA(C.accent, 0.4 * prog)); ag.addColorStop(1, "transparent");
      ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(0, 0, ar2, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // the bot: level, rising slightly, in his crackling ELECTRIC POWER POSE
      const fr = (imgPower && imgPower.complete && imgPower.naturalWidth) ? imgPower : odFrames[0];
      const isPow = fr === imgPower;
      if (fr && fr.complete && fr.naturalWidth) {
        const sc = 2.2 + prog * 0.9 + Math.sin(game.t * 30) * 0.05;
        const dh = PH * sc, dw = dh * (isPow ? POW_AR : OD_AR);
        ctx.imageSmoothingEnabled = false;
        ctx.shadowColor = C.accent; ctx.shadowBlur = 30;
        ctx.drawImage(fr, -dw / 2, -dh / 2 - prog * PH * 0.35, dw, dh);
        ctx.shadowBlur = 0; ctx.imageSmoothingEnabled = true;
      }
      ctx.restore();
      return;
    }
    // PEPE invincibility — golden blazing aura with orbiting sparks
    if (game.invincible > 0 && !blink) {
      const r = PH * 2.3;
      const ga = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      const gp = 0.5 + 0.3 * Math.sin(game.t * 18);
      ga.addColorStop(0, hexA("#fff6c8", gp)); ga.addColorStop(0.5, hexA("#ffd23f", gp * 0.6)); ga.addColorStop(1, "transparent");
      ctx.fillStyle = ga; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = "#ffd23f"; ctx.shadowBlur = 20; ctx.fillStyle = "#ffffff";
      for (let k = 0; k < 6; k++) { const a = game.t * 5 + k / 6 * 6.28; ctx.beginPath(); ctx.arc(Math.cos(a) * PH * 1.4, Math.sin(a) * PH * 1.4, 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.shadowBlur = 0;
    }
    // charge indicator — a tightening white ring while right-click is held
    if (game.charging && state === STATE.PLAY) {
      const c = Math.min(1, game.chargeT / T.chargeMin);
      const ready = game.chargeT >= T.chargeMin;
      ctx.strokeStyle = ready ? "#ffffff" : hexA(C.accentSoft, 0.7);
      ctx.lineWidth = ready ? 3 : 2; ctx.shadowColor = C.accent; ctx.shadowBlur = ready ? 20 : 8;
      ctx.beginPath(); ctx.arc(0, 0, PH * (1.6 - 0.7 * c) + (ready ? Math.sin(game.t * 20) * 2 : 0), 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // OVERDRIVE: roaring blue aura, flames, and crackling electricity around the bot
    if (od && !blink) {
      const r = PH * 2.1;
      const aura = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      const ap = 0.45 + 0.25 * Math.sin(game.t * 16);
      aura.addColorStop(0, hexA("#ffffff", ap));
      aura.addColorStop(0.35, hexA("#bfeaff", ap * 0.8));
      aura.addColorStop(0.7, hexA(C.accent, ap * 0.45));
      aura.addColorStop(1, "transparent");
      ctx.fillStyle = aura;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      // pulsing energy ring
      ctx.strokeStyle = hexA(C.accentSoft, 0.5 + 0.3 * Math.sin(game.t * 10));
      ctx.lineWidth = 2.5; ctx.shadowColor = C.accent; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(0, 0, PH * (1.2 + 0.12 * Math.sin(game.t * 8)), 0, Math.PI * 2); ctx.stroke();
      // big blue flame tongues licking off the body
      ctx.shadowColor = C.accent; ctx.shadowBlur = 22;
      for (let k = 0; k < 12; k++) {
        const a = game.t * 3.4 + k / 12 * Math.PI * 2;
        const fl = PH * (1.0 + Math.random() * 0.8);
        ctx.fillStyle = k % 2 ? "#ffffff" : C.accentSoft;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a - 0.14) * PH * 0.55, Math.sin(a - 0.14) * PH * 0.55);
        ctx.lineTo(Math.cos(a) * fl, Math.sin(a) * fl);
        ctx.lineTo(Math.cos(a + 0.14) * PH * 0.55, Math.sin(a + 0.14) * PH * 0.55);
        ctx.closePath(); ctx.fill();
      }
      // electric arcs
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.6;
      for (let k = 0; k < 5; k++) {
        const a0 = Math.random() * 6.28, r0 = PH * 0.7, r1 = PH * (1.3 + Math.random() * 0.6);
        ctx.beginPath(); ctx.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0);
        const am = a0 + (Math.random() - 0.5) * 0.8;
        ctx.lineTo(Math.cos(am) * (r0 + r1) / 2 + (Math.random() - 0.5) * 10, Math.sin(am) * (r0 + r1) / 2 + (Math.random() - 0.5) * 10);
        ctx.lineTo(Math.cos(a0) * r1, Math.sin(a0) * r1); ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // SHIELD barrier — translucent hex bubble around the bot while a shield is held
    if (game.shield && !blink) {
      const r = PH * 1.55;
      ctx.save();
      const sg = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r);
      sg.addColorStop(0, "transparent"); sg.addColorStop(0.8, hexA("#2dd4ff", 0.10)); sg.addColorStop(1, hexA("#6df0ff", 0.22));
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = hexA("#6df0ff", 0.5 + 0.3 * Math.sin(game.t * 6)); ctx.lineWidth = 2.4;
      ctx.shadowColor = C.accent; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.2; ctx.strokeStyle = hexA("#bdf3ff", 0.4);
      ctx.save(); ctx.rotate(game.t * 0.8); polyPath(6, r * 0.98, 0); ctx.stroke(); ctx.restore();
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // lively motion: lean into velocity + gentle idle bob/sway/breathe
    const tilt = Math.max(-0.4, Math.min(0.5, game.vy / 900)) + Math.sin(game.t * 4) * 0.04;
    ctx.rotate(tilt);
    const bob = Math.sin(game.t * 7) * PH * 0.06;
    const breathe = 1 + Math.sin(game.t * 7) * 0.03;
    if (!blink) {
      const fr = (od ? odFrames : flyFrames)[0];
      if (fr && fr.complete && fr.naturalWidth) {
        const ar = od ? OD_AR : SPR_AR;
        const dh = PH * 2.15 * breathe, dw = dh * ar;
        ctx.imageSmoothingEnabled = false;
        if (rew) ctx.scale(-1, 1);   // face backward while rewinding
        ctx.shadowColor = od ? C.accent : C.accentSoft;
        ctx.shadowBlur = od ? 24 : 10;
        ctx.drawImage(fr, -dw / 2, -dh / 2 + bob, dw, dh);
        ctx.shadowBlur = 0;
        ctx.imageSmoothingEnabled = true;
      } else {
        drawHexPlayer();
      }
    }
    ctx.restore();

    // overdrive sheds blue embers into the world
    if (od && state === STATE.PLAY && !paused && Math.random() < 0.7) {
      game.particles.push({ x: game.px + (Math.random() - 0.5) * PH, y: game.py + (Math.random() - 0.5) * PH,
        vx: -120 - Math.random() * 120, vy: (Math.random() - 0.5) * 80,
        life: 0.3 + Math.random() * 0.3, max: 0.6, color: Math.random() < 0.5 ? "#ffffff" : C.accentSoft, r: 1.5 + Math.random() * 2.5 });
    }
  }

  // electrified white hexagon (procedural player)
  function drawHexPlayer() {
    const r = PW * 0.5;
    const pulse = 0.5 + 0.5 * Math.sin(game.t * 7);
    // HOLOGRAM aura — pulsing rings + scanline shimmer
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.6);
    halo.addColorStop(0, hexA(C.accentSoft, 0.4));
    halo.addColorStop(0.5, hexA(C.accent, 0.12));
    halo.addColorStop(1, "transparent");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, r * 2.6, 0, Math.PI * 2); ctx.fill();
    // orbiting hologram rings
    ctx.strokeStyle = hexA("#ffffff", 0.5 + 0.3 * pulse); ctx.lineWidth = 1.5;
    ctx.shadowColor = C.accent; ctx.shadowBlur = 14;
    for (let k = 0; k < 2; k++) {
      ctx.save(); ctx.rotate(game.t * (k ? -1.6 : 1.2)); ctx.scale(1, 0.4);
      ctx.beginPath(); ctx.arc(0, 0, r * (1.5 + k * 0.5), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    // body
    ctx.shadowColor = C.accentSoft; ctx.shadowBlur = 18;
    polyPath(6, r, Math.PI / 6);
    const g = ctx.createRadialGradient(0, -r * 0.3, r * 0.1, 0, 0, r);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.7, "#eafdff");
    g.addColorStop(1, "#bfe9f5");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = C.accent;
    ctx.stroke();
    // inner ring
    ctx.shadowBlur = 0;
    polyPath(6, r * 0.58, Math.PI / 6);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(45,212,255,0.6)";
    ctx.stroke();
    // electric arcs flicking off the vertices
    ctx.strokeStyle = C.accentSoft;
    ctx.shadowColor = C.accentSoft; ctx.shadowBlur = 12;
    ctx.lineWidth = 1.4;
    const arcs = 5;
    for (let k = 0; k < arcs; k++) {
      const a = Math.random() * Math.PI * 2;
      const x0 = Math.cos(a) * r, y0 = Math.sin(a) * r;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      let px = x0, py = y0;
      const steps = 3, reach = r * (0.5 + Math.random() * 0.5);
      for (let s = 1; s <= steps; s++) {
        const t2 = s / steps;
        const nx = Math.cos(a) * (r + reach * t2) + (Math.random() - 0.5) * 7;
        const ny = Math.sin(a) * (r + reach * t2) + (Math.random() - 0.5) * 7;
        ctx.lineTo(nx, ny); px = nx; py = ny;
      }
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.shadowBlur = 0;
  }

  function drawParticles() {
    for (const p of game.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  // ---- main-menu sprite : pixel-perfect power-up / power-down ----------------
  // The 10 source frames are independently-generated and the body morphs/scales
  // between them, so an animated body can never be truly pixel-locked. Instead we
  // hold ONE eye-locked frame perfectly still (zero jitter, eyes never move) and
  // render the whole "power up → power down" surge as a smooth PROCEDURAL electric
  // aura around it (60fps) — pixel-perfect AND buttery smooth, no stacking.
  let menuClock = 0, menuCtx = null;
  function menuGlow(g, cxp, cyp, rad, col, inten) {
    const rg = g.createRadialGradient(cxp, cyp, 0, cxp, cyp, rad);
    rg.addColorStop(0, hexA(col, inten)); rg.addColorStop(0.5, hexA(col, inten * 0.5)); rg.addColorStop(1, "transparent");
    g.fillStyle = rg; g.beginPath(); g.arc(cxp, cyp, rad, 0, 6.283); g.fill();
  }
  function updateMenuSprite(dt) {
    const el = hud.menuSprite;
    if (!el) return;
    const show = state === STATE.MENU && !hud.overlay.classList.contains("hidden");
    if (!show) { if (!el.classList.contains("hidden")) el.classList.add("hidden"); return; }
    if (!menuCtx) menuCtx = el.getContext("2d");
    const body = menuFrames[8];   // one calm, eye-locked frame (aligned_09) — the static base
    if (!body || !body.complete || !body.naturalWidth) return;
    if (el.classList.contains("hidden")) el.classList.remove("hidden");
    menuClock += dt;
    const g = menuCtx, cw = el.width, ch = el.height, t = menuClock;
    const bx = 173, by = 205;     // aura/body centre (native frame coords)
    // power 0→1→0 (eased), with a small idle floor so he always crackles a little
    const cyc = (t % 3.6) / 3.6;
    let p = cyc < 0.5 ? cyc / 0.5 : (1 - cyc) / 0.5;
    p = p * p * (3 - 2 * p);
    const pw = 0.12 + 0.88 * p;
    g.clearRect(0, 0, cw, ch);
    g.save();
    // radial energy field
    const rg = g.createRadialGradient(bx, by, 0, bx, by, 150);
    rg.addColorStop(0, hexA("#ffffff", 0.18 * pw));
    rg.addColorStop(0.35, hexA("#6df0ff", 0.34 * pw));
    rg.addColorStop(0.7, hexA("#2dd4ff", 0.16 * pw));
    rg.addColorStop(1, "transparent");
    g.fillStyle = rg; g.beginPath(); g.arc(bx, by, 150, 0, 6.283); g.fill();
    // expanding shock rings
    g.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      const rp = (t * 0.5 + k / 3) % 1;
      g.globalAlpha = (1 - rp) * 0.5 * pw;
      g.strokeStyle = "#bdf3ff";
      g.beginPath(); g.arc(bx, by, 40 + rp * 112, 0, 6.283); g.stroke();
    }
    g.globalAlpha = 1;
    // radiating lightning bolts
    g.strokeStyle = "#ffffff"; g.shadowColor = "#2dd4ff"; g.shadowBlur = 14; g.lineWidth = 2;
    const bolts = 11;
    for (let k = 0; k < bolts; k++) {
      if (Math.random() > 0.3 + 0.6 * pw) continue;
      const a = (k / bolts) * 6.283 + t * 0.6;
      const r0 = 55, r1 = (92 + Math.random() * 62) * (0.5 + 0.5 * pw);
      g.globalAlpha = 0.5 + 0.5 * pw;
      g.beginPath();
      let rx = bx + Math.cos(a) * r0, ry = by + Math.sin(a) * r0; g.moveTo(rx, ry);
      for (let j = 1; j <= 3; j++) {
        const rr = r0 + (r1 - r0) * (j / 3);
        rx = bx + Math.cos(a) * rr + (Math.random() - 0.5) * 16;
        ry = by + Math.sin(a) * rr + (Math.random() - 0.5) * 16;
        g.lineTo(rx, ry);
      }
      g.stroke();
    }
    g.globalAlpha = 1; g.shadowBlur = 0;
    // ground energy glow
    g.fillStyle = hexA("#6df0ff", 0.30 * pw);
    g.beginPath(); g.ellipse(bx, 332, 72 * (0.6 + 0.5 * pw), 12 * (0.6 + 0.5 * pw), 0, 0, 6.283); g.fill();
    // STATIC BODY — pixel-locked, never moves
    g.imageSmoothingEnabled = true;
    g.drawImage(body, 0, 0, cw, ch);
    // eyes + chest core brighten with power (additive)
    const eg = 0.45 + 0.55 * pw;
    g.globalCompositeOperation = "lighter";
    menuGlow(g, 173, 150, 16, "#7df7ff", 0.7 * eg);   // round eye
    menuGlow(g, 141, 150, 14, "#7df7ff", 0.5 * eg);   // slit eye
    menuGlow(g, 173, 224, 18, "#9bdcff", 0.55 * eg);  // chest core
    g.globalCompositeOperation = "source-over";
    // close electric arcs hugging the body at high power
    if (pw > 0.4) {
      g.strokeStyle = "#ffffff"; g.shadowColor = "#2dd4ff"; g.shadowBlur = 8; g.lineWidth = 1.4; g.globalAlpha = (pw - 0.4) * 1.2;
      for (let k = 0; k < 4; k++) {
        const a = Math.random() * 6.283, r0 = 60, r1 = 82;
        g.beginPath(); g.moveTo(bx + Math.cos(a) * r0, by + Math.sin(a) * r0);
        const am = a + (Math.random() - 0.5) * 0.6;
        g.lineTo(bx + Math.cos(am) * (r0 + r1) / 2 + (Math.random() - 0.5) * 10, by + Math.sin(am) * (r0 + r1) / 2 + (Math.random() - 0.5) * 10);
        g.lineTo(bx + Math.cos(a) * r1, by + Math.sin(a) * r1); g.stroke();
      }
      g.globalAlpha = 1; g.shadowBlur = 0;
    }
    g.restore();
  }

  // ---- loop ----------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    if (!W || !H) resize();   // self-heal if the canvas sized to 0 (first-launch race)
    if (!W || !H) { last = now; requestAnimationFrame(frame); return; } // still 0 (layout not ready) — wait; don't run physics/render at 0 dims (NaN / div-by-zero)
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.max(0, Math.min(0.05, dt)); // guard against negative / huge deltas
    if (state === STATE.PLAY && !paused) update(dt);
    updateMenuSprite(dt);
    if (touchMode && touchUI) {
      const showTouch = state === STATE.PLAY && !paused;
      if (touchUI._on !== showTouch) { touchUI._on = showTouch; touchUI.classList.toggle("on", showTouch); }  // only touch the DOM on change
    }
    render();
    requestAnimationFrame(frame);
  }

  function refreshMuteLabels() {
    var muted = window.DDAudio && window.DDAudio.muted;
    var txt = "[M] SOUND: " + (muted ? "OFF" : "ON");
    var a = document.getElementById("mute-status"), b = document.getElementById("mute-status-pause");
    if (a) a.textContent = txt; if (b) b.textContent = txt;
  }
  // ---- touch controls (mobile, landscape twin-stick) ----------------------
  function checkOrient() {
    if (touchMode) document.body.classList.toggle("portrait", window.innerHeight > window.innerWidth);
  }
  function setupTouch() {
    if (!touchMode) return;
    document.body.classList.add("touch");
    touchUI = document.getElementById("touch-ui");
    if (!touchUI) return;
    const uiRect = () => touchUI.getBoundingClientRect();
    const MAXR = 52, DEAD = 12;

    function bindStick(zoneId, stickId, onVec, onEnd) {
      const zone = document.getElementById(zoneId), stick = document.getElementById(stickId);
      if (!zone || !stick) return;
      const knob = stick.querySelector(".touch-knob");
      let id = null, ox = 0, oy = 0;
      zone.addEventListener("touchstart", (e) => {
        e.preventDefault();
        if (id !== null) return;
        const t = e.changedTouches[0]; id = t.identifier;
        const r = uiRect(); ox = t.clientX - r.left; oy = t.clientY - r.top;
        stick.style.left = ox + "px"; stick.style.top = oy + "px"; stick.classList.add("show");
        knob.style.transform = "translate(-50%,-50%)";
        onVec(0, 0);
      }, { passive: false });
      zone.addEventListener("touchmove", (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {   // indexed loop: TouchList isn't iterable on some old/embedded webviews
          const t = e.changedTouches[i];
          if (t.identifier !== id) continue;
          const r = uiRect(); const dx = (t.clientX - r.left) - ox, dy = (t.clientY - r.top) - oy;
          const m = Math.hypot(dx, dy) || 1, cl = m > MAXR ? MAXR / m : 1;
          knob.style.transform = `translate(calc(-50% + ${dx * cl}px), calc(-50% + ${dy * cl}px))`;
          onVec(dx, dy);
        }
      }, { passive: false });
      function end(e) {
        for (let i = 0; i < e.changedTouches.length; i++) {   // indexed loop: TouchList isn't iterable on some old/embedded webviews
          const t = e.changedTouches[i];
          if (t.identifier !== id) continue;
          id = null; stick.classList.remove("show"); knob.style.transform = "translate(-50%,-50%)"; onEnd();
        }
      }
      zone.addEventListener("touchend", end); zone.addEventListener("touchcancel", end);
    }

    // LEFT stick — drift thrusters
    bindStick("touch-move", "ts-move", (dx, dy) => {
      keys.up = keys.down = keys.left = keys.right = false;
      if (Math.hypot(dx, dy) < DEAD) return;
      if (dx > 14) keys.right = true; else if (dx < -14) keys.left = true;
      if (dy > 14) keys.down = true; else if (dy < -14) keys.up = true;
    }, () => { keys.up = keys.down = keys.left = keys.right = false; });

    // RIGHT stick — aim + fire (drag to aim, release to stop; tap = forward shot)
    bindStick("touch-aim", "ts-aim", (dx, dy) => {
      if (state !== STATE.PLAY || paused || !game) return;
      game.shooting = true;
      if (Math.hypot(dx, dy) >= DEAD) { aimX = game.px + dx; aimY = game.py + dy; aimSet = true; }
      else aimSet = false;   // pressed but not aimed → straight ahead
    }, () => { if (game) game.shooting = false; aimSet = false; });

    // CHARGE button — hold to build, release to fire
    const cb = document.getElementById("tbtn-charge");
    if (cb) {
      cb.addEventListener("touchstart", (e) => { e.preventDefault(); if (state === STATE.PLAY && !paused && game) { game.charging = true; cb.classList.add("charging", "held"); if (window.DDAudio) window.DDAudio.startLoop("chargeLoop"); } }, { passive: false });
      const up = (e) => { e.preventDefault(); cb.classList.remove("charging", "held"); if (game && game.charging) { game.charging = false; if (window.DDAudio) window.DDAudio.stopLoop("chargeLoop"); releaseCharge(); } };
      cb.addEventListener("touchend", up); cb.addEventListener("touchcancel", up);
    }
    const pb = document.getElementById("tbtn-pause");
    if (pb) pb.addEventListener("touchstart", (e) => { e.preventDefault(); togglePause(); }, { passive: false });
    const mb = document.getElementById("tbtn-mute");
    if (mb) mb.addEventListener("touchstart", (e) => { e.preventDefault(); if (window.DDAudio) { const m = window.DDAudio.toggleMute(); mb.textContent = m ? "🔇" : "🔊"; refreshMuteLabels(); } }, { passive: false });

    checkOrient();
    window.addEventListener("resize", checkOrient);
    window.addEventListener("orientationchange", checkOrient);
  }

  // ---- boot ----------------------------------------------------------------
  function boot() {
    resize();
    // menu overlay copy
    hud.ovTitle.textContent = TEXT.title;
    hud.ovSub.textContent = TEXT.tagline;
    hud.ovBtn.textContent = TEXT.start;
    hud.ovBest.textContent = best > 0 ? `${TEXT.bestLabel}: ${formatBytes(best)}` : "";

    // wire menu + scoreboard buttons
    document.querySelectorAll("[data-open-controls]").forEach((btn) =>
      btn.addEventListener("click", openControls));
    const ctrlClose = document.getElementById("ctrl-close");
    if (ctrlClose) ctrlClose.addEventListener("click", closeControls);
    const pauseResume = document.getElementById("pause-resume");
    if (pauseResume) pauseResume.addEventListener("click", togglePause);
    if (hud.scoreName) hud.scoreName.addEventListener("input", () => {
      if (!lastScoreEntry) return;
      lastScoreEntry.name = (hud.scoreName.value || "").replace(/[^A-Za-z0-9_.#]/g, "").slice(0, 24) || "—";
      saveScores(); renderScores();
    });
    // Keep keystrokes in the score-name field from reaching the global game key
    // listeners — typing a Discord ID (a/s/d/w move, Space/Arrows) would otherwise
    // fly the ship or restart the game. Wired here via addEventListener (not an
    // inline onkeydown= attribute) so it survives a strict CSP: the Discord
    // Activity iframe disallows unsafe-inline handlers.
    if (hud.scoreName) {
      hud.scoreName.addEventListener("keydown", (e) => e.stopPropagation());
      hud.scoreName.addEventListener("keyup", (e) => e.stopPropagation());
    }

    if (hud.ovControls) hud.ovControls.textContent = touchMode
      ? "LEFT STICK fly · RIGHT STICK aim & fire · CHARGE hold/release"
      : "WASD/ARROWS fly · MOUSE aim · L-CLICK fire · R-CLICK charge · P pause";
    if (hud.timerLabel) hud.timerLabel.textContent = "CLICK TO FRAG";
    refreshMuteLabels();
    setupTouch();
    // start menu music on the first user gesture (autoplay needs interaction)
    window.addEventListener("pointerdown", function gm() {
      window.removeEventListener("pointerdown", gm);
      if (window.DDAudio && state !== STATE.PLAY) { window.DDAudio.init().then(function () { window.DDAudio.music("menuMusic"); }); }
    }, { once: true });
    renderScores();
    last = performance.now();
    requestAnimationFrame(frame);
  }
  // ensure layout is ready
  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot);

})();
