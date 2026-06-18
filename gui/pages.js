/* SeekDeep · pages.js — the SINGLE page registry.
 *
 * One source of truth for every GUI surface, consumed by:
 *   - the Cmd-K jump palette (nav.js)
 *   - the "More" nav dropdown (nav.js)
 *   - the verb-grouped topnav (nav.js, Phase 2)
 *   - the Hub directory + surface count (index.html, Phase 4)
 *
 * Loaded as a plain <script defer> BEFORE nav.js (defer preserves document
 * order), so window.SEEKDEEP_PAGES is set before nav.js reads it. nav.js keeps
 * an internal fallback list, so a page that somehow omits pages.js still works.
 *
 * Fields:
 *   id         stable slug
 *   title      display name
 *   path       html path (relative to /gui/)
 *   group      'run' | 'create' | 'manage' | 'learn' | 'system'
 *   glyph      single-char icon for the palette
 *   meta       short palette subtitle
 *   live       true = a real, working surface; false = mock/marketing/splash
 *   navigable  true = should appear in primary navigation (Phase 2 topnav)
 *   gateFlag   SEEKDEEP_FEATURE_* env flag, or null — gated items only show
 *              when GET /config/features reports the flag on
 *   palette    true = listed in the Cmd-K jump palette (membership preserved
 *              from the pre-registry nav.js PAGES array)
 *   more       true = listed in the "More" dropdown (membership preserved from
 *              the pre-registry MORE_ITEMS array); gated items use gateFlag
 *              instead and are appended after the flags resolve.
 */
(function () {
  'use strict';
  if (window.SEEKDEEP_PAGES) return; // idempotent — survive double-include

  var PAGES = [
    // ---- RUN (primary, most-used) ----
    { id: 'chat',         title: 'Chat Client',     path: 'chat.html',         group: 'run',    glyph: '▸', meta: 'PWA chat · same models as Discord', live: true,  navigable: true,  gateFlag: null, palette: true,  more: false },
    { id: 'app',          title: 'Control Center',  path: 'app.html',          group: 'run',    glyph: '⌘', meta: 'launcher · gpu · models · logs · live events', live: true, navigable: true, gateFlag: null, palette: true, more: false },
    { id: 'index',        title: 'Hub',             path: 'index.html',        group: 'run',    glyph: '⌂', meta: 'home · surface directory', live: true,  navigable: true,  gateFlag: null, palette: true,  more: false },
    { id: 'setup_wizard', title: 'Setup',           path: 'setup-wizard.html', group: 'run',    glyph: '◇', meta: 'zero-terminal first-run · auto-detect + auto-fix', live: true, navigable: true, gateFlag: null, palette: true, more: false },
    { id: 'installer',    title: 'Installer',       path: 'installer.html',    group: 'run',    glyph: '⚙', meta: '9-step wizard · VRAM calculator', live: true,  navigable: false, gateFlag: null, palette: true,  more: false },

    // ---- CREATE (the creative tools) ----
    { id: 'image_ab',     title: 'Image A/B',       path: 'image-ab.html',     group: 'create', glyph: '▩', meta: '4 pipelines side-by-side', live: true, navigable: true, gateFlag: null, palette: true, more: true },
    { id: 'prompts',      title: 'Prompt Templates',path: 'prompts.html',      group: 'create', glyph: '◩', meta: 'local template library + #prompts share', live: true, navigable: true, gateFlag: null, palette: true, more: true },
    { id: 'personas',     title: 'Personas',        path: 'personas.html',     group: 'create', glyph: '☺', meta: 'custom personas · list/create/assign', live: true, navigable: true, gateFlag: null, palette: true, more: true },
    { id: 'tts',          title: 'TTS Voice',       path: 'tts.html',          group: 'create', glyph: '♫', meta: 'install Piper + download voices + Speak', live: true, navigable: true, gateFlag: null, palette: false, more: true },
    { id: 'add_model',    title: 'Add a Model',     path: 'add-model.html',    group: 'create', glyph: '+', meta: 'wizard · POST /model/install', live: true, navigable: true, gateFlag: null, palette: true, more: true },
    { id: 'activity',     title: 'DATA DASH!',      path: 'activity/index.html', group: 'create', glyph: '◆', meta: 'the DataDash Discord Activity game', live: true, navigable: true, gateFlag: null, palette: false, more: true },

    // ---- MANAGE (config + admin) ----
    { id: 'settings',     title: 'All Settings',    path: 'settings.html',     group: 'manage', glyph: '⛭', meta: 'every .env key · typed + grouped', live: true, navigable: true, gateFlag: null, palette: true, more: true },
    { id: 'memory',       title: 'Memory',          path: 'memory.html',       group: 'manage', glyph: '⌗', meta: 'user-facts · live', live: true, navigable: true, gateFlag: null, palette: true, more: true },
    { id: 'changelog',    title: 'Changelog',       path: 'changelog.html',    group: 'learn',  glyph: '⊞', meta: 'v10.x history', live: true, navigable: true, gateFlag: null, palette: true, more: true },
    { id: 'emoji_vault',  title: 'Emoji Vault',     path: 'emoji-vault.html',  group: 'manage', glyph: '☻', meta: 'per-guild emoji browse / backup / import', live: true, navigable: true, gateFlag: 'SEEKDEEP_FEATURE_EMOJI_VAULT', palette: false, more: false },
    { id: 'force_react',  title: 'Force React',     path: 'force-react.html',  group: 'manage', glyph: '✦', meta: 'per-guild cumulative react cap + emoji pool', live: true, navigable: true, gateFlag: 'SEEKDEEP_FEATURE_FORCE_REACT', palette: false, more: false },
    { id: 'bot_bridge',   title: 'Bot Bridge',      path: 'bot-bridge.html',   group: 'manage', glyph: '⇄', meta: 'read-only bot ping / status / guilds', live: true, navigable: true, gateFlag: 'SEEKDEEP_FEATURE_BOT_BRIDGE', palette: false, more: false },

    // ---- LEARN (reference) ----
    { id: 'docs',         title: 'Docs',            path: 'docs.html',         group: 'learn',  glyph: '▤', meta: 'COMMANDS.md mirror', live: true, navigable: true, gateFlag: null, palette: true, more: false },
    { id: 'api',          title: 'API Explorer',    path: 'api.html',          group: 'learn',  glyph: '⚡', meta: 'live + offline route inspector', live: true, navigable: true, gateFlag: null, palette: true, more: false },
    { id: 'architecture', title: 'Architecture',    path: 'architecture.html', group: 'learn',  glyph: '⌬', meta: 'system map', live: true, navigable: true, gateFlag: null, palette: true, more: false },
    { id: 'roadmap',      title: 'Roadmap',         path: 'roadmap.html',      group: 'learn',  glyph: '▦', meta: 'PLANNED.md', live: true, navigable: true, gateFlag: null, palette: true, more: false },

    // ---- SYSTEM / splash / marketing (not primary nav; live:false = mock/no backend) ----
    { id: 'boot',            title: 'Boot sequence',  path: 'boot.html',            group: 'system', glyph: '◉', meta: 'splash', live: false, navigable: false, gateFlag: null, palette: true,  more: false },
    { id: 'seekdeep_loading',title: 'Loading',        path: 'seekdeep-loading.html',group: 'system', glyph: '◴', meta: 'boot overlay', live: false, navigable: false, gateFlag: null, palette: false, more: false },
    { id: 'landing',         title: 'Landing',        path: 'landing.html',         group: 'system', glyph: '◷', meta: 'marketing landing (mock)', live: false, navigable: false, gateFlag: null, palette: false, more: false },
    { id: 'pitch',           title: 'Pitch',          path: 'pitch.html',           group: 'system', glyph: '◵', meta: 'pitch deck (mock)', live: false, navigable: false, gateFlag: null, palette: false, more: false },
    { id: 'tour',            title: 'Tour',           path: 'tour.html',            group: 'system', glyph: '◶', meta: 'guided tour (mock)', live: false, navigable: false, gateFlag: null, palette: false, more: false },
    { id: 'mobile',          title: 'Mobile',         path: 'mobile.html',          group: 'system', glyph: '▢', meta: 'mobile layout (mock)', live: false, navigable: false, gateFlag: null, palette: false, more: false },
  ];

  // Convenience accessors. Filters preserve registry array order.
  window.SEEKDEEP_PAGES = PAGES;
  window.SeekDeepPages = {
    all: function () { return PAGES.slice(); },
    byId: function (id) { return PAGES.filter(function (p) { return p.id === id; })[0] || null; },
    palette: function () { return PAGES.filter(function (p) { return p.palette; }); },
    more: function () { return PAGES.filter(function (p) { return p.more; }); },
    gated: function () { return PAGES.filter(function (p) { return !!p.gateFlag; }); },
    group: function (g) { return PAGES.filter(function (p) { return p.group === g && p.navigable; }); },
    navigable: function () { return PAGES.filter(function (p) { return p.navigable; }); },
    live: function () { return PAGES.filter(function (p) { return p.live; }); },
  };
})();
