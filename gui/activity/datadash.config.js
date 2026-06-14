/* ============================================================================
 *  SeekDeep's DATA DASH — RESKIN SURFACE
 * ----------------------------------------------------------------------------
 *  Everything you need to retheme the game lives in this one file.
 *  Swap sprites, colors, copy, and difficulty without touching the engine.
 *  Drop new art in /assets and point SPRITES at it. That's the whole job.
 * ========================================================================== */

window.DATADASH = {

  /* --- SOUND --------------------------------------------------------------
   * Event → audio file. Engine (datadash.audio.js) decodes each, auto-trims
   * leading/trailing silence, and plays trimmed so rapid SFX stay in sync.
   * Keys flagged loop are sustained; the rest are one-shots.
   */
  SOUNDS: {
    base: "uploads/",
    files: {
      jackIn:        "Menu_Jack_In_~1s_-_c_4-1780472800433.mp3",
      menuMusic:     "mainmenubackgroundmusic-endmenubackgroundmusic.mp3",
      music:         "Main_background_musi_4-1780472639099.mp3",
      shot:          "Normal_shot_(L-click_1-1780471777305.mp3",
      chargeLoop:    "Charge_building_(hol_1-1780471815761.mp3",
      chargeFire:    "Charged_shot_release_3-1780471852017.mp3",
      firewallSmash: "Firewall_smash_(over_3-1780471950716.mp3",
      kernel:        "Video_game_Kernel_pi_3-1780471159600.mp3",
      packet:        "Video_game_DATA_pack_3-1780471221141.mp3",
      mystery:       "Video_game_Mystery_s_3-1780471342326.mp3",
      speedUp:       "Speed-Up!_Power_Up_V_4-1780472836543.mp3",
      slowDown:      "Slow-Motion_slow_dow_3-1780472889011.mp3",
      powerUp:       "Video_Game_Power_Up__4-1780470935207.mp3",
      powerDown:     "Power_Down_(overdriv_3-1780471064621.mp3",
      shieldHeld:    "Shield_Held_(1st_hit_3-1780471122557.mp3",
      pepe:          "Video_game_Pepe_Jack_2-1780471380872.mp3",
      invincibleLoop:"invincible_pepe.mp3",
      malwareSpawn:  "minimalwarespawn.mp3",
      malwareLoop:   "Mini-malware_present_2-1780475702345.mp3",
      malwareDie:    "Malware_destroyed_~0_4-1780472064737.mp3",
      damage:        "Damage_taken_(lose_k_4-1780472154960.mp3",
      gameOver:      "Game_over_(Connectio_3-1780472179707.mp3",
      bossIncoming:  "Boss_incoming_warnin_2-1780472219930.mp3",
      bossMusic:     "Boss_battle_music_lo_4-1780472305825.mp3",
      bossShot:      "Boss_bullet_fire_~0._4-1780472360590.mp3",
      bossBomb:      "Boss_bomb_detonation_3-1780472438259.mp3",
      bossDead:      "Boss_defeatedcrashed_3-1780472556720.mp3",
    },
    loops: ["menuMusic", "music", "bossMusic", "chargeLoop", "malwareLoop"],
    volumes: { music: 1.7, menuMusic: 1.7, bossMusic: 1.8, shot: 0.42, packet: 0.34, malwareLoop: 0.4, malwareDie: 0.95, malwareSpawn: 0.85, kernel: 1.6, bossShot: 0.36, bossIncoming: 1.1, bossBomb: 1.15, bossDead: 1.05, damage: 0.95, gameOver: 1.0, invincibleLoop: 2.8 },
  },

  /* --- BRANDING / COPY ---------------------------------------------------
   * All player-facing strings. The {n} token is filled with a number.
   */
  TEXT: {
    title:        "DATA DASH",
    titleAccent:  "SEEKDEEP'S",          // small kicker above the title
    tagline:      "You are SeekDeep. Stream the bytes, neutralize the threats, and backdoor your way through every system.",
    start:        "JACK IN",
    retry:        "REROUTE",
    unit:         "B",                    // distance unit suffix (bytes)
    distanceLabel:"DATA STREAMED",
    bestLabel:    "BEST RUN",
    livesLabel:   "KERNELS",

    checkpoint:   "KERNEL BACKUP ATTAINED",   // shown when a life pickup is grabbed
    checkpointSub:"×{n} kernels online",

    bonus:        "EMERGENCY KERNEL PACK",     // shown when a +2 bonus pack is grabbed
    bonusSub:     "+{v} kernels · ×{n} online",

    mysteryFast:    "PERFORMANCE MODE ⏩",      // mystery pickup: speed up
    mysterySlow:    "THROTTLED ⏸",            // mystery pickup: slow down
    mysteryReverse: "REVERTING . . . ⏪",       // mystery pickup: reverse
    mysterySub:     "{s}s",

    scoreTitle:   "TOP STREAMS",
    scoreEmpty:   "no runs logged yet — go stream some bytes",
    scorePrompt:  "TAG YOUR RUN",

    paused:       "PAUSED",
    pausedSub:    "press P to resume",

    bossIncoming: "⚠  FIREWALL DAEMON INBOUND",
    bossSurvive:  "DAEMON CRASHED",
    bossSurviveSub:"packet cleared — keep streaming",

    hit:          "FRAGMENTED",
    gameOver:     "CONNECTION LOST",
    gameOverSub:  "you streamed {n}",
    newBest:      "NEW PERSONAL BEST",

    holdHint:     "HOLD  /  SPACE  /  TAP   to thrust",
  },

  /* --- SPRITES -----------------------------------------------------------
   * Player and boss art. Reskin = replace these two images.
   * w/h are the on-screen draw size in CSS px.
   */
  SPRITES: {
    // Player defaults to a procedural "electrified white hexagon" (drawn from shapes).
    // Set src to an image path to use your own art instead; size with w/h.
    player: { src: null, w: 24,  h: 24 },
    // Boss is drawn procedurally from simple shapes (original art, no 3rd-party graphic).
    // To use your own boss image instead, set src to a file path; size with w/h.
    boss:   { src: null, w: 124, h: 124 },
  },

  /* --- PALETTE -----------------------------------------------------------
   * Pulled from the SeekDeep "cyber-ocean" activity theme.
   */
  COLORS: {
    bg:        "#02060f",
    bgGlow:    "rgba(45,212,255,0.12)",
    grid:      "rgba(120,222,255,0.10)",
    terrain:   "#06182e",          // fill of ceiling/floor walls
    terrainEdge:"#2dd4ff",         // glowing wall edge
    obstacle:  "#0a2742",
    obstacleEdge:"#6df0ff",
    accent:    "#2dd4ff",
    accentSoft:"#6df0ff",
    ok:        "#72ffcf",          // checkpoints / backups
    warn:      "#ffd166",          // boss / danger telegraph
    danger:    "#ff5d73",          // bullets / death
    mystery:   "#c08cff",          // question-mark mystery pickups
    text:      "#eefaff",
    muted:     "#a9bac7",
    thrust:    "#6df0ff",          // thruster flame
  },

  /* --- LEVELS ------------------------------------------------------------
   * Zones unlocked by total DATA STREAMED. The level is the magnitude bracket
   * of DATA streamed; it tracks DATA BOTH ways (non-monotonic, with hysteresis).
   * Each level sets its own scroll speed, colour palette, and tower-shape
   * profile, so the world visibly changes character as you stream more data.
   *   threshold = bytes at/above which this level becomes active.
   *   speed     = world scroll px/s (eased on level-up). L1 is the slow base;
   *               TB is faster than the old single-ramp max (860).
   *   palette   = all hex. glow/grid are the hex tint (alpha applied in-engine);
   *               terrain/obstacle/accent families recolour the whole world.
   *   shape     = per-level overrides for the corridor generator (anything
   *               omitted falls back to TUNING). Gap / lane / min-channel params
   *               are intentionally NOT here — they stay constant in TUNING so
   *               the "always a flyable thread" guarantee holds at every level.
   *     weights = relative chance of each feature {open,floorTower,ceilTower,pinch,ramp}.
   */
  LEVELS: [
    // --- cyan family (Start / KB / MB<250): easy on-ramp, differentiated by bg/terrain luminance ---
    { name: "BOOT · DATA STREAM", sub: "spooling up — ease in", threshold: 0, speed: 380,
      palette: { bg:"#02060f", glow:"#2dd4ff", grid:"#78deff", terrain:"#06182e", terrainEdge:"#2dd4ff", obstacle:"#0a2742", obstacleEdge:"#6df0ff", accent:"#2dd4ff", accentSoft:"#6df0ff" },
      shape: { rampFrac:0.50, wallStepFrac:0, towerMin:0.06, towerMax:0.12, pinchAmt:0.10, featMin:10, featMax:18, obsChance:0.40, obsDoubleChance:0.00,
        weights:{ open:0.50, floorTower:0.16, ceilTower:0.16, pinch:0.04, ramp:0.14 } } },
    { name: "KB · DATA STREAM", sub: "kilobyte channel", threshold: 1e3, speed: 460,
      palette: { bg:"#03091a", glow:"#2dd4ff", grid:"#78deff", terrain:"#08203c", terrainEdge:"#2dd4ff", obstacle:"#0c2d4e", obstacleEdge:"#6df0ff", accent:"#2dd4ff", accentSoft:"#6df0ff" },
      shape: { rampFrac:0.45, wallStepFrac:0, towerMin:0.07, towerMax:0.14, pinchAmt:0.12, featMin:9, featMax:16, obsChance:0.52, obsDoubleChance:0.04,
        weights:{ open:0.40, floorTower:0.19, ceilTower:0.19, pinch:0.07, ramp:0.15 } } },
    { name: "MB · DATA RIVER", sub: "megabyte flow", threshold: 1e6, speed: 560,
      palette: { bg:"#040d22", glow:"#2dd4ff", grid:"#8fe6ff", terrain:"#0a2848", terrainEdge:"#2dd4ff", obstacle:"#0e3558", obstacleEdge:"#6df0ff", accent:"#2dd4ff", accentSoft:"#8fe6ff" },
      shape: { rampFrac:0.38, wallStepFrac:0.04, towerMin:0.08, towerMax:0.16, pinchAmt:0.15, featMin:7, featMax:14, obsChance:0.66, obsDoubleChance:0.10,
        weights:{ open:0.30, floorTower:0.22, ceilTower:0.22, pinch:0.11, ramp:0.15 } } },
    // --- teal @ 250MB (colour shift; speed keeps climbing) ---
    { name: "MB · DATA SURGE", sub: "quarter-gig — current rising", threshold: 2.5e8, speed: 680,
      palette: { bg:"#02100c", glow:"#2dd4c0", grid:"#7cffe0", terrain:"#06281f", terrainEdge:"#2dd4c0", obstacle:"#0a3a30", obstacleEdge:"#6df0d8", accent:"#2dd4c0", accentSoft:"#5ff0d8" },
      shape: { rampFrac:0.28, wallStepFrac:0.05, towerMin:0.09, towerMax:0.175, pinchAmt:0.17, featMin:6, featMax:12, obsChance:0.78, obsDoubleChance:0.16,
        weights:{ open:0.22, floorTower:0.25, ceilTower:0.25, pinch:0.13, ramp:0.15 } } },
    // --- green @ GB (the original speed) ---
    { name: "GB · DATA TORRENT", sub: "gigabyte zone — full speed", threshold: 1e9, speed: 860,
      palette: { bg:"#02100a", glow:"#39ff96", grid:"#7cffb4", terrain:"#06281a", terrainEdge:"#39ff96", obstacle:"#0a3a26", obstacleEdge:"#6dffae", accent:"#39ff96", accentSoft:"#7cffb4" },
      shape: { rampFrac:0.18, wallStepFrac:0, towerMin:0.10, towerMax:0.185, pinchAmt:0.18, featMin:5, featMax:10, obsChance:0.85, obsDoubleChance:0.20,
        weights:{ open:0.15, floorTower:0.29, ceilTower:0.29, pinch:0.15, ramp:0.12 } } },
    // --- red @ TB (fastest, brutal) ---
    { name: "TB · DATA OVERLOAD", sub: "terabyte zone — maximum velocity", threshold: 1e12, speed: 1040,
      palette: { bg:"#140604", glow:"#ff5a3c", grid:"#ffaa78", terrain:"#2e0d06", terrainEdge:"#ff5d3a", obstacle:"#421a11", obstacleEdge:"#ff9a6d", accent:"#ff5d3a", accentSoft:"#ffae6d" },
      shape: { rampFrac:0.22, wallStepFrac:0.04, towerMin:0.11, towerMax:0.185, pinchAmt:0.18, featMin:4, featMax:8, obsChance:0.92, obsDoubleChance:0.30,
        weights:{ open:0.10, floorTower:0.28, ceilTower:0.28, pinch:0.19, ramp:0.15 } } },
  ],

  FONTS: {
    ui:   `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`,
    mono: `"Cascadia Code", "JetBrains Mono", "SFMono-Regular", Consolas, monospace`,
  },

  /* --- CONTROLS ----------------------------------------------------------
   * Default bindings. The in-game CONTROLS menu lets players rebind these to
   * any key or mouse button; their choice is saved to localStorage and wins
   * over these defaults. type is "key" (code = KeyboardEvent.code) or
   * "mouse" (code = button index: 0 left, 1 middle, 2 right).
   */
  CONTROLS: {
    lift:  { type: "key",   code: "Space", label: "Space" },
    shoot: { type: "mouse", code: 0,       label: "Left Click" },
  },

  /* --- TUNING ------------------------------------------------------------
   * Pure feel/difficulty. All physics are in CSS px and seconds.
   */
  TUNING: {
    worldScale:        1.5,    // camera zoom-out: >1 reveals more of the course (smaller ball, more room)
    startLives:        2,
    invulnTime:        0.9,    // seconds of blink + damage-immunity after a hit (still solid)
    bumpBounce:        70,     // gentle, consistent rebound speed off any wall (px/s)

    // ---- DRIFT MOVEMENT (no gravity — momentum craft) ----
    // The ship has no constant pull. Thrusters add momentum; damping bleeds it
    // off. Loose enough to feel like flying in zero-g, tight enough to thread gates.
    driftThrust:       3700,   // vertical thruster accel (UP/DOWN)
    driftDamp:         0.93,    // vertical momentum damping per 1/60s — coasts loosely but settles
    vMax:              840,     // max vertical drift speed (px/s)
    playerX:           0.5,     // player horizontal anchor (fraction of width)
    // LEFT/RIGHT thrusters — horizontal dodging (great in boss fights)
    hThrust:           4300,    // sideways thruster accel
    hSpring:           2.6,     // gentle pull back to the anchor lane when you let go
    hDamp:             0.9,      // horizontal damping (per 1/60s)
    hMax:              860,      // max sideways speed (px/s)
    hMargin:           0.1,      // player stays within this margin of the screen edges
    crashGravity:      900,     // pull used only for the boss death-spiral

    scrollStart:       560,    // fallback base speed only (used if CFG.LEVELS is absent) — real per-level speeds now live in CFG.LEVELS (440 → 980)

    bytesPerPx:        14,     // distance → bytes multiplier

    // ---- CORRIDOR GENERATOR ----
    // An OPEN data-channel with distinct structures jutting in: flat-topped chip
    // towers, ceiling overhangs, pinches and ramps. Ceiling & floor are driven
    // independently with a guaranteed min channel + flyable slopes (never impossible).
    colW:              20,     // terrain column width (px)
    edgeMargin:        0.05,   // walls never enter this margin of the screen edges
    minGapFrac:        0.215,  // narrowest safe channel (fraction of H) — tightest pinch clearance
    maxGapFrac:        0.44,   // open channel width — eased from 0.42 (too hard); still <0.45 so the
                               // gap occasionally sits off screen-centre (centre not a guaranteed free ride)
    wallSlopePx:       8,      // max wall move per column (px) — gentler ramps; worst-case wall close (~1.5×) stays < vMax even at full scroll
    rampFrac:          0.3,    // fraction of a tower spent ramping (rest is flat top → ziggurat)
    towerMin:          0.09,   // tower/overhang height range — kept under the shared feature-height
    towerMax:          0.18,   //   cap (maxGapFrac − minGapFrac − 0.02 ≈ 0.185) so towers stay varied,
                               //   not clamped flat. Re-fit whenever maxGapFrac/minGapFrac move.
    wallStepFrac:      0.055,  // walls snap to this vertical grid → blocky chip towers (not smooth ramps)
    pinchAmt:          0.17,   // how far an archway pinch closes (fraction of H) — under the ~0.185 cap so pinches vary (still the tightest feature)
    centerStepMin:     0.14,   // base-channel meander per feature (fraction H) — kept high for vertical travel
    centerStepMax:     0.23,   //   (Nathan likes it). CAP at the half-range (0.45 − maxGapFrac/2 = 0.23): a
                               //   larger step from mid-channel overshoots BOTH bounds → degenerate slam to edge.
    featMin:           6,      // base feature length range (columns) for open/ramp stretches
    featMax:           13,
    corridorRampBytes: 80000,  // distance over which towers get a touch taller/more frequent

    // ---- CHIP OBSTACLES ----
    // Discrete rectangular circuit-chips jut from a wall into the open channel,
    // always leaving a passage on the far side. The dodge gameplay.
    obsEveryMin:       12,     // columns between obstacles (range)
    obsEveryMax:       22,
    obsChance:         0.82,   // chance to place one when eligible
    obsSpanMin:        2,      // obstacle width (columns)
    obsSpanMax:        4,
    obsPassage:        0.17,   // guaranteed clear channel past the chip (fraction of H)
    obsMinHeight:      0.16,   // chip protrusion range (fraction of H) — juts a bit more
    obsMaxHeight:      0.42,
    obsDoubleChance:   0.16,   // chance of a top+bottom pair (squeeze you through the middle)

    // ---- FLYABLE LANE (error correction) ----
    // A slope-limited "safe altitude" that walls & chips may never cross, so a
    // navigable thread always exists no matter how dense/varied the layout.
    laneMargin:        0.11,   // half-height of the protected lane (fraction of H) — tighter, more dodging
    laneSlopePx:       8,      // max lane drift per column (px) — gentler, easier to track
    laneRetargetMin:   13,     // columns between lane re-aims (range)
    laneRetargetMax:   30,

    // Checkpoints (extra-life backups) — frequency scales with how many kernels you hold.
    // Plenty when you're hurting, rare once you're comfortable (5+).
    checkpointEvery:   46000,  // base bytes between +1 packs (scaled by kernels held) — rarer
    checkpointRich:    5,      // kernels at/above which packs become rare
    pickupSize:        44,
    pickupPull:        360,    // pickups gravitate to the player within this radius (px) — stronger reach
    pickupPullForce:   2200,   // pull strength (px/s at the edge of the radius) — much grabbier

    // Emergency packs: only appear while you're down to your last kernel, grant +2
    bonusEvery:        12000,  // bytes between emergency-pack spawns (while at 1 kernel)
    bonusValue:        2,      // kernels granted by an emergency pack

    // DATA PACKETS — tiny collectibles that bump your streamed total
    packetEvery:       8000,   // bytes between data-packet spawns (≈2× as many)
    packetStringChance:0.6,    // chance a packet spawn is a string of several — more trails
    packetStringMax:   14,     // up to this many in a string — longer trails, cooler grabs
    packetValue:      10000,   // DATA (bytes) granted per packet — 10 KB

    // BOSS AMMO RELIEF — during a boss fight, if the player's reserves run low,
    // feed spaced-out but consistent kb packet strips so they're never stranded
    // without ammo. (Outside bosses we still want them to save up.)
    bossPacketEvery:   34000,  // streamed bytes between relief strips (spaced + consistent)
    bossPacketCount:   5,      // packets per strip (~50 KB ≈ 2 shots)
    bossPacketLowKB:   1000000,// only feed relief while DATA reserves are under 1 MB

    // MINI-MALWARE BOTS — small drifting hazards on their own respawn clock
    botSpawnSeconds:   20,     // independent timer: spawn a batch every N seconds (50% more frequent)
    botBatch:          2,      // how many spawn per tick
    botMax:            6,      // hard cap on screen — clock won't restart until there's room
    botLoudFar:        420,    // world px: beyond this the presence loop is silent
    botLoudNear:       90,     // world px: within this the presence loop hits peak (proximity audio)
    botLoudPeak:       0.6,    // max presence-loop gain when a bot is right on top of you
    botEvery:          42000,  // (legacy — spawns are now time-based; kept for reference)
    botSpeed:          96,     // creep speed (px/s) — closes in, but always dodgeable
    botSize:           46,     // bot diameter (px) — big enough to shoot / dodge
    botHomeForce:      90,     // how much it veers toward the player (gentle interference)
    botCrashKB:        320000, // bytes a bot tails you before it self-crashes if not shot

    // Mystery (?) pickups — randomly warp the scroll speed for a while. Uncommon.
    mysteryEvery:      320000, // avg bytes between mystery spawns (rarer, more spaced)
    mysteryDurMin:     6,      // effect duration range (seconds)
    mysteryDurMax:     14,
    mysterySlowDurMax: 10,     // slowdown is capped shorter than other effects
    mysteryFastMult:   2.0,    // PERFORMANCE MODE scroll multiplier ×2 (violent rainbow world filter)
    mysterySlowMult:   0.5,    // scroll multiplier: throttle (flashes GREEN)
    mysteryReverseMult:-0.8,   // scroll multiplier: rewind (flashes RED, negative = backwards)
    revertGrace:       1.2,    // wall-damage immunity (s) DURING a rewind + this long after it
                               // ends, so a rewind-generated impassable config can't unfairly kill

    // RANDOM EVENTS — special hallway segments that trigger unpredictably (not on a
    // fixed cadence) and can be any one of: double-boss, DATA Base, DDoS, Pepe Packets.
    eventEveryMin:     62,     // soonest seconds before another event can roll
    eventEveryMax:     140,    // latest — picked randomly between so it never feels metronomic
    eventGap:          0.80,   // straight-hallway opening (fraction of H) during an event
    eventCols:         560,    // event "distance" in terrain columns (~12–16s)
    dbWaveAmp:         0.30,   // DATA Base: kb wave amplitude (fraction of H)
    dbSpacingCols:     3,      // DATA Base: columns between kb bits along the wave
    ddosSpacingCols:   5,      // DDoS: columns between maze rows (more horizontal room = gentler, followable slopes)
    ddosSlots:         8,      // DDoS: vertical slots per maze row
    pepeGridCols:      5,      // Pepe Packets: columns between grid columns
    pepeGridRows:      6,      // Pepe Packets: rows of collectibles across the hallway

    // Bosses — vicious animated malware daemon
    bossEverySeconds:  50,     // a boss arrives after this many seconds of boss-free survival
    bossDuration:      24,     // seconds you must survive (longer, tougher fights)
    bossEnterTime:     1.4,    // glide-in time
    bossArenaGap:      0.78,   // cave opens to this fraction of height during fight (room to dodge)
    bossMoveSpeed:     3.0,    // how briskly it darts around its zone
    bossPatternEvery:  2.4,    // seconds between switching attack patterns
    bulletSpeed:       420,    // base px/s (faster)
    bulletSize:        15,
    barSpeed:          300,    // firewall wall travel speed (px/s)
    barGap:            0.26,   // gap height in the firewall you fly through (fraction of H)
    barWarn:           0.55,   // telegraph time before the firewall goes lethal (s)
    barThickness:      30,     // firewall wall thickness (px)

    // Player return fire (CLICK) — costs DATA: spend bytes to shoot. Out of data =
    // no fire, but bosses still expire on their own timer; bullets just speed it up.
    playerFireEvery:   0.24,   // seconds between your shots
    playerBulletSpeed: 900,    // px/s
    playerBulletSize:  11,
    bossHitReduce:     0.9,    // seconds shaved off the challenge timer per hit
    chargeCost:        1000000, // DATA spent per charged big shot — 1 MB
    chargeMin:         0.35,   // min hold time (s) to fire a charged shot
    chargeBulletSize:  34,     // big bullet diameter (px)
    chargeBossReduce:  6.0,    // seconds shaved per charged hit (≈4 hits to fell a boss)

    // PEPE COIN — jackpot: time-gated random spawn, AT MOST once every 60s of play.
    // The clock restarts on every spawn (collected or not) — it never queues up.
    pepeEverySec:      120,     // minimum seconds between Pepe spawns (hard cap) — halved frequency
    pepeRandSec:       70,      // extra random seconds on top so timing stays unpredictable
    pepeSize:          76,
    pepeInvincible:    15,      // seconds of invincibility on collect

    // ELEMENTAL EVENT — a shared spawn pool that yields EITHER a DATA LOSS skull or
    // a DATA RECOVERY drive (never both at once), at most once a minute.
    elementalEvery:    60,      // minimum seconds between elemental events (≥ 1 / minute)
    dataRecoveryMult:  5,       // DATA RECOVERY instantly grants this × your current DATA streamed

    // SHIELD pickup — its OWN entity: completely random, memoryless spawn. No event
    // or cycle triggers or blocks it; could appear in seconds or not for ages.
    shieldMeanSec:     30,      // average seconds between spawns (but fully unpredictable)
    shieldSize:        66,      // pickup icon diameter (px)
    shotCost:          25000,  // DATA (bytes) spent per shot — 25 KB
    bombFuse:          1.6,    // boss bomb: blink time before it detonates (s)
    bombRadius:        150,    // bomb splash radius (px)
    bombSpeed:         150,    // bomb drift speed (px/s)
    bombShrapnel:      14,     // stray orbs released in all directions on detonation

    // Rare UPGRADE element — electric bolt, ~once per MB. No magnet (align to grab).
    // Grants free ammo (no DATA cost) until you take a hit, which it absorbs
    // instead of a kernel.
    upgradeEvery:      1000000, // bytes between upgrade spawns (50% rarer — 1 MB)
    upgradeSize:       104,    // 2× bigger lightning bolt
    transformTime:     1.6,    // world-freeze duration while the Over Clocked transform plays

    // Local scoreboard
    scoreMax:          8,      // how many top runs to keep
  },
};
