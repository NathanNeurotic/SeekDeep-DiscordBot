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
    volumes: { music: 1.7, menuMusic: 1.7, bossMusic: 1.8, shot: 0.42, packet: 0.34, malwareLoop: 0.4, malwareDie: 0.95, malwareSpawn: 0.85, kernel: 1.6, bossShot: 0.36, bossIncoming: 1.1, bossBomb: 1.15, bossDead: 1.05, damage: 0.95, gameOver: 1.0, invincibleLoop: 1.4 },
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

    scrollStart:       640,    // world speed px/s at start (2× faster — more challenge)
    scrollMax:         1040,   // caps out here
    scrollRampBytes:   90000,  // bytes over which speed ramps to max

    bytesPerPx:        14,     // distance → bytes multiplier

    // ---- CORRIDOR GENERATOR ----
    // An OPEN data-channel with distinct structures jutting in: flat-topped chip
    // towers, ceiling overhangs, pinches and ramps. Ceiling & floor are driven
    // independently with a guaranteed min channel + flyable slopes (never impossible).
    colW:              20,     // terrain column width (px)
    edgeMargin:        0.05,   // walls never enter this margin of the screen edges
    minGapFrac:        0.235,  // narrowest safe channel (fraction of H) — fairer tightest clearance
    maxGapFrac:        0.50,   // open channel width — tighter so screen-centre is no longer auto-safe
                               // (centre used to always sit inside the gap; you must follow it up/down now)
    wallSlopePx:       12,     // max wall move per column (px) — kept followable at 2× speed
    rampFrac:          0.3,    // fraction of a tower spent ramping (rest is flat top → ziggurat)
    towerMin:          0.24,   // tower/overhang height range (fraction of H)
    towerMax:          0.42,
    wallStepFrac:      0.055,  // walls snap to this vertical grid → blocky chip towers (not smooth ramps)
    pinchAmt:          0.38,   // how far an archway pinch closes (fraction of H)
    centerStepMin:     0.1,    // base-channel meander per feature (fraction H)
    centerStepMax:     0.28,
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
    mysteryFastMult:   1.45,   // scroll multiplier: overclock (flashes GREEN)
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
    barAlignThreshold: 240,    // x-distance within which a new firewall snaps to an existing one's gap (anti-solid-wall)

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
